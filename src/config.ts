import { createHash } from 'node:crypto'
import type { ModelConfig } from './providers/types.js'
import type { AgentSpec } from './runtime/runner.js'
import type { McpServerConfig } from './mcp/protocol.js'
import type { McpRegisterOptions } from './mcp/registry.js'
import type { OAuthProviderDeclaration } from './auth/providers.js'

/**
 * 统一配置（DESIGN.md §12）。
 *
 * T3 能力边界（工具/MCP 白名单）活在这里 —— 它的载体不是规则文本，
 * 而是「给不给」，所以天然属于配置。
 *
 * **secrets 不进这里、不进 git**：只写 `apiKeyRef`（凭据引用名），
 * 值从环境变量 / keychain / 0600 文件解析。
 *
 * 注意 `apiKeyRef` 是历史命名，它引用的可能是 API key，
 * 也可能是 OAuth access token —— 两者在 HTTP 层都作为 Bearer 发送。
 * OpenAI 与 Grok 的订阅不发 API key，只能走 OAuth。
 */

export interface NucleusConfig {
  models: ModelConfig[]
  agents: AgentConfig[]
  /** MCP server 列表；部署与运行归用户，Nucleus 只负责连接 */
  mcp?: McpServerConfig[]
  /**
   * MCP 工具的副作用声明。
   * MCP 协议本身不表达副作用等级，但崩溃恢复完全依赖它 —— 必须显式配置。
   */
  mcpPolicies?: McpRegisterOptions
  /**
   * OAuth provider 声明。
   *
   * **必须自己提供 clientId** —— 内置只有端点模板（公开的协议事实），
   * 不含任何第三方产品的应用标识。借用别人的 clientId 等于把本程序
   * 声明成对方，配额与审计都记在人家头上。
   *
   * 不配置就用不了 OAuth；四家 provider 都支持 API key，OAuth 非必需。
   */
  oauthProviders?: Record<string, OAuthProviderDeclaration>
  defaults: {
    modelChain: string[]
    maxSteps: number
    maxCostUsd: number
  }
  runtime: {
    workerId: string
    leaseMs: number
    heartbeatMs: number
    workdirRoot: string
  }
  api: {
    bind: string
    port: number
  }
}

export interface AgentConfig {
  id: string
  /** 显示名 */
  name: string
  /** identity + policy 的正文；prefix 由它们拼成，必须逐字节稳定 */
  identity: string
  policy?: string
  modelChain?: string[]
  /** T3：能力边界。不在白名单里的工具模型根本看不到 */
  toolsAllow: string[]
  toolsDeny?: string[]
  capabilities?: Array<'research' | 'code'>
  /** 由启用的规则推导出的必填字段 */
  requiredFields?: string[]
  maxSteps?: number
  maxCostUsd?: number
}

/** 所有 agent 共享的运行时契约（prefix 第一段） */
export const RUNTIME_CONTRACT = `# 运行时契约
- 你在一个多 agent 编排系统中执行一次任务。
- 完成任务必须调用 submit_result；不要用纯文本结束。
- summary 只写结论与关键数据，完整内容写成 artifact 后在 artifacts 中引用。
- 只能使用下方列出的工具。工具被拒绝时，按返回的说明修正后重试。`

export function agentSpec(cfg: AgentConfig, defaults: NucleusConfig['defaults']): AgentSpec {
  const spec: AgentSpec = {
    id: cfg.id,
    systemPrompt: buildSystemPrompt(cfg),
    modelChain: cfg.modelChain ?? defaults.modelChain,
    toolsAllow: cfg.toolsAllow,
    maxSteps: cfg.maxSteps ?? defaults.maxSteps,
    maxCostUsd: cfg.maxCostUsd ?? defaults.maxCostUsd,
  }
  if (cfg.toolsDeny) spec.toolsDeny = cfg.toolsDeny
  if (cfg.capabilities || cfg.requiredFields) {
    spec.resultSpec = {
      ...(cfg.capabilities ? { capabilities: cfg.capabilities } : {}),
      ...(cfg.requiredFields ? { requiredFields: cfg.requiredFields } : {}),
    }
  }
  return spec
}

/**
 * 拼 system prompt。
 *
 * **只依赖 agent 定义，不含任何 run 状态** —— 这是缓存前缀能命中的前提。
 * identity 首行的 `# <id>` 同时被 mock provider 用来识别 agent。
 */
export function buildSystemPrompt(cfg: AgentConfig): string {
  return [RUNTIME_CONTRACT, `# ${cfg.id}\n${cfg.identity.trim()}`, cfg.policy?.trim()]
    .filter(Boolean)
    .join('\n\n')
}

