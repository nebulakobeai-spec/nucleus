import { NucleusError } from '../../src/errors.js'
import type { McpTransport } from '../../src/mcp/protocol.js'

/**
 * 进程内假 MCP server。
 *
 * 避免测试依赖真实子进程 —— 那会让测试变慢、变脆，
 * 而且这台开发机对 Node 进程有网络限制。
 */
export interface FakeServerSpec {
  name?: string
  tools: Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    /** 调用时返回什么；抛出则模拟工具崩溃 */
    handler?: (args: unknown) => unknown
  }>
  /** 每页返回几个工具，用于测分页 */
  pageSize?: number
  /** initialize 时抛错，模拟启动失败 */
  failOnInit?: string
  /** 第 N 次 tools/call 抛错（1 起）；`'all'` 表示每次都失败 */
  failCallsAt?: number[] | 'all'
  /** 每次请求的人为延迟 */
  delayMs?: number
}

export class FakeMcpTransport implements McpTransport {
  #closed = false
  #callCount = 0
  readonly requests: Array<{ method: string; params: unknown }> = []

  constructor(private spec: FakeServerSpec) {}

  get alive(): boolean {
    return !this.#closed
  }

  get callCount(): number {
    return this.#callCount
  }

  /** 模拟重启：进程换了，但测试要观察跨重启的累计计数 */
  reopen(): void {
    this.#closed = false
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    if (this.#closed) throw new NucleusError('mcp.server_unavailable', 'transport 已关闭')
    if (this.spec.delayMs) await new Promise((r) => setTimeout(r, this.spec.delayMs))

    switch (method) {
      case 'initialize': {
        if (this.spec.failOnInit) {
          throw new NucleusError('mcp.server_unavailable', this.spec.failOnInit)
        }
        return {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: this.spec.name ?? 'fake', version: '1.0.0' },
        }
      }

      case 'tools/list': {
        const size = this.spec.pageSize ?? this.spec.tools.length
        const cursor = (params as { cursor?: string })?.cursor
        const start = cursor ? Number(cursor) : 0
        const page = this.spec.tools.slice(start, start + size)
        const next = start + size < this.spec.tools.length ? String(start + size) : undefined
        return {
          tools: page.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          ...(next ? { nextCursor: next } : {}),
        }
      }

      case 'tools/call': {
        this.#callCount++
        const fail = this.spec.failCallsAt
        if (fail === 'all' || (Array.isArray(fail) && fail.includes(this.#callCount))) {
          throw new NucleusError('mcp.server_crashed', `第 ${this.#callCount} 次调用失败（注入）`)
        }
        const { name, arguments: args } = params as { name: string; arguments: unknown }
        const tool = this.spec.tools.find((t) => t.name === name)
        if (!tool) throw new NucleusError('mcp.tool_missing', `未知工具 ${name}`)

        try {
          const out = tool.handler ? tool.handler(args) : { echo: args }
          return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] }
        } catch (e) {
          // MCP 用 isError 表达工具自身失败，不是协议错误
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true }
        }
      }

      default:
        throw new NucleusError('mcp.server_unavailable', `未实现的方法 ${method}`)
    }
  }

  async notify(): Promise<void> {
    /* 忽略 */
  }

  async close(): Promise<void> {
    this.#closed = true
  }
}
