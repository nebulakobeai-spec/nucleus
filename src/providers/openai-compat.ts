import { NucleusError } from '../errors.js'
import type {
  ChatRequest,
  ChatResponse,
  ModelConfig,
  Provider,
  RateLimitInfo,
  ToolCall,
  Usage,
} from './types.js'
import type { Clock } from '../seams.js'

/** 可注入的 fetch，便于 record/replay 与故障注入。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface OpenAICompatOptions {
  fetch?: FetchLike
  clock: Clock
  /** 单次请求超时 */
  timeoutMs?: number
}

/**
 * OpenAI 兼容 provider。
 *
 * 覆盖 z.ai / Moonshot / OpenAI / xAI / ollama —— 它们的 chat/completions
 * 接口形状一致，差异只在 baseUrl、鉴权和响应头。
 *
 * 注意：**不信任 provider 的 schema 遵守**。各家对 JSON Schema 的支持子集
 * 不同，工具参数一律在上层再校验一次（DESIGN.md §6）。
 */
export class OpenAICompatProvider implements Provider {
  readonly id: string
  #fetch: FetchLike
  #clock: Clock
  #timeoutMs: number

  constructor(
    private cfg: ModelConfig,
    private apiKey: string | null,
    opts: OpenAICompatOptions,
  ) {
    this.id = cfg.key
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i))
    this.#clock = opts.clock
    this.#timeoutMs = opts.timeoutMs ?? 120_000
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = this.#clock.now()
    const stream = Boolean(req.onDelta)
    const body = this.#buildBody(req, stream)

    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), this.#timeoutMs)

    let res: Response
    try {
      res = await this.#fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      if (req.signal?.aborted) {
        throw new NucleusError('runtime.cancelled', '请求已取消', { cause: e })
      }
      // 带上底层原因：网络错误、DNS、被拦截、fixture 未命中 —— 只说「超时」
      // 会让排查时完全看不到根因。
      const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)
      throw new NucleusError('provider.timeout', `请求 ${this.cfg.key} 失败：${why}`, {
        cause: e,
        detail: { reason: why },
      })
    }

    const rateLimit = parseRateLimitHeaders(res.headers, this.#clock.now())

    if (!res.ok) {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      throw await this.#toError(res, rateLimit)
    }

    try {
      const out = stream
        ? await this.#readStream(res, req)
        : await this.#readJson(res)
      return {
        ...out,
        model: this.cfg.model,
        ...(rateLimit ? { rateLimit } : {}),
        latencyMs: this.#clock.now() - started,
      }
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
    }
  }

  #buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages = req.messages.map((m) => {
      const base: Record<string, unknown> = { role: m.role, content: m.content }
      if (m.toolCalls?.length) {
        base['tool_calls'] = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments },
        }))
      }
      if (m.toolCallId) base['tool_call_id'] = m.toolCallId
      if (m.name) base['name'] = m.name
      return base
    })

    const body: Record<string, unknown> = { model: this.cfg.model, messages }
    if (stream) {
      body['stream'] = true
      // 拿到流式下的 usage；不支持的家会忽略这个字段
      body['stream_options'] = { include_usage: true }
    }
    if (req.temperature !== undefined) body['temperature'] = req.temperature
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens
    if (req.tools?.length) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
      if (req.toolChoice) {
        body['tool_choice'] =
          typeof req.toolChoice === 'string'
            ? req.toolChoice
            : { type: 'function', function: { name: req.toolChoice.name } }
      }
    }
    return body
  }

  async #readJson(res: Response): Promise<Omit<ChatResponse, 'model' | 'latencyMs'>> {
    const j = (await res.json()) as OpenAIChatCompletion
    const choice = j.choices?.[0]
    return {
      content: choice?.message?.content ?? '',
      toolCalls: (choice?.message?.tool_calls ?? []).map(toToolCall),
      finishReason: mapFinish(choice?.finish_reason),
      usage: mapUsage(j.usage),
    }
  }

  /**
   * SSE 流式解析。
   *
   * 工具调用参数是分片到达的，必须按 index 累积 —— 这是各家实现差异最大的地方，
   * 也是最容易出静默 bug 的地方（参数被截断但 JSON 恰好可解析）。
   */
  async #readStream(
    res: Response,
    req: ChatRequest,
  ): Promise<Omit<ChatResponse, 'model' | 'latencyMs'>> {
    if (!res.body) throw new NucleusError('provider.server_error', '流式响应没有 body')

    let content = ''
    const partial = new Map<number, { id: string; name: string; args: string }>()
    let finish: string | undefined
    let usage: Usage = { tokensIn: 0, tokensOut: 0, cacheRead: 0 }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue

        let chunk: OpenAIChatChunk
        try {
          chunk = JSON.parse(data) as OpenAIChatChunk
        } catch {
          continue // 不完整的行，下一轮补齐
        }

        if (chunk.usage) usage = mapUsage(chunk.usage)
        const d = chunk.choices?.[0]
        if (!d) continue
        if (d.finish_reason) finish = d.finish_reason

        const text = d.delta?.content
        if (text) {
          content += text
          req.onDelta?.({ text })
        }

        for (const tc of d.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0
          const cur = partial.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          partial.set(idx, cur)
          req.onDelta?.({
            toolCallDelta: {
              index: idx,
              ...(tc.id ? { id: tc.id } : {}),
              ...(tc.function?.name ? { name: tc.function.name } : {}),
              ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
            },
          })
        }
      }
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, v]) => ({ id: v.id || `call_${i}`, name: v.name, arguments: v.args }))

    return {
      content,
      toolCalls,
      finishReason: mapFinish(finish ?? (toolCalls.length ? 'tool_calls' : 'stop')),
      usage,
    }
  }

  /** HTTP 错误 → 带 error_code 的 NucleusError。分类决定重试策略。 */
  async #toError(res: Response, rl: RateLimitInfo | undefined): Promise<NucleusError> {
    const text = await res.text().catch(() => '')
    const detail = { status: res.status, body: text.slice(0, 2000) }

    if (res.status === 401 || res.status === 403) {
      return new NucleusError('provider.auth_failed', `${this.cfg.key} 鉴权失败`, { detail })
    }
    if (res.status === 429) {
      // 区分「稍后重试」与「本周期额度用尽」—— 后者要熔断整个模型
      const exhausted = /quota|exceeded your current|usage limit|insufficient/i.test(text)
      const retryAfter = rl?.retryAfterMs ?? null
      return new NucleusError(
        exhausted ? 'provider.quota_exhausted' : 'provider.rate_limited',
        exhausted ? `${this.cfg.key} 额度用尽` : `${this.cfg.key} 被限流`,
        { detail, retryAfterMs: retryAfter },
      )
    }
    if (res.status >= 500) {
      return new NucleusError('provider.server_error', `${this.cfg.key} 服务异常`, { detail })
    }
    return new NucleusError('provider.bad_request', `${this.cfg.key} 拒绝请求`, { detail })
  }
}

