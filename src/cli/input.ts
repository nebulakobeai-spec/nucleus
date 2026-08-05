import { charWidth, visibleLength } from './ui.js'

/**
 * 带框的输入区。
 *
 * 为什么自己写而不用 readline：readline 只给一行内联提示符，做不了
 * 「边框 + 光标在框内 + 下方弹联想」。要这些就必须接管键盘（raw mode
 * 逐键处理），于是解析、状态、渲染全都得自己来。
 *
 * 拆法是刻意的：
 *  - `LineEditor` 是**纯状态机** —— `feed('\\x1b[D')` 进去，状态变化出来，
 *    不碰终端。键盘处理最容易出错，能喂字符串测才敢改。
 *  - `layout()` 是纯函数 —— 换行与光标坐标一起算出来，两者用同一套
 *    宽度规则，中文才不会让光标跑偏。
 *  - `BoxInput` 只负责 raw mode、重绘、resize。
 *
 * 明确不做全屏 alt-buffer：SSH 下兼容性差，崩溃会留下烂摊子。
 * 这里只在**底部固定几行**内重绘，上面的滚动输出照常。
 */

export interface Completion {
  /** 补全后的完整文本，如 `/model ` */
  value: string
  /** 展示用的名字，如 `/model` */
  label: string
  /** 右侧说明 */
  hint: string
}

export type EditorEvent =
  | { type: 'submit'; text: string }
  /** Ctrl-C：取消当前输入或中断请求 */
  | { type: 'cancel' }
  /** Ctrl-D 且输入为空：退出 */
  | { type: 'eof' }
  /** 需要重绘 */
  | { type: 'changed' }

export interface LineEditorOptions {
  /** 根据当前输入给出候选；返回空数组表示不弹 */
  complete?: (buffer: string) => Completion[]
  history?: string[]
  /** 联想列表最多显示几条 */
  maxSuggestions?: number
}

/** 把字符串按码点切开 —— 不能按 UTF-16 单元，否则 emoji 会被切半 */
const chars = (s: string): string[] => [...s]

export class LineEditor {
  #buf: string[] = []
  #cursor = 0
  #history: string[]
  /** null 表示在编辑新内容，数字是在浏览历史 */
  #histIdx: number | null = null
  /** 进入历史浏览前的草稿，退出时还原 */
  #draft = ''
  #suggestions: Completion[] = []
  #suggestIdx = 0
  #complete: (buffer: string) => Completion[]
  #maxSuggestions: number
  /** bracketed paste 区间内，所有字节都当字面量 */
  #pasting = false
  #pasteBuf = ''

  constructor(opts: LineEditorOptions = {}) {
    this.#history = [...(opts.history ?? [])]
    this.#complete = opts.complete ?? (() => [])
    this.#maxSuggestions = opts.maxSuggestions ?? 6
  }

  get text(): string {
    return this.#buf.join('')
  }
  get cursor(): number {
    return this.#cursor
  }
  get suggestions(): readonly Completion[] {
    return this.#suggestions
  }
  get suggestIndex(): number {
    return this.#suggestIdx
  }
  get history(): readonly string[] {
    return this.#history
  }

  /** 清空当前输入，保留历史 */
  reset(): void {
    this.#buf = []
    this.#cursor = 0
    this.#histIdx = null
    this.#draft = ''
    this.#refreshSuggestions()
  }

