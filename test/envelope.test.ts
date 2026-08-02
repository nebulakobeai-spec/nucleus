import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import {
  envelopeSizes,
  parseEnvelope,
  renderEnvelope,
  validateEnvelope,
} from '../src/runtime/envelope.js'
import { RULE } from '../src/runtime/rules.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 任务信封。
 *
 * 专家**看不到会话历史**（子 run 没有 conversationId，结构上无法直发用户），
 * 所以信封必须自足 —— 编排者写漏了背景，专家就抓瞎，而且以前没有任何机制
 * 能发现这件事：工具描述里那句「包含必要上下文与验收标准」只是劝导。
 */

const GOOD = {
  agent: 'researcher',
  goal: '调研向量数据库选型',
  context: '用户在做本地 RAG，32G 内存，不接受云服务',
  acceptance: '至少三个候选，每个给出取舍与来源',
  why: '需要外部资料且结论要带来源',
}

// ═══════════════════════════════════════════════════════
// 纯函数：校验与渲染
// ═══════════════════════════════════════════════════════

describe('validateEnvelope', () => {
  it('三段齐全就放行', () => {
    expect(validateEnvelope(GOOD)).toEqual([])
  })

  it('缺哪一段就报哪一段，并说清为什么要它', () => {
    const problems = validateEnvelope({ agent: 'x', goal: '干活' })
    expect(problems.map((p) => p.field)).toEqual(['context', 'acceptance'])
    // 报错要带理由 —— 只说「context 不能为空」模型不知道该写什么
    expect(problems[0]!.message).toContain('看不到之前的对话')
  })

  it('只有空白也算空 —— 否则模型填个空格就过了', () => {
    expect(validateEnvelope({ ...GOOD, context: '   \n ' }).map((p) => p.field)).toEqual(['context'])
  })

  it('不设长度阈值 —— 阈值是拍脑袋的数字', () => {
    // 「acceptance 写得敷衍」和「确实很短就够了」区分不了，
    // 所以硬规则只到非空，长度靠度量
    expect(validateEnvelope({ ...GOOD, acceptance: '对' })).toEqual([])
  })

  it('完全不是对象也不炸', () => {
    expect(validateEnvelope(null).length).toBe(3)
    expect(validateEnvelope('字符串').length).toBe(3)
  })
})

describe('renderEnvelope', () => {
  it('分段带小标题 —— 专家要照 acceptance 自检，拼成散文它得先拆回来', () => {
    const m = renderEnvelope({ goal: '做 A', context: '前提 B', acceptance: '标准 C' })
    expect(m.role).toBe('user')
    expect(m.content).toContain('# 任务\n做 A')
    expect(m.content).toContain('## 背景\n前提 B')
    expect(m.content).toContain('## 验收标准\n标准 C')
  })

  it('顺序固定：任务 → 背景 → 验收标准', () => {
    const c = renderEnvelope({ goal: 'g', context: 'c', acceptance: 'a' }).content
    expect(c.indexOf('任务')).toBeLessThan(c.indexOf('背景'))
    expect(c.indexOf('背景')).toBeLessThan(c.indexOf('验收标准'))
  })

  it('why 不进信封 —— 它是「派给谁」的推理，会带偏干活的专家', () => {
    const c = renderEnvelope({ ...GOOD }).content
    expect(c).not.toContain(GOOD.why)
  })

  it('老形状 { task } 仍然读得出 —— 历史 run 的 input 是这个', () => {
    // 数据库里已有的 run 不能因为 schema 变了就读不出来
    expect(renderEnvelope({ task: '旧任务' }).content).toBe('旧任务')
  })

  it('认不出的 input 如实转成文本，不静默丢掉', () => {
    // 丢掉的话专家会收到空消息然后胡编
    const c = renderEnvelope({ 随便: 1 }).content
    expect(c).toContain('随便')
  })

  it('空段不占版面', () => {
    const c = renderEnvelope({ goal: 'g', context: '', acceptance: '' }).content
    expect(c).toBe('# 任务\ng')
  })
})

describe('parseEnvelope', () => {
  it('新形状优先于老形状', () => {
    const e = parseEnvelope({ goal: 'g', task: '旧' })
    expect(e).toMatchObject({ goal: 'g' })
    expect(e).not.toHaveProperty('task')
  })

  it('两个都没有就是 null', () => {
    expect(parseEnvelope({})).toBeNull()
    expect(parseEnvelope({ goal: '  ' })).toBeNull()
  })
})

