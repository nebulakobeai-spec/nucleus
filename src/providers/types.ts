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
  /**
   * 推理模型的思考过程（如 gemma4 / deepseek-r1）。
   *
   * **刻意与 content 分开**：Gemma 4 的最佳实践明确要求多轮对话的历史里
   * 不能包含 thinking 内容。放进 content 就会被存入会话并在下一轮回放，
   * 违反这条规范且浪费 context。
   *
   * 只用于可观测（写入 run_events），永不进入会话历史。
   */
  reasoning?: string
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

/**
 * 线路协议。
 *
 * 不是所有 provider 都是 OpenAI 兼容形态 —— Kimi 的 coding 端点和
 * Anthropic 官方 API 用的是 messages 协议，请求体、流式事件、usage
 * 字段全都不同，必须走独立适配器。
 */
export type WireApi = 'openai-completions' | 'anthropic-messages'

/**
 * 计费方式。
 *
 * 订阅制下按 token 算钱没有意义（月费已付），真正的约束是配额与限流。
 * 成本显示为「订阅」而非 $0 —— 后者看起来像数据缺失。
 */
export type Billing = 'usage' | 'subscription'

export interface ModelConfig {
  /** 'provider:model'，全系统唯一键 */
  key: string
  provider: string
  model: string
  baseUrl: string
  /** 默认 openai-completions */
  api?: WireApi
  /** 默认 usage */
  billing?: Billing
  /** 订阅月费，仅用于展示 */
  subscriptionUsdPerMonth?: number
  /** anthropic-messages 专用 */
  anthropicVersion?: string
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

/**
 * 单次调用的边际成本。
 *
 * 订阅制返回 0 —— 这一次调用确实不产生额外费用。
 * 但**不要**把它当作「免费」展示：用 `isSubscription()` 区分，
 * UI 显示「订阅」而不是 $0（见 DATA-INTEGRITY：不编造数字，
 * 也不让真实的 0 被误读成数据缺失）。
 */
export function costOf(cfg: ModelConfig, u: Usage): number {
  if (cfg.billing === 'subscription') return 0
  const m = 1_000_000
  return (
    ((u.tokensIn - u.cacheRead) * (cfg.costPerMTokIn ?? 0)) / m +
    (u.cacheRead * (cfg.costPerMTokCacheRead ?? cfg.costPerMTokIn ?? 0)) / m +
    (u.tokensOut * (cfg.costPerMTokOut ?? 0)) / m
  )
}

export function isSubscription(cfg: ModelConfig): boolean {
  return cfg.billing === 'subscription'
}

/** 是否有可用的单价数据；没有就不该显示金额 */
export function hasPricing(cfg: ModelConfig): boolean {
  return cfg.costPerMTokIn !== undefined || cfg.costPerMTokOut !== undefined
}
