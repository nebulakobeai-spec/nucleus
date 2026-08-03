import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { parseRuleFile, resultFieldsForAgent } from '../src/runtime/user-rules.js'
import { validateResult } from '../src/runtime/result-schema.js'
import { agentSpec } from '../src/config.js'
import { loadRuleFiles } from '../src/runtime/user-rules.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 规则能**声明**结果字段，而不只是要求已有字段必填。
 *
 * ── 为什么必须能声明 ──────────────────────────────────
 *
 * 真实要求长这样：「金融数据必须标明来源、抓取时间与验证状态」。
 * 落成「检查」就是 `requiredFields: [data_points[].source, ...]` ——
 * 但 `data_points` **不在核心字段里**（核心只有 status / summary /
 * artifacts / confidence / open_questions），所以光有 requiredFields
 * 会引用一个未声明的字段。
 *
 * 把声明放在 agent 上是错的：那条要求属于**规则**，而不属于某个专家 ——
 * 换个专家做同一件事，要求不该消失。规则自带声明，规则一删字段也一起消失。
 */

const RULE = `---
appliesTo: ['*']
requiredFields: [data_points[].value, data_points[].source, data_points[].fetched_at]
resultFields:
  data_points:
    type: object[]
    description: 金融数据必须标明来源与抓取时间
    fields:
      value: number
      source: string
      fetched_at: string
---

不确定的数字不要编。API 失败时明确标注「数据无法验证」。
`

describe('规则声明结果字段', () => {
  it('解析出 resultFields 与 requiredFields', () => {
    const { rule, problems } = parseRuleFile('rules/data-validation.md', RULE)
    expect(problems.filter((p) => p.fatal)).toEqual([])
    expect(rule!.check!.requiredFields).toContain('data_points[].source')
    expect(rule!.check!.resultFields!['data_points']).toMatchObject({ type: 'object[]' })
  })

  /**
   * **字段名必须 snake_case** —— 核心字段就是这个约定（`open_questions`）。
   *
   * 这条是我自己踩的：向导的示例文案写的是 `dataPoints`（camelCase），
   * 照着填完最后一步才被加载器拒。「向导让我这么填，加载器又说不行」
   * 是最难堪的那种错，所以向导现在**输入时**就用同一个正则校验。
   */
  it('camelCase 字段名被拒，并说明约定', () => {
    const { rule, problems } = parseRuleFile(
      'rules/x.md',
      RULE.replace(/data_points/g, 'dataPoints').replace(/fetched_at/g, 'fetchedAt'),
    )
    expect(rule).toBeUndefined()
    expect(problems.some((p) => /snake_case/.test(p.message))).toBe(true)
  })

  it('规则的声明合并进 agentSpec —— 否则会说「引用了未声明的字段」', () => {
    const { rule } = parseRuleFile('rules/data-validation.md', RULE)
    const spec = agentSpec({ id: 'a', name: 'a', identity: 'x' }, defaultConfig.defaults, [rule!])
    expect(Object.keys(spec.resultSpec!.fields!)).toContain('data_points')
    expect(spec.resultSpec!.requiredFields).toContain('data_points[].source')
  })

  /** 同名冲突时 agent 的声明优先 —— 它更具体，而且冲突要报出来 */
  it('同名字段冲突时 agent 优先，并报出冲突', () => {
    const { rule } = parseRuleFile('rules/data-validation.md', RULE)
    const { conflicts } = resultFieldsForAgent([rule!, { ...rule!, id: 'other' }], 'a')
    expect(conflicts.length).toBeGreaterThan(0)

    const spec = agentSpec(
      {
        id: 'a',
        name: 'a',
        identity: 'x',
        resultFields: { data_points: { type: 'string[]', description: '专家自己的' } },
      },
      defaultConfig.defaults,
      [rule!],
    )
    // agent 的声明赢
    expect(spec.resultSpec!.fields!['data_points']).toMatchObject({ type: 'string[]' })
  })
})

describe('规则真的会退回不合规的结果', () => {
  let n: Nucleus
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nucleus-rules-'))
    writeFileSync(join(dir, 'data-validation.md'), RULE)
  })

  afterEach(async () => {
    await n?.close()
    n = null as unknown as Nucleus
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 这一条是整块的意义：**「检查」不是配置对了就算，得真的把结果退回。**
   * 用真实的校验器跑一遍，而不是断言配置字段。
   */
  it('缺 source 的结果被判不合规', async () => {
    const rules = loadRuleFiles(dir).rules
    const spec = agentSpec({ id: 'a', name: 'a', identity: 'x' }, defaultConfig.defaults, rules)

    const bad = validateResult(
      {
        status: 'ok',
        summary: 'AAPL 收盘 195.2',
        artifacts: [],
        data_points: [{ value: 195.2, fetched_at: '2026-08-02T10:00:00Z' }],
      },
      spec.resultSpec,
    )
    expect(bad.ok).toBe(false)
    expect(JSON.stringify(bad)).toMatch(/source/)
  })

  it('齐全的结果通过', async () => {
    const rules = loadRuleFiles(dir).rules
    const spec = agentSpec({ id: 'a', name: 'a', identity: 'x' }, defaultConfig.defaults, rules)

    const good = validateResult(
      {
        status: 'ok',
        summary: 'AAPL 收盘 195.2',
        artifacts: [],
        data_points: [
          { value: 195.2, source: 'Finnhub API', fetched_at: '2026-08-02T10:00:00Z' },
        ],
      },
      spec.resultSpec,
    )
    expect(good.ok, JSON.stringify(good)).toBe(true)
  })

  /** 空列表也算不合规 —— `a[].b` 的语义是「a 非空且每条的 b 都非空」 */
  it('列表为空时也不合规', async () => {
    const rules = loadRuleFiles(dir).rules
    const spec = agentSpec({ id: 'a', name: 'a', identity: 'x' }, defaultConfig.defaults, rules)
    const r = validateResult(
      { status: 'ok', summary: 'x', artifacts: [], data_points: [] },
      spec.resultSpec,
    )
    expect(r.ok).toBe(false)
  })

  it('结果 schema 里真的出现了这个字段 —— 模型才知道要填', async () => {
    const rules = loadRuleFiles(dir).rules
    n = await boot({
      config: { ...structuredClone(defaultConfig), rules },
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: { orchestrator: [{ submit: { status: 'ok', summary: 'x', artifacts: [] } }] },
    })
    const spec = n.worker.agentSpecs.get('orchestrator')!
    expect(Object.keys(spec.resultSpec!.fields!)).toContain('data_points')
  })
})
