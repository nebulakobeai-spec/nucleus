import { createHash } from 'node:crypto'
import { NucleusError } from '../errors.js'
import type { CredentialStore } from '../auth/credentials.js'
import type { Clock } from '../seams.js'
import { flattenSchema } from './schema.js'
import {
  MCP_PROTOCOL_VERSION,
  parseQualifiedName,
  qualifiedName,
  type McpContent,
  type McpInitializeResult,
  type McpServerConfig,
  type McpTool,
  type McpToolCallResult,
  type McpToolsListResult,
  type McpTransport,
} from './protocol.js'
import { HttpTransport, StdioTransport } from './transport.js'

export interface ResolvedMcpTool {
  /** 全局唯一名，形如 `searxng__search` */
  name: string
  serverId: string
  originalName: string
  description: string
  parameters: Record<string, unknown>
  /** schema 归一化时丢掉了什么 */
  warnings: string[]
}

export interface McpServerStatus {
  id: string
  state: 'idle' | 'starting' | 'ready' | 'failed' | 'disabled'
  toolCount: number
  failureCount: number
  lastError: string | null
  disabledAt: number | null
  startedAt: number | null
}

export interface McpClientOptions {
  clock: Clock
  credentials?: CredentialStore
  /** 空闲多久后回收子进程 */
  idleTimeoutMs?: number
  /** 注入传输层，便于测试 */
  makeTransport?: (cfg: McpServerConfig, env: Record<string, string>) => McpTransport
  onEvent?: (e: { serverId: string; kind: string; detail?: unknown }) => void
}

/**
 * 单个 MCP server 的连接管理。
 *
 * 职责边界（DESIGN.md §8）：部署与运行 server 是**用户的事**，
 * Nucleus 只负责连接与发现、schema 翻译、命名空间、调用与错误归一。
 *
 * 生命周期策略：按需拉起 + 空闲回收 + 崩溃自动重启（带退避）。
 * 常驻多个 stdio 子进程既占资源又经常挂。
 */
class McpConnection {
  #transport: McpTransport | null = null
  #tools: McpTool[] = []
  #state: McpServerStatus['state'] = 'idle'
  #failures = 0
  #lastError: string | null = null
  #disabledAt: number | null = null
  #startedAt: number | null = null
  #lastUsedAt = 0
  #starting: Promise<void> | null = null

  constructor(
    private cfg: McpServerConfig,
    private opts: McpClientOptions,
  ) {
    if (cfg.enabled === false) this.#state = 'disabled'
  }

  get id(): string {
    return this.cfg.id
  }

  get status(): McpServerStatus {
    return {
      id: this.cfg.id,
      state: this.#state,
      toolCount: this.#tools.length,
      failureCount: this.#failures,
      lastError: this.#lastError,
      disabledAt: this.#disabledAt,
      startedAt: this.#startedAt,
    }
  }

  get disabled(): boolean {
    return this.#state === 'disabled'
  }

