import { afterEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { EXAMPLE_AGENTS, withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import {
  buildPrompt,
  overlapWarnings,
  proposalSchema,
  renderAgentMd,
  renderCasesMd,
  validateProposal,
  type ProposedAgent,
} from '../src/cli/agent-propose.js'
import { parseAgentFile } from '../src/config/agent-files.js'
import { GRANTABLE } from '../src/runtime/permissions.js'

/**
 * `agent new --describe` 的可判定部分。
 *
 * 这个功能之所以不是黑盒：**生成之后的每一项判定都是确定性的** ——
 * 权限必须合法可授予、引用的工具必须真实注册、结果字段声明必须过校验、
 * 职责重叠要报出来。模型只负责把一句话展开成正文。
 *
 * 所以这里测的全是那条分界线之后的东西，不需要调模型。
 */

let n: Nucleus | null = null
afterEach(async () => {
  await n?.close()
  n = null
})

function cfg(): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  return c
}

async function nucleus(): Promise<Nucleus> {
  n = await boot({ config: cfg(), deps: { clock: new FakeClock(), ids: new FakeIds() }, mock: {} })
  return n
}

const OK: ProposedAgent = {
  whenToUse: '需要从财报或行情数据得出带出处的量化结论时',
  identity: '你是金融数据分析专家。所有数字必须能追溯到数据源。',
  permissions: ['read', 'artifact'],
  resultFields: {
    metrics: {
      type: 'object[]',
      description: '关键指标',
      fields: { name: 'string', value: 'number', source: 'string' },
    },
  },
  requiredFields: ['metrics[].source'],
  cases: ['看一下 PE 与自由现金流', '数据只到去年时你怎么处理'],
  rationale: '只读数据 + 出报告，不需要写文件或执行',
}

// ═══════════════════════════════════════════════════════
// 提示词：把真实目录摊给模型
// ═══════════════════════════════════════════════════════

describe('buildPrompt', () => {
  it('带上权限词表连风险 —— 凭空写与照着真实目录写差别就在这里', async () => {
    const p = buildPrompt(await nucleus(), 'analyst', '做金融分析')
    for (const perm of GRANTABLE) expect(p, perm).toContain(perm)
    expect(p).toContain('基本等于拿到本机权限') // execute 的风险
  })

  it('带上已注册工具及其所需权限', async () => {
    const p = buildPrompt(await nucleus(), 'analyst', 'x')
    expect(p).toContain('write_report')
    expect(p).toContain('需要 artifact')
  })

  it('带上现有 agent 的职责，并明确要求不要重叠', async () => {
    const p = buildPrompt(await nucleus(), 'analyst', 'x')
    expect(p).toContain('researcher')
    expect(p).toContain('不要与它们语义重叠')
    // 不包含自己 —— 重新生成同一个 id 时不该拿旧版当参照
    const p2 = buildPrompt(await nucleus(), 'researcher', 'x')
    expect(p2.split('## 现有的 agent')[1]).not.toContain('- researcher')
  })

  it('说清专家看不到会话历史', async () => {
    expect(buildPrompt(await nucleus(), 'x', 'y')).toContain('看不到会话历史')
  })
})

describe('proposalSchema', () => {
  it('权限用 enum 限死在可授予的范围内', () => {
    const s = proposalSchema() as {
      properties: { permissions: { items: { enum: string[] } } }
      required: string[]
    }
    expect(s.properties.permissions.items.enum).toEqual([...GRANTABLE])
    // unclassified 是哨兵，不可授予
    expect(s.properties.permissions.items.enum).not.toContain('unclassified')
    expect(s.required).toContain('cases')
  })
})

// ═══════════════════════════════════════════════════════
// 校验：LLM 生成与黑盒的分界线
// ═══════════════════════════════════════════════════════

describe('validateProposal', () => {
  it('合法提案只剩提醒，没有阻断项', async () => {
    const problems = validateProposal(await nucleus(), 'analyst', OK)
    expect(problems.filter((p) => p.fatal)).toEqual([])
  })

  it('未知或不可授予的权限是阻断项', async () => {
    const nn = await nucleus()
    expect(
      validateProposal(nn, 'x', { ...OK, permissions: ['read', 'sudo'] }).some((p) => p.fatal),
    ).toBe(true)
    // 哨兵权限必须被拒 —— 它存在的意义就是没人能拿到
    expect(
      validateProposal(nn, 'x', { ...OK, permissions: ['unclassified'] }).some((p) => p.fatal),
    ).toBe(true)
  })

  it('空的 whenToUse 或正文是阻断项', async () => {
    const nn = await nucleus()
    expect(validateProposal(nn, 'x', { ...OK, whenToUse: '  ' }).some((p) => p.fatal)).toBe(true)
    expect(validateProposal(nn, 'x', { ...OK, identity: '' }).some((p) => p.fatal)).toBe(true)
  })

  it('结果字段声明写错是阻断项', async () => {
    const problems = validateProposal(await nucleus(), 'x', {
      ...OK,
      resultFields: { summary: { type: 'string' } },
    })
    expect(problems.some((p) => p.fatal && p.field.startsWith('resultFields'))).toBe(true)
  })

  it('requiredFields 引用未声明的字段是阻断项', async () => {
    const problems = validateProposal(await nucleus(), 'x', {
      ...OK,
      requiredFields: ['nonexistent[].x'],
    })
    expect(problems.some((p) => p.fatal && p.field === 'requiredFields')).toBe(true)
  })

  it('requiredFields 指向核心字段是允许的', async () => {
    const problems = validateProposal(await nucleus(), 'x', {
      ...OK,
      requiredFields: ['open_questions'],
    })
    expect(problems.filter((p) => p.fatal)).toEqual([])
  })

  it('授予了没有工具覆盖的权限 → 提醒而不阻断', async () => {
    // network 现在没有任何内置工具需要它（搜索靠 MCP）
    const problems = validateProposal(await nucleus(), 'x', {
      ...OK,
      permissions: ['read', 'network'],
    })
    const warn = problems.find((p) => !p.fatal && p.message.includes('network'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('现在是空的')
    expect(problems.filter((p) => p.fatal)).toEqual([])
  })

  it('试题少于 2 道 → 提醒（一道题看不出退步）', async () => {
    const problems = validateProposal(await nucleus(), 'x', { ...OK, cases: ['只有一道'] })
    expect(problems.some((p) => !p.fatal && p.field === 'cases')).toBe(true)
  })
})

describe('overlapWarnings', () => {
  it('与现有专家高度重叠时提醒', async () => {
    const nn = await nucleus()
    const researcher = EXAMPLE_AGENTS.find((a) => a.id === 'researcher')!
    // 用几乎一样的说法
    const w = overlapWarnings(nn, 'newbie', researcher.whenToUse!)
    expect(w.length).toBeGreaterThan(0)
    expect(w[0]!.message).toContain('researcher')
  })

  it('职责明显不同时不提醒', async () => {
    expect(overlapWarnings(await nucleus(), 'x', '需要给图片做无损压缩时')).toEqual([])
  })

  it('不与自己比', async () => {
    const nn = await nucleus()
    const r = EXAMPLE_AGENTS.find((a) => a.id === 'researcher')!
    expect(overlapWarnings(nn, 'researcher', r.whenToUse!).every((w) => !w.message.includes('researcher'))).toBe(true)
  })

  it('提醒而非阻断 —— 判据是粗糙的，只为让人去看', async () => {
    const nn = await nucleus()
    const r = EXAMPLE_AGENTS.find((a) => a.id === 'researcher')!
    expect(overlapWarnings(nn, 'x', r.whenToUse!).every((w) => !w.fatal)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// 渲染出来的 md 必须能被自己的解析器读回去
// ═══════════════════════════════════════════════════════

describe('renderAgentMd', () => {
  it('生成的 md 能被 parseAgentFile 读回去，字段不丢', () => {
    const { agent, errors } = parseAgentFile('/x/analyst.md', renderAgentMd('analyst', OK))
    expect(errors).toEqual([])
    expect(agent!.whenToUse).toBe(OK.whenToUse)
    expect(agent!.identity).toContain('金融数据分析专家')
    expect(agent!.permissions).toEqual(['read', 'artifact'])
    expect(agent!.requiredFields).toEqual(['metrics[].source'])
    // 嵌套的 resultFields 也要还原
    expect(agent!.resultFields).toMatchObject({
      metrics: { type: 'object[]', fields: { name: 'string', value: 'number', source: 'string' } },
    })
  })

  it('没有结果字段时也生成合法的 md', () => {
    const { agent, errors } = parseAgentFile(
      '/x/simple.md',
      renderAgentMd('simple', { ...OK, resultFields: undefined, requiredFields: undefined }),
    )
    expect(errors).toEqual([])
    expect(agent!.resultFields).toBeUndefined()
  })

  it('试题写进 cases.md 且不进定义', () => {
    const cases = renderCasesMd('analyst', OK.cases!)
    expect(cases).toContain(OK.cases![0]!)
    // 定义文件里不该有试题
    expect(renderAgentMd('analyst', OK)).not.toContain(OK.cases![0]!)
  })
})
