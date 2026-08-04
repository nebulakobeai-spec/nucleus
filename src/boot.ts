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
import { presenceOf } from './runtime/user-rules.js'
import { Runner } from './runtime/runner.js'
import { Worker, type WorkerOptions } from './runtime/worker.js'
import { DEFAULT_COMPACT_POLICY } from './context/compact.js'
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
  /** 覆盖 worker 选项（测试用：把压缩阈值调低，否则要灌几十轮才触发） */
  worker?: Partial<WorkerOptions>
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
  // 排除**入口 agent**（entryAgent 已可配，这里曾硬编码 'orchestrator'）——
  // 派回用户入口没有意义。成环由 maxDelegationDepth 兜底，不靠这里。
  const delegateTargets = config.agents
    .filter((a) => a.id !== config.defaults.entryAgent)
    .map((a) => ({ id: a.id, whenToUse: a.whenToUse }))
  registerBuiltins(tools, {
    // ask_user 要能把问题写给用户 —— 没有这个入口就不注册那个工具
    conversations,
    store: runs,
    delegateTargets,
    delegateLimits: {
      maxDepth: config.defaults.maxDelegationDepth,
      maxRunsPerRoot: config.defaults.maxRunsPerRoot,
    },
    /**
     * 正文按需加载的规则。工具注册表是全局的，所以这里放**所有** agent 的
     * 按需规则 —— 谁能看到 read_rule 由权限层决定（它无需权限，所以人人可见）。
     *
     * 那是对的：约束块里的索引行只会列出这个 agent 自己受约束的那些，
     * 所以它不会去读与自己无关的规则；而万一读了也无害（规则不是秘密）。
     */
    indexedRules: (config.rules ?? []).filter((r) => presenceOf(r) === 'indexed'),
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
    // 这一行以前不存在，于是 openai-compat 里硬编码的 120 秒是唯一生效的值
    ...(config.runtime.requestTimeoutMs ? { timeoutMs: config.runtime.requestTimeoutMs } : {}),
  })

  const runner = new Runner(db, deps, router, tools, events, {
    heartbeatMs: config.runtime.heartbeatMs,
    leaseMs: config.runtime.leaseMs,
    assumedContextWindow: config.defaults.assumedContextWindow,
    ...(config.runtime.captureTranscripts !== undefined
      ? { captureTranscripts: config.runtime.captureTranscripts }
      : {}),
    ...(config.runtime.transcriptMaxChars !== undefined
      ? { transcriptMaxChars: config.runtime.transcriptMaxChars }
      : {}),
  })

  const worker = new Worker(db, deps, runner, agentMap(config), events, {
    retryPolicy: {
      maxAttempts: config.defaults.maxAttempts,
      baseMs: config.defaults.retryBaseMs,
      capMs: config.defaults.retryCapMs,
    },
    workerId: config.runtime.workerId,
    leaseMs: config.runtime.leaseMs,
    workdirRoot: config.runtime.workdirRoot,
    // 配置里的压缩阈值。默认在大窗口模型上要四五十轮才触发，
    // 调低它是评估压缩质量的唯一办法
    ...(config.runtime.compact
      ? {
          compactPolicy: {
            ...DEFAULT_COMPACT_POLICY,
            ...config.runtime.compact,
          },
        }
      : {}),
    ...(opts.worker ?? {}),
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
): Promise<{ runId: string; loops: number; answered: boolean }> {
  const conv = await n.conversations.get(conversationId)
  if (!conv) throw new Error(`会话 ${conversationId} 不存在`)

  /**
   * **有 run 在等回答时，这条消息就是回答，不是新任务。**
   *
   * ── 为什么必须先判这一步 ──────────────────────────
   *
   * 不判的话，编排者问「你说的 X 指的是 A 还是 B？」而你回「A」——
   * 系统会**把「A」当成一个新任务开一个新 run**，同时原来那个 run 永远停在
   * waiting_user。你会看到一个莫名其妙的回答，而真正在等的那件事再也不动。
   *
   * 让系统去猜「这句是答案还是新任务」是不行的：猜错的代价是把回答喂给错误的
   * run，而那不可逆。所以规则是死的 —— **有提问在等，你的下一句就是答案**。
   * 想开新任务用 `/new` 另起会话。
   */
  const question = await n.runs.questionAwaitingAnswer(conversationId)
  if (question) {
    await n.conversations.append({ conversationId, role: 'user', content })
    const fired = await n.runs.answerQuestion(question.id)
    if (fired) {
      try {
        const loops = await n.worker.drain(100, hooks)
        return { runId: fired.runId, loops, answered: true }
      } finally {
        // 与上面同一个判据：又问了一句就继续持锁，否则放掉
        const after = await n.runs.getRun(fired.runId)
        if (after?.status !== 'waiting_user') {
          await n.conversations.release(conversationId, fired.runId)
        }
      }
    }
    // 条件更新没抢到 —— 另一条消息刚刚点了火。那一次 drain 会处理这句话
    return { runId: question.parentRunId, loops: 0, answered: true }
  }

  await n.conversations.append({ conversationId, role: 'user', content })
  const run = await n.runs.createRun({ agentId: conv.agentId, conversationId })

  /**
   * **会话锁。** 同一个会话同时只允许一个活跃 run。
   *
   * ── 为什么现在才接上 ────────────────────────────
   *
   * `conversations.acquire()` 用条件更新做好了 CAS，而**只有它自己的测试在调用**
   * ——「声明了但没接线」的一个实例（backlog 记为「第 9 处」）。
   * 今天没出问题只是因为 CLI 与 REPL 都是串行的：一旦有并发入口
   * （或者两个终端同时对同一个会话说话），就会两个 run 抢一个会话，
   * 各自往里追加消息，而**双方看到的历史都是错的** —— 交错之后谁也说不清
   * 哪句回应哪句。
   *
   * 抢不到时把刚建的 run 取消掉再抛。不取消的话会留下一个永远 pending 的 run，
   * 而它在 `nucleus runs` 里看起来像一个卡住的任务。
   */
  try {
    await n.conversations.acquire(conversationId, run.id)
  } catch (e) {
    await n.runs.cancel(run.id, 'conversation.busy')
    throw e
  }

  try {
    await n.runs.enqueueAttempt(run.id)
    const loops = await n.worker.drain(100, hooks)
    return { runId: run.id, loops, answered: false }
  } finally {
    /**
     * **放锁的判据是「还等不等用户说话」，不是「有没有结束」。**
     *
     * 我第一版写的是「只在终态才放」，看起来更严格 —— 而它造成一个死锁：
     *
     *   provider 全挂 → run 进 waiting_retry（持锁）
     *   → 重试需要一次 drain
     *   → CLI 的 drain 只在下一条命令时发生
     *   → 下一条命令被锁拒绝
     *
     * 会话从此谁也用不了，而它显示的状态是「有正在执行的 run」——
     * 一句正确的话指向一个不可能自行解开的局。测试里 5 次连续 ask 就撞上了。
     *
     * 所以锁只守两件事：
     *  ① **并发入口** —— 两个终端同时对同一会话说话（CAS 在 acquire 里挡住）
     *  ② **待答提问的窗口** —— 你的下一句是那个回答，不能被当成新任务
     *
     * 它**不**守重试窗口。代价是：重试期间发新消息会开一个并行的 run，
     * 两者的结果会交错追加。那比死锁好，而且真正的修法是让重试由长驻 worker
     * 推进（那时 ask 返回后重试自己会走完），不是靠加长锁的持有时间。
     */
    const after = await n.runs.getRun(run.id)
    if (after?.status !== 'waiting_user') {
      await n.conversations.release(conversationId, run.id)
    }
  }
}
