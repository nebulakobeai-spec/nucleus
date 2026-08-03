import { describe, expect, it } from 'vitest'
import {
  constraintsForAgent,
  indexedRulesForAgent,
  presenceOf,
  roughTokens,
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
 * 三层有名字而不是编号：**边界 / 检查 / 提醒**（强的排前面）。
 * 编号记不住，而且 T1 听起来像「第一层、最基本的」，恰恰它最弱 ——
 * 那个误导正好助长了要修的毛病。
 *
 * 这一组主要钉住**两条原则由校验强制，不靠自觉**：
 *
 *  ① 提醒必须配检查或边界。只有提醒的规则会被**拒绝** ——
 *    那等于「prompt 里写满禁止但模型照犯」，而且它会显示在规则清单里、
 *    看起来系统在管这件事。**看起来有约束比没有约束更糟。**
 *  ② 能用边界表达的绝不写成提醒。边界零成本且不可违反。
 */

const md = (fm: string, body = '') => `---\n${fm}\n---\n\n${body}`

describe('parseRuleFile', () => {
  it('提醒 + 检查：正文进 constraint，requiredFields 进 check', () => {
    const { rule, problems } = parseRuleFile(
      'rules/cite-sources.md',
      md('appliesTo: [researcher]\nrequiredFields: [findings[].sources]', '每条 finding 至少一个可验证来源。'),
    )
    expect(problems.filter((p) => p.fatal)).toEqual([])
    expect(rule!.id).toBe('cite-sources')
    expect(rule!.constraint).toBe('每条 finding 至少一个可验证来源。')
    expect(rule!.check).toEqual({ requiredFields: ['findings[].sources'] })
    expect(tiersOf(rule!)).toEqual(['check', 'reminder'])
  })

  /** 只有「边界」的规则**不需要正文** —— 那是好事，不是缺失 */
  it('只有 denyTools 也是合法规则，且不需要正文', () => {
    const { rule, problems } = parseRuleFile(
      'rules/no-exec.md',
      md('appliesTo: [analyst]\ndenyTools: [exec_shell]'),
    )
    expect(problems.filter((p) => p.fatal)).toEqual([])
    expect(rule!.constraint).toBeNull()
    expect(tiersOf(rule!)).toEqual(['boundary'])
  })

  /**
   * **这条是整个模块存在的理由。**
   *
   * 一条只写了正文、没有任何机械强制的规则，就是这个项目要修的第一个问题。
   * 它会显示在规则清单里、看起来系统在管，而实际什么都没管。
   */
  it('只有「提醒」→ **拒绝**，并给出该问的两个问题', () => {
    const { rule, problems } = parseRuleFile(
      'rules/be-nice.md',
      md('appliesTo: [researcher]', '回答要礼貌一点。'),
    )
    expect(rule).toBeUndefined()
    const msg = problems.map((p) => p.message).join('\n')
    expect(msg).toMatch(/只有「提醒」正文/)
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
    gist: null,
    check: null,
    denyTools: [],
    appliesTo: [],
    uncovered: [],
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

  it('denyTools 引用不存在的工具 → 阻断（拼错会让「边界」形同虚设）', () => {
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
   * 原则②：边界已经挡住的东西不必再写提醒。是提示而非阻断 ——
   * 那句话可能讲的是别的事。
   */
  it('同时有边界与提醒正文 → 提示白花预算（不阻断）', () => {
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
      gist: null,
      denyTools: [],
      appliesTo: ['researcher'],
      uncovered: [],
      path: 'a',
    },
    {
      id: 'global-no-exec',
      constraint: null,
      gist: null,
      check: null,
      denyTools: ['exec_shell'],
      appliesTo: [],
      uncovered: [],
      path: 'b',
    },
    {
      id: 'star',
      constraint: '不确定的数字不要编。',
      check: { requiredFields: ['confidence'] },
      gist: null,
      denyTools: [],
      appliesTo: ['*'],
      uncovered: [],
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

  it('提醒只收集有正文的', () => {
    expect(constraintsForAgent(rules, 'researcher')).toEqual([
      '结论要带来源。',
      '不确定的数字不要编。',
    ])
  })

  it('检查合并且去重', () => {
    expect(requiredFieldsForAgent(rules, 'researcher').sort()).toEqual([
      'confidence',
      'findings[].sources',
    ])
    expect(requiredFieldsForAgent(rules, 'orchestrator')).toEqual(['confidence'])
  })

  it('边界合并且去重', () => {
    expect(denyToolsForAgent(rules, 'orchestrator')).toEqual(['exec_shell'])
  })
})


// ═══════════════════════════════════════════════════════
// 大文本规则：索引 + 按需加载
// ═══════════════════════════════════════════════════════

describe('长正文的规则', () => {
  /**
   * ── 尺寸是实测的 ──────────────────────────────────────
   *
   * 一份真实的规则集：18 个文件、共约 28k token，单个最大 7k，最小 320。
   * 而末尾约束块的预算只有 ~2000 token（131k 窗口）。
   *
   * 全塞进去的后果不是报错，是被**静默砍半**（`shrink_constraints`）——
   * 而砍半的文档比没有更糟：前半段读起来像完整的规则，
   * 后半段（往往正是例外与反例）不见了，且没有任何提示。
   */
  const long = (tokens: number) => '规则内容。'.repeat(Math.ceil((tokens * 1.6) / 5))

  it('roughTokens 的量级对得上真实文件', () => {
    // 实测 environment.md 657 字节 ≈ 330 token
    const text = 'x'.repeat(0) + '禁止推测硬件参数，必须先验证再陈述。'.repeat(20)
    const t = roughTokens(text)
    expect(t).toBeGreaterThan(200)
    expect(t).toBeLessThan(300)
  })

  it('短正文直接内联，不需要 gist', () => {
    const { rule } = parseRuleFile(
      'rules/short.md',
      md('requiredFields: [summary]', '结论要带来源。'),
    )
    expect(presenceOf(rule!)).toBe('inline')
    expect(constraintsForAgent([rule!], 'a')).toEqual(['结论要带来源。'])
  })

  /** 长正文没有索引行 → **拒绝**，并教怎么写 gist */
  it('长正文缺 gist → 拒绝，并说明 gist 要带触发条件', () => {
    const { rule, problems } = parseRuleFile(
      'rules/big.md',
      md('requiredFields: [summary]', long(3000)),
    )
    expect(rule).toBeUndefined()
    const msg = problems.map((p) => p.message).join('\n')
    expect(msg).toMatch(/超过内联上限/)
    // 关键：要教会「gist 必须同时是提醒和触发条件」
    expect(msg).toMatch(/创建或部署文件前必读/)
    expect(msg).toMatch(/没有触发条件，等于没说/)
  })

  it('长正文 + gist → 约束块里只放索引行，并指出怎么取正文', () => {
    const { rule, problems } = parseRuleFile(
      'rules/workspace-paths.md',
      md('gist: 创建或部署文件前必读 —— 路径规则\nrequiredFields: [summary]', long(4000)),
    )
    expect(problems.filter((p) => p.fatal)).toEqual([])
    expect(presenceOf(rule!)).toBe('indexed')

    const injected = constraintsForAgent([rule!], 'a')
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatch(/创建或部署文件前必读/)
    // 必须写出规则 id —— 否则模型不知道该 read_rule 什么
    expect(injected[0]).toMatch(/read_rule\("workspace-paths"\)/)
    // 正文**不在**约束块里
    expect(injected[0]!.length).toBeLessThan(200)
  })

  /**
   * **这条是这套设计的全部意义。**
   * 用实测的分布造一批规则，确认常驻成本落在约束块预算之内。
   */
  it('18 条规则（实测分布，共 ~28k tok）压成约束块能装下的量', () => {
    const SIZES = [
      459, 674, 322, 688, 328, 5502, 338, 757, 597, 493, 7033, 377, 745, 343, 1145, 839, 4283, 3020,
    ]
    const rules: UserRule[] = SIZES.map((t, i) => ({
      id: `rule-${i}`,
      constraint: long(t),
      gist: `第 ${i} 类操作前必读 —— 某项规则`,
      check: { requiredFields: ['summary'] },
      denyTools: [],
      appliesTo: [],
      uncovered: [],
      path: `rules/rule-${i}.md`,
    }))

    const rawTotal = rules.reduce((n, r) => n + roughTokens(r.constraint!), 0)
    const injected = constraintsForAgent(rules, 'a').join('\n')
    const injectedTokens = roughTokens(injected)

    // 原始量级对得上实测的 28k
    expect(rawTotal).toBeGreaterThan(25_000)
    // 常驻成本要能装进约束块预算（131k 窗口下是 2000）
    expect(injectedTokens).toBeLessThan(2_000)
    // 压缩比至少一个数量级
    expect(rawTotal / injectedTokens).toBeGreaterThan(10)
  })

  it('indexedRulesForAgent 只列按需的那些 —— read_rule 的可取清单', () => {
    const rules: UserRule[] = [
      {
        id: 'big',
        constraint: long(3000),
        gist: '某操作前必读',
        check: { requiredFields: ['summary'] },
        denyTools: [],
        appliesTo: [],
        uncovered: [],
        path: 'a',
      },
      {
        id: 'small',
        constraint: '一句话规则。',
        gist: null,
        check: { requiredFields: ['summary'] },
        denyTools: [],
        appliesTo: [],
        uncovered: [],
        path: 'b',
      },
      {
        id: 't3-only',
        constraint: null,
        gist: null,
        check: null,
        denyTools: ['write_file'],
        appliesTo: [],
        uncovered: [],
        path: 'c',
      },
    ]
    expect(indexedRulesForAgent(rules, 'a').map((r) => r.id)).toEqual(['big'])
  })

  /**
   * gist 说不说清「什么时候该读」—— **筛查，不是判定**。
   *
   * 机器判不了一句话是否真的可行动，但最典型的坏形状能抓：纯名词短语。
   * 中文的祈使句几乎必然带「要 / 必须 / 前 / 禁止」之一。
   */
  it('gist 没有触发条件时提醒 —— 那一行是模型唯一的判断依据', () => {
    for (const gist of ['工作区路径规则', '市场分析', 'communication —— 相关规则']) {
      const { rule, problems } = parseRuleFile(
        'rules/communication.md',
        md(`gist: ${gist}\nrequiredFields: [summary]`, long(3000)),
      )
      expect(rule, gist).toBeDefined()
      expect(
        problems.some((p) => !p.fatal && /什么时候/.test(p.message)),
        `「${gist}」该被提醒`,
      ).toBe(true)
    }
  })

  it('带触发条件的 gist 不报', () => {
    for (const gist of ['创建或部署文件前必读 —— 路径规则', '禁止推测硬件参数', '结论要带来源']) {
      const { problems } = parseRuleFile(
        'rules/x.md',
        md(`gist: ${gist}\nrequiredFields: [summary]`, long(3000)),
      )
      expect(problems.some((p) => /什么时候/.test(p.message)), `「${gist}」不该被提醒`).toBe(false)
    }
  })

  /** 短正文又给 gist 是浪费 —— 提醒而非阻断 */
  it('短正文给了 gist → 提醒白占一行（不阻断）', () => {
    const { rule, problems } = parseRuleFile(
      'rules/x.md',
      md('gist: 某某\nrequiredFields: [summary]', '很短。'),
    )
    expect(rule).toBeDefined()
    expect(problems.some((p) => !p.fatal && /多占一行常驻预算/.test(p.message))).toBe(true)
  })
})