/** config 指纹，写进 attempt 用于归因 */
export function configHash(cfg: NucleusConfig): string {
  const stable = {
    models: cfg.models.map((m) => ({ ...m, apiKeyRef: m.apiKeyRef ?? null })),
    agents: cfg.agents,
    defaults: cfg.defaults,
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16)
}

/** ollama 的默认端点；本地模型全部共用 */
export function ollamaBaseUrl(): string {
  return process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1'
}

/**
 * 为任意 `ollama:<模型名>` 动态生成配置。
 *
 * 本地模型换得勤（拉一个新的就想试），为每个都写一条配置不现实。
 * 只对 ollama 这么做 —— 它在本机、零成本、没有凭据，猜错了最多是一次
 * 「模型不存在」的报错；云端 provider 必须显式配置，否则拼错模型名
 * 会变成一次真实的付费调用。
 */
export function dynamicOllamaModel(key: string): ModelConfig | null {
  if (!key.startsWith('ollama:')) return null
  const model = key.slice('ollama:'.length)
  if (!model) return null
  return {
    key,
    provider: 'ollama',
    model,
    baseUrl: ollamaBaseUrl(),
    billing: 'usage',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
  }
}

/**
 * 模型表。
 *
 * 未显式配置的 `ollama:*` 动态生成，其余一律要求配置里有声明。
 *
 * 实现上包一层子类而不是改写实例方法 —— 后者会把动态模型 `set` 回
 * Map，而 config 常常是共享对象（模块级 `defaultConfig`），
 * 于是一次查询会污染其他调用方看到的模型表。
 */
class ModelRegistry extends Map<string, ModelConfig> {
  override get(key: string): ModelConfig | undefined {
    return super.get(key) ?? dynamicOllamaModel(key) ?? undefined
  }

  override has(key: string): boolean {
    return super.has(key) || dynamicOllamaModel(key) !== null
  }
}

export function modelMap(cfg: NucleusConfig): Map<string, ModelConfig> {
  return new ModelRegistry(cfg.models.map((m) => [m.key, m] as const))
}

export function agentMap(cfg: NucleusConfig): Map<string, AgentSpec> {
  return new Map(cfg.agents.map((a) => [a.id, agentSpec(a, cfg.defaults)]))
}

/** 从 env 取密钥。config 里只有 ref。 */
export function envSecrets(ref: string | undefined): string | null {
  if (!ref) return null
  return process.env[ref] ?? null
}

// ─────────────────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────────────────

