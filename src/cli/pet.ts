import { c } from './ui.js'

/**
 * 终端里的一只猫，名叫 Nu。
 *
 * 为什么这不只是玩票：这个运行时的一轮任务经常要几十秒到几分钟
 * （编排者 + 若干专家 + 可能是本地模型），中间大段时间是纯等待。
 * 一条静止的进度行没法区分「在想」和「已经卡死」—— 而「任务挂住了却
 * 看不出来」正是我们要修的老问题之一。会眨眼、会摇尾巴的活物把
 * 「系统还活着」变成一眼可见的事实，挂起时打呼、出错时炸毛，
 * 顺带把状态也说清楚了。
 *
 * 三条硬约束：
 *  1. **非 TTY 一个字节都不输出**。管道、CI、测试里动画是纯噪音，
 *     转义序列还会污染被断言的输出。
 *  2. 动画只占**一行**，用 \r 原地重绘，绝不使用 alt-buffer ——
 *     全屏切换在 SSH 和各种终端下兼容性差，且一旦崩溃会留下烂摊子。
 *  3. 帧计算是纯函数，测试不需要定时器。
 */

export type Mood =
  /** 空闲 */
  | 'idle'
  /** 等模型回话 */
  | 'think'
  /** 正在执行工具 */
  | 'work'
  /** 挂起，等子 run */
  | 'wait'
  /** 成功收尾 */
  | 'happy'
  /** 失败 */
  | 'sad'

/**
 * 每种情绪 4 帧。
 *
 * 只用宽度确定的字符：ASCII + 半角片假名中点(･) + 希腊 ω。
 * 刻意避开 ⌒ ノ ᵕ 之类 —— 它们在等宽字体里宽度不定，会让行尾抖动。
 */
const FRAMES: Record<Mood, readonly string[]> = {
  // 偶尔眨一下眼，仅此而已 —— 空闲时不该抢注意力
  idle: ['(=^･ω･^=)', '(=^･ω･^=)', '(=^･ω･^=)', '(=^-ω-^=)'],
  think: ['(=^･ω･^=)?', '(=^･ω･^=)?', '(=^-ω-^=)?', '(=^･ω･^=)?'],
  // 摇尾巴：动得最明显的状态，因为这时确实在干活
  work: ['(=^･ω･^=)~', '(=^･ω･^=)~~', '(=^･ω･^=)~~~', '(=^･ω･^=)~~'],
  wait: ['(=-ω-=) z', '(=-ω-=) zz', '(=-ω-=) zzz', '(=-ω-=) zz'],
  happy: ['(=^ω^=)/', '(=^ω^=)|', '(=^ω^=)/', '(=^ω^=)|'],
  sad: ['(=;ω;=)', '(=;ω;=)', '(=xωx=)', '(=;ω;=)'],
}

/** 情绪对应的说法，慢速轮换，避免长时间一动不动 */
const VERBS: Record<Mood, readonly string[]> = {
  idle: ['待命'],
  think: ['琢磨中', '思考中', '盘算中'],
  work: ['干活中', '忙着呢', '处理中'],
  wait: ['等专家', '打个盹', '候着'],
  happy: ['搞定'],
  sad: ['出问题了'],
}

const COLOR: Record<Mood, (s: string) => string> = {
  idle: c.gray,
  think: c.cyan,
  work: c.cyan,
  wait: c.yellow,
  happy: c.green,
  sad: c.red,
}

/** 情绪 → 当前帧。纯函数，tick 从 0 开始单调递增。 */
export function petFrame(mood: Mood, tick: number): string {
  const f = FRAMES[mood]
  return f[((tick % f.length) + f.length) % f.length]!
}

/** 情绪 → 当前说法。比帧慢得多（每 20 帧换一次），否则读不完就变了。 */
export function petVerb(mood: Mood, tick: number): string {
  const v = VERBS[mood]
  return v[Math.floor(Math.max(0, tick) / 20) % v.length]!
}

/** 1234 → 1.2k；给状态行用，越短越好 */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function elapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

export interface StatusLineInput {
  mood: Mood
  tick: number
  /** 当前在做什么的补充说明，如 agent id 或工具名 */
  context?: string | null
  elapsedMs: number
  tokens?: number
  /** 末尾提示，如「Ctrl-C 取消」 */
  hint?: string | null
}

/**
 * 组装状态行。纯函数 —— 动画的全部内容都在这里，测试只需要比字符串。
 *
 * 形如：`(=^･ω･^=)~~ 干活中… write_report · 3.2s · 1.2k tok · Ctrl-C 取消`
 */
