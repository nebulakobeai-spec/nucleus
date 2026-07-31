import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { NucleusError } from '../errors.js'
import type { JsonRpcMessage, JsonRpcResponse, McpTransport } from './protocol.js'

/**
 * stdio 传输：把 MCP server 作为子进程拉起，用换行分隔的 JSON-RPC 通信。
 *
 * 几处必须处理对的地方：
 *  - stdout 的分帧（一条消息可能跨多个 chunk，一个 chunk 可能含多条消息）
 *  - stderr 单独收集：server 常往 stderr 打日志，混进 stdout 会破坏协议
 *  - 进程退出时把所有挂起请求一并 reject，否则调用方永远等下去
 */
export class StdioTransport implements McpTransport {
  #proc: ChildProcessWithoutNullStreams | null = null
  #pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>()
  #nextId = 1
  #buf = ''
  #stderr: string[] = []
  #closed = false
  #exitReason: string | null = null

  constructor(
    private cfg: {
      id: string
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      defaultTimeoutMs?: number
      /** stderr 最多保留多少行，用于诊断 */
      stderrLines?: number
    },
  ) {}

  get alive(): boolean {
    return !this.#closed && this.#proc !== null && this.#proc.exitCode === null
  }

  /** 最近的 stderr 输出，崩溃诊断用 */
  get stderr(): string {
    return this.#stderr.join('\n')
  }

  async start(): Promise<void> {
    if (this.#proc) return

    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      // 只传显式给定的环境变量 + PATH —— 不把整个父进程环境（含其他密钥）泄露给 server
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...this.cfg.env },
      ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#proc = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.#onStdout(chunk))

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      const max = this.cfg.stderrLines ?? 50
      for (const l of chunk.split('\n')) {
        if (!l.trim()) continue
        this.#stderr.push(l)
        if (this.#stderr.length > max) this.#stderr.shift()
      }
    })

    proc.on('exit', (code, signal) => {
      this.#exitReason = signal ? `signal ${signal}` : `exit code ${code}`
      this.#failAllPending(
        new NucleusError('mcp.server_crashed', `MCP server ${this.cfg.id} 退出（${this.#exitReason}）`, {
          detail: { stderr: this.stderr.slice(-1000) },
        }),
      )
    })

    proc.on('error', (err) => {
      this.#exitReason = err.message
      this.#failAllPending(
        new NucleusError('mcp.server_unavailable', `无法启动 MCP server ${this.cfg.id}：${err.message}`, {
          cause: err,
        }),
      )
    })

    // 立即失败的进程（命令不存在）在这里就能暴露，而不是等第一次请求超时
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        proc.off('error', onError)
        resolve()
      }
      const onError = (e: Error) => {
        proc.off('spawn', onSpawn)
        reject(new NucleusError('mcp.server_unavailable', `无法启动 ${this.cfg.command}：${e.message}`, { cause: e }))
      }
      proc.once('spawn', onSpawn)
      proc.once('error', onError)
    })
  }

  /**
   * 换行分帧。
   *
   * MCP stdio 规定每条消息一行 JSON。但 server 有时会在 stdout 里
   * 混入非 JSON 的行（启动横幅之类），所以解析失败的行直接跳过而不是崩溃。
   */
  #onStdout(chunk: string): void {
    this.#buf += chunk
    let nl: number
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim()
      this.#buf = this.#buf.slice(nl + 1)
      if (!line) continue
      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(line) as JsonRpcMessage
      } catch {
        this.#stderr.push(`[非 JSON 输出] ${line.slice(0, 200)}`)
        continue
      }
      this.#dispatch(msg)
    }
  }

  #dispatch(msg: JsonRpcMessage): void {
    if (!('id' in msg)) return // 通知：暂不处理
    const res = msg as JsonRpcResponse
    const p = this.#pending.get(res.id)
    if (!p) return
    this.#pending.delete(res.id)
    clearTimeout(p.timer)
    if (res.error) {
      p.reject(
        new NucleusError('mcp.server_unavailable', `MCP 错误 ${res.error.code}：${res.error.message}`, {
          detail: res.error,
        }),
      )
    } else {
      p.resolve(res.result)
    }
  }

  #failAllPending(err: unknown): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.#pending.clear()
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.alive) {
      throw new NucleusError('mcp.server_unavailable', `MCP server ${this.cfg.id} 未运行${this.#exitReason ? `（${this.#exitReason}）` : ''}`)
    }
    const id = this.#nextId++
    const timeout = timeoutMs ?? this.cfg.defaultTimeoutMs ?? 30_000

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new NucleusError('tool.timeout', `MCP ${this.cfg.id}.${method} 超时（${timeout}ms）`))
      }, timeout)
      this.#pending.set(id, { resolve, reject, timer })
      this.#proc!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
        if (err) {
          this.#pending.delete(id)
          clearTimeout(timer)
          reject(new NucleusError('mcp.server_unavailable', `写入 ${this.cfg.id} 失败：${err.message}`))
        }
      })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.alive) return
    this.#proc!.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async close(): Promise<void> {
    this.#closed = true
    const proc = this.#proc
    if (!proc || proc.exitCode !== null) return

    this.#failAllPending(new NucleusError('mcp.server_unavailable', `MCP server ${this.cfg.id} 已关闭`))

    proc.stdin.end()
    // 优雅退出 → 强制杀，与 run 取消的两段式一致
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve()
      }, 3_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  }
}