// ── 响应解析辅助 ────────────────────────────────────────

interface OpenAIToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }
    finish_reason?: string
  }>
  usage?: OpenAIUsage
}

interface OpenAIChatChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<OpenAIToolCall & { index?: number }>
    }
    finish_reason?: string
  }>
  usage?: OpenAIUsage
}

function toToolCall(t: OpenAIToolCall, i: number): ToolCall {
  return {
    id: t.id ?? `call_${i}`,
    name: t.function?.name ?? '',
    arguments: t.function?.arguments ?? '{}',
  }
}

function mapUsage(u: OpenAIUsage | undefined): Usage {
  return {
    tokensIn: u?.prompt_tokens ?? 0,
    tokensOut: u?.completion_tokens ?? 0,
    cacheRead: u?.prompt_tokens_details?.cached_tokens ?? 0,
  }
}

function mapFinish(f: string | undefined): ChatResponse['finishReason'] {
  switch (f) {
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'other'
  }
}

/**
 * 解析 rate-limit 响应头。
 *
 * OpenAI / xAI 返回这些头；z.ai / Kimi 基本只有 429。
 * 拿得到就用真实值，拿不到就靠本地令牌桶兜底（见 health.ts）。
 */
export function parseRateLimitHeaders(h: Headers, nowMs: number): RateLimitInfo | undefined {
  const num = (k: string): number | undefined => {
    const v = h.get(k)
    if (v == null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }

  const info: RateLimitInfo = {}
  const rr = num('x-ratelimit-remaining-requests')
  const rt = num('x-ratelimit-remaining-tokens')
  if (rr !== undefined) info.remainingRequests = rr
  if (rt !== undefined) info.remainingTokens = rt

  const reset = h.get('x-ratelimit-reset-requests') ?? h.get('x-ratelimit-reset-tokens')
  const resetMs = reset ? parseDuration(reset) : undefined
  if (resetMs !== undefined) info.resetAt = nowMs + resetMs

  const ra = h.get('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs)) info.retryAfterMs = secs * 1000
    else {
      const at = Date.parse(ra)
      if (!Number.isNaN(at)) info.retryAfterMs = Math.max(0, at - nowMs)
    }
  }

  return Object.keys(info).length ? info : undefined
}

/** OpenAI 的 reset 头是 "1s" / "6m0s" / "300ms" 这种格式 */
export function parseDuration(s: string): number | undefined {
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/)
  if (!m || m.slice(1).every((x) => x === undefined)) {
    const n = Number(s)
    return Number.isFinite(n) ? n * 1000 : undefined
  }
  return (
    Number(m[1] ?? 0) * 3_600_000 +
    Number(m[2] ?? 0) * 60_000 +
    Number(m[3] ?? 0) * 1000 +
    Number(m[4] ?? 0)
  )
}
