import { describe, expect, it } from 'vitest'
import { LineEditor, layout, renderBox, type Completion } from '../src/cli/input.js'
import { visibleLength } from '../src/cli/ui.js'

/**
 * 输入框的测试。
 *
 * 这块代码自己接管了键盘，是整个 CLI 里最容易静默出错的地方 ——
 * 光标偏一格、中文宽度算错、粘贴被拆成多次提交，都不会抛异常，
 * 只会让人觉得「这东西怪怪的」。所以状态机做成纯的，用喂字符串的方式测。
 */

const CMDS: Completion[] = [
  { value: '/model ', label: '/model', hint: '换模型链' },
  { value: '/runs ', label: '/runs', hint: '查看 run' },
  { value: '/new', label: '/new', hint: '开新会话' },
  { value: '/exit', label: '/exit', hint: '退出' },
]

function complete(buf: string): Completion[] {
  if (!buf.startsWith('/')) return []
  const word = buf.split(/\s/)[0]!
  // 已经打完并带了参数就不再弹
  if (buf.includes(' ')) return []
  return CMDS.filter((c) => c.label.startsWith(word))
}

function editor(opts: { history?: string[] } = {}) {
  return new LineEditor({ complete, ...(opts.history ? { history: opts.history } : {}) })
}

// ═══════════════════════════════════════════════════════
// 基本编辑
// ═══════════════════════════════════════════════════════

describe('输入与删除', () => {
  it('逐字输入', () => {
    const e = editor()
    e.feed('abc')
    expect(e.text).toBe('abc')
    expect(e.cursor).toBe(3)
  })

  it('中文按码点计数，不是 UTF-16 单元', () => {
    const e = editor()
    e.feed('调研向量数据库')
    expect(e.text).toBe('调研向量数据库')
    expect(e.cursor).toBe(7)
  })

  it('emoji 不会被切成半个', () => {
    const e = editor()
    e.feed('a🎉b')
    expect(e.text).toBe('a🎉b')
    expect(e.cursor).toBe(3)
    e.feed('\x7f') // 退格
    expect(e.text).toBe('a🎉')
  })

  it('退格删一个字符', () => {
    const e = editor()
    e.feed('abc\x7f')
    expect(e.text).toBe('ab')
    expect(e.cursor).toBe(2)
  })

  it('空输入时退格不炸', () => {
    const e = editor()
    expect(() => e.feed('\x7f\x7f\x7f')).not.toThrow()
    expect(e.text).toBe('')
  })

  it('在光标处插入，不总是追加到末尾', () => {
    const e = editor()
    e.feed('abd')
    e.feed('\x1b[D') // ←
    e.feed('c')
    expect(e.text).toBe('abcd')
  })

  it('Delete 键往后删', () => {
    const e = editor()
    e.feed('abc')
    e.feed('\x1b[D\x1b[D')
    e.feed('\x1b[3~')
    expect(e.text).toBe('ac')
  })

  it('Ctrl-U 清到行首，Ctrl-K 清到行尾', () => {
    const e = editor()
    e.feed('hello world')
    e.feed('\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D') // 退 5 格到 world 前
    e.feed('\x15')
    expect(e.text).toBe('world')

    const e2 = editor()
    e2.feed('hello world')
    e2.feed('\x01') // 行首
    e2.feed('\x0b')
    expect(e2.text).toBe('')
  })

  it('Ctrl-W 删一个词', () => {
    const e = editor()
    e.feed('调研 向量数据库')
    e.feed('\x17')
    expect(e.text).toBe('调研 ')
  })
})

