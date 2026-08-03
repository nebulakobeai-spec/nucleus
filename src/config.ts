import { createHash } from 'node:crypto'
import type { Permission } from './runtime/permissions.js'
import type { ResultFields } from './runtime/result-schema.js'
import type { ModelConfig } from './providers/types.js'
import type { ProviderConfig } from './providers/registry.js'
import {
  constraintsForAgent,
  denyToolsForAgent,
  requiredFieldsForAgent,
  type UserRule,
} from './runtime/user-rules.js'
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
  /**
   * Provider 定义 —— 端点、协议、凭据引用、账号级限流。
   *
   * 与 models 分开是因为**同一个模型跑在不同 provider 上是常态**
   * （anthropic 的 opus-5、openrouter 的 kimi-k3、ollama 的 kimi-k3）。
   * 合在一起就得把 baseUrl / apiKeyRef 抄好几遍，而抄漏一处**不会报错** ——
   * 只会在调用时 401，那时你会去查凭据，不会想到是配置抄漏了。
   *
   * 留空也能跑：models 里直接写 baseUrl 即可（旧写法照旧有效）。
   */
  providers?: Record<string, ProviderConfig>
  /**
   * 模型清单。
   *
   * provider 级字段（baseUrl / api / apiKeyRef / rpm …）可以省略 ——
   * 从 `providers[provider]` 取；写了就覆盖。同一 provider 下某个模型走不同
   * 端点是真实存在的（比如 Kimi 的 coding 端点），所以是「默认 + 覆盖」
   * 而不是「二选一」。
   */
  models: ModelConfig[]
  agents: AgentConfig[]
  /**
   * 用户自己写的规则（来自 `rules/*.md`）。
   *
   * 不在 JSON 里声明 —— 与 agents 同样的理由：T1 正文是改得最勤的东西，
   * 写在 JSON 里是转义串，diff 读不出改了什么。
   */
  rules?: UserRule[]
  /** 规则目录，默认 `rules/` */
  rulesDir?: string | null
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
  /**
   * 专家定义所在目录，默认 `agents/`。
   *
   * 给「某个专家只想在某台机器上有」留的口子；也可以用
   * NUCLEUS_AGENTS_DIR 覆盖。
   */
  agentsDir?: string
  defaults: {
    modelChain: string[]
    maxSteps: number
    maxCostUsd: number
    /**
     * 未声明 contextWindow 的模型按这个值做预算。
     *
     * 为什么不给每个模型编一个数：窗口大小是模型的事实，不知道就该留空
     * （config.ts 一贯的规矩：宁可不填，不编造数字）。但预算总得有个数，
     * 所以把「假设」显式命名在这里，而不是散落在代码里的魔数。
     *
     * 宁可偏小 —— 假设偏小只是历史被多裁一点，假设偏大会直接溢出，
     * 而 ollama 的默认 num_ctx 常常只有 4096。
     */
    assumedContextWindow: number
    /**
     * 一个 run 最多几次 attempt（含首次）。
     *
     * 超过就落 terminal failed 而不再重试 —— 无限重试会把「模型一直答不对」
     * 变成「任务永远不结束」，那比失败更糟。
     */
    maxAttempts: number
    /** 重试退避基数与上限 */
    retryBaseMs: number
    retryCapMs: number
    /**
     * 委派链的最大深度。编排者是 0，它派出的专家是 1。
     *
     * 没有这道闸门时，只要有一个 agent 能委派给自己（或形成环），
     * 就会造出一串永远不终态的 run —— 实测 95 个 run 全停在
     * waiting_children/pending，用户看到的就是「任务永远不动」。
     * 长驻 worker 下更糟：它不会停，会一直派下去烧真钱。
     */
    maxDelegationDepth: number
    /**
     * 一棵 run 树的总 run 数上限。
     *
     * 深度之外还要防扇出爆炸：一次回复里派 50 个专家，深度只有 1，
     * 但同样会把队列灌满、把预算烧光。
     */
    maxRunsPerRoot: number
    /**
     * 用户提问时由哪个 agent 接手。
     *
     * 必须显式存在于 `agents` 里 —— 否则每个任务都会在运行时才失败。
     * 之前 `ask` 硬编码 `orchestrator` 而 `chat` 取 `agents[0]`，
     * 同一份配置两条命令行为不同；这里统一成一个来源。
     */
    entryAgent: string
  }
  runtime: {
    /**
     * 是否记录 transcript（发给模型的完整消息 + 模型的回复）。
     *
     * **默认开**。理由：出问题之后再想开启就来不及了 —— 而这恰恰是
     * 「模型为什么那么做」唯一的证据。代价是数据库变大，用
     * transcriptMaxChars 控制单条上限。
     */
    captureTranscripts?: boolean
    /** 单条 transcript 的字符上限，超出截断并标记 */
    transcriptMaxChars?: number
    /**
     * 什么时候压缩会话历史。
     *
     * 放进配置而不是写死，是因为默认阈值在大窗口模型上非常高 ——
     * 131k 窗口下要 28000 tokens 的历史才触发，也就是四五十轮。
     * 那意味着**这个功能在真实使用中很久都不会被执行到**，
     * 而没被执行过的代码路径不能算验证过。调低它是评估压缩质量的唯一办法。
     */
    compact?: {
      /** 历史占预算的比例超过它就压缩。默认 0.7 */
      triggerRatio?: number
      /**
       * 保留最近多少 **token** 的原文（占历史预算的比例）。默认 0.3。
       *
       * 按 token 而不是条数：一条粘贴的日志可能顶几十条对话，
       * 「最近 10 条」在那种情况下能占满整个窗口。
       */
      keepRecentRatio?: number
      /** 无论如何至少保留几条原文。默认 2 —— 「上一句刚说了什么」不能只剩摘要 */
      keepRecentMin?: number
      /**
       * 要退役的 **token** 少于这个值就不压。默认 2000。
       *
       * 值不值得调一次模型（以及付出一次不可逆的信息损失）取决于省多少 token，
       * 与条数无关：退役 3 条小消息省不下什么，退役 1 条巨大的日志能省很多。
       */
      minRetireTokens?: number
    }
    /**
     * 单次模型请求的超时（毫秒），可被 model 上的 `timeoutMs` 覆盖。
     *
     * 之前这个值**硬编码在 openai-compat 里是 120 秒，而且 boot 从来不传** ——
     * 又一处「声明了但没接线」（RouterOptions.timeoutMs 一直存在）。
     * 实测后果：gemma4:31b 写一份调研报告超过 120 秒 → provider.timeout →
     * 因为它是 runRetryable，任务进 waiting_retry 再跑一遍，花两倍时间后
     * 同样超时。
     */
    requestTimeoutMs?: number
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
  /**
   * 一句话说清**什么时候该派给它**。
   *
   * 与 identity 的区别很要紧：identity 是第二人称、给这个 agent 自己读的
   * （「你是研究专家…」）；whenToUse 是第三人称、给**编排者**读的选路依据。
   *
   * 没有它的时候，编排者只能看到 agent 的 id 字符串去猜派给谁 ——
   * `researcher` 这种英文常用词还能猜对，加一个 `reviewer` 或两个相近的
   * （`web-researcher` / `data-analyst`）就会派错。这不是可视化问题，
   * 是编排质量问题。
   */
  whenToUse?: string
  /** identity + policy 的正文；prefix 由它们拼成，必须逐字节稳定 */
  identity: string
  policy?: string
  modelChain?: string[]
  /**
   * 授予的权限 —— T3 能力边界的**主关**。
   *
   * 工具声明自己需要什么权限，这里授予权限。新接一个会写文件的 MCP 工具时，
   * 没有 `write` 的 agent 自动看不到它，配置一个字都不用改。
   * 空数组 = 没有任何工具（fail closed），但仍然可以直接 submit_result 作答。
   */
  permissions?: Permission[]
  /**
   * 按名字**收窄**（可选）。
   *
   * 用于「给了 read，但只许用 postgres 那个读，不许读文件」。
   * 与权限是**与**关系：名字在这里但权限没给，依然看不到；反之亦然。
   * 不填表示不收窄。
   */
  toolsAllow?: string[]
  toolsDeny?: string[]
  /**
   * 结果 schema 的附加段（research → findings[].sources 等）。
   *
   * 注意这与上面的 `permissions` 是两件事：它决定**要交出什么**，
   * 不决定**允许做什么**。名字里的「capabilities」是历史遗留，
   * 语义上更接近「结果类型」。
   */
  capabilities?: Array<'research' | 'code'>
  /**
   * 自己声明的结果字段。
   *
   * 内置预设（research / code）只是用**同一套词表**写的两个例子 ——
   * 一个金融分析专家可以要求交出
   * `metrics: { type: 'object[]', fields: { name: 'string', value: 'number',
   * asOf: 'string', source: 'string' } }`，不必迁就那两个预设。
   *
   * 声明只描述**形状**；哪些必填由 requiredFields 决定（两处都能要求必填
   * 会让「为什么这里报错」变得难说清）。
   */
  resultFields?: ResultFields
  /** 由启用的规则推导出的必填字段 */
  requiredFields?: string[]
  maxSteps?: number
  maxCostUsd?: number
  /**
   * 单次调用的输出上限。留空则用 provider 默认。
   *
   * **推理模型要给足** —— 思考过程消耗这份预算，不够会在给出答案前
   * 被截断（错误码 provider.output_truncated）。
   */
  maxTokens?: number
}

