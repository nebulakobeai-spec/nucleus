import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import {
  buildRulePrompt,
  renderRuleMd,
  ruleProposalSchema,
  toRule,
  validateRuleProposal,
  type RuleProposal,
} from '../src/cli/rule-propose.js'
import { parseRuleFile } from '../src/runtime/user-rules.js'

/**
 * `rule new --describe` —— 让模型判层。
 *
 * ── 为什么改成这个入口 ────────────────────────────────
 *
 * 第一版只有问答树（先问边界、再问检查、最后提醒）。逻辑没错但**不直觉**：
 * 它把分类过程强加给使用者，而使用者心里想的是一句具体的要求。
 * 而「属于哪一层」恰好是模型擅长判的。
 *
 * 这一组测的是**校验**那一半 —— 模型的判断没法在离线测试里验，
 * 但「工具是否真实、字段名是否合法、是否只剩提醒」全都能验，而且必须验：
 * 那正是「LLM 生成」与「黑盒」的分界线。
 */

let n: Nucleus

beforeEach(async () => {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  n = await boot({
    config: c,
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: { orchestrator: [{ submit: { status: 'ok', summary: 'x', artifacts: [] } }] },
  })
})

afterEach(async () => {
  await n.close()
  n = null as unknown as Nucleus
})

const p = (over: Partial<RuleProposal> = {}): RuleProposal => ({
  tier: ['check'],
  reasoning: '能从结果里看出来',
  ...over,
})

describe('提示词', () => {
  /**
   * **三层各自的代价必须给。** 只说「有三层」的话，模型会像人一样默认写提醒
   * —— 那是最省事的一层。
   */
  it('给出三层的代价，而不只是名字', () => {
    const text = buildRulePrompt(n, 'x', '结论要带来源')
    expect(text).toMatch(/boundary/)
    expect(text).toMatch(/零成本/)
    expect(text).toMatch(/每一轮/)
  })

  it('摊出真实的工具清单与核心字段 —— 否则它只能猜', () => {
    const text = buildRulePrompt(n, 'x', 'y')
    expect(text).toMatch(/write_report/)
    expect(text).toMatch(/open_questions/)
    expect(text).toMatch(/snake_case/)
  })

  /**
   * **必须明确允许「强制不了」这个答案。**
   *
   * 不然为了满足「提醒必须配检查」，模型会编一个不相干的检查来凑数 ——
   * 那比只有提醒更糟，因为看起来还多了一层保障。
   */
  it('明确允许回答「无法可靠强制」，并说明为什么不要凑数', () => {
    const text = buildRulePrompt(n, 'x', 'y')
    expect(text).toMatch(/cannotEnforce/)
    expect(text).toMatch(/合法答案/)
    expect(text).toMatch(/不要编一个不相干的 check/)
    // schema 里也要写
    const schema = JSON.stringify(ruleProposalSchema())
    expect(schema).toMatch(/凑数|凑齐/)
  })

  it('按强度倒着给判断顺序', () => {
    const text = buildRulePrompt(n, 'x', 'y')
    const iB = text.indexOf('不许用某个工具')
    const iC = text.indexOf('只看提交的结果')
    const iR = text.indexOf('reminder 只负责解释')
    expect(iB).toBeLessThan(iC)
    expect(iC).toBeLessThan(iR)
  })
})

