import { describe, expect, it } from 'vitest'
import {
  classifyKey,
  nextEnabled,
  renderChoices,
  type Choice,
} from '../src/cli/prompt.js'

/**
 * 交互式单选的纯函数部分。
 *
 * 渲染与按键映射是这里最容易出错的地方，而它们恰好都能不碰终端就测 ——
 * 剩下的（raw mode、擦行）只能手动验。
 */

const CH: Array<Choice<string>> = [
  { value: 'a', label: 'ollama', detail: '不需要凭据' },
  { value: 'b', label: 'openai', disabled: '还没配 clientId' },
  { value: 'c', label: 'zai', detail: 'API key' },
]

describe('renderChoices', () => {
  it('当前项有指示符，其余没有', () => {
    const out = renderChoices(CH, 0).join('\n')
    expect(out).toMatch(/❯.*ollama/)
    expect(out).not.toMatch(/❯.*zai/)
  })

  /** disabled 的要显示出来**并说明为什么** —— 藏起来等于让人猜为什么少了一项 */
  it('disabled 显示原因，而不是被藏掉', () => {
    const out = renderChoices(CH, 0).join('\n')
    expect(out).toMatch(/openai/)
    expect(out).toMatch(/还没配 clientId/)
  })

  it('编号模式给每项标号 —— 管道下唯一可用的形态', () => {
    const out = renderChoices(CH, -1, { numbered: true }).join('\n')
    expect(out).toMatch(/1\..*ollama/)
    expect(out).toMatch(/3\..*zai/)
    expect(out).not.toMatch(/❯/)
  })

  /**
   * 超过一页时要让当前项尽量居中，且**不越界** ——
   * 越界会算出负的起点，渲染出空行。
   */
  it('分页时当前项居中，且首尾不越界', () => {
    const many: Array<Choice<number>> = Array.from({ length: 30 }, (_, i) => ({
      value: i,
      label: `m${i}`,
    }))
    const mid = renderChoices(many, 15, { pageSize: 5 })
    expect(mid.join('\n')).toMatch(/m15/)
    // 首项
    const head = renderChoices(many, 0, { pageSize: 5 })
    expect(head.join('\n')).toMatch(/m0/)
    expect(head.join('\n')).not.toMatch(/m-/)
    // 末项
    const tail = renderChoices(many, 29, { pageSize: 5 })
    expect(tail.join('\n')).toMatch(/m29/)
  })

  it('分页时报出位置 —— 否则不知道列表还有多长', () => {
    const many: Array<Choice<number>> = Array.from({ length: 30 }, (_, i) => ({
      value: i,
      label: `m${i}`,
    }))
    expect(renderChoices(many, 0, { pageSize: 5 }).join('\n')).toMatch(/1-5 \/ 30/)
  })
})

describe('classifyKey', () => {
  it('方向键与 vim 键都认', () => {
    expect(classifyKey('\x1b[A')).toBe('up')
    expect(classifyKey('\x1b[B')).toBe('down')
    expect(classifyKey('k')).toBe('up')
    expect(classifyKey('j')).toBe('down')
  })

  it('回车确认', () => {
    expect(classifyKey('\r')).toBe('enter')
    expect(classifyKey('\n')).toBe('enter')
  })

  /** 三种「我不想选了」的表达都要认 —— 只认一种会让人以为卡住了 */
  it('Ctrl-C / Ctrl-D / Esc 都算取消', () => {
    expect(classifyKey('\x03')).toBe('cancel')
    expect(classifyKey('\x04')).toBe('cancel')
    expect(classifyKey('\x1b')).toBe('cancel')
  })

  it('别的键不做事', () => {
    expect(classifyKey('x')).toBe('other')
  })
})

describe('nextEnabled', () => {
  it('跳过 disabled 项', () => {
    // 0=ollama(可) 1=openai(不可) 2=zai(可)
    expect(nextEnabled(CH, 0, 1)).toBe(2)
    expect(nextEnabled(CH, 2, -1)).toBe(0)
  })

  it('循环到头尾会绕回来', () => {
    expect(nextEnabled(CH, 2, 1)).toBe(0)
    expect(nextEnabled(CH, 0, -1)).toBe(2)
  })

  /** 全都不可选时返回 -1，让调用方去说「没有可选项」而不是卡在循环里 */
  it('全部 disabled 时返回 -1', () => {
    const allOff: Array<Choice<string>> = [
      { value: 'a', label: 'a', disabled: 'x' },
      { value: 'b', label: 'b', disabled: 'y' },
    ]
    expect(nextEnabled(allOff, 0, 1)).toBe(-1)
  })

  it('只有一个可选时停在它身上', () => {
    const one: Array<Choice<string>> = [
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b', disabled: 'x' },
    ]
    expect(nextEnabled(one, 0, 1)).toBe(0)
  })
})
