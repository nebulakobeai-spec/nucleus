import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FetchLike } from '../../src/providers/openai-compat.js'

/**
 * Provider 的 record / replay。
 *
 * 目的：**live 跑一次，之后永远离线、确定性、零成本重放。**
 * 这样 tier 3（真模型）的验证成果可以固化成 tier 2（回放）测试。
 *
 * 用法：
 *   NUCLEUS_RECORD=1 npm run test:live   # 真调 → 写入 fixture
 *   npm test                             # 从 fixture 重放
 */

export interface RecordedExchange {
  key: string
  request: { url: string; body: unknown }
  response: {
    status: number
    headers: Record<string, string>
    /** 非流式为 JSON 字符串；流式为完整 SSE 文本 */
    body: string
  }
}

/**
 * 请求指纹。
 *
 * 只取影响输出的字段。**不含 api key**（fixture 会进 git）。
 */
export function fingerprint(url: string, body: unknown): string {
  const b = body as Record<string, unknown>
  const stable = {
    url: url.replace(/^https?:\/\/[^/]+/, ''),
    model: b?.['model'],
    messages: b?.['messages'],
    tools: b?.['tools'],
    tool_choice: b?.['tool_choice'],
    temperature: b?.['temperature'],
    stream: b?.['stream'] ?? false,
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16)
}

/** 落盘前剥掉所有敏感头 —— fixture 是要提交到仓库的。 */
const SENSITIVE_HEADERS = new Set(['authorization', 'api-key', 'x-api-key', 'cookie', 'set-cookie'])

function redactHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v
  })
  return out
}

export class Cassette {
  #entries = new Map<string, RecordedExchange>()
  #dirty = false

  constructor(private path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as RecordedExchange[]
      for (const e of raw) this.#entries.set(e.key, e)
    }
  }

  get(key: string): RecordedExchange | undefined {
    return this.#entries.get(key)
  }

  put(e: RecordedExchange): void {
    this.#entries.set(e.key, e)
    this.#dirty = true
  }

  save(): void {
    if (!this.#dirty) return
    mkdirSync(dirname(this.path), { recursive: true })
    const sorted = [...this.#entries.values()].sort((a, b) => a.key.localeCompare(b.key))
    writeFileSync(this.path, JSON.stringify(sorted, null, 2) + '\n')
    this.#dirty = false
  }

  get size(): number {
    return this.#entries.size
  }
}

export interface ReplayOptions {
  /** 录制模式：真调并写盘 */
  record?: boolean
  /** 录制时使用的真实 fetch */
  realFetch?: FetchLike
  /** 未命中 fixture 时的行为 */
  onMiss?: 'throw' | 'passthrough'
}

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'provider')

/**
 * 造一个 FetchLike：命中 fixture 就重放，否则按配置录制或报错。
 */
export function cassetteFetch(name: string, opts: ReplayOptions = {}): FetchLike & { save(): void } {
  const cassette = new Cassette(join(FIXTURE_ROOT, `${name}.json`))
  const record = opts.record ?? process.env['NUCLEUS_RECORD'] === '1'

  const f = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const key = fingerprint(url, body)
    const hit = cassette.get(key)

    if (hit) {
      return new Response(hit.response.body, {
        status: hit.response.status,
        headers: hit.response.headers,
      })
    }

    if (!record) {
      if (opts.onMiss === 'passthrough' && opts.realFetch) return opts.realFetch(url, init)
      throw new Error(
        `cassette「${name}」未命中：${key}\n` +
          `model=${body.model} stream=${body.stream ?? false}\n` +
          `用 NUCLEUS_RECORD=1 npm run test:live 录制。`,
      )
    }

    const real = opts.realFetch ?? ((u: string, i: RequestInit) => fetch(u, i))
    const res = await real(url, init)
    const text = await res.text()
    cassette.put({
      key,
      request: { url, body },
      response: { status: res.status, headers: redactHeaders(res.headers), body: text },
    })
    cassette.save()
    return new Response(text, { status: res.status, headers: redactHeaders(res.headers) })
  }) as FetchLike & { save(): void }

  f.save = () => cassette.save()
  return f
}

// ── 手工构造响应（不需要真模型的单元测试用）────────────

export interface StubChoice {
  content?: string
  toolCalls?: Array<{ id?: string; name: string; args: unknown }>
  finishReason?: string
}

/** 造一个非流式的 OpenAI 兼容成功响应。 */
export function stubCompletion(
  c: StubChoice,
  usage: { in?: number; out?: number; cached?: number } = {},
  headers: Record<string, string> = {},
): Response {
  const body = {
    id: 'chatcmpl-stub',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: c.content ?? null,
          ...(c.toolCalls
            ? {
                tool_calls: c.toolCalls.map((t, i) => ({
                  id: t.id ?? `call_${i}`,
                  type: 'function',
                  function: { name: t.name, arguments: JSON.stringify(t.args) },
                })),
              }
            : {}),
        },
        finish_reason: c.finishReason ?? (c.toolCalls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: {
      prompt_tokens: usage.in ?? 10,
      completion_tokens: usage.out ?? 5,
      ...(usage.cached ? { prompt_tokens_details: { cached_tokens: usage.cached } } : {}),
    },
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** 造一个 SSE 流式响应，可控制分片边界（用于测工具参数分片累积）。 */
export function stubStream(chunks: unknown[], headers: Record<string, string> = {}): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

/** 造一个错误响应。 */
export function stubError(
  status: number,
  body: unknown = { error: { message: 'boom' } },
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

/** 把一串预置响应按顺序返回的 fetch；用于测 fallback 切换。 */
export function scriptedFetch(responses: Array<Response | (() => Response | Promise<Response>)>): FetchLike & {
  calls: Array<{ url: string; body: Record<string, unknown> }>
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  let i = 0
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} })
    const r = responses[Math.min(i++, responses.length - 1)]
    if (!r) throw new Error('scriptedFetch: 响应用尽')
    return typeof r === 'function' ? r() : r.clone()
  }) as FetchLike & { calls: typeof calls }
  f.calls = calls
  return f
}
