/**
 * Provider 抽象。
 *
 * 四家目标（Kimi / GLM / OpenAI / Grok）以及本地 ollama 全部是
 * OpenAI 兼容形态，所以只有一个 client 实现 + 一张配置表，不做多态抽象层。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ChatMessage {
  role: Role
  content: string
  /** assistant 发起的工具调用 */
  toolCalls?: ToolCall[]
  /** role='tool' 时，对应哪次调用 */
  toolCallId?: string
  name?: string
}

export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串；解析失败也要保留原文用于诊断 */
  arguments: string
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  temperature?: number
  maxTokens?: number
  /** 流式增量回调；提供即启用流式 */
  onDelta?: (chunk: StreamDelta) => void
  signal?: AbortSignal
}

export interface StreamDelta {
  /** 文本增量 */
  text?: string
  /** 工具调用参数增量（按 index 累积） */
  toolCallDelta?: { index: number; id?: string; name?: string; arguments?: string }
}

export interface Usage {
  tokensIn: number
  tokensOut: number
  cacheRead: number
}

export interface ChatResponse {
  content: string
  toolCalls: ToolCall[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'aborted' | 'other'
  usage: Usage
  model: string
  /** 从响应头学到的限流信息，写入 provider_state */
  rateLimit?: RateLimitInfo
  /** 端到端耗时 */
  latencyMs: number
}

export interface RateLimitInfo {
  remainingRequests?: number
  remainingTokens?: number
  /** 何时重置（绝对时间戳 ms） */
  resetAt?: number
  /** 429 时服务端要求等待多久 */
  retryAfterMs?: number
}

export interface Provider {
  readonly id: string
  chat(req: ChatRequest): Promise<ChatResponse>
}

// ── 配置 ────────────────────────────────────────────────

export interface ModelConfig {
  /** 'provider:model'，全系统唯一键 */
  key: string
  provider: string
  model: string
  baseUrl: string
  /** env 变量名；值不进 config、不进 git */
  apiKeyRef?: string
  /** 每分钟请求数上限；无 rate-limit 响应头的家靠这个本地令牌桶 */
  rpm?: number
  /** 每分钟 token 上限 */
  tpm?: number
  costPerMTokIn?: number
  costPerMTokOut?: number
  costPerMTokCacheRead?: number
  contextWindow?: number
  maxTokens?: number
  supportsTools?: boolean
}

export function costOf(cfg: ModelConfig, u: Usage): number {
  const m = 1_000_000
  return (
    ((u.tokensIn - u.cacheRead) * (cfg.costPerMTokIn ?? 0)) / m +
    (u.cacheRead * (cfg.costPerMTokCacheRead ?? cfg.costPerMTokIn ?? 0)) / m +
    (u.tokensOut * (cfg.costPerMTokOut ?? 0)) / m
  )
}
