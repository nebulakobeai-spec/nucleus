import { createInterface, type Interface } from 'node:readline/promises'
import type { Nucleus } from '../boot.js'
import { c, ICON, line } from './ui.js'
import { printRunList, printRunTree, printTurn, runTurn } from './turn.js'

/**
 * `nucleus chat` —— 交互式 REPL。
 *
 * 用原生 readline，不引第三方 TUI 库：全屏 alt-buffer 在 SSH 下兼容性差、
 * 调试困难，而这里需要的只是「连续输入 + 打印」。
 *
 * 每轮走的是与 `ask` 完全相同的管线（`runTurn`），所以两者输出一致 ——
 * 在 chat 里看到的和脚本里看到的不会漂移。
 */

export interface ChatSession {
  conversationId: string | null
  /** null 表示用配置里的默认链 */
  modelChain: string[] | null
}

const HELP = `${c.bold('命令')}
  /new                 开新会话（下一轮生成新的会话 id）
  /model <a,b,c>       换模型链，对后续轮次生效
  /model               显示当前模型链
  /runs [id 前缀]      查看最近的 run 或某个 run 树
  /help                这份帮助
  /exit                退出（Ctrl-D 同效）`

export interface ChatOptions {
  conversationId?: string | null
  modelChain?: string[] | null
  /** 注入输入输出，便于测试 */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export async function chatLoop(n: Nucleus, opts: ChatOptions = {}): Promise<number> {
  const session: ChatSession = {
    conversationId: opts.conversationId ?? null,
    modelChain: opts.modelChain ?? null,
  }

  const rl = createInterface({
    input: opts.input ?? process.stdin,
    output: opts.output ?? process.stdout,
    terminal: (opts.input ?? process.stdin) === process.stdin && process.stdin.isTTY,
  })

  printBanner(n, session)
  line(c.gray('/help 查看命令 · /exit 退出'))
  line()

  // Ctrl-C：中止当前请求而不退出 REPL。
  // 没有正在执行的请求时才退出，避免误触丢掉整个会话。
  let inflight: AbortController | null = null

  /**
   * 输入队列。
   *
   * 不用 `rl.question()` 拉取，原因有二：
   *  1. EOF 时它既不 resolve 也不 reject，会永久挂起
   *  2. 管道输入时，处理一行的过程中流会被读到底并触发 close，
   *     缓冲区里剩余的行全部丢失 —— 只有第一条命令会被执行
   *
   * 改成 `line` 事件驱动：所有行先进队列，消费者按序取。
   * 交互式下行为不变（一次一行），管道输入下不再丢数据。
   */
  const queue: string[] = []
  let eof = false
  let notify: (() => void) | null = null

  const wake = () => {
    const f = notify
    notify = null
    f?.()
  }

  rl.on('line', (l) => {
    queue.push(l)
    wake()
  })
  rl.once('close', () => {
    eof = true
    wake()
  })

  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const l = queue.shift()
      if (l !== undefined) return l
      if (eof) return null
      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }
  }

  const onSigint = () => {
    if (inflight) {
      inflight.abort()
      line()
      line(`${ICON.warn} 已取消当前请求`)
      inflight = null
      prompt()
    } else {
      line()
      line(c.gray('再见'))
      rl.close()
    }
  }
  rl.on('SIGINT', onSigint)

  const interactive = rl.terminal
  const prompt = () => {
    if (interactive) process.stdout.write('> ')
  }

  try {
    prompt()
    for (;;) {
      const raw = await nextLine()
      if (raw === null) break // EOF
      const input = raw.trim()

      if (!input) {
        prompt()
        continue
      }

      if (input.startsWith('/')) {
        const done = await handleCommand(n, session, input)
        if (done) break
        prompt()
        continue
      }

      inflight = new AbortController()
      try {
        await handleTurn(n, session, input)
      } catch (e) {
        // 模型报错、数据库抖动都不该让 REPL 退出
        line()
        line(`${ICON.fail} ${c.red((e as Error).message)}`)
        line(c.gray('  会话仍然可用，可以继续提问'))
      } finally {
        inflight = null
      }
      line()
      prompt()
    }
  } finally {
    rl.close()
  }

  return 0
}