describe('光标移动', () => {
  it('左右不越界', () => {
    const e = editor()
    e.feed('ab')
    e.feed('\x1b[C\x1b[C\x1b[C')
    expect(e.cursor).toBe(2)
    e.feed('\x1b[D\x1b[D\x1b[D\x1b[D')
    expect(e.cursor).toBe(0)
  })

  it('Home / End 与 Ctrl-A / Ctrl-E 等效', () => {
    const e = editor()
    e.feed('abcdef')
    e.feed('\x1b[H')
    expect(e.cursor).toBe(0)
    e.feed('\x1b[F')
    expect(e.cursor).toBe(6)
    e.feed('\x01')
    expect(e.cursor).toBe(0)
    e.feed('\x05')
    expect(e.cursor).toBe(6)
  })

  it('按词移动', () => {
    const e = editor()
    e.feed('one two three')
    e.feed('\x1bb') // 往左一个词
    expect(e.text.slice(e.cursor)).toBe('three')
    e.feed('\x1bb')
    expect(e.text.slice(e.cursor)).toBe('two three')
  })
})

// ═══════════════════════════════════════════════════════
// 提交与多行
// ═══════════════════════════════════════════════════════

describe('提交', () => {
  it('回车产生 submit 并清空', () => {
    const e = editor()
    e.feed('你好')
    const evs = e.feed('\r')
    expect(evs).toEqual([{ type: 'submit', text: '你好' }])
    expect(e.text).toBe('')
  })

  it('Alt+Enter 插换行而不提交 —— 多行输入要有办法打出来', () => {
    const e = editor()
    e.feed('第一行')
    const evs = e.feed('\x1b\r')
    expect(evs.every((x) => x.type !== 'submit')).toBe(true)
    e.feed('第二行')
    expect(e.text).toBe('第一行\n第二行')
    expect(e.feed('\r')).toEqual([{ type: 'submit', text: '第一行\n第二行' }])
  })

  it('Ctrl-C 产生 cancel，Ctrl-D 空输入产生 eof', () => {
    const e = editor()
    expect(e.feed('\x03')).toEqual([{ type: 'cancel' }])
    expect(e.feed('\x04')).toEqual([{ type: 'eof' }])
  })

  it('Ctrl-D 在有内容时是往后删，不是退出', () => {
    const e = editor()
    e.feed('ab')
    e.feed('\x1b[D')
    const evs = e.feed('\x04')
    expect(evs.every((x) => x.type !== 'eof')).toBe(true)
    expect(e.text).toBe('a')
  })
})

// ═══════════════════════════════════════════════════════
// 粘贴
// ═══════════════════════════════════════════════════════

describe('粘贴', () => {
  it('多行粘贴是一条输入，不是多次提交', () => {
    const e = editor()
    const evs = e.feed('\x1b[200~第一行\n第二行\n第三行\x1b[201~')
    expect(evs.every((x) => x.type !== 'submit')).toBe(true)
    expect(e.text).toBe('第一行\n第二行\n第三行')
  })

  it('粘贴内容里的 \\r\\n 统一成 \\n', () => {
    const e = editor()
    e.feed('\x1b[200~a\r\nb\rc\x1b[201~')
    expect(e.text).toBe('a\nb\nc')
  })

  it('粘贴跨多个 data 块也能拼回来 —— 大段粘贴一定会被拆开', () => {
    const e = editor()
    e.feed('\x1b[200~开头')
    e.feed('中间')
    e.feed('结尾\x1b[201~')
    expect(e.text).toBe('开头中间结尾')
  })

  it('粘贴里的控制字符不被解释成快捷键', () => {
    const e = editor()
    e.feed('abc')
    // \x15 平时是「清到行首」，粘贴区间内应当只是字面量被忽略/保留
    e.feed('\x1b[200~\x03\x15\x1b[201~')
    expect(e.text).toContain('abc')
  })

  it('粘贴后紧跟的回车正常提交', () => {
    const e = editor()
    e.feed('\x1b[200~粘的内容\x1b[201~')
    expect(e.feed('\r')).toEqual([{ type: 'submit', text: '粘的内容' }])
  })
})

// ═══════════════════════════════════════════════════════
// 历史
// ═══════════════════════════════════════════════════════

