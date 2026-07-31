import { NucleusError } from '../errors.js'
import type { Clock } from '../seams.js'
import type { FetchLike } from './openai-compat.js'
import type {
  ChatRequest,
  ChatResponse,
  ModelConfig,
  Provider,
  RateLimitInfo,
  ToolCall,
  Usage,
} from './types.js'

/**
 * Anthropic Messages 协议适配器。
 *
 * 覆盖两类端点：
 *  - Anthropic 官方 API（`x-api-key` + `anthropic-version`）
 *  - Kimi 的 coding 端点（`api.kimi.com/coding/`，同协议，Bearer 鉴权）
 *
 * 与 OpenAI 形态的实质差异（不是换个 URL 就行）：
 *  - system 是顶层字段，不是 messages 里的一条
 *  - content 是 block 数组；工具调用是 `tool_use` block
 *  - 工具结果作为 user 消息里的 `tool_result` block 回灌
 *  - 流式事件语义完全不同（工具参数走 `input_json_delta`）
 *  - usage 字段名不同，且缓存命中单独计
 */
export class AnthropicProvider implements Provider {
  readonly id: string
  #fetch: FetchLike
  #clock: Clock
  #timeoutMs: number

  constructor(
    private cfg: ModelConfig,
    private apiKey: string | null,
    opts: { fetch?: FetchLike; clock: Clock; timeoutMs?: number },
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
      res = await this.#fetch(this.#endpoint(), {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      if (req.signal?.aborted) throw new NucleusError('runtime.cancelled', '请求已取消', { cause: e })
      const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)
      throw new NucleusError('provider.timeout', `请求 ${this.cfg.key} 失败：${why}`, {
        cause: e,
        detail: { reason: why },
      })
    }

    const rateLimit = parseAnthropicRateLimit(res.headers, this.#clock.now())

    if (!res.ok) {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      throw await this.#toError(res, rateLimit)
    }

    try {
      const out = stream ? await this.#readStream(res, req) : await this.#readJson(res)
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

  #endpoint(): string {
    const base = this.cfg.baseUrl.replace(/\/$/, '')
    return base.endsWith('/v1/messages') ? base : `${base}/v1/messages`
  }

  /**
   * 鉴权头。
   *
   * 官方 API 用 `x-api-key`；Kimi 的 coding 端点用 `Authorization: Bearer`。
   * 两个都发是安全的 —— 服务端只认自己那个，多余的会被忽略。
   */
  #headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': this.cfg.anthropicVersion ?? '2023-06-01',
    }
    if (this.apiKey) {
      h['x-api-key'] = this.apiKey
      h['authorization'] = `Bearer ${this.apiKey}`
    }
    return h
  }

  #buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    // system 是顶层字段 —— 这是与 OpenAI 形态最容易踩的差异
    const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content)
    const rest = req.messages.filter((m) => m.role !== 'system')

    const messages: Array<Record<string, unknown>> = []
    for (const m of rest) {
      if (m.role === 'tool') {
        // 工具结果是 user 消息里的 tool_result block；
        // 连续的工具结果要合并进同一条 user 消息，否则会被拒
        const block = {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: m.content,
        }
        const last = messages[messages.length - 1]
        if (last && last['role'] === 'user' && Array.isArray(last['content'])) {
          ;(last['content'] as unknown[]).push(block)
        } else {
          messages.push({ role: 'user', content: [block] })
        }
        continue
      }

      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: unknown[] = []
        if (m.content) content.push({ type: 'text', text: m.content })
        for (const t of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: t.id,
            name: t.name,
            input: safeParse(t.arguments),
          })
        }
        messages.push({ role: 'assistant', content })
        continue
      }

      // Anthropic 不接受空内容的消息
      messages.push({ role: m.role, content: m.content || '(empty)' })
    }

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      // max_tokens 是**必填**，缺了直接 400
      max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? 8192,
    }
    if (systemParts.length) body['system'] = systemParts.join('\n\n')
    if (req.temperature !== undefined) body['temperature'] = req.temperature
    if (stream) body['stream'] = true

    if (req.tools?.length) {
      body['tools'] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
      if (req.toolChoice) {
        body['tool_choice'] =
          typeof req.toolChoice === 'string'
            ? req.toolChoice === 'required'
              ? { type: 'any' }
              : { type: req.toolChoice === 'none' ? 'none' : 'auto' }
            : { type: 'tool', name: req.toolChoice.name }
      }
    }
    return body
  }

  async #readJson(res: Response): Promise<Omit<ChatResponse, 'model' | 'latencyMs'>> {
    const j = (await res.json()) as AnthropicMessage
    let text = ''
    const toolCalls: ToolCall[] = []

    for (const block of j.content ?? []) {
      if (block.type === 'text') text += block.text ?? ''
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `call_${toolCalls.length}`,
          name: block.name ?? '',
          arguments: JSON.stringify(block.input ?? {}),
        })
      }
    }

    return {
      content: text,
      toolCalls,
      finishReason: mapStopReason(j.stop_reason),
      usage: mapUsage(j.usage),
    }
  }

  /**
   * 流式解析。
   *
   * 事件序列：message_start → content_block_start → content_block_delta*
   *          → content_block_stop → message_delta → message_stop
   *
   * 工具参数走 `input_json_delta`，按 block index 累积 —— 与 OpenAI 的
   * `tool_calls[].function.arguments` 分片是完全不同的形状。
   */
  async #readStream(res: Response, req: ChatRequest): Promise<Omit<ChatResponse, 'model' | 'latencyMs'>> {
    if (!res.body) throw new NucleusError('provider.server_error', '流式响应没有 body')

    let text = ''
    let stopReason: string | undefined
    let usage: Usage = { tokensIn: 0, tokensOut: 0, cacheRead: 0 }
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const lineRaw = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const line = lineRaw.trim()
        if (!line.startsWith('data:')) continue

        let ev: AnthropicStreamEvent
        try {
          ev = JSON.parse(line.slice(5).trim()) as AnthropicStreamEvent
        } catch {
          continue
        }

        switch (ev.type) {
          case 'message_start':
            if (ev.message?.usage) usage = mapUsage(ev.message.usage)
            break

          case 'content_block_start': {
            const b = ev.content_block
            if (b) {
              blocks.set(ev.index ?? 0, {
                type: b.type ?? 'text',
                id: b.id ?? '',
                name: b.name ?? '',
                json: '',
              })
            }
            break
          }

          case 'content_block_delta': {
            const d = ev.delta
            const idx = ev.index ?? 0
            if (d?.type === 'text_delta' && d.text) {
              text += d.text
              req.onDelta?.({ text: d.text })
            } else if (d?.type === 'input_json_delta' && d.partial_json !== undefined) {
              const b = blocks.get(idx)
              if (b) {
                b.json += d.partial_json
                req.onDelta?.({
                  toolCallDelta: { index: idx, id: b.id, name: b.name, arguments: d.partial_json },
                })
              }
            }
            break
          }

          case 'message_delta':
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
            // 输出 token 只在这里给最终值
            if (ev.usage?.output_tokens !== undefined) usage.tokensOut = ev.usage.output_tokens
            break
        }
      }
    }

    const toolCalls: ToolCall[] = [...blocks.entries()]
      .filter(([, b]) => b.type === 'tool_use')
      .sort((a, b) => a[0] - b[0])
      .map(([i, b]) => ({
        id: b.id || `call_${i}`,
        name: b.name,
        // 空 json 要给 {}，否则上层 JSON.parse 失败
        arguments: b.json || '{}',
      }))

    return {
      content: text,
      toolCalls,
      finishReason: mapStopReason(stopReason ?? (toolCalls.length ? 'tool_use' : 'end_turn')),
      usage,
    }
  }

  async #toError(res: Response, rl: RateLimitInfo | undefined): Promise<NucleusError> {
    const text = await res.text().catch(() => '')
    const detail = { status: res.status, body: text.slice(0, 2000) }

    if (res.status === 401 || res.status === 403) {
      return new NucleusError('provider.auth_failed', `${this.cfg.key} 鉴权失败`, { detail })
    }
    if (res.status === 429) {
      // 订阅制的额度耗尽与瞬时限流要分开：前者要熔断到周期恢复
      const exhausted = /quota|usage limit|credit balance|exceeded your current/i.test(text)
      return new NucleusError(
        exhausted ? 'provider.quota_exhausted' : 'provider.rate_limited',
        exhausted ? `${this.cfg.key} 额度用尽` : `${this.cfg.key} 被限流`,
        { detail, retryAfterMs: rl?.retryAfterMs ?? null },
      )
    }
    if (res.status === 529) {
      // Anthropic 的过载信号
      return new NucleusError('provider.server_error', `${this.cfg.key} 过载`, { detail })
    }
    if (res.status >= 500) {
      return new NucleusError('provider.server_error', `${this.cfg.key} 服务异常`, { detail })
    }
    return new NucleusError('provider.bad_request', `${this.cfg.key} 拒绝请求`, { detail })
  }
}