describe('envelopeSizes', () => {
  it('报出各段长度 —— 写得敷衍只能靠度量发现', () => {
    expect(envelopeSizes({ goal: '12345', context: '123', acceptance: '' })).toEqual({
      goal: 5,
      context: 3,
      acceptance: 0,
    })
  })
})

// ═══════════════════════════════════════════════════════
// 端到端
// ═══════════════════════════════════════════════════════

function config(): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  return c
}

let n: Nucleus | null = null
afterEach(async () => {
  await n?.close()
  n = null
})

async function bootWith(script: MockScript): Promise<Nucleus> {
  return boot({ config: config(), deps: { clock: new FakeClock(), ids: new FakeIds() }, mock: script })
}

const RESEARCHER_OK = {
  submit: {
    status: 'ok',
    summary: '调研完成',
    findings: [{ claim: 'A 可行', sources: ['s1'] }],
    artifacts: [],
  },
}

describe('委派时的信封校验', () => {
  it('信封不完整时被拒，模型收到缺了哪几项', async () => {
    n = await bootWith({
      orchestrator: [
        // 只给 goal，缺 context 与 acceptance
        { tool: { name: 'delegate', args: { agent: 'researcher', goal: '去查' } } },
        { submit: { status: 'ok', summary: '改为自己作答', artifacts: [] } },
      ],
      researcher: [RESEARCHER_OK],
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '调研')

    const v = await n.db.query<{ payload: { rule: string } }>(
      `select e.payload from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 and e.kind = 'rule.violation'`,
      [runId],
    )
    expect(v.rows.map((x) => x.payload.rule)).toContain(RULE.delegateEnvelope)

    // 被拒的调用视为从未发生 —— 不留意图记录
    const inv = await n.db.query<{ n: number }>(
      `select count(*)::int n from tool_invocations i
         join run_attempts a on a.id = i.run_attempt_id
         join runs r on r.id = a.run_id
        where r.root_run_id = $1 and i.tool_name = 'delegate'`,
      [runId],
    )
    expect(inv.rows[0]!.n).toBe(0)
    // 而且没有子 run 被创建
    expect((await n.runs.tree(runId)).length).toBe(1)
  })

  it('信封齐全时正常派出，专家收到分段渲染', async () => {
    n = await bootWith({
      orchestrator: [
        { tool: { name: 'delegate', args: GOOD } },
        { submit: { status: 'ok', summary: '整合完成', artifacts: [] } },
      ],
      researcher: [RESEARCHER_OK],
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '调研')

    const tree = await n.runs.tree(runId)
    expect(tree).toHaveLength(2)
    const child = tree.find((r) => r.depth === 1)!
    // 存的是结构化信封，不是拼好的文本 —— 渲染是读的时候做的
    expect(child.input).toMatchObject({
      goal: GOOD.goal,
      context: GOOD.context,
      acceptance: GOOD.acceptance,
    })
    // why 不存进子 run
    expect(child.input).not.toHaveProperty('why')
  })

  it('意图日志里记下派给谁、为什么、信封各段多长', async () => {
    n = await bootWith({
      orchestrator: [
        { tool: { name: 'delegate', args: GOOD } },
        { submit: { status: 'ok', summary: '完成', artifacts: [] } },
      ],
      researcher: [RESEARCHER_OK],
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '调研')

    const e = await n.db.query<{
      payload: { target: string; why: string; envelope: Record<string, number> }
    }>(
      `select e.payload from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 and e.kind = 'tool.intent'
          and e.payload->>'tool' = 'delegate'`,
      [runId],
    )
    const p = e.rows[0]!.payload
    // 「派得对不对」要靠 target + why 事后核对
    expect(p.target).toBe('researcher')
    expect(p.why).toBe(GOOD.why)
    // 「信封写得够不够」只能靠度量
    expect(p.envelope['goal']).toBe(GOOD.goal.length)
    expect(p.envelope['acceptance']).toBe(GOOD.acceptance.length)
  })

  it('delegate.envelope-complete 在规则清单里，不是隐形规则', async () => {
    const { RULES, ruleSpec } = await import('../src/runtime/rules.js')
    expect(ruleSpec(RULE.delegateEnvelope)).not.toBeNull()
    expect(RULES.find((r) => r.id === RULE.delegateEnvelope)!.tools).toContain('delegate')
  })
})
