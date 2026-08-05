import { createInterface, type Interface } from 'node:readline/promises'
import type { Nucleus } from '../boot.js'
import { isMockOnly } from '../config.js'
import { BoxInput, type Completion } from './input.js'
import { petStill } from './pet.js'
import { c, ICON, line, visibleLength } from './ui.js'
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

/**
 * 命令表。
 *
 * 帮助文本与输入框的联想都从这里生成 —— 两处分开写迟早会不一致，
 * 而「帮助里有的命令实际不存在」是最让人不信任 CLI 的事。
 */
const COMMANDS: Array<{ name: string; arg?: string; hint: string }> = [
  { name: '/new', hint: '开新会话（下一轮生成新的会话 id）' },
  { name: '/model', arg: '<a,b,c>', hint: '换模型链（按顺序降级），不带参数则显示当前链' },
  { name: '/runs', arg: '[id 前缀]', hint: '查看最近的 run 或某个 run 树' },
  { name: '/help', hint: '这份帮助' },
  { name: '/exit', hint: '退出（Ctrl-D 同效）' },
]

const HELP = [
  c.bold('命令'),
  ...COMMANDS.map((x) => {
    const sig = x.name + (x.arg ? ' ' + x.arg : '')
    // 按显示宽度补空格 —— padEnd 用的是 .length，中文会让这一列歪掉
    return `  ${sig}${' '.repeat(Math.max(1, 20 - visibleLength(sig)))} ${x.hint}`
  }),
  '',
  c.gray('  编辑：← → 移动 · ⌥← ⌥→ 按词 · ⌃A/⌃E 行首行尾 · ⌃U/⌃K 清除 · ⌃W 删词'),
  c.gray('  历史：↑ ↓ 翻上次输入 · 联想开着时 ↑↓ 选候选、Tab 采用'),
  c.gray('  多行：⌥Enter 换行不提交 · 粘贴多行不会被拆成多次提交'),
].join('\n')

/** 输入框的命令联想 */
function completeCommand(buffer: string): Completion[] {
  if (!buffer.startsWith('/')) return []
  // 已经带参数了就不再弹，否则会挡住正在输入的内容
  if (/\s/.test(buffer)) return []
  return COMMANDS.filter((x) => x.name.startsWith(buffer)).map((x) => ({
    // 带参数的命令补出一个空格，可以直接接着打
    value: x.arg ? x.name + ' ' : x.name,
    label: x.name,
    hint: x.hint,
  }))
}