/** 所有 agent 共享的运行时契约（prefix 第一段） */
export const RUNTIME_CONTRACT = `# 运行时契约
- 你在一个多 agent 编排系统中执行一次任务。
- 完成任务必须调用 submit_result；不要用纯文本结束。
- summary 只写结论与关键数据，完整内容写成 artifact 后在 artifacts 中引用。
- 只能使用下方列出的工具。工具被拒绝时，按返回的说明修正后重试。`

export function agentSpec(
  cfg: AgentConfig,
  defaults: NucleusConfig['defaults'],
  /**
   * 用户规则。三层在这里落地：
   *  T3 → 合并进 toolsDeny（工具根本不出现在模型看到的定义里）
   *  T2 → 合并进 requiredFields（缺字段就退回让它重写）
   *  T1 → **不在这里** —— 它是每回合装配 context 时注入末尾约束块的，
   *       放进 systemPrompt 会破坏缓存前缀的逐字节稳定性
   */
  rules: UserRule[] = [],
): AgentSpec {
  const spec: AgentSpec = {
    id: cfg.id,
    systemPrompt: buildSystemPrompt(cfg),
    modelChain: cfg.modelChain ?? defaults.modelChain,
    permissions: cfg.permissions ?? [],
    maxSteps: cfg.maxSteps ?? defaults.maxSteps,
    maxCostUsd: cfg.maxCostUsd ?? defaults.maxCostUsd,
  }
  if (cfg.maxTokens !== undefined) spec.maxTokens = cfg.maxTokens
  if (cfg.toolsAllow) spec.toolsAllow = cfg.toolsAllow

  // T3：规则禁掉的工具与 agent 自己的 toolsDeny 合并
  const ruleDeny = denyToolsForAgent(rules, cfg.id)
  const deny = [...new Set([...(cfg.toolsDeny ?? []), ...ruleDeny])]
  if (deny.length) spec.toolsDeny = deny

  // T2：规则要求的必填字段与 agent 自己声明的合并
  const ruleRequired = requiredFieldsForAgent(rules, cfg.id)
  const required = [...new Set([...(cfg.requiredFields ?? []), ...ruleRequired])]
  if (cfg.capabilities || required.length || cfg.resultFields) {
    spec.resultSpec = {
      ...(cfg.capabilities ? { capabilities: cfg.capabilities } : {}),
      ...(cfg.resultFields ? { fields: cfg.resultFields } : {}),
      ...(required.length ? { requiredFields: required } : {}),
    }
  }

  // T1：交给 runner 在装配时注入末尾约束块。放进 systemPrompt 会破坏缓存前缀
  const constraints = constraintsForAgent(rules, cfg.id)
  if (constraints.length) spec.constraints = constraints

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

/**
 * 当前模型链是否一个真实模型都没有。
 *
 * 因为代码里不内置任何真实模型，没配置就会落到 mock 上 —— 而 mock 的
 * 回答是**假的**。把假答案当真是这里最严重的失败模式，所以 doctor 与
 * chat/ask 的开头都要显著提示，而不是让人从模型名去推断。
 */
export function isMockOnly(cfg: NucleusConfig): boolean {
  const chain = cfg.defaults.modelChain
  if (chain.length === 0) return true
  return chain.every((k) => k === 'mock:local' || k.startsWith('mock:'))
}

export function modelMap(cfg: NucleusConfig): Map<string, ModelConfig> {
  return new ModelRegistry(cfg.models.map((m) => [m.key, m] as const))
}

export function agentMap(cfg: NucleusConfig): Map<string, AgentSpec> {
  // 规则从 cfg 上取 —— 三层在 agentSpec 里落地
  return new Map(cfg.agents.map((a) => [a.id, agentSpec(a, cfg.defaults, cfg.rules ?? [])]))
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
  /**
   * 模型列表。
   *
   * **刻意只有 mock 一个。** 任何真实模型都必须由使用者自己声明 ——
   * 把某几个云端模型写进代码等于把作者的订阅和取舍强加给所有人，
   * 而 provider、单价、计费方式、端点都随时间变。
   *
   * 在哪里配：项目根目录的 `nucleus.config.json`（`nucleus.config.example.json`
   * 是可直接复制的模板）。也可以用 NUCLEUS_CONFIG 指向别处。
   *
   * 两个例外，都不是「默认模型」：
   *  - `mock:local` 是测试替身，不联网、不需要凭据、输出显然是假的，
   *    `nucleus verify` 的离线冒烟靠它。
   *  - `ollama:<任意模型名>` 动态解析（见 ModelRegistry），因为本地模型
   *    在本机、零成本、无凭据，猜错最多报「模型不存在」。
   */
  models: [
    {
      key: 'mock:local',
      provider: 'mock',
      model: 'mock',
      baseUrl: 'http://mock.invalid/v1',
      billing: 'usage',
      costPerMTokIn: 0,
      costPerMTokOut: 0,
    },
  ],
  agents: [
    {
      id: 'orchestrator',
      name: '编排者',
      whenToUse: '用户的入口，不作为委派目标',
      identity: `你是编排者，用户的唯一入口。
理解需求 → 拆解 → 委派给专家 → 整合结果。
你自己不执行具体工作，一律委派。`,
      // 只有 delegate 与 user：物理上无法自己读写或执行
      permissions: ['delegate', 'user'],
    },
  ],
  defaults: {
    entryAgent: 'orchestrator',
    assumedContextWindow: 32_768,
    maxAttempts: 4,
    retryBaseMs: 2_000,
    // 等一小时不如报给人
    retryCapMs: 5 * 60_000,
    // 3 层足够「编排者 → 专家 → 子专家」，再深通常是模型在兜圈子
    maxDelegationDepth: 3,
    maxRunsPerRoot: 32,
    /**
     * 降级链，按顺序尝试。
     *
     * 默认只有 mock —— **它不会调用任何真实模型，回答是假的**。
     * doctor 与 chat/ask 的开头都会显著提示这件事，避免有人把假答案
     * 当真。配置真实模型见 nucleus.config.example.json。
     */
    modelChain: ['mock:local'],
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
    captureTranscripts: true,
    transcriptMaxChars: 200_000,
    // 本地模型是这个项目的一等场景，所以默认按本地取值。
    // 太长的代价只是「多等一会儿才降级」，太短的代价是「任务失败并重跑」
    requestTimeoutMs: 300_000,
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
