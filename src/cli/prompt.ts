import { createInterface } from 'node:readline'
import { c, line, visibleLength } from './ui.js'

/**
 * 交互式单选 / 输入。
 *
 * ── 为什么不直接用现成的 prompt 库 ────────────────────────
 *
 * 这里要的东西很少（单选 + 一行输入 + 是否），而现成的库会把 raw mode、
 * 信号处理、ANSI 渲染整套带进来 —— 而这个项目已经有一套（`input.ts` 的
 * `BoxInput`）。再引一套意味着两处 raw mode 逻辑，退出时谁负责把终端恢复
 * 就说不清了 —— 那类 bug 的症状是「跑完命令终端不回显了」。
 *
 * ── 两条路径，不是「优雅降级」而是必须都对 ─────────────────
 *
 * TTY 下用方向键选；**非 TTY 下必须仍然可用**（管道、CI、脚本）。
 * 后者不是可选项：一个只能手动跑的配置向导，在「照着文档一步步做」的场景里
 * 等于不存在。所以非 TTY 走「打印编号 + 读一行数字」。
 *
 * ── 渲染的关键约束 ────────────────────────────────────
 *
 * 重画前要**精确擦掉上一次画的行数**。少擦一行会留下残影，多擦一行会吃掉
 * 上面的正文 —— 后者更糟，因为它把你刚看过的上下文吞了。所以记住画了几行。
 */

export interface Choice<T> {
  value: T
  label: string
  /** 第二行的说明，灰字 */
  detail?: string
  /** 不可选（比如「OAuth：还没配 clientId」），但要显示出来说明为什么 */
  disabled?: string
}

export interface SelectOptions {
  /** 超过这个数就分页显示 */
  pageSize?: number
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  /** 强制走非 TTY 路径（测试用） */
  forceNumbered?: boolean
}

const ESC = '\x1b'

/** 画出一页选项。纯函数 —— 渲染是这里最容易出错的部分，要能单测 */
export function renderChoices<T>(
  choices: Array<Choice<T>>,
  active: number,
  opts: { pageSize?: number; numbered?: boolean } = {},
): string[] {
  const pageSize = opts.pageSize ?? 12
  const total = choices.length
  // 让 active 尽量居中，但不越界
  let start = 0
  if (total > pageSize) {
    start = Math.max(0, Math.min(active - Math.floor(pageSize / 2), total - pageSize))
  }
  const end = Math.min(total, start + pageSize)

  const out: string[] = []
  for (let i = start; i < end; i++) {
    const ch = choices[i]!
    const on = i === active
    const bullet = opts.numbered ? `${String(i + 1).padStart(2)}.` : on ? '❯' : ' '
    const label = ch.disabled ? c.gray(ch.label) : on && !opts.numbered ? c.cyan(ch.label) : ch.label
    out.push(`  ${on && !opts.numbered ? c.cyan(bullet) : c.gray(bullet)} ${label}`)
    const note = ch.disabled ?? ch.detail
    if (note) out.push(`     ${c.gray(note)}`)
  }
  if (total > end || start > 0) {
    out.push(c.gray(`     … ${start + 1}-${end} / ${total}`))
  }
  return out
}

/** 键盘输入 → 动作。纯函数，方便把「按了什么」和「怎么响应」分开测 */
export type Key = 'up' | 'down' | 'enter' | 'cancel' | 'other'

export function classifyKey(data: string): Key {
  if (data === `${ESC}[A` || data === 'k') return 'up'
  if (data === `${ESC}[B` || data === 'j') return 'down'
  if (data === '\r' || data === '\n') return 'enter'
  // Ctrl-C / Ctrl-D / Esc 都算取消 —— 三个都是「我不想选了」的常见表达
  if (data === '\x03' || data === '\x04' || data === ESC) return 'cancel'
  return 'other'
}

/** 下一个可选项（跳过 disabled）。全都不可选时返回 -1 */
export function nextEnabled<T>(choices: Array<Choice<T>>, from: number, dir: 1 | -1): number {
  const n = choices.length
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n
    if (!choices[i]!.disabled) return i
  }
  return choices[from]?.disabled ? -1 : from
}