describe('历史', () => {
  it('上键从最近一条往前翻', () => {
    const e = editor({ history: ['第一问', '第二问'] })
    e.feed('\x1b[A')
    expect(e.text).toBe('第二问')
    e.feed('\x1b[A')
    expect(e.text).toBe('第一问')
    e.feed('\x1b[A')
    expect(e.text).toBe('第一问') // 到顶不动
  })

  it('下键翻回来，翻到底恢复草稿而不是卡住', () => {
    const e = editor({ history: ['旧的'] })
    e.feed('写了一半')
    e.feed('\x1b[A')
    expect(e.text).toBe('旧的')
    e.feed('\x1b[B')
    // 关键：草稿要还回来，否则翻一下历史就把没写完的话弄丢了
    expect(e.text).toBe('写了一半')
  })

  it('没有历史时上键什么也不做', () => {
    const e = editor()
    e.feed('abc')
    e.feed('\x1b[A')
    expect(e.text).toBe('abc')
  })

  it('提交后进历史，连续重复的只记一条', () => {
    const e = editor()
    e.feed('同一句\r')
    e.feed('同一句\r')
    expect(e.history).toEqual(['同一句'])
  })

  it('空白输入不进历史', () => {
    const e = editor()
    e.feed('   \r')
    expect(e.history).toEqual([])
  })

  it('翻历史后再打字，就脱离历史浏览', () => {
    const e = editor({ history: ['旧的'] })
    e.feed('\x1b[A')
    e.feed('X')
    expect(e.text).toBe('旧的X')
    e.feed('\x1b[B') // 已不在浏览态，不该跳回草稿
    expect(e.text).toBe('旧的X')
  })
})

// ═══════════════════════════════════════════════════════
// 联想
// ═══════════════════════════════════════════════════════

describe('命令联想', () => {
  it('输入 / 就弹出全部命令', () => {
    const e = editor()
    e.feed('/')
    expect(e.suggestions.map((s) => s.label)).toEqual(['/model', '/runs', '/new', '/exit'])
  })

  it('继续输入会收窄', () => {
    const e = editor()
    e.feed('/m')
    expect(e.suggestions.map((s) => s.label)).toEqual(['/model'])
  })

  it('普通提问不弹联想', () => {
    const e = editor()
    e.feed('帮我调研')
    expect(e.suggestions).toEqual([])
  })

  it('上下键在联想开着时选候选，而不是翻历史', () => {
    const e = editor({ history: ['旧的'] })
    e.feed('/')
    e.feed('\x1b[B')
    expect(e.suggestIndex).toBe(1)
    // 历史没被碰
    expect(e.text).toBe('/')
  })

  it('候选选择是循环的', () => {
    const e = editor()
    e.feed('/')
    e.feed('\x1b[A') // 往上从第一个跳到最后一个
    expect(e.suggestIndex).toBe(3)
    e.feed('\x1b[B')
    expect(e.suggestIndex).toBe(0)
  })

  it('Tab 采用选中的候选', () => {
    const e = editor()
    e.feed('/m\t')
    expect(e.text).toBe('/model ')
    expect(e.suggestions).toEqual([])
  })

  it('联想开着时回车先当「选中」用，不直接提交', () => {
    const e = editor()
    e.feed('/m')
    const evs = e.feed('\r')
    expect(evs.every((x) => x.type !== 'submit')).toBe(true)
    expect(e.text).toBe('/model ')
    // 再回车才真的提交。尾空格是候选值自带的（方便接着打参数），
    // 编辑器如实汇报缓冲区内容，trim 交给上层
    expect(e.feed('\r')).toEqual([{ type: 'submit', text: '/model ' }])
  })

  it('ESC 关掉联想', () => {
    const e = editor()
    e.feed('/')
    expect(e.suggestions.length).toBeGreaterThan(0)
    e.feed('\x1b')
    expect(e.suggestions).toEqual([])
  })

  it('退格回到 / 时联想重新出现', () => {
    const e = editor()
    e.feed('/mo')
    e.feed('\x7f\x7f')
    expect(e.suggestions.length).toBe(4)
  })
})

// ═══════════════════════════════════════════════════════
// 布局：中文宽度与折行
// ═══════════════════════════════════════════════════════