/**
 * HTTP 传输（streamable HTTP）。
 *
 * 相比 stdio 简单得多：无进程管理、无分帧。
 * 但要处理 SSE 形式的响应 —— 部分 server 对同一个 POST 用 SSE 回。
 */
export class HttpTransport implements McpTransport {
  #nextId = 1
  #sessionId: string | null = null
  #closed = false

  constructor(
    private cfg: {
      id: string
      url: string
      headers?: Record<string, string>
      defaultTimeoutMs?: number
      fetch?: (url: string, init: RequestInit) => Promise<Response>
    },
  ) {}

  get alive(): boolean {
    return !this.#closed
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const f = this.cfg.fetch ?? ((u: string, i: RequestInit) => fetch(u, i))
    const id = this.#nextId++
    const timeout = timeoutMs ?? this.cfg.defaultTimeoutMs ?? 30_000

    let res: Response
    try {
      res = await f(this.cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
          ...this.cfg.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? `超时（${timeout}ms）` : (e as Error).message
      throw new NucleusError('mcp.server_unavailable', `MCP ${this.cfg.id}.${method} 请求失败：${msg}`, { cause: e })
    }

    const sid = res.headers.get('mcp-session-id')
    if (sid) this.#sessionId = sid

    if (!res.ok) {
      throw new NucleusError('mcp.server_unavailable', `MCP ${this.cfg.id} 返回 HTTP ${res.status}`, {
        detail: { body: (await res.text()).slice(0, 500) },
      })
    }

    const ct = res.headers.get('content-type') ?? ''
    const payload = ct.includes('text/event-stream')
      ? await this.#readSse(res, id)
      : ((await res.json()) as JsonRpcResponse)

    if (payload.error) {
      throw new NucleusError('mcp.server_unavailable', `MCP 错误 ${payload.error.code}：${payload.error.message}`, {
        detail: payload.error,
      })
    }
    return payload.result
  }

  /** 从 SSE 流里挑出 id 匹配的那条响应 */
  async #readSse(res: Response, id: number): Promise<JsonRpcResponse> {
    const text = await res.text()
    for (const block of text.split('\n\n')) {
      for (const l of block.split('\n')) {
        if (!l.startsWith('data:')) continue
        try {
          const m = JSON.parse(l.slice(5).trim()) as JsonRpcResponse
          if (m.id === id) return m
        } catch {
          /* 跳过非 JSON 行 */
        }
      }
    }
    throw new NucleusError('mcp.server_unavailable', `MCP ${this.cfg.id} 的 SSE 响应中没有 id=${id} 的结果`)
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const f = this.cfg.fetch ?? ((u: string, i: RequestInit) => fetch(u, i))
    await f(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
        ...this.cfg.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {
      /* 通知失败不影响主流程 */
    })
  }

  async close(): Promise<void> {
    this.#closed = true
  }
}