export interface ChatOptions {
  conversationId?: string | null
  modelChain?: string[] | null
  /** 注入输入输出，便于测试 */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

/**
 * 交互式（TTY）循环：带框输入区。
 *
 * 与管道分支分开写，而不是塞进一个函数里加 if —— 两者的输入模型完全不同
 * （raw mode 逐键 vs 行事件队列），混在一起只会让两条路都难改。
 * 管道分支必须保留：脚本、CI 和测试都靠它。
 */
async function interactiveLoop(n: Nucleus, session: ChatSession): Promise<number> {
  let inflight: AbortController | null = null

  const box = new BoxInput({
    complete: completeCommand,
    theme: {
      prompt: ICON.prompt,
      border: c.gray,
      dim: c.gray,
      accent: c.cyan,
    },
    footer: '/ 看命令 · ⌥Enter 换行 · ⌃C 取消 · ⌃D 退出',
    // 跑任务时 raw mode 下没有 SIGINT，只能从字节流里认 Ctrl-C
    onInterrupt: () => {
      if (!inflight) return
      inflight.abort()
      inflight = null
      line()
      line(`${ICON.warn} 已取消当前请求`)
    },
  })

  printBanner(n, session)

  try {
    /** 空手 Ctrl-C 按过一次了吗 —— 第二次才退 */
    let armedExit = false
    for (;;) {
      const r = await box.read()
      if (r.type === 'eof') {
        line(`${petStill('idle')} ${c.gray('再见')}`)
        break
      }
      if (r.type === 'cancel') {
        /**
         * **连按两次 Ctrl-C 退出。**
         *
         * 原先空手 Ctrl-C 只清输入、永不退出，理由写的是「误触不该丢掉整个会话」。
         * 而那个代价**根本不存在** —— 会话是落库的，`nucleus chat --conv <id>`
         * 就能接着聊。也就是说我用一个不存在的代价，换掉了所有人对 Ctrl-C 的
         * 肌肉记忆，而使用者的反馈正是「为什么不能 Ctrl-C 退出」。
         *
         * 通行约定是连按两次：第一次给提示，第二次退。有输入时第一次仍然只清输入
         * （那时你想清的是那行字，不是退出）。
         */
        // 有字时第一次只清掉那行 —— 那时你想清的是那行字，不是退出
        if (r.hadText) {
          armedExit = false
          continue
        }
        if (armedExit) {
          line(`${petStill('idle')} ${c.gray('再见')}`)
          break
        }
        armedExit = true
        line(c.gray('  再按一次 Ctrl-C 退出（/exit 同效）。会话已落库，下次 --conv 接着聊。'))
        continue
      }
      // 任何别的输入都解除「再按一次就退」——否则十分钟前那次误触会一直生效
      armedExit = false

      const input = r.text.trim()
      if (!input) continue

      // 提交的内容留成永久一行，和框里看到的一致
      line(`${c.cyan(ICON.prompt)} ${input}`)

      if (input.startsWith('/')) {
        if (await handleCommand(n, session, input)) break
        line()
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
    }
  } finally {
    box.close()
  }
  return 0
}

export async function chatLoop(n: Nucleus, opts: ChatOptions = {}): Promise<number> {
  const session: ChatSession = {
    conversationId: opts.conversationId ?? null,
    modelChain: opts.modelChain ?? null,
  }

  const stdin = opts.input ?? process.stdin
  const isTty = stdin === process.stdin && Boolean(process.stdin.isTTY)

  // 交互式走带框输入区；管道/重定向走行队列（脚本与测试依赖后者）
  if (isTty && !process.env['NUCLEUS_NO_BOX']) {
    return interactiveLoop(n, session)
  }

  const rl = createInterface({
    input: stdin,
    output: opts.output ?? process.stdout,
    terminal: false,
  })

  printBanner(n, session)
  line(c.gray(`  ${ICON.prompt} 直接输入提问 · /help 看命令 · /exit 退出`))
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
      line(`${petStill('idle')} ${c.gray('再见')}`)
      rl.close()
    }
  }
  rl.on('SIGINT', onSigint)

  const interactive = rl.terminal
  const prompt = () => {
    if (interactive) process.stdout.write(`${c.cyan(ICON.prompt)} `)
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
      agentId: n.config.defaults.entryAgent,
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
      line(`${petStill('idle')} ${c.gray('再见')}`)
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
        line(c.gray('本地模型可直接写 ollama:<模型名>，无需预先配置'))
        return false
      }
      const chain = arg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      // 先校验再生效：写错模型名要立刻知道，而不是下一轮才炸。
      // `ollama:*` 放行 —— 本地模型动态解析，猜错最多报「模型不存在」，
      // 不像云端 provider 拼错会变成一次真实的付费调用。
      const unknown = chain.filter(
        (k) => !k.startsWith('ollama:') && !n.config.models.some((m) => m.key === k),
      )
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
  const conv = session.conversationId ?? '（首次提问时创建）'
  const model = (session.modelChain ?? n.config.defaults.modelChain).join(' → ')
  const agents = n.config.agents.map((a) => a.id).join(' · ')

  line()
  line(`${petStill('happy')}  ${c.bold('nucleus')} ${c.gray('多 agent 编排运行时')}`)
  line()
  line(`  ${c.gray('会话')}  ${c.cyan(conv)}`)
  // 模型链用 → 连接：这是**降级顺序**而不是并列，第一个挂了才轮到第二个
  line(`  ${c.gray('模型')}  ${c.cyan(model)}`)
  line(`  ${c.gray('agent')} ${c.gray(agents)}`)
  line(`  ${c.gray('入口')}  ${c.cyan(n.config.defaults.entryAgent)}`)
  line()
  // 假模型必须显著提示 —— 把 mock 的回答当真是最严重的失败模式
  if (isMockOnly(n.config)) {
    line(`  ${ICON.warn} ${c.yellow('当前是 mock 模型，回答是假的，不会调用任何真实模型')}`)
    line(c.gray('     配置真实模型：cp nucleus.config.example.json nucleus.config.json'))
    line()
  }
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