/**
 * 单选。返回 null 表示用户取消。
 *
 * 取消必须是**明确的返回值**而不是抛异常 —— 「用户按了 Ctrl-C」不是错误，
 * 而调用方几乎总要为它做点事（打印「已取消」而不是栈）。
 */
export async function select<T>(
  title: string,
  choices: Array<Choice<T>>,
  opts: SelectOptions = {},
): Promise<T | null> {
  const output = opts.output ?? process.stdout
  const input = opts.input ?? process.stdin
  const usable = choices.filter((x) => !x.disabled)
  if (usable.length === 0) {
    line(c.red('没有可选项'))
    for (const ch of choices) if (ch.disabled) line(c.gray(`  ${ch.label} —— ${ch.disabled}`))
    return null
  }
  // 只有一个能选时不必打扰 —— 但要说出来，别让人以为跳过了这一步
  if (usable.length === 1 && choices.length === 1) {
    line(`${title} ${c.cyan(usable[0]!.label)} ${c.gray('（只有这一个）')}`)
    return usable[0]!.value
  }

  const interactive = !opts.forceNumbered && Boolean(input.isTTY && output.isTTY)
  if (!interactive) return selectNumbered(title, choices, opts)

  let active = choices.findIndex((x) => !x.disabled)
  let drawn = 0

  /**
   * 重画。两个坑都在这里，而且**症状是同一个**（文字往右跑）：
   *
   * ① **raw mode 下 `\n` 只换行不回车。** 光标停在原来的列，所以每写一行都
   *    比上一行更靠右，画出一个楼梯。必须用 `\r\n`。
   *    （`input.ts` 里知道这件事 —— 它一直用 `\r\x1b[2K`。这里当初忘了。）
   *
   * ② **要按「物理行」而不是「逻辑行」上移。** 一行中文在窄一点的终端里会折成
   *    两行，那时 `ESC[nA` 上移得不够，擦除从中间开始，上一次的残留就留在屏幕上。
   *    所以按可见宽度算折行数。
   *
   * 上移之后还要 `\r` 回到第 0 列 —— `ESC[nA` **只动行不动列**，
   * 而 `ESC[0J` 是「从光标擦到屏幕末尾」，光标在第 20 列的话前 20 列就留着了。
   */
  const cols = () => (output.columns && output.columns > 20 ? output.columns : 80)
  const physicalRows = (lines: string[]) =>
    lines.reduce((n, l) => n + Math.max(1, Math.ceil(visibleLength(l) / cols())), 0)

  const draw = () => {
    if (drawn > 0) output.write(`${ESC}[${drawn}A\r${ESC}[0J`)
    const body = renderChoices(choices, active, {
      ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
    })
    const foot = c.gray('  ↑↓ 选择 · Enter 确认 · Ctrl-C 取消')
    const lines = [...body, foot]
    output.write(lines.join('\r\n') + '\r\n')
    drawn = physicalRows(lines)
  }

  line(title)
  const wasRaw = input.isRaw
  input.setRawMode?.(true)
  input.resume()
  // 隐藏光标 —— 它会在列表里乱跳
  output.write(`${ESC}[?25l`)

  try {
    draw()
    for (;;) {
      const key = await new Promise<Key>((resolve) => {
        const onData = (buf: Buffer) => {
          input.off('data', onData)
          resolve(classifyKey(buf.toString('utf8')))
        }
        input.on('data', onData)
      })
      if (key === 'cancel') return null
      if (key === 'enter') return choices[active]!.value
      if (key === 'up') active = nextEnabled(choices, active, -1)
      if (key === 'down') active = nextEnabled(choices, active, 1)
      if (key === 'up' || key === 'down') draw()
    }
  } finally {
    output.write(`${ESC}[?25h`)
    input.setRawMode?.(Boolean(wasRaw))
    input.pause()
  }
}