// ── 响应类型 ─────────────────────────────────────────────

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicMessage {
  content?: AnthropicBlock[]
  stop_reason?: string
  usage?: AnthropicUsage
}

interface AnthropicStreamEvent {
  type?: string
  index?: number
  message?: { usage?: AnthropicUsage }
  content_block?: AnthropicBlock
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: AnthropicUsage
}

function mapUsage(u: AnthropicUsage | undefined): Usage {
  return {
    // input_tokens 不含缓存命中部分，要加回来才是总输入
    tokensIn: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
    tokensOut: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
  }
}

function mapStopReason(r: string | undefined): ChatResponse['finishReason'] {
  switch (r) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    case 'refusal':
      return 'content_filter'
    default:
      return 'other'
  }
}

export function parseAnthropicRateLimit(h: Headers, nowMs: number): RateLimitInfo | undefined {
  const info: RateLimitInfo = {}
  const num = (k: string): number | undefined => {
    const v = h.get(k)
    if (v == null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }

  const rr = num('anthropic-ratelimit-requests-remaining')
  const rt = num('anthropic-ratelimit-tokens-remaining')
  if (rr !== undefined) info.remainingRequests = rr
  if (rt !== undefined) info.remainingTokens = rt

  const reset =
    h.get('anthropic-ratelimit-requests-reset') ?? h.get('anthropic-ratelimit-tokens-reset')
  if (reset) {
    const at = Date.parse(reset)
    if (!Number.isNaN(at)) info.resetAt = at
  }

  const ra = h.get('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs)) info.retryAfterMs = secs * 1000
  }

  return Object.keys(info).length ? info : undefined
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
