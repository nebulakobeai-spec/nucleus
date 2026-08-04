import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELP } from '../src/cli/index.js'

/**
 * 帮助文本、dispatch 表、文档三者必须对得上。
 *
 * ── 为什么写这条 ────────────────────────────────────
 *
 * 盘点这一整轮的产出时发现：`rule add` / `rule edit` / `rule rm` / `model config`
 * 在 README 和 USAGE 里**一处都没有** —— 规则和模型配置这两套命令从来没进过文档。
 * 而 `serve` 是我手工加进 dispatch 和帮助两处的，全靠记得。
 *
 * 这类漂移的症状是**功能存在而没人知道**，而它完全可以机械查。
 *
 * 不查「文档写得好不好」（那查不了），只查**名字有没有出现过**：
 * 一个命令能跑而任何文档里都搜不到它，那和没做差不多。
 */

const dispatch = readFileSync('src/cli/index.ts', 'utf8')
const readme = readFileSync('README.md', 'utf8')
const usage = readFileSync('docs/USAGE.md', 'utf8')

/** dispatch 里 `case 'x':` 的全部命令名 */
const CASES = [...dispatch.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]!)

/**
 * 别名与非命令。
 *
 * 复数/单数别名（`rules` / `rule`）与 `--help` 这种不需要在帮助里各占一行 ——
 * 但**每一条都要写出来为什么**，否则这个名单会变成「让测试变绿」的垃圾桶。
 */
const NOT_LISTED: Record<string, string> = {
  help: '它本身就是帮助',
  '--help': '同上',
  migrate: '内部命令：boot 时自动跑，手动跑只在排查 schema 时',
  verify: '离线冒烟，在 README 的开发回路里而不是命令清单里',
  // 单复数别名 —— 帮助里只列一种
  agent: '别名，帮助里列的是 agent list / show / …',
  artifact: '别名，帮助里列 artifacts',
  conversation: '别名，帮助里列 conv',
  convs: '同上',
  cron: '别名，帮助里列 schedule',
  schedules: '同上',
  models: '别名，帮助里列 model',
  provider: '别名，帮助里列 providers',
  rule: '别名：rule add / edit / rm 各自列了',
}

describe('帮助文本与 dispatch 一致', () => {
  it('扫到了命令 —— 否则这条测试永远是绿的', () => {
    expect(CASES.length).toBeGreaterThan(15)
    expect(CASES).toContain('serve')
    expect(CASES).toContain('rules')
  })

  it('每个命令都在帮助里出现过，否则要写下为什么不列', () => {
    const missing = CASES.filter((c) => !NOT_LISTED[c] && !HELP.includes(c))
    expect(
      missing,
      '这些命令能跑但帮助里搜不到 —— 要么加进 HELP，要么在 NOT_LISTED 里写理由',
    ).toEqual([])
  })

  it('NOT_LISTED 里没有已经不存在的命令', () => {
    const stale = Object.keys(NOT_LISTED).filter((c) => !CASES.includes(c))
    expect(stale, '这些命令已经没了，从名单里删掉').toEqual([])
  })
})

describe('文档跟得上命令', () => {
  /**
   * **这一条就是那个发现。**
   *
   * 只查名字出现过没有 —— 不查写得好不好。一个命令能跑而 README 与 USAGE
   * 里都搜不到它，那和没做差不多。
   */
  const docs = readme + '\n' + usage

  it('每个命令在 README 或 USAGE 里至少被提到一次', () => {
    const missing = CASES.filter((c) => !NOT_LISTED[c] && !docs.includes(c))
    expect(missing, '这些命令没进任何文档').toEqual([])
  })

  /**
   * 子命令单独查 —— 只查顶层的话 `rule` 出现一次就算过，
   * 而实际情况正是 `rule` 有而 `rule add` 没有。
   */
  it('这一轮新加的子命令也在文档里', () => {
    const subs = ['rule add', 'rule edit', 'rule rm', 'model config', 'serve --install']
    const missing = subs.filter((s) => !docs.includes(s))
    expect(missing, '这些子命令没进任何文档').toEqual([])
  })

  /**
   * 三层规则改名成「边界 / 检查 / 提醒」之后，文档里不该再有 T1/T2/T3 ——
   * 编号记不住哪个是哪个，而且 T1 听起来像「最基本的」而它恰恰最弱。
   */
  it('文档里不再用 T1/T2/T3 称呼三层规则', () => {
    /**
     * 例外只有一处：README 里**解释为什么不用编号**的那一句本身要提到它们。
     * 把它也算成违规就等于不能解释这个决定。
     */
    const lines = docs.split('\n').filter((l) => /\bT[123]\b/.test(l))
    // 豁免「在讨论命名这件事本身」的行 —— 否则就不能解释这个决定了
    const bad = lines.filter((l) => !/编号|用名字/.test(l))
    expect(bad, '三层规则已经改名成 边界 / 检查 / 提醒').toEqual([])
  })
})
