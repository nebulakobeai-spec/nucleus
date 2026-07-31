import { createHash } from 'node:crypto'
import type { ModelConfig } from './providers/types.js'
import type { AgentSpec } from './runtime/runner.js'
import type { McpServerConfig } from './mcp/protocol.js'
import type { McpRegisterOptions } from './mcp/registry.js'

/**
 * 统一配置（DESIGN.md §12）。
 *
 * T3 能力边界（工具/MCP 白名单）活在这里 —— 它的载体不是规则文本，
 * 而是「给不给」，所以天然属于配置。
 *
 * **secrets 不进这里、不进 git**：只写 `apiKeyRef`，值从 env 取。
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

export function modelMap(cfg: NucleusConfig): Map<string, ModelConfig> {
  return new Map(cfg.models.map((m) => [m.key, m]))
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
    {
      key: 'mock:local',
      provider: 'mock',
      model: 'mock',
      baseUrl: 'http://mock.invalid/v1',
      costPerMTokIn: 0,
      costPerMTokOut: 0,
    },
    {
      key: 'ollama:llama',
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1',
      costPerMTokIn: 0,
      costPerMTokOut: 0,
    },
    {
      key: 'zai:glm-4.7',
      provider: 'zai',
      model: 'glm-4.7',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKeyRef: 'ZAI_API_KEY',
      rpm: 60,
      costPerMTokIn: 0.6,
      costPerMTokOut: 2.2,
      costPerMTokCacheRead: 0.11,
      contextWindow: 200_000,
    },
    {
      key: 'openai:gpt-5',
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyRef: 'OPENAI_API_KEY',
      contextWindow: 400_000,
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