  /** 解析 env_refs 到真实密钥 —— config 里只有 ref */
  async #buildEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = { ...this.cfg.env }
    for (const [key, ref] of Object.entries(this.cfg.envRefs ?? {})) {
      const cred = await this.opts.credentials?.resolve(ref)
      if (!cred) {
        throw new NucleusError('mcp.server_unavailable', `MCP ${this.cfg.id} 需要凭据 ${ref}，但未配置`, {
          detail: { hint: `运行 nucleus auth login ${ref}` },
        })
      }
      env[key] = cred.secret
    }
    return env
  }

  /** 幂等启动：并发调用共享同一次启动过程 */
  async ensureStarted(): Promise<void> {
    if (this.disabled) {
      throw new NucleusError('mcp.auto_disabled', `MCP server ${this.cfg.id} 已被禁用：${this.#lastError ?? '手动禁用'}`)
    }
    if (this.#transport?.alive) {
      this.#lastUsedAt = this.opts.clock.now()
      return
    }
    if (this.#starting) return this.#starting

    this.#starting = this.#start().finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #start(): Promise<void> {
    this.#state = 'starting'
    this.opts.onEvent?.({ serverId: this.cfg.id, kind: 'mcp.starting' })

    try {
      const env = await this.#buildEnv()
      const transport = this.opts.makeTransport
        ? this.opts.makeTransport(this.cfg, env)
        : this.#defaultTransport(env)

      if (transport instanceof StdioTransport) await transport.start()
      this.#transport = transport

      // 握手
      const init = (await transport.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'nucleus', version: '0.1.0' },
        },
        15_000,
      )) as McpInitializeResult
      await transport.notify('notifications/initialized')

      this.#tools = await this.#listAllTools(transport)
      this.#state = 'ready'
      this.#lastError = null
      this.#startedAt = this.opts.clock.now()
      this.#lastUsedAt = this.#startedAt
      // 注意：**不清零 failures** —— 一个反复崩溃的 server 每次都能重启成功，
      // 若在这里清零，熔断计数永远到不了阈值，自动禁用形同虚设。
      // 只有「调用成功」才证明它真的可用（见 call()）。

      this.opts.onEvent?.({
        serverId: this.cfg.id,
        kind: 'mcp.ready',
        detail: { server: init.serverInfo, tools: this.#tools.length },
      })
    } catch (e) {
      await this.#recordFailure(e)
      throw e
    }
  }

  #defaultTransport(env: Record<string, string>): McpTransport {
    if (this.cfg.transport === 'http') {
      if (!this.cfg.url) throw new NucleusError('mcp.server_unavailable', `MCP ${this.cfg.id} 缺少 url`)
      return new HttpTransport({
        id: this.cfg.id,
        url: this.cfg.url,
        ...(this.cfg.headers ? { headers: this.cfg.headers } : {}),
        ...(this.cfg.timeoutMs ? { defaultTimeoutMs: this.cfg.timeoutMs } : {}),
      })
    }
    if (!this.cfg.command) throw new NucleusError('mcp.server_unavailable', `MCP ${this.cfg.id} 缺少 command`)
    return new StdioTransport({
      id: this.cfg.id,
      command: this.cfg.command,
      ...(this.cfg.args ? { args: this.cfg.args } : {}),
      env,
      ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}),
      ...(this.cfg.timeoutMs ? { defaultTimeoutMs: this.cfg.timeoutMs } : {}),
    })
  }

  /** tools/list 分页拉全 */
  async #listAllTools(transport: McpTransport): Promise<McpTool[]> {
    const all: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = (await transport.request('tools/list', cursor ? { cursor } : {})) as McpToolsListResult
      all.push(...(res.tools ?? []))
      cursor = res.nextCursor
      if (!cursor) break
    }
    return all
  }

  /**
   * 失败计数与自动禁用。
   *
   * 连续失败超阈值即禁用并从 agent 工具集中移除 ——
   * 一个挂掉的 server 不该每次都拖慢每个 run。
   */
  async #recordFailure(e: unknown): Promise<void> {
    this.#failures++
    this.#lastError = e instanceof Error ? e.message : String(e)
    this.#state = 'failed'
    await this.#transport?.close().catch(() => {})
    this.#transport = null

    const threshold = this.cfg.failureThreshold ?? 3
    if (this.#failures >= threshold) {
      this.#state = 'disabled'
      this.#disabledAt = this.opts.clock.now()
      this.opts.onEvent?.({
        serverId: this.cfg.id,
        kind: 'mcp.auto_disabled',
        detail: { failures: this.#failures, lastError: this.#lastError },
      })
    } else {
      this.opts.onEvent?.({
        serverId: this.cfg.id,
        kind: 'mcp.failed',
        detail: { failures: this.#failures, error: this.#lastError },
      })
    }
  }

  tools(): ResolvedMcpTool[] {
    return this.#tools.map((t) => {
      const { schema, warnings } = flattenSchema(t.inputSchema)
      return {
        name: qualifiedName(this.cfg.id, t.name),
        serverId: this.cfg.id,
        originalName: t.name,
        description: t.description ?? `${this.cfg.id} 的 ${t.name}`,
        parameters: schema,
        warnings,
      }
    })
  }

  async call(toolName: string, args: unknown, timeoutMs?: number): Promise<McpToolCallResult> {
    // 已禁用时直接抛，不要走进 catch 再计一次失败
    if (this.disabled) {
      throw new NucleusError('mcp.auto_disabled', `MCP server ${this.cfg.id} 已被禁用：${this.#lastError ?? '手动禁用'}`, {
        detail: { hint: `修复后运行 nucleus mcp enable ${this.cfg.id}` },
      })
    }
    await this.ensureStarted()
    this.#lastUsedAt = this.opts.clock.now()
    try {
      const res = (await this.#transport!.request(
        'tools/call',
        { name: toolName, arguments: args ?? {} },
        timeoutMs ?? this.cfg.timeoutMs,
      )) as McpToolCallResult
      // 工具自身报错（isError）不算 server 故障，不计入熔断
      this.#failures = 0
      return res
    } catch (e) {
      await this.#recordFailure(e)
      throw e
    }
  }

  /** 禁用后仍需知道它**曾经**有哪些工具，以便给出正确的错误码 */
  hasTool(name: string): boolean {
    return this.#tools.some((t) => qualifiedName(this.cfg.id, t.name) === name)
  }

  /** 空闲回收：释放子进程，下次调用会自动重启 */
  async reapIfIdle(idleMs: number): Promise<boolean> {
    if (!this.#transport?.alive) return false
    if (this.opts.clock.now() - this.#lastUsedAt < idleMs) return false
    await this.close()
    this.#state = 'idle'
    this.opts.onEvent?.({ serverId: this.cfg.id, kind: 'mcp.reaped' })
    return true
  }

  /** 人工重新启用（`nucleus mcp enable`） */
  reset(): void {
    this.#failures = 0
    this.#lastError = null
    this.#disabledAt = null
    this.#state = 'idle'
  }

  async close(): Promise<void> {
    await this.#transport?.close().catch(() => {})
    this.#transport = null
    if (this.#state === 'ready') this.#state = 'idle'
  }
}

/**
 * MCP 客户端：管理所有 server。
 */
export class McpClient {
  #conns = new Map<string, McpConnection>()
  #snapshotCache: { checksum: string; tools: ResolvedMcpTool[] } | null = null

  constructor(
    configs: McpServerConfig[],
    private opts: McpClientOptions,
  ) {
    for (const cfg of configs) this.#conns.set(cfg.id, new McpConnection(cfg, opts))
  }

  get serverIds(): string[] {
    return [...this.#conns.keys()]
  }

  /**
   * 连接所有 server 并收集工具。
   *
   * 单个 server 失败不影响其余 —— 一个坏掉的 server 不该让整个系统起不来。
   */
  async discover(): Promise<{ tools: ResolvedMcpTool[]; failed: Array<{ id: string; error: string }> }> {
    const failed: Array<{ id: string; error: string }> = []
    const tools: ResolvedMcpTool[] = []

    await Promise.all(
      [...this.#conns.values()].map(async (conn) => {
        if (conn.disabled) {
          failed.push({ id: conn.id, error: conn.status.lastError ?? '已禁用' })
          return
        }
        try {
          await conn.ensureStarted()
          tools.push(...conn.tools())
        } catch (e) {
          failed.push({ id: conn.id, error: (e as Error).message })
        }
      }),
    )

    tools.sort((a, b) => a.name.localeCompare(b.name))
    this.#snapshotCache = { checksum: checksumOf(tools), tools }
    return { tools, failed }
  }

  /** 当前工具快照；run 记录它的 checksum 用于归因 */
  snapshot(): { checksum: string; tools: ResolvedMcpTool[] } {
    return this.#snapshotCache ?? { checksum: 'empty', tools: [] }
  }

  async call(qualified: string, args: unknown, timeoutMs?: number): Promise<McpToolCallResult> {
    const parsed = this.#resolve(qualified)
    if (!parsed) {
      throw new NucleusError('mcp.tool_missing', `未知 MCP 工具 ${qualified}`)
    }
    return parsed.conn.call(parsed.originalName, args, timeoutMs)
  }

  #resolve(qualified: string): { conn: McpConnection; originalName: string } | null {
    for (const conn of this.#conns.values()) {
      // 用 hasTool 而非 tools()：被禁用的 server 也要能匹配到，
      // 这样报的是「已禁用」而不是误导性的「工具不存在」
      if (!conn.hasTool(qualified)) continue
      const parsed = parseQualifiedName(qualified)
      if (parsed) return { conn, originalName: parsed.toolName }
    }
    return null
  }

  statuses(): McpServerStatus[] {
    return [...this.#conns.values()].map((c) => c.status)
  }

  enable(id: string): boolean {
    const conn = this.#conns.get(id)
    if (!conn) return false
    conn.reset()
    return true
  }

  async reapIdle(): Promise<string[]> {
    const idleMs = this.opts.idleTimeoutMs ?? 300_000
    const reaped: string[] = []
    for (const conn of this.#conns.values()) {
      if (await conn.reapIfIdle(idleMs)) reaped.push(conn.id)
    }
    return reaped
  }

  async close(): Promise<void> {
    await Promise.all([...this.#conns.values()].map((c) => c.close()))
  }
}

/**
 * MCP 返回内容 → 模型可消费的文本。
 *
 * 图片/音频/二进制不内联（会撑爆 context），只留描述性占位；
 * 需要时由专门的多模态路径处理。
 */
export function renderContent(result: McpToolCallResult): string {
  const parts: string[] = []
  for (const c of result.content ?? []) {
    parts.push(renderOne(c))
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent))
  }
  return parts.join('\n') || '(空结果)'
}

function renderOne(c: McpContent): string {
  switch (c.type) {
    case 'text':
      return c.text
    case 'image':
      return `[图片 ${c.mimeType}，${estimateBytes(c.data)} 字节，未内联]`
    case 'audio':
      return `[音频 ${c.mimeType}，${estimateBytes(c.data)} 字节，未内联]`
    case 'resource':
      return c.resource.text ?? `[资源 ${c.resource.uri}${c.resource.mimeType ? ` (${c.resource.mimeType})` : ''}]`
    case 'resource_link':
      return `[链接 ${c.uri}${c.name ? ` — ${c.name}` : ''}]`
    default:
      return `[未知内容类型 ${JSON.stringify(c).slice(0, 80)}]`
  }
}

function estimateBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4)
}

function checksumOf(tools: ResolvedMcpTool[]): string {
  const h = createHash('sha256')
  for (const t of tools) h.update(t.name).update(JSON.stringify(t.parameters))
  return h.digest('hex').slice(0, 16)
}
