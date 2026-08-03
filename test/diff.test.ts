import { describe, expect, it } from 'vitest'
import { changed, diffLines, renderDiff } from '../src/cli/diff.js'

/**
 * 覆盖别人的文件之前必须能看见改了什么。
 *
 * `rule new <已存在的 id> --force` 原先是**直接盖掉**：不给差异、不留备份。
 * 而那个文件很可能被手改过 —— 调过措辞、收窄过 appliesTo、加过一句注释。
 * 全部无声消失。
 */

const kinds = (a: string, b: string) => diffLines(a, b).map((o) => o.kind).join('')
const of = (a: string, b: string, k: '-' | '+') =>
  diffLines(a, b).filter((o) => o.kind === k).map((o) => o.text)

describe('按行差异', () => {
  it('一模一样 → 全是未变，changed 为 false', () => {
    const ops = diffLines('a\nb\nc', 'a\nb\nc')
    expect(kinds('a\nb\nc', 'a\nb\nc')).toBe('   ')
    expect(changed(ops)).toBe(false)
  })

  it('改一行 → 一删一增', () => {
    expect(of('a\nb\nc', 'a\nB\nc', '-')).toEqual(['b'])
    expect(of('a\nb\nc', 'a\nB\nc', '+')).toEqual(['B'])
  })

  it('中间插入 → 只有增', () => {
    expect(of('a\nc', 'a\nb\nc', '+')).toEqual(['b'])
    expect(of('a\nc', 'a\nb\nc', '-')).toEqual([])
  })

  it('删一行 → 只有删', () => {
    expect(of('a\nb\nc', 'a\nc', '-')).toEqual(['b'])
    expect(of('a\nb\nc', 'a\nc', '+')).toEqual([])
  })

  /**
   * **这是这个函数值得存在的理由。**
   *
   * 用最朴素的「逐行比」实现的话，前面插一行会让后面每一行都错位，
   * 于是一次「加了个字段」看起来像整个文件被重写了 —— 而那种差异
   * 没人会认真读，等于回到了没有差异。
   */
  it('开头插一行不会让后面全部错位', () => {
    const before = 'appliesTo: [*]\nrequiredFields: [summary]\n\n正文。'
    const after = 'gist: 提交前必读\nappliesTo: [*]\nrequiredFields: [summary]\n\n正文。'
    expect(of(before, after, '+')).toEqual(['gist: 提交前必读'])
    expect(of(before, after, '-')).toEqual([])
  })

  it('真实的规则文件改动：加一个 uncovered 段', () => {
    const before = ['---', "appliesTo: ['*']", 'requiredFields: [plan]', '---'].join('\n')
    const after = [
      '---',
      "appliesTo: ['*']",
      'requiredFields: [plan]',
      'uncovered:',
      '  - 要用户同意',
      '---',
    ].join('\n')
    expect(of(before, after, '+')).toEqual(['uncovered:', '  - 要用户同意'])
    expect(of(before, after, '-')).toEqual([])
  })

  it('全空 → 无改动', () => {
    expect(changed(diffLines('', ''))).toBe(false)
  })

  it('从空到有内容 → 全是增', () => {
    expect(of('', 'a\nb', '+')).toEqual(['a', 'b'])
  })
})

describe('上色', () => {
  it('删红增绿，与 git 一致', () => {
    const out = renderDiff(diffLines('a', 'b')).join('\n')
    expect(out).toMatch(/- a/)
    expect(out).toMatch(/\+ b/)
  })

  it('未变的行也显示 —— 规则文件小，全给上下文', () => {
    expect(renderDiff(diffLines('a\nb', 'a\nc'))).toHaveLength(3)
  })
})