describe('layout', () => {
  it('短文本一行，光标在末尾', () => {
    const l = layout('abc', 3, 20)
    expect(l.rows).toEqual(['abc'])
    expect(l.cursorRow).toBe(0)
    expect(l.cursorCol).toBe(3)
  })

  it('中文按 2 列算宽度 —— 算成 1 光标就会越走越偏', () => {
    const l = layout('调研', 2, 20)
    expect(l.cursorCol).toBe(4)
  })

  it('超宽自动折行', () => {
    const l = layout('abcdefghij', 10, 4)
    expect(l.rows).toEqual(['abcd', 'efgh', 'ij'])
    expect(l.cursorRow).toBe(2)
    expect(l.cursorCol).toBe(2)
  })

  it('折行不把中文切成半个格 —— 宽度放不下就换行', () => {
    // 宽度 3 放不下两个中文（各 2 列）
    const l = layout('调研员', 3, 3)
    expect(l.rows).toEqual(['调', '研', '员'])
  })

  it('显式换行照原样断开', () => {
    const l = layout('a\nb', 3, 20)
    expect(l.rows).toEqual(['a', 'b'])
    expect(l.cursorRow).toBe(1)
    expect(l.cursorCol).toBe(1)
  })

  it('光标在中间时坐标正确', () => {
    const l = layout('第一行\n第二行', 4, 20)
    expect(l.cursorRow).toBe(1)
    expect(l.cursorCol).toBe(0)
  })

  it('空文本也有一行，光标在原点', () => {
    const l = layout('', 0, 20)
    expect(l.rows).toEqual([''])
    expect(l.cursorRow).toBe(0)
    expect(l.cursorCol).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════
// 画框
// ═══════════════════════════════════════════════════════

const THEME = {
  prompt: '❯',
  border: (s: string) => s,
  dim: (s: string) => s,
  accent: (s: string) => s,
}

describe('renderBox', () => {
  it('每一行显示宽度一致 —— 右边框必须对齐', () => {
    const box = renderBox(
      { text: '调研向量数据库', cursor: 7, suggestions: [], suggestIndex: 0 },
      40,
      THEME,
    )
    const widths = box.lines.slice(0, 3).map(visibleLength)
    expect(new Set(widths).size).toBe(1)
  })

  it('中英混排也对齐', () => {
    const box = renderBox(
      { text: 'GLM 和 Kimi 的取舍', cursor: 3, suggestions: [], suggestIndex: 0 },
      50,
      THEME,
    )
    const widths = box.lines.slice(0, 3).map(visibleLength)
    expect(new Set(widths).size).toBe(1)
  })

  it('有上下边框和提示符', () => {
    const box = renderBox({ text: '', cursor: 0, suggestions: [], suggestIndex: 0 }, 30, THEME)
    expect(box.lines[0]).toMatch(/^╭─+╮$/)
    expect(box.lines[1]).toContain('❯')
    expect(box.lines[2]).toMatch(/^╰─+╯$/)
  })

  it('联想列表画在框下面，选中项有标记', () => {
    const box = renderBox(
      { text: '/', cursor: 1, suggestions: CMDS, suggestIndex: 1 },
      40,
      THEME,
    )
    const tail = box.lines.slice(3)
    expect(tail).toHaveLength(4)
    expect(tail[1]).toContain('❯')
    expect(tail[1]).toContain('/runs')
    expect(tail[0]).not.toContain('❯')
    // 说明文字也要在
    expect(tail[1]).toContain('查看 run')
  })

  it('没有联想时显示 footer 提示', () => {
    const box = renderBox(
      { text: '', cursor: 0, suggestions: [], suggestIndex: 0 },
      40,
      THEME,
      '/help 看命令',
    )
    expect(box.lines[3]).toContain('/help 看命令')
  })

  it('光标坐标指向框内的正确位置', () => {
    const box = renderBox({ text: 'ab', cursor: 2, suggestions: [], suggestIndex: 0 }, 40, THEME)
    // 第 0 行是上边框，内容在第 1 行
    expect(box.cursorRow).toBe(1)
    // 左边框(1) + 空格(1) + 提示符(1) + 空格(1) + "ab"(2) = 6
    expect(box.cursorCol).toBe(6)
  })

  it('多行输入时光标行号跟着走', () => {
    const box = renderBox(
      { text: 'a\nb', cursor: 3, suggestions: [], suggestIndex: 0 },
      40,
      THEME,
    )
    expect(box.lines).toHaveLength(4) // 上框 + 2 行 + 下框
    expect(box.cursorRow).toBe(2)
  })

  it('窄终端不崩，也不产生负数重复', () => {
    for (const w of [1, 2, 5, 8]) {
      expect(() =>
        renderBox({ text: '调研', cursor: 1, suggestions: [], suggestIndex: 0 }, w, THEME),
      ).not.toThrow()
    }
  })
})

// ═══════════════════════════════════════════════════════
// 终端驱动：擦除与光标定位
// ═══════════════════════════════════════════════════════

import { EventEmitter } from 'node:events'
import { BoxInput } from '../src/cli/input.js'

/**
 * 假的 tty 对。
 *
 * 直接测 BoxInput 而不是起真 pty：pty 在这个沙箱里起不来，而且真 pty
 * 的输出含大量时序噪音，断言不稳。这里能精确检查吐出的转义序列。
 */
function fakeTty(columns = 60) {
  const input = Object.assign(new EventEmitter(), {
    setRawMode: (_on: boolean) => {},
    resume: () => {},
    pause: () => {},
    setEncoding: (_e: string) => {},
    rawModeCalls: [] as boolean[],
  })
  input.setRawMode = (on: boolean) => {
    input.rawModeCalls.push(on)
  }

  const chunks: string[] = []
  const output = Object.assign(new EventEmitter(), {
    columns,
    write: (s: string) => {
      chunks.push(s)
      return true
    },
    text: () => chunks.join(''),
    clear: () => {
      chunks.length = 0
    },
  })

  return {
    input: input as unknown as NodeJS.ReadStream & { rawModeCalls: boolean[] },
    output: output as unknown as NodeJS.WriteStream & { text: () => string; clear: () => void },
    type: (s: string) => input.emit('data', s),
    resize: (w: number) => {
      ;(output as unknown as { columns: number }).columns = w
      output.emit('resize')
    },
  }
}

function boxOn(tty: ReturnType<typeof fakeTty>, opts: { onInterrupt?: () => void } = {}) {
  return new BoxInput({
    input: tty.input,
    output: tty.output,
    complete,
    theme: THEME,
    footer: '提示',
    ...opts,
  })
}

describe('BoxInput', () => {
  it('启动时开 raw mode 与 bracketed paste', () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    expect(tty.input.rawModeCalls).toEqual([true])
    // 不开 bracketed paste，多行粘贴会被拆成多次提交
    expect(tty.output.text()).toContain('\x1b[?2004h')
    box.close()
  })

  it('close 关掉 raw mode 与 bracketed paste —— 不能把终端留在怪状态', () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    tty.output.clear()
    box.close()
    expect(tty.output.text()).toContain('\x1b[?2004l')
    expect(tty.input.rawModeCalls).toEqual([true, false])
  })

  it('重复 close 不炸 —— 异常路径会走到两次', () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    expect(() => {
      box.close()
      box.close()
    }).not.toThrow()
  })

  it('read 画出框，输入后 resolve 出文本', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()
    expect(tty.output.text()).toContain('╭')

    tty.type('你好')
    tty.type('\r')
    await expect(p).resolves.toEqual({ type: 'submit', text: '你好' })
    box.close()
  })

  it('每次重绘前先擦掉旧的整块 —— 不擦会留下上一帧的残迹', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()
    tty.output.clear()

    tty.type('a')
    const t = tty.output.text()
    // 3 行框：先下移/清行，再重画
    expect(t).toContain('\x1b[2K')
    expect(t).toContain('╭')

    tty.type('\r')
    await p
    box.close()
  })

  it('提交后把框擦干净，不留边框在屏幕上', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()
    tty.type('x')
    tty.output.clear()
    tty.type('\r')
    await p
    const t = tty.output.text()
    expect(t).toContain('\x1b[2K')
    expect(t).not.toContain('╭')
    box.close()
  })

  it('光标定位用绝对列，中文也不偏', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()
    tty.output.clear()
    tty.type('调研')
    const t = tty.output.text()
    // 左边框(1)+空格(1)+提示符(1)+空格(1)=4，加两个中文 4 列 → 第 8 列
    expect(t).toContain('\x1b[8C')
    tty.type('\r')
    await p
    box.close()
  })

  it('终端 resize 时重绘 —— 不重绘边框会错位', async () => {
    const tty = fakeTty(60)
    const box = boxOn(tty)
    const p = box.read()
    tty.type('abc')
    tty.output.clear()

    tty.resize(30)
    const t = tty.output.text()
    expect(t).toContain('╭')
    // 新宽度：内框 = 30-4 = 26，加两个边框字符
    expect(t).toContain('─'.repeat(28))

    tty.type('\r')
    await p
    box.close()
  })

  it('print 在框显示时先擦框再打印再重画', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()
    tty.output.clear()

    box.print('⏺ 永久的一行')
    const t = tty.output.text()
    const erase = t.indexOf('\x1b[2K')
    const perm = t.indexOf('⏺ 永久的一行')
    const redraw = t.lastIndexOf('╭')
    expect(erase).toBeGreaterThanOrEqual(0)
    expect(perm).toBeGreaterThan(erase)
    expect(redraw).toBeGreaterThan(perm)

    tty.type('\r')
    await p
    box.close()
  })

  it('不读输入时 Ctrl-C 走 onInterrupt —— raw mode 下���有 SIGINT', () => {
    const tty = fakeTty()
    let hit = 0
    const box = boxOn(tty, { onInterrupt: () => hit++ })
    // 没有 read()，处于 idle
    tty.type('\x03')
    expect(hit).toBe(1)
    // idle 时普通按键被忽略，不该积累到下一次输入里
    tty.type('abc')
    expect(hit).toBe(1)
    box.close()
  })

  it('读输入时 Ctrl-C 是 cancel，不是 onInterrupt', async () => {
    const tty = fakeTty()
    let hit = 0
    const box = boxOn(tty, { onInterrupt: () => hit++ })
    const p = box.read()
    tty.type('\x03')
    await expect(p).resolves.toEqual({ type: 'cancel' })
    expect(hit).toBe(0)
    box.close()
  })

  it('空输入 Ctrl-D 是 eof', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()
    tty.type('\x04')
    await expect(p).resolves.toEqual({ type: 'eof' })
    box.close()
  })

  it('联想列表出现时框会变高，擦除也要跟着变 —— 高度写死会留残迹', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()

    tty.type('/')
    tty.output.clear()
    tty.type('m') // 候选从 4 条收窄到 1 条，整体变矮
    const t = tty.output.text()
    // 变矮时必须把多余的行清掉：清行次数应当覆盖上一帧的高度
    expect((t.match(/\x1b\[2K/g) ?? []).length).toBeGreaterThanOrEqual(4)

    tty.type('\x15')
    tty.type('\r')
    await p
    box.close()
  })

  it('close 之后 read 直接返回 eof，不挂住', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    box.close()
    await expect(box.read()).resolves.toEqual({ type: 'eof' })
  })

  it('多行输入时框长高', async () => {
    const tty = fakeTty()
    const box = boxOn(tty)
    const p = box.read()
    tty.type('第一行')
    tty.output.clear()
    tty.type('\x1b\r') // ⌥Enter
    tty.type('第二行')
    const t = tty.output.text()
    expect(t).toContain('第一行')
    expect(t).toContain('第二行')
    tty.type('\r')
    await expect(p).resolves.toEqual({ type: 'submit', text: '第一行\n第二行' })
    box.close()
  })
})
