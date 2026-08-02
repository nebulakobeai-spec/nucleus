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
      // 区分「超时」与「连不上」。
      //
      // 以前一律报 provider.timeout，于是连接被拒也显示「系统会自动重试」——
      // 而那种情况重试永远不会成功，该做的是启动服务或改 baseUrl。
      // 实测中还出现过 540ms 就报「超时」，本身就说不通。
      const timedOut = ctl.signal.reason instanceof Error && ctl.signal.reason.message === 'timeout'
      const sys = systemErrorCode(e)
      const why = describeFetchError(e)
      throw timedOut
        ? new NucleusError(
            'provider.timeout',
            `${this.cfg.key} 超时（${this.#timeoutMs}ms）—— ` +
              `本地大模型生成长文本常常超过这个值。` +
              `调大：该模型配置里的 timeoutMs，或全局 runtime.requestTimeoutMs`,
            {
              cause: e,
              detail: {
                timeoutMs: this.#timeoutMs,
                hint: '本地 31B 级别的模型写长文本很容易超过 2-5 分钟；第一次调用还含模型加载时间',
              },
            },
          )
        : new NucleusError(
            'provider.unreachable',
            `连不上 ${this.cfg.key}（${this.cfg.baseUrl}）：${why}`,
            {
              cause: e,
              detail: {
                reason: why,
                syscallCode: sys,
                baseUrl: this.cfg.baseUrl,
                hint: hintFor(sys),
              },
            },
          )
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
    // reasoning 单独取出，不并入 content —— 见 ChatResponse.reasoning 的说明
    const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content
    return {
      content: choice?.message?.content ?? '',
      ...(reasoning ? { reasoning } : {}),
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
    let reasoning = ''
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
        // 思考增量不进 content，也不推给 UI —— 它不属于最终回复
        const think = d.delta?.reasoning ?? d.delta?.reasoning_content
        if (think) reasoning += think

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
      ...(reasoning ? { reasoning } : {}),
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
    message?: {
      content?: string | null
      /** ollama 用这个字段承载 thinking；有的实现叫 reasoning_content */
      reasoning?: string
      reasoning_content?: string
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason?: string
  }>
  usage?: OpenAIUsage
}

interface OpenAIChatChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning?: string
      reasoning_content?: string
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
/**
 * 从错误链里挖出系统错误码。
 *
 * fetch 失败时外层只是 `TypeError: fetch failed`，有用的东西藏在 `cause`
 * 里，而且**不在 message 上而在 code 上**（EPERM 之类的 message 常常是空的）。
 * 一度只取 `cause.message`，结果诊断里记下来的 reason 是空字符串 ——
 * 专门为保留根因写的代码什么也没保留下来。
 */
export function systemErrorCode(e: unknown): string | null {
  let cur: unknown = e
  for (let i = 0; i < 5 && cur; i++) {
    const c = (cur as { code?: unknown }).code
    if (typeof c === 'string' && /^[A-Z_]+$/.test(c)) return c
    // undici 会把多个尝试（IPv6/IPv4）包成 AggregateError
    const errs = (cur as { errors?: unknown[] }).errors
    if (Array.isArray(errs) && errs.length) {
      const inner = errs.map(systemErrorCode).find(Boolean)
      if (inner) return inner
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

/** 拼一句人能看懂的原因，message 为空时退回系统码 */
export function describeFetchError(e: unknown): string {
  const sys = systemErrorCode(e)
  // 非 Error 的输入不能直接 String()：对象会变成「[object Object]」，
  // 比空字符串更没用
  const msg =
    e instanceof Error
      ? (e.cause instanceof Error && e.cause.message ? e.cause.message : e.message)
      : typeof e === 'string'
        ? e
        : ''
  if (sys && !msg.includes(sys)) return msg ? `${sys}（${msg}）` : sys
  return msg || '未知网络错误'
}

/** 系统码 → 下一步该做什么。不给提示的诊断只是把问题重述一遍。 */
export function hintFor(sys: string | null): string {
  switch (sys) {
    case 'ECONNREFUSED':
      return '服务没在监听 —— 本地模型确认 ollama serve 已启动，云端确认 baseUrl 正确'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析不了 —— 检查 baseUrl 拼写与 DNS'
    case 'EPERM':
    case 'EACCES':
      return '被网络策略拦下 —— 当前进程没有出网权限'
    case 'ECONNRESET':
      return '连接被对端重置 —— 可能是代理或 TLS 中间设备'
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return '证书校验失败 —— 检查系统时间与代理证书'
    default:
      return '检查 baseUrl、网络连通性与代理设置'
  }
}

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
