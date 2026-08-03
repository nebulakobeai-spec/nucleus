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
import { guessKind } from '../src/cli/rule-new.js'

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

/**
 * ── 「强制不了」的两种，建议完全相反 ────────────────────────
 *
 * 实测触发这一组的是一条**很典型**的规则：
 *
 *   "每次执行任务前必须写计划，计划写完必须由用户审核后同意后再执行"
 *
 * gemma4 判它 cannotEnforce，理由是自己推出来的、而且完全正确：这是跨回合的
 * 状态流转，而 check 只能验模型自己提交的字段 —— 加一个 `plan_approved`
 * 等于让同一个模型给自己签字。
 *
 * 但我当时给的建议是「写进 agent 的 identity」，**那是错的**。identity 就是
 * 提醒，正是这套设计要减少依赖的那一层。这条要求不是本质判不了，
 * 是运行时缺原语（用户审批、对运行时事实的检查）。把它埋进 identity 等于
 * 把一个能修的缺口变成一句没人强制的话，而且从此没人会再想起它。
 */
describe('强制不了的两种原因', () => {
  it('提示词里写明 check 只能验模型自己提交的东西', () => {
    const text = buildRulePrompt(n, 'x', 'y')
    expect(text).toMatch(/模型自己提交的那份结果/)
    // 那三个「自己给自己签字」的字段要点名 —— 它们最容易被写出来
    expect(text).toMatch(/plan_approved/)
    expect(text).toMatch(/verified: true/)
  })

  it('提示词要求区分 inherent 与 missing_mechanism', () => {
    const text = buildRulePrompt(n, 'x', 'y')
    expect(text).toMatch(/unenforceableKind/)
    expect(text).toMatch(/missing_mechanism/)
    const schema = JSON.stringify(ruleProposalSchema())
    expect(schema).toMatch(/本质判不了/)
    expect(schema).toMatch(/缺原语/)
  })

  it('两种都算合法结论，不阻断', () => {
    for (const kind of ['inherent', 'missing_mechanism'] as const) {
      const out = validateRuleProposal(
        n,
        p({ tier: ['reminder'], constraint: 'x', cannotEnforce: true, unenforceableKind: kind }),
      )
      expect(out.filter((x) => x.fatal), kind).toEqual([])
    }
  })
})

describe('模型没给 kind 时的兜底', () => {
  /** gemma4 对 plan-first 的**真实原文**（截断）—— 唯一的真样本，值得钉住 */
  const REAL = `该约束涉及的是一个跨回合的状态流转（计划 -> 用户审核 -> 执行），而非单次输出的静态格式。虽然可以增加一个 plan_approved 字段并要求必填，但模型可以通过伪造该字段（幻觉）直接跳过审核阶段。runtime check 只能验证结果中是否包含某个值，无法验证用户在历史对话中是否真的表达了"同意"。`

  it('认出真实那段推理是「缺原语」而不是「本质判不了」', () => {
    expect(guessKind({ tier: ['reminder'], reasoning: REAL })).toBe('missing_mechanism')
  })

  it('纯风格的理由判成 inherent', () => {
    expect(
      guessKind({ tier: ['reminder'], reasoning: '这是行文风格，读起来舒不舒服要人来看' }),
    ).toBe('inherent')
  })

  /**
   * 猜不出来时落回 inherent —— **不是因为它更可能对**，
   * 而是因为猜错方向给出的是相反的建议，而 inherent 那条建议
   * 至少不会把人引去埋一个能修的缺口。
   */
  it('看不出来时落回保守的那一边', () => {
    expect(guessKind({ tier: ['reminder'], reasoning: '不好说' })).toBe('inherent')
  })
})