export function statusLine(i: StatusLineInput): string {
  const tint = COLOR[i.mood]
  const parts = [i.context, elapsed(i.elapsedMs)]
  if (i.tokens) parts.push(`${compactTokens(i.tokens)} tok`)
  if (i.hint) parts.push(i.hint)
  const tail = parts.filter(Boolean).join(' · ')
  return `${tint(petFrame(i.mood, i.tick))} ${tint(petVerb(i.mood, i.tick) + '…')} ${c.gray(tail)}`
}

export interface PetOptions {
  out?: NodeJS.WritableStream
  /**
   * 是否播动画。默认：输出是 TTY 且没设 NUCLEUS_NO_ANIM。
   * 显式传入便于测试两条分支。
   */
  animate?: boolean
  intervalMs?: number
  /** 便于测试注入；默认 Date.now */
  now?: () => number
}

/**
 * 会动的状态行。
 *
 * 与永久输出的关系是这个类存在的主要理由：动画占着最后一行，
 * 任何永久输出都必须先擦掉它再打印，否则会撞在一起。所以打印
 * 一律走 `say()`，而不是直接 `console.log`。
 */
export class Pet {
  readonly animate: boolean
  #out: NodeJS.WritableStream
  #interval: number
  #now: () => number

  #timer: ReturnType<typeof setInterval> | null = null
  #tick = 0
  #mood: Mood = 'idle'
  #context: string | null = null
  #tokens = 0
  #hint: string | null = null
  #t0: number
  /** 屏幕上是否有一行待擦除的动画 */
  #onScreen = false

  constructor(opts: PetOptions = {}) {
    this.#out = opts.out ?? process.stdout
    this.#interval = opts.intervalMs ?? 160
    this.#now = opts.now ?? (() => Date.now())
    this.#t0 = this.#now()
    this.animate =
      opts.animate ??
      (Boolean((this.#out as NodeJS.WriteStream).isTTY) && !process.env['NUCLEUS_NO_ANIM'])
  }

  /** 开始动。已经在动时只改情绪。 */
  start(mood: Mood = 'think', context?: string | null): this {
    this.#mood = mood
    this.#context = context ?? null
    this.#t0 = this.#now()
    if (!this.animate || this.#timer) return this
    this.#draw()
    this.#timer = setInterval(() => {
      this.#tick++
      this.#draw()
    }, this.#interval)
    // 动画不该拖住进程退出
    this.#timer.unref?.()
    return this
  }

  mood(m: Mood, context?: string | null): this {
    this.#mood = m
    if (context !== undefined) this.#context = context
    if (this.animate && this.#timer) this.#draw()
    return this
  }

  context(s: string | null): this {
    this.#context = s
    if (this.animate && this.#timer) this.#draw()
    return this
  }

  addTokens(n: number): this {
    this.#tokens += n
    return this
  }

  hint(s: string | null): this {
    this.#hint = s
    return this
  }

  /**
   * 打印一行永久输出。
   *
   * 先擦动画再打印再重绘 —— 这是动画与滚动输出唯一安全的共存方式。
   * 非动画模式下退化成普通输出，所以调用方不需要分支。
   */
  say(s = ''): this {
    this.#erase()
    this.#out.write(s + '\n')
    if (this.#timer) this.#draw()
    return this
  }

  /** 停止并擦掉动画行；给了 final 就在原位留下一行永久结论。 */
  stop(final?: string): this {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.#erase()
    if (final !== undefined) this.#out.write(final + '\n')
    return this
  }

  /** 当前状态行内容；测试与非动画模式下取一次性快照用 */
  render(): string {
    return statusLine({
      mood: this.#mood,
      tick: this.#tick,
      context: this.#context,
      elapsedMs: this.#now() - this.#t0,
      tokens: this.#tokens,
      hint: this.#hint,
    })
  }

  #draw(): void {
    if (!this.animate) return
    // \r 回到行首，\x1b[2K 清整行 —— 帧宽度会变，不清会留下上一帧的尾巴
    this.#out.write(`\r\x1b[2K${this.render()}`)
    this.#onScreen = true
  }

  #erase(): void {
    if (!this.#onScreen) return
    this.#out.write('\r\x1b[2K')
    this.#onScreen = false
  }
}

/** 打招呼用的静止猫，给 banner */
export function petStill(mood: Mood = 'idle'): string {
  return COLOR[mood](petFrame(mood, 0))
}