  /** 提交后记入历史（去掉与上一条重复的） */
  remember(text: string): void {
    const t = text.trim()
    if (!t) return
    if (this.#history[this.#history.length - 1] === t) return
    this.#history.push(t)
  }

  /**
   * 喂入原始输入。
   *
   * 一次 data 可能含多个键（快速输入、粘贴、以及一次完整的转义序列），
   * 所以要循环解析而不是假定「一次一个键」。
   */
  feed(data: string): EditorEvent[] {
    const out: EditorEvent[] = []
    let i = 0

    while (i < data.length) {
      // ── bracketed paste：区间内一律当字面量 ──
      if (this.#pasting) {
        const end = data.indexOf('\x1b[201~', i)
        if (end < 0) {
          this.#pasteBuf += data.slice(i)
          return out.length ? out : [{ type: 'changed' }]
        }
        this.#pasteBuf += data.slice(i, end)
        this.#insertPaste(this.#pasteBuf)
        this.#pasteBuf = ''
        this.#pasting = false
        i = end + 6
        out.push({ type: 'changed' })
        continue
      }
      if (data.startsWith('\x1b[200~', i)) {
        this.#pasting = true
        i += 6
        continue
      }

      const [ev, consumed] = this.#key(data, i)
      i += consumed
      if (ev) out.push(ev)
    }

    return out
  }

  /** 解析一个键，返回事件与消耗的字符数 */
  #key(data: string, i: number): [EditorEvent | null, number] {
    const rest = data.slice(i)

    // ── 转义序列 ──
    const seq: Array<[string, () => EditorEvent | null]> = [
      ['\x1b[A', () => this.#up()],
      ['\x1b[B', () => this.#down()],
      ['\x1b[C', () => this.#move(1)],
      ['\x1b[D', () => this.#move(-1)],
      ['\x1b[H', () => this.#home()],
      ['\x1b[F', () => this.#end()],
      ['\x1b[1~', () => this.#home()],
      ['\x1b[4~', () => this.#end()],
      ['\x1b[3~', () => this.#deleteForward()],
      // Alt/Option + 左右：按词移动
      ['\x1b[1;5C', () => this.#moveWord(1)],
      ['\x1b[1;5D', () => this.#moveWord(-1)],
      ['\x1bb', () => this.#moveWord(-1)],
      ['\x1bf', () => this.#moveWord(1)],
      // Alt+Enter / Option+Enter：插入换行而不提交
      ['\x1b\r', () => this.#insert('\n')],
      ['\x1b\n', () => this.#insert('\n')],
    ]
    for (const [s, fn] of seq) {
      if (rest.startsWith(s)) return [fn(), s.length]
    }

    const ch = rest[0]!

    // ── 控制字符 ──
    switch (ch) {
      case '\r':
      case '\n':
        return [this.#submit(), 1]
      case '\x7f':
      case '\b':
        return [this.#backspace(), 1]
      case '\t':
        return [this.#acceptSuggestion(), 1]
      case '\x03': // Ctrl-C
        return [{ type: 'cancel' }, 1]
      case '\x04': // Ctrl-D
        return [this.#buf.length === 0 ? { type: 'eof' } : this.#deleteForward(), 1]
      case '\x01': // Ctrl-A
        return [this.#home(), 1]
      case '\x05': // Ctrl-E
        return [this.#end(), 1]
      case '\x15': // Ctrl-U 清空到行首
        this.#buf.splice(0, this.#cursor)
        this.#cursor = 0
        this.#refreshSuggestions()
        return [{ type: 'changed' }, 1]
      case '\x0b': // Ctrl-K 删到行尾
        this.#buf.splice(this.#cursor)
        this.#refreshSuggestions()
        return [{ type: 'changed' }, 1]
      case '\x17': // Ctrl-W 删一个词
        return [this.#deleteWord(), 1]
      case '\x1b': // 落单的 ESC：关掉联想
        if (this.#suggestions.length) {
          this.#suggestions = []
          return [{ type: 'changed' }, 1]
        }
        return [null, 1]
    }

    // 其它控制字符一律忽略，避免把终端弄花
    if (ch < ' ') return [null, 1]

    // ── 可见字符 ──
    // 按码点取，避免把 emoji 的代理对切开
    const cp = String.fromCodePoint(rest.codePointAt(0)!)
    return [this.#insert(cp), cp.length]
  }

  // ── 编辑动作 ────────────────────────────────────────────

  #insert(s: string): EditorEvent {
    this.#buf.splice(this.#cursor, 0, ...chars(s))
    this.#cursor += chars(s).length
    this.#histIdx = null
    this.#refreshSuggestions()
    return { type: 'changed' }
  }

  /**
   * 粘贴。
   *
   * 多行粘贴保留换行而**不逐行提交** —— 粘一段 5 行的文字应该得到
   * 一条 5 行的输入，而不是发出 5 次请求。
   */
  #insertPaste(s: string): void {
    // \r\n 与裸 \r 统一成 \n
    this.#insert(s.replace(/\r\n?/g, '\n'))
  }

  #backspace(): EditorEvent {
    if (this.#cursor > 0) {
      this.#buf.splice(this.#cursor - 1, 1)
      this.#cursor--
      this.#refreshSuggestions()
    }
    return { type: 'changed' }
  }

  #deleteForward(): EditorEvent {
    if (this.#cursor < this.#buf.length) {
      this.#buf.splice(this.#cursor, 1)
      this.#refreshSuggestions()
    }
    return { type: 'changed' }
  }

  #deleteWord(): EditorEvent {
    let i = this.#cursor
    while (i > 0 && this.#buf[i - 1] === ' ') i--
    while (i > 0 && this.#buf[i - 1] !== ' ') i--
    this.#buf.splice(i, this.#cursor - i)
    this.#cursor = i
    this.#refreshSuggestions()
    return { type: 'changed' }
  }

  #move(d: number): EditorEvent {
    this.#cursor = Math.max(0, Math.min(this.#buf.length, this.#cursor + d))
    return { type: 'changed' }
  }

  #moveWord(d: number): EditorEvent {
    if (d < 0) {
      while (this.#cursor > 0 && this.#buf[this.#cursor - 1] === ' ') this.#cursor--
      while (this.#cursor > 0 && this.#buf[this.#cursor - 1] !== ' ') this.#cursor--
    } else {
      while (this.#cursor < this.#buf.length && this.#buf[this.#cursor] !== ' ') this.#cursor++
      while (this.#cursor < this.#buf.length && this.#buf[this.#cursor] === ' ') this.#cursor++
    }
    return { type: 'changed' }
  }

  #home(): EditorEvent {
    this.#cursor = 0
    return { type: 'changed' }
  }

  #end(): EditorEvent {
    this.#cursor = this.#buf.length
    return { type: 'changed' }
  }

  #submit(): EditorEvent {
    // 联想开着时，回车先当「选中」用 —— 与 Tab 一致
    if (this.#suggestions.length) return this.#acceptSuggestion()
    const text = this.text
    this.remember(text)
    this.reset()
    return { type: 'submit', text }
  }

  // ── 历史与联想共用上下键 ────────────────────────────────

  /**
   * 上键：联想开着时在候选里移动，否则翻历史。
   *
   * 共用一组键是刻意的 —— 用户不必记「什么时候上键是历史」，
   * 屏幕上有没有候选列表就是答案。
   */
  #up(): EditorEvent {
    if (this.#suggestions.length) {
      this.#suggestIdx =
        (this.#suggestIdx - 1 + this.#suggestions.length) % this.#suggestions.length
      return { type: 'changed' }
    }
    if (this.#history.length === 0) return { type: 'changed' }
    if (this.#histIdx === null) {
      this.#draft = this.text
      this.#histIdx = this.#history.length - 1
    } else if (this.#histIdx > 0) {
      this.#histIdx--
    }
    this.#load(this.#history[this.#histIdx]!)
    return { type: 'changed' }
  }

  #down(): EditorEvent {
    if (this.#suggestions.length) {
      this.#suggestIdx = (this.#suggestIdx + 1) % this.#suggestions.length
      return { type: 'changed' }
    }
    if (this.#histIdx === null) return { type: 'changed' }
    if (this.#histIdx < this.#history.length - 1) {
      this.#histIdx++
      this.#load(this.#history[this.#histIdx]!)
    } else {
      // 翻到底回到草稿，而不是卡在最后一条
      this.#histIdx = null
      this.#load(this.#draft)
    }
    return { type: 'changed' }
  }

  #load(text: string): void {
    this.#buf = chars(text)
    this.#cursor = this.#buf.length
    this.#suggestions = []
  }

  #acceptSuggestion(): EditorEvent {
    const pick = this.#suggestions[this.#suggestIdx]
    if (!pick) return { type: 'changed' }
    this.#buf = chars(pick.value)
    this.#cursor = this.#buf.length
    this.#suggestions = []
    this.#suggestIdx = 0
    return { type: 'changed' }
  }

  #refreshSuggestions(): void {
    this.#suggestions = this.#complete(this.text).slice(0, this.#maxSuggestions)
    this.#suggestIdx = 0
  }
}

// ═══════════════════════════════════════════════════════
// 布局：换行与光标坐标必须用同一套宽度规则算
// ═══════════════════════════════════════════════════════

export interface Layout {
  /** 框内每一行的文本（不含边框） */
  rows: string[]
  /** 光标所在行（0 起） */
  cursorRow: number
  /** 光标所在列（0 起，按显示宽度） */
  cursorCol: number
}

/**
 * 按显示宽度折行，并算出光标坐标。
 *
 * 两件事必须在同一个函数里做完 —— 分开算的话，中文、emoji 或者
 * 显式换行只要有一处规则不一致，光标就会跑到别的地方去。
 */
export function layout(text: string, cursor: number, width: number): Layout {
  const w = Math.max(1, width)
  const rows: string[] = []
  let line = ''
  let lineWidth = 0
  let cursorRow = 0
  let cursorCol = 0
  let idx = 0

  const flush = () => {
    rows.push(line)
    line = ''
    lineWidth = 0
  }

  for (const ch of text) {
    if (idx === cursor) {
      cursorRow = rows.length
      cursorCol = lineWidth
    }
    if (ch === '\n') {
      flush()
      idx++
      continue
    }
    const cw = charWidth(ch)
    if (lineWidth + cw > w) flush()
    line += ch
    lineWidth += cw
    idx++
  }
  if (idx === cursor) {
    cursorRow = rows.length
    cursorCol = lineWidth
  }
  // 光标正好落在行尾且已满时，移到下一行开头
  if (cursorCol >= w) {
    cursorRow++
    cursorCol = 0
  }
  rows.push(line)

  return { rows, cursorRow, cursorCol }
}

export interface BoxTheme {
  /** 提示符，画在第一行内容前 */
  prompt: string
  /** 边框上色函数 */
  border: (s: string) => string
  dim: (s: string) => string
  accent: (s: string) => string
}

export interface RenderedBox {
  lines: string[]
  /** 光标应落在第几行（0 起，相对于 lines） */
  cursorRow: number
  /** 光标应落在第几列（0 起，绝对列，含边框与提示符） */
  cursorCol: number
}

/**
 * 画出输入框。纯函数 —— 测试比字符串就能覆盖对齐与联想。
 */
export function renderBox(
  state: { text: string; cursor: number; suggestions: readonly Completion[]; suggestIndex: number },
  width: number,
  theme: BoxTheme,
  footer?: string,
): RenderedBox {
  // 边框 2 列 + 左右各 1 空格 = 4；再让出提示符的宽度
  const promptWidth = visibleLength(theme.prompt) + 1
  const inner = Math.max(8, width - 4)
  const content = Math.max(4, inner - promptWidth)

  const lay = layout(state.text, state.cursor, content)
  const lines: string[] = []

  lines.push(theme.border('╭' + '─'.repeat(inner + 2) + '╮'))
  lay.rows.forEach((row, i) => {
    const head = i === 0 ? theme.accent(theme.prompt) + ' ' : ' '.repeat(promptWidth)
    const pad = ' '.repeat(Math.max(0, content - visibleLength(row)))
    lines.push(theme.border('│') + ' ' + head + row + pad + ' ' + theme.border('│'))
  })
  lines.push(theme.border('╰' + '─'.repeat(inner + 2) + '╯'))

  // ── 联想列表 ──
  if (state.suggestions.length) {
    const labelW = Math.max(...state.suggestions.map((s) => visibleLength(s.label)))
    state.suggestions.forEach((s, i) => {
      const on = i === state.suggestIndex
      const label = s.label + ' '.repeat(labelW - visibleLength(s.label))
      lines.push(
        '  ' +
          (on ? theme.accent('❯ ' + label) : '  ' + theme.dim(label)) +
          '  ' +
          theme.dim(s.hint),
      )
    })
  } else if (footer) {
    lines.push('  ' + theme.dim(footer))
  }

  return {
    lines,
    // +1 跳过上边框
    cursorRow: 1 + lay.cursorRow,
    // 左边框 + 空格 + 提示符宽度
    cursorCol: 2 + promptWidth + lay.cursorCol,
  }
}

// ═══════════════════════════════════════════════════════
// 终端驱动
// ═══════════════════════════════════════════════════════

export interface BoxInputOptions {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  complete?: (buffer: string) => Completion[]
  history?: string[]
  theme: BoxTheme
  /** 框下面那行灰字提示 */
  footer?: string
  /** 不在读输入时收到 Ctrl-C（用于取消正在跑的请求） */
  onInterrupt?: () => void
}

export type ReadResult =
  | { type: 'submit'; text: string }
  /**
   * Ctrl-C。`hadText` 区分两种意图：
   *
   *  有文字 → 你想清掉这一行
   *  空手   → 你想退出（连按两次才真退，见 chat.ts）
   *
   * 不带这个标志的话上层没法分开处理，只能二选一 ——
   * 而原先选的是「永不退出」，于是 Ctrl-C 退不出去。
   */
  | { type: 'cancel'; hadText: boolean }
  | { type: 'eof' }

/**
 * 底部固定的输入框。
 *
 * 生命周期与「跑任务」是错开的：读输入时显示框，提交后把框擦掉、
 * 打印一行永久的 `❯ 你问的话`，然后让动画接管底部那一行。
 * 这样框和滚动输出永远不会互相覆盖。
 *
 * stdin 的监听是**常驻**的：跑任务期间不读输入，但 raw mode 下 Ctrl-C
 * 不再产生 SIGINT，只能自己从字节流里认出 \x03。
 */
export class BoxInput {
  #in: NodeJS.ReadStream
  #out: NodeJS.WriteStream
  #editor: LineEditor
  #theme: BoxTheme
  #footer: string | undefined
  #onInterrupt: (() => void) | undefined

  #mode: 'idle' | 'reading' = 'idle'
  #resolve: ((r: ReadResult) => void) | null = null
  /** 屏幕上框占了几行 */
  #height = 0
  #cursorRow = 0
  #closed = false

  #onData = (chunk: Buffer | string): void => this.#handle(String(chunk))
  #onResize = (): void => {
    if (this.#mode === 'reading') {
      this.#erase()
      this.#draw()
    }
  }

  constructor(opts: BoxInputOptions) {
    this.#in = opts.input ?? process.stdin
    this.#out = opts.output ?? process.stdout
    this.#theme = opts.theme
    this.#footer = opts.footer
    this.#onInterrupt = opts.onInterrupt
    this.#editor = new LineEditor({
      ...(opts.complete ? { complete: opts.complete } : {}),
      ...(opts.history ? { history: opts.history } : {}),
    })

    this.#in.setRawMode?.(true)
    this.#in.resume()
    this.#in.setEncoding('utf8')
    this.#in.on('data', this.#onData)
    this.#out.on('resize', this.#onResize)
    // bracketed paste：让终端把粘贴用 \x1b[200~ / \x1b[201~ 包起来，
    // 否则多行粘贴会被当成连续回车，一段话变成好几次提交
    this.#out.write('\x1b[?2004h')
  }

  get history(): readonly string[] {
    return this.#editor.history
  }

  /** 显示输入框并等一次输入 */
  read(): Promise<ReadResult> {
    if (this.#closed) return Promise.resolve({ type: 'eof' })
    this.#mode = 'reading'
    this.#editor.reset()
    this.#draw()
    return new Promise<ReadResult>((resolve) => {
      this.#resolve = resolve
    })
  }

  /** 擦掉框并打印永久输出 */
  print(s = ''): void {
    const showing = this.#mode === 'reading' && this.#height > 0
    if (showing) this.#erase()
    this.#out.write(s + '\n')
    if (showing) this.#draw()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#mode === 'reading') this.#erase()
    this.#out.write('\x1b[?2004l')
    this.#in.off('data', this.#onData)
    this.#out.off('resize', this.#onResize)
    this.#in.setRawMode?.(false)
    this.#in.pause()
    this.#mode = 'idle'
  }

  #handle(data: string): void {
    if (this.#mode !== 'reading') {
      // 不读输入时只认中断 —— raw mode 下没有 SIGINT
      if (data.includes('\x03')) this.#onInterrupt?.()
      return
    }

    let done: ReadResult | null = null
    for (const ev of this.#editor.feed(data)) {
      if (ev.type === 'submit') done = { type: 'submit', text: ev.text }
      // 按下那一刻还有没有字 —— 编辑器已经清了 buffer，所以要在这里取
      else if (ev.type === 'cancel') done = { type: 'cancel', hadText: this.#editor.text.length > 0 }
      else if (ev.type === 'eof') done = { type: 'eof' }
    }

    if (done) {
      this.#erase()
      this.#mode = 'idle'
      const r = this.#resolve
      this.#resolve = null
      r?.(done)
      return
    }
    // 有变化就整块重绘 —— 逐字符增量绘制在折行和 CJK 上极易出错，
    // 而输入框只有几行，整体重绘的开销可以忽略
    this.#erase()
    this.#draw()
  }

  #draw(): void {
    const box = renderBox(
      {
        text: this.#editor.text,
        cursor: this.#editor.cursor,
        suggestions: this.#editor.suggestions,
        suggestIndex: this.#editor.suggestIndex,
      },
      this.#out.columns ?? 80,
      this.#theme,
      this.#footer,
    )
    this.#out.write(box.lines.join('\n'))

    // 写完后光标在最后一行末尾，往回定位到框内
    const up = box.lines.length - 1 - box.cursorRow
    if (up > 0) this.#out.write(`\x1b[${up}A`)
    this.#out.write('\r')
    if (box.cursorCol > 0) this.#out.write(`\x1b[${box.cursorCol}C`)

    this.#height = box.lines.length
    this.#cursorRow = box.cursorRow
  }

  #erase(): void {
    if (this.#height === 0) return
    // 光标此刻在框内，先下到最后一行，再自下往上逐行清
    const down = this.#height - 1 - this.#cursorRow
    if (down > 0) this.#out.write(`\x1b[${down}B`)
    for (let i = 0; i < this.#height; i++) {
      this.#out.write('\r\x1b[2K')
      if (i < this.#height - 1) this.#out.write('\x1b[1A')
    }
    this.#height = 0
    this.#cursorRow = 0
  }
}
