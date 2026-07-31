import { PgliteDb } from './db/pglite.js'
import { PostgresDb } from './db/postgres.js'
import type { Db } from './db/types.js'
import { migrate } from './db/migrate.js'
import { systemDeps, type Deps } from './seams.js'
import { agentMap, defaultConfig, envSecrets, modelMap, type NucleusConfig } from './config.js'
import { CredentialStore } from './auth/credentials.js'
import { ModelRouter } from './providers/router.js'
import { mockProviderFetch, type MockScript } from './providers/mock.js'
import type { FetchLike } from './providers/openai-compat.js'
import { RunStore } from './store/runs.js'
import { ConversationStore } from './store/conversations.js'
import { ToolRegistry } from './runtime/tools.js'
import { registerBuiltins } from './runtime/builtin-tools.js'
import { Runner } from './runtime/runner.js'
import { Worker } from './runtime/worker.js'
import { Reconciler } from './runtime/reconciler.js'
import { DbEventSink, TeeEventSink, type RunEventSink } from './runtime/events.js'
import { McpClient } from './mcp/client.js'
import { registerMcpTools, type RegisterResult } from './mcp/registry.js'
import type { McpServerConfig, McpTransport } from './mcp/protocol.js'

/**
 * 组装整个系统。
 *
 * 一个入口，CLI / API / 测试共用 —— 避免出现「测试里的接线」与
 * 「生产里的接线」两套代码，那是最容易漂移的地方。
 */
export interface Nucleus {
  db: Db
  deps: Deps
  config: NucleusConfig
  runs: RunStore
  conversations: ConversationStore
  tools: ToolRegistry
  runner: Runner
  worker: Worker
  reconciler: Reconciler
  router: ModelRouter
  events: RunEventSink
  /** 未配置 MCP server 时为 null */
  mcp: McpClient | null
  /** MCP 工具注册结果：注册了哪些、跳过哪些、schema 降级提示、副作用分级 */
  mcpReport: RegisterResult | null
  close(): Promise<void>
}

export interface BootOptions {
  config?: NucleusConfig
  deps?: Deps
  /** 留空则用 PGlite（本地/测试）；给了连接串则用真 Postgres */
  databaseUrl?: string | null
  /** PGlite 的持久化目录；留空为内存 */
  dataDir?: string | null
  /** 注入 fetch：mock provider、cassette 回放或故障注入 */
  fetch?: FetchLike
  /** 用内置 mock provider 跑（无网络环境） */
  mock?: MockScript
  events?: RunEventSink
  /** 凭据存储；默认 env > keychain > ~/.nucleus/credentials.json */
  credentials?: CredentialStore
  /** 跳过 MCP 连接（测试、离线环境） */
  skipMcp?: boolean
  /** 注入 MCP 传输层，便于测试 */
  mcpTransport?: (cfg: McpServerConfig, env: Record<string, string>) => McpTransport
  /** MCP 生命周期事件（不属于任何 run，不写 run_events） */
  onMcpEvent?: (e: { serverId: string; kind: string; detail?: unknown }) => void
}

export async function boot(opts: BootOptions = {}): Promise<Nucleus> {
  const config = opts.config ?? defaultConfig
  const deps = opts.deps ?? systemDeps

  const db: Db = opts.databaseUrl
    ? await PostgresDb.open(opts.databaseUrl)
    : await PgliteDb.open(opts.dataDir ?? undefined)
  await migrate(db)

  // 默认包一层旁路：无监听者时就是透明转发，成本为零；
  // 有监听者时（终端实时渲染、将来的 SSE 广播）读到的就是落库的同一条流，
  // 不会出现「终端显示的过程」和「诊断包记录的过程」各说一套。
  const events = opts.events ?? new TeeEventSink(new DbEventSink(db, deps.clock))
  const runs = new RunStore(db, deps)
  const conversations = new ConversationStore(db, deps)

  // 凭据解析：env > keychain > 文件。config 里只有 ref，值永不落 config。
  // 同步预解析一次，router 需要同步取值。
  const credentials = opts.credentials ?? new CredentialStore()
  const secretCache = new Map<string, string>()
  for (const m of config.models) {
    if (!m.apiKeyRef || secretCache.has(m.apiKeyRef)) continue
    const r = await credentials.resolve(m.apiKeyRef)
    if (r) secretCache.set(m.apiKeyRef, r.secret)
  }
  const secrets = (ref: string | undefined): string | null =>
    ref ? (secretCache.get(ref) ?? envSecrets(ref)) : null

  const tools = new ToolRegistry()
  const delegateTargets = config.agents.filter((a) => a.id !== 'orchestrator').map((a) => a.id)
  registerBuiltins(tools, {
    store: runs,
    delegateTargets,
    delegateLimits: {
      maxDepth: config.defaults.maxDelegationDepth,
      maxRunsPerRoot: config.defaults.maxRunsPerRoot,
    },
  })

  // MCP：部署与运行 server 是用户的事；这里只负责连接、翻译、命名空间、调用。
  // 单个 server 起不来不影响系统启动。
  let mcp: McpClient | null = null
  let mcpReport: RegisterResult | null = null
  const mcpConfigs = config.mcp ?? []
  if (mcpConfigs.length > 0 && !opts.skipMcp) {
    mcp = new McpClient(mcpConfigs, {
      clock: deps.clock,
      credentials,
      ...(opts.mcpTransport ? { makeTransport: opts.mcpTransport } : {}),
      // MCP 事件不属于任何 run —— 走独立回调，不写 run_events
      ...(opts.onMcpEvent ? { onEvent: opts.onMcpEvent } : {}),
    })
    const { tools: mcpTools } = await mcp.discover()
    mcpReport = registerMcpTools(tools, mcpTools, mcp, config.mcpPolicies ?? {})
  }

  const fetchImpl = opts.fetch ?? (opts.mock ? mockProviderFetch(opts.mock) : undefined)

  const router = new ModelRouter(db, deps, modelMap(config), secrets, {
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })

  const runner = new Runner(db, deps, router, tools, events, {
    heartbeatMs: config.runtime.heartbeatMs,
    leaseMs: config.runtime.leaseMs,
  })

  const worker = new Worker(db, deps, runner, agentMap(config), events, {
    workerId: config.runtime.workerId,
    leaseMs: config.runtime.leaseMs,
    workdirRoot: config.runtime.workdirRoot,
  })

  const reconciler = new Reconciler(db, deps)

  return {
    db,
    deps,
    config,
    runs,
    conversations,
    tools,
    runner,
    worker,
    reconciler,
    router,
    events,
    mcp,
    mcpReport,
    close: async () => {
      await mcp?.close()
      await db.close()
    },
  }
}

/**
 * 发起一轮对话：建 root run → 入队 → 跑到静止。
 *
 * 「跑到静止」包含被 wake 唤醒的后续 attempt —— worker loop 会把它们
 * 一并领出来执行，这正是 wake 机制生效的地方。
 */
export async function ask(
  n: Nucleus,
  conversationId: string,
  content: string,
  hooks: Parameters<Worker['drain']>[1] = {},
): Promise<{ runId: string; loops: number }> {
  await n.conversations.append({ conversationId, role: 'user', content })
  const conv = await n.conversations.get(conversationId)
  if (!conv) throw new Error(`会话 ${conversationId} 不存在`)

  const run = await n.runs.createRun({ agentId: conv.agentId, conversationId })
  await n.runs.enqueueAttempt(run.id)
  const loops = await n.worker.drain(100, hooks)
  return { runId: run.id, loops }
}
