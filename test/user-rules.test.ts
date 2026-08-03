import { describe, expect, it } from 'vitest'
import {
  constraintsForAgent,
  denyToolsForAgent,
  parseRuleFile,
  requiredFieldsForAgent,
  rulesForAgent,
  tiersOf,
  validateRules,
  type UserRule,
} from '../src/runtime/user-rules.js'

/**
 * 用户自己写的规则 —— 一条规则同时携带三层。
 *
 * 这一组主要钉住**两条原则由校验强制，不靠自觉**：
 *
 *  ① T1 必须配 T2 或 T3。只有 T1 的规则会被**拒绝** ——
 *    那等于「prompt 里写满禁止但模型照犯」，而且它会显示在规则清单里、
 *    看起来系统在管这件事。**看起来有约束比没有约束更糟。**
 *  ② 能用 T3 表达的绝不写成 T1。T3 零成本且不可违反。
 */

const md = (fm: string, body = '') => `---\n${fm}\n---\n\n${body}`

describe('parseRuleFile', () => {
  it('T1 + T2：正文进 constraint，requiredFields 进 check', () => {
    const { rule, problems } = parseRuleFile(
      'rules/cite-sources.md',
      md('appliesTo: [researcher]\nrequiredFields: [findings[].sources]', '每条 finding 至少一个可验证来源。'),
    )
    expect(problems.filter((p) => p.fatal)).toEqual([])
    expect(rule!.id).toBe('cite-sources')
    expect(rule!.constraint).toBe('每条 finding 至少一个可验证来源。')
    expect(rule!.check).toEqual({ requiredFields: ['findings[].sources'] })
    expect(tiersOf(rule!)).toEqual(['T1', 'T2'])
  })

  /** 只有 T3 的规则**不需要正文** —— 那是好事，不是缺失 */
  it('只有 denyTools 也是合法规则，且不需要正文', () => {
    const { rule, problems } = parseRuleFile(
      'rules/no-exec.md',
      md('appliesTo: [analyst]\ndenyTools: [exec_shell]'),
    )
    expect(problems.filter((p) => p.fatal)).toEqual([])
    expect(rule!.constraint).toBeNull()
    expect(tiersOf(rule!)).toEqual(['T3'])
  })

  /**
   * **这条是整个模块存在的理由。**
   *
   * 一条只写了正文、没有任何机械强制的规则，就是这个项目要修的第一个问题。
   * 它会显示在规则清单里、看起来系统在管，而实际什么都没管。
   */
  it('只有 T1 正文 → **拒绝**，并给出该问的两个问题', () => {
    const { rule, problems } = parseRuleFile(
      'rules/be-nice.md',
      md('appliesTo: [researcher]', '回答要礼貌一点。'),
    )
    expect(rule).toBeUndefined()
    const msg = problems.map((p) => p.message).join('\n')
    expect(msg).toMatch(/只有 T1 正文/)
    // 要给出下一步该怎么想，而不是只说「不行」
    expect(msg).toMatch(/denyTools/)
    expect(msg).toMatch(/requiredFields/)
    // 并且允许「先不加」这个结论
    expect(msg).toMatch(/不如先不加/)
  })

  it('全空的规则被拒', () => {
    const { rule, problems } = parseRuleFile('rules/empty.md', md('appliesTo: [x]'))
    expect(rule).toBeUndefined()
    expect(problems.some((p) => /空规则/.test(p.message))).toBe(true)
  })

  it('未知 frontmatter 键报错，不静默忽略', () => {
    const { problems } = parseRuleFile(
      'rules/x.md',
      md('appliesTo: [a]\nrequiredFeilds: [x]', '正文'),
    )
    // 拼错 requiredFields 会让 T2 静默失效 —— 必须报出来
    expect(problems.some((p) => /未知的 frontmatter 键/.test(p.message))).toBe(true)
  })

  it('id 只允许小写字母数字点连字符', () => {
    const { problems } = parseRuleFile('rules/Bad_Name.md', md('denyTools: [x]'))
    expect(problems.some((p) => /文件名/.test(p.message))).toBe(true)
  })

  it('缺 frontmatter 时报错', () => {
    const { problems } = parseRuleFile('rules/x.md', '没有 frontmatter 的正文')
    expect(problems.some((p) => p.fatal)).toBe(true)
  })
})