export const defaultConfig: NucleusConfig = {
  models: [
    // ── 你的订阅模型 ────────────────────────────────────
    // 全部为订阅制（月费已付），单次调用无边际成本 ——
    // 真正的约束是配额与限流，不是 token 单价。
    // 上下文窗口留空表示未知：宁可不填，也不编造数字。
    {
      key: 'zai:glm-5.2',
      provider: 'zai',
      model: 'glm-5.2',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      api: 'openai-completions',
      // GLM 订阅提供 API key
      apiKeyRef: 'ZAI_API_KEY',
      billing: 'subscription',
      subscriptionUsdPerMonth: 30,
    },
    {
      // 订阅制**不发 API key**，只能走 OAuth：
      //   nucleus auth login OPENAI_OAUTH --oauth --provider openai
      // 凭据里存的是 access token，运行时按 Bearer 发送（与 key 同形）
      key: 'openai:gpt-5.6-sol',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      apiKeyRef: 'OPENAI_OAUTH',
      billing: 'subscription',
      subscriptionUsdPerMonth: 20,
    },
    {
      // 同 OpenAI：订阅制无 API key，走 OAuth
      //   nucleus auth login XAI_OAUTH --oauth --provider xai
      key: 'xai:grok-4.5',
      provider: 'xai',
      model: 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      api: 'openai-completions',
      apiKeyRef: 'XAI_OAUTH',
      billing: 'subscription',
      subscriptionUsdPerMonth: 30,
    },
    {
      // Kimi 的 coding 端点走 anthropic-messages 协议，不是 OpenAI 兼容
      key: 'kimi:k3',
      provider: 'kimi',
      model: 'k3',
      baseUrl: 'https://api.kimi.com/coding',
      api: 'anthropic-messages',
      // Kimi 订阅提供 API key
      apiKeyRef: 'KIMI_API_KEY',
      billing: 'subscription',
      subscriptionUsdPerMonth: 39,
      maxTokens: 32768,
    },

    // ── 本地与测试 ──────────────────────────────────────
    {
      key: 'mock:local',
      provider: 'mock',
      model: 'mock',
      baseUrl: 'http://mock.invalid/v1',
      billing: 'usage',
      costPerMTokIn: 0,
      costPerMTokOut: 0,
    },
    // 本地 ollama 模型。
    //
    // `ollama:<任意模型名>` 会被动态解析（见 modelMap），不必为每个
    // 本地模型写一条配置 —— 本地模型换得勤，写死会一直追着改。
    //   nucleus chat --model ollama:gemma3
    //   nucleus ask "..." --model ollama:deepseek-r1:7b
    {
      key: 'ollama:llama',
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1',
      billing: 'usage',
      costPerMTokIn: 0,
      costPerMTokOut: 0,
    },

    // ── 按量计费的备选（有可靠单价数据）────────────────
    {
      key: 'zai:glm-4.7',
      provider: 'zai',
      model: 'glm-4.7',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      api: 'openai-completions',
      apiKeyRef: 'ZAI_API_KEY',
      billing: 'usage',
      rpm: 60,
      costPerMTokIn: 0.6,
      costPerMTokOut: 2.2,
      costPerMTokCacheRead: 0.11,
      contextWindow: 204_800,
      maxTokens: 131_072,
    },
  ],
  agents: [
    {
      id: 'orchestrator',
      name: '编排者',
      identity: `你是编排者，用户的唯一入口。
理解需求 → 拆解 → 委派给专家 → 整合结果。
你自己不执行具体工作，一律委派。`,
      // T3：只有 delegate，没有 exec/write —— 物理上无法自己动手
      toolsAllow: ['delegate'],
    },
    {
      id: 'researcher',
      name: '研究员',
      identity: `你是研究专家，负责调研与信息收集。
结论必须标注来源。`,
      toolsAllow: ['web_search', 'write_report'],
      capabilities: ['research'],
      requiredFields: ['findings[].sources'],
    },
    {
      id: 'operator',
      name: '执行者',
      identity: `你是执行专家，负责脚本执行与文件操作。
限制输出规模，只返回关键信息。`,
      toolsAllow: ['read_file', 'write_file'],
    },
  ],
  defaults: {
    // 全订阅制，切换不产生额外费用 —— fallback 链可以放宽
    modelChain: ['zai:glm-5.2', 'kimi:k3', 'openai:gpt-5.6-sol', 'xai:grok-4.5'],
    maxSteps: 12,
    maxCostUsd: 1.0,
  },
  // MCP server 列表。部署与运行归用户；这里只声明怎么连。
  // 密钥用 envRefs 引用凭据，不写明文。示例：
  //   { id: 'searxng', transport: 'stdio', command: 'npx',
  //     args: ['-y', 'mcp-searxng'], env: { SEARXNG_URL: 'http://localhost:8888' } },
  //   { id: 'finnhub', transport: 'stdio', command: 'npx',
  //     args: ['-y', 'finnhub-mcp'], envRefs: { FINNHUB_API_KEY: 'FINNHUB_API_KEY' } },
  //   { id: 'web-search-prime', transport: 'http',
  //     url: 'https://api.z.ai/api/mcp/web_search_prime/mcp' },
  mcp: [],
  mcpPolicies: {
    policies: [
      // 只读检索类：崩溃后可安全重跑
      { pattern: 'searxng__*', sideEffect: 'pure' },
      { pattern: 'web-search-prime__*', sideEffect: 'pure' },
      { pattern: 'yfinance__*', sideEffect: 'pure' },
      { pattern: 'alphavantage__*', sideEffect: 'pure' },
      { pattern: 'finnhub__*', sideEffect: 'pure' },
      { pattern: 'postgres__list_*', sideEffect: 'pure' },
      { pattern: 'postgres__describe_*', sideEffect: 'pure' },
      // 写入类：同键重放结果一致
      { pattern: 'memory__*', sideEffect: 'idempotent' },
    ],
    // 未匹配的一律按不可幂等处理：宁可事后人工确认，也不要自动重发
    fallback: 'non_idempotent',
    maxOutputChars: 8_000,
  },
  runtime: {
    workerId: 'local-1',
    leaseMs: 60_000,
    heartbeatMs: 15_000,
    workdirRoot: process.env['NUCLEUS_WORKDIR'] ?? '/tmp/nucleus',
  },
  api: {
    bind: process.env['NUCLEUS_BIND'] ?? '127.0.0.1',
    port: Number(process.env['NUCLEUS_PORT'] ?? 8787),
  },
}