async function handleTurn(n: Nucleus, session: ChatSession, text: string): Promise<void> {
  if (!session.conversationId) {
    const conv = await n.conversations.create({
      agentId: n.config.agents[0]?.id ?? 'orchestrator',
      title: text.slice(0, 40),
    })
    session.conversationId = conv.id
    line(c.gray(`新会话 ${conv.id.slice(0, 8)}`))
  }

  const result = await runTurn(n, session.conversationId, text)
  const tree = await n.runs.tree(result.runId)
  printTurn(result, { runCount: tree.length })
}

/** 返回 true 表示要退出 REPL */
async function handleCommand(n: Nucleus, session: ChatSession, input: string): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()

  switch (cmd) {
    case 'exit':
    case 'quit':
    case 'q':
      line(c.gray('再见'))
      return true

    case 'help':
    case 'h':
    case '?':
      line(HELP)
      return false

    case 'new': {
      session.conversationId = null
      line(`${ICON.ok} 已开新会话（下一轮生效）`)
      printBanner(n, session)
      return false
    }

    case 'model': {
      if (!arg) {
        line(`当前模型链：${c.cyan((session.modelChain ?? n.config.defaults.modelChain).join(', '))}`)
        line(c.gray(`可用：${n.config.models.map((m) => m.key).join(', ')}`))
        return false
      }
      const chain = arg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      // 先校验再生效：写错模型名要立刻知道，而不是下一轮才炸
      const unknown = chain.filter((k) => !n.config.models.some((m) => m.key === k))
      if (unknown.length) {
        line(`${ICON.fail} 未知模型：${unknown.join(', ')}`)
        line(c.gray(`可用：${n.config.models.map((m) => m.key).join(', ')}`))
        return false
      }
      session.modelChain = chain
      applyModelChain(n, chain)
      line(`${ICON.ok} 模型链已切换为 ${c.cyan(chain.join(', '))}`)
      return false
    }

    case 'runs': {
      if (arg) {
        const found = await printRunTree(n, arg)
        if (!found) line(`${ICON.warn} 未找到 run ${arg}`)
      } else {
        await printRunList(n, 10)
      }
      return false
    }

    default:
      line(`${ICON.warn} 未知命令 /${cmd}`)
      line(HELP)
      return false
  }
}

/**
 * 切换模型链。
 *
 * agent 的 spec 在 boot 时已固化进 worker，所以要同时改配置与已生成的 spec ——
 * 只改配置的话对已启动的 worker 无效。
 */
function applyModelChain(n: Nucleus, chain: string[]): void {
  n.config.defaults.modelChain = chain
  for (const spec of n.worker.agentSpecs.values()) {
    // 只覆盖没有显式指定模型链的 agent：显式配置过的应当保持
    const declared = n.config.agents.find((a) => a.id === spec.id)?.modelChain
    if (!declared) spec.modelChain = chain
  }
}

function printBanner(n: Nucleus, session: ChatSession): void {
  const conv = session.conversationId ? session.conversationId : '（下一轮创建）'
  const model = (session.modelChain ?? n.config.defaults.modelChain).join(', ')
  const width = Math.max(conv.length, model.length) + 8

  const pad = (s: string) => s + ' '.repeat(Math.max(0, width - visualLength(s)))
  line(c.gray('╭─ ') + c.bold('nucleus') + c.gray(' ' + '─'.repeat(Math.max(0, width - 8)) + '╮'))
  line(c.gray('│ ') + pad(`会话 ${c.cyan(conv)}`) + c.gray('│'))
  line(c.gray('│ ') + pad(`模型 ${c.cyan(model)}`) + c.gray('│'))
  line(c.gray('╰' + '─'.repeat(width + 1) + '╯'))
}

/** 去掉 ANSI 后的显示宽度（CJK 按 2 列） */
function visualLength(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '')
  let n = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!
    n +=
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6))
        ? 2
        : 1
  }
  return n
}

/** 供测试：解析一条命令但不启动 REPL */
export async function runChatCommand(
  n: Nucleus,
  session: ChatSession,
  input: string,
): Promise<boolean> {
  return handleCommand(n, session, input)
}

export type { Interface as ReadlineInterface }