describe('validateRules', () => {
  const rule = (over: Partial<UserRule> = {}): UserRule => ({
    id: 'r',
    constraint: null,
    check: null,
    denyTools: [],
    appliesTo: [],
    path: 'rules/r.md',
    ...over,
  })
  const known = { agents: ['orchestrator', 'researcher'], tools: ['delegate', 'write_report'] }

  /**
   * 引用不存在的 agent **不会报错**，只会让规则静默失效 —— 所以必须校验。
   */
  it('appliesTo 引用不存在的 agent → 阻断，并列出现有的', () => {
    const p = validateRules([rule({ denyTools: ['delegate'], appliesTo: ['nope'] })], known)
    expect(p[0]!.fatal).toBe(true)
    expect(p[0]!.message).toMatch(/不会对任何人生效/)
    expect(p[0]!.message).toMatch(/orchestrator/)
  })

  it('denyTools 引用不存在的工具 → 阻断（拼错会让 T3 形同虚设）', () => {
    const p = validateRules([rule({ denyTools: ['write_reprot'] })], known)
    expect(p[0]!.fatal).toBe(true)
    expect(p[0]!.message).toMatch(/形同虚设/)
  })

  it('通配符不校验 —— mcp__* 是合理写法', () => {
    expect(validateRules([rule({ denyTools: ['mcp__*'] })], known)).toEqual([])
  })

  it('`*` 作为 appliesTo 合法', () => {
    expect(validateRules([rule({ denyTools: ['delegate'], appliesTo: ['*'] })], known)).toEqual([])
  })

  it('id 重复报出来', () => {
    const p = validateRules(
      [rule({ denyTools: ['delegate'] }), rule({ denyTools: ['delegate'] })],
      known,
    )
    expect(p.some((x) => /重复/.test(x.message))).toBe(true)
  })

  /**
   * 原则②：T3 已经挡住的东西不必再写 T1。提醒而非阻断 ——
   * 那句话可能讲的是别的事。
   */
  it('同时有 denyTools 与 T1 正文 → 提醒白花预算（不阻断）', () => {
    const p = validateRules(
      [rule({ denyTools: ['write_report'], constraint: '不要写文件' })],
      known,
    )
    expect(p[0]!.fatal).toBe(false)
    expect(p[0]!.message).toMatch(/白花每轮的约束块预算/)
  })
})

describe('按 agent 解析三层', () => {
  const rules: UserRule[] = [
    {
      id: 'cite',
      constraint: '结论要带来源。',
      check: { requiredFields: ['findings[].sources'] },
      denyTools: [],
      appliesTo: ['researcher'],
      path: 'a',
    },
    {
      id: 'global-no-exec',
      constraint: null,
      check: null,
      denyTools: ['exec_shell'],
      appliesTo: [],
      path: 'b',
    },
    {
      id: 'star',
      constraint: '不确定的数字不要编。',
      check: { requiredFields: ['confidence'] },
      denyTools: [],
      appliesTo: ['*'],
      path: 'c',
    },
  ]

  /**
   * appliesTo 为空或含 `*` 视为全局 —— 「对所有人生效」是常见意图，
   * 让人把每个 agent 列一遍会在加新 agent 时**静默漏掉**。
   */
  it('空 appliesTo 与 `*` 都是全局', () => {
    expect(rulesForAgent(rules, 'orchestrator').map((r) => r.id)).toEqual([
      'global-no-exec',
      'star',
    ])
  })

  it('指名的只对那个 agent 生效', () => {
    expect(rulesForAgent(rules, 'researcher').map((r) => r.id)).toEqual([
      'cite',
      'global-no-exec',
      'star',
    ])
  })

  it('T1 只收集有正文的', () => {
    expect(constraintsForAgent(rules, 'researcher')).toEqual([
      '结论要带来源。',
      '不确定的数字不要编。',
    ])
  })

  it('T2 合并且去重', () => {
    expect(requiredFieldsForAgent(rules, 'researcher').sort()).toEqual([
      'confidence',
      'findings[].sources',
    ])
    expect(requiredFieldsForAgent(rules, 'orchestrator')).toEqual(['confidence'])
  })

  it('T3 合并且去重', () => {
    expect(denyToolsForAgent(rules, 'orchestrator')).toEqual(['exec_shell'])
  })
})