describe('校验模型的产出', () => {
  it('工具不存在 → 阻断', () => {
    const out = validateRuleProposal(n, p({ tier: ['boundary'], denyTools: ['exec_shell'] }))
    expect(out.some((x) => x.fatal && /形同虚设/.test(x.message))).toBe(true)
  })

  it('通配符放过', () => {
    expect(validateRuleProposal(n, p({ tier: ['boundary'], denyTools: ['mcp__*'] }))).toEqual([])
  })

  it('agent 不存在 → 阻断，并列出现有的', () => {
    const out = validateRuleProposal(n, p({ requiredFields: ['summary'], appliesTo: ['nope'] }))
    expect(out[0]!.fatal).toBe(true)
    expect(out[0]!.message).toMatch(/orchestrator/)
  })

  it('camelCase 字段名 → 阻断', () => {
    const out = validateRuleProposal(
      n,
      p({ resultFields: { dataPoints: { type: 'object[]' } }, requiredFields: ['dataPoints'] }),
    )
    expect(out.some((x) => x.fatal && /snake_case/.test(x.message))).toBe(true)
  })

  it('覆盖核心字段 → 阻断', () => {
    const out = validateRuleProposal(n, p({ resultFields: { summary: { type: 'string' } } }))
    expect(out.some((x) => /核心字段/.test(x.message))).toBe(true)
  })

  /** 最容易犯的一个：要求一个谁都没声明的字段 */
  it('requiredFields 引用未声明的字段 → 阻断，并说清两条出路', () => {
    const out = validateRuleProposal(n, p({ requiredFields: ['data_points[].source'] }))
    expect(out[0]!.fatal).toBe(true)
    expect(out[0]!.message).toMatch(/未声明/)
    expect(out[0]!.message).toMatch(/resultFields/)
  })

  it('声明了就放过', () => {
    const out = validateRuleProposal(
      n,
      p({
        resultFields: { data_points: { type: 'object[]', fields: { source: 'string' } } },
        requiredFields: ['data_points[].source'],
      }),
    )
    expect(out.filter((x) => x.fatal)).toEqual([])
  })

  /** 整套设计的核心约束 —— 模型也不能例外 */
  it('只剩提醒 → 阻断（除非它明说强制不了）', () => {
    const out = validateRuleProposal(n, p({ tier: ['reminder'], constraint: '要礼貌' }))
    expect(out.some((x) => x.fatal && /没有任何机械强制/.test(x.message))).toBe(true)

    const ok = validateRuleProposal(
      n,
      p({ tier: ['reminder'], constraint: '要礼貌', cannotEnforce: true }),
    )
    expect(ok.filter((x) => x.fatal)).toEqual([])
  })

  it('边界够了还写提醒 → 提示而非阻断', () => {
    const out = validateRuleProposal(
      n,
      p({ tier: ['boundary', 'reminder'], denyTools: ['write_report'], constraint: '不要写报告' }),
    )
    expect(out.some((x) => !x.fatal && /白花每轮/.test(x.message))).toBe(true)
    expect(out.filter((x) => x.fatal)).toEqual([])
  })

  it('长正文没有索引行 → 阻断', () => {
    const out = validateRuleProposal(
      n,
      p({ requiredFields: ['summary'], constraint: '规则内容。'.repeat(200) }),
    )
    expect(out.some((x) => x.fatal && x.field === 'gist')).toBe(true)
  })
})

describe('提案 → 文件', () => {
  /**
   * 生成的文件必须能被加载器**原样读回来** —— 否则「向导生成的规则加载不了」
   * 就是最难堪的那种错（我在字段名上已经踩过一次）。
   */
  it('渲染出的 md 能被 parseRuleFile 读回来，且内容一致', () => {
    const proposal = p({
      tier: ['check', 'reminder'],
      resultFields: {
        data_points: {
          type: 'object[]',
          description: '金融数据',
          fields: { value: 'number', source: 'string', fetched_at: 'string' },
        },
      },
      requiredFields: ['data_points[].value', 'data_points[].source', 'data_points[].fetched_at'],
      constraint: '不确定的数字不要编。',
      appliesTo: ['*'],
    })
    const rule = toRule('data-validation', proposal, 'rules/data-validation.md')
    const md = renderRuleMd(rule)

    const back = parseRuleFile('rules/data-validation.md', md)
    expect(back.problems.filter((x) => x.fatal), md).toEqual([])
    expect(back.rule!.check!.requiredFields).toEqual(rule.check!.requiredFields)
    expect(back.rule!.check!.resultFields!['data_points']).toMatchObject({ type: 'object[]' })
    expect(back.rule!.constraint).toBe('不确定的数字不要编。')
  })

  it('纯边界的规则渲染出来没有正文，也能读回来', () => {
    const rule = toRule('no-writes', p({ tier: ['boundary'], denyTools: ['write_file'] }), 'x.md')
    const md = renderRuleMd(rule)
    expect(md).not.toMatch(/\n\n\S/)
    const back = parseRuleFile('rules/no-writes.md', md)
    expect(back.problems.filter((x) => x.fatal)).toEqual([])
    expect(back.rule!.denyTools).toEqual(['write_file'])
  })

  it('appliesTo 缺省时是全部', () => {
    expect(toRule('x', p({ requiredFields: ['summary'] }), 'x.md').appliesTo).toEqual(['*'])
  })
})