/** 非 TTY：打印编号，读一行数字。管道与脚本里唯一可用的形态 */
async function selectNumbered<T>(
  title: string,
  choices: Array<Choice<T>>,
  opts: SelectOptions,
): Promise<T | null> {
  line(title)
  for (const l of renderChoices(choices, -1, { numbered: true, pageSize: choices.length })) line(l)
  const answer = await readLine('  输入编号（回车取消）：', opts)
  if (!answer.trim()) return null
  const i = Number(answer.trim()) - 1
  if (!Number.isInteger(i) || i < 0 || i >= choices.length) {
    line(c.red(`「${answer.trim()}」不是 1-${choices.length} 之间的编号`))
    return null
  }
  const ch = choices[i]!
  if (ch.disabled) {
    line(c.red(`${ch.label} 不可选 —— ${ch.disabled}`))
    return null
  }
  return ch.value
}

/**
 * 读一行 —— TTY 与管道走**两条完全不同的路**。
 *
 * ── 为什么不能都用 readline ────────────────────────────
 *
 * 管道输入时 readline 会把能读的**一次全读进缓冲**，然后在 EOF 时关闭接口 ——
 * 哪怕后面的问题还没问。第二个 `question()` 直接抛 `readline was closed`。
 *
 * 症状是向导问完第一个问题就崩，报一句和「输入」毫无关系的话。
 * 我第一版还踩了另一个更隐蔽的：每次 readLine 新建再 close 接口 ——
 * `close()` 把 stdin 一起带走，于是第二次读**什么都拿不到而且不报错**。
 *
 * 所以：**管道下一次读完 stdin，按行出队。** 那既正确又可测
 * （测试可以直接喂一个字符串数组）。TTY 下才用 readline（要它的行编辑）。
 */
let queued: string[] | null = null
let rl: ReturnType<typeof createInterface> | null = null

/** 一次读完非 TTY 的 stdin。返回行数组（末尾空行去掉） */
async function drainStdin(input: NodeJS.ReadStream): Promise<string[]> {
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 预置输入队列 —— 测试用，免得真去碰 stdin */

/** 向导结束时调一次 —— readline 不关的话进程不会退出 */
export function closePrompts(): void {
  rl?.close()
  rl = null
  queued = null
}

export async function readLine(prompt: string, opts: SelectOptions = {}): Promise<string> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout

  // TTY：用 readline，要它的行编辑与回显
  if (input.isTTY && !opts.forceNumbered) {
    if (!rl) rl = createInterface({ input, output })
    return new Promise<string>((resolve) => rl!.question(prompt, resolve))
  }

  // 管道 / 脚本：一次读完，按行出队
  if (queued === null) queued = await drainStdin(input)
  const next = queued.shift() ?? ''
  // 回显 —— 否则事后看不出每个问题被答了什么
  output.write(`${prompt}${next}\n`)
  return next
}

/** 是否。默认值在提示里显示成大写 */
export async function confirm(
  question: string,
  defaultYes = true,
  opts: SelectOptions = {},
): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const a = (await readLine(`${question} ${c.gray(hint)} `, opts)).trim().toLowerCase()
  if (!a) return defaultYes
  return a === 'y' || a === 'yes'
}

/**
 * 让用户输入一个数字。
 *
 * `required` 时空输入会**再问一次**而不是取默认值 —— 有些数字（contextWindow）
 * 没有合理的默认，替人猜比让人多按一次回车糟得多。
 */
export async function askNumber(
  question: string,
  opts: SelectOptions & { min?: number; max?: number; required?: boolean } = {},
): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = (await readLine(`${question} `, opts)).trim().replace(/[_,]/g, '')
    if (!a) {
      if (!opts.required) return null
      line(c.yellow('  这一项没有默认值，必须填。'))
      continue
    }
    const n = Number(a)
    if (!Number.isFinite(n) || n <= 0) {
      line(c.red(`  「${a}」不是正数`))
      continue
    }
    if (opts.min !== undefined && n < opts.min) {
      line(c.red(`  太小了，至少 ${opts.min}`))
      continue
    }
    if (opts.max !== undefined && n > opts.max) {
      line(c.red(`  太大了，最多 ${opts.max}`))
      continue
    }
    return n
  }
  return null
}
