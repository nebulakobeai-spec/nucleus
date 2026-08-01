import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { RULE, RULES, ruleSpec } from '../src/runtime/rules.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 规则清单与遵守率。
 *
 * 这组测试守着两件以前答不出来的事：
 *  1. 「这个系统有哪些规则」—— 规则 id 曾散落在 precondition 里，
 *     只能靠触发才知道某条存在。
 *  2. 「模型听不听」—— contract.rejected 一直在落库却没有统计入口，
 *     而「prompt 规则被忽略」是这个项目要修的问题之一，
 *     修没修好必须能用数字回答。
 */

function config(): NucleusConfig {
  const c = structuredClone(defaultConfig)
  c.defaults.modelChain = ['mock:local']
  // 入口直接用 researcher，省掉委派那一层，让契约事件更好观察
  c.defaults.entryAgent = 'researcher'
  return c
}

let n: Nucleus | null = null

afterEach(async () => {
  // 必须置空 —— 否则纯函数用例的 afterEach 会对已关闭的实例再 close 一次，
  // 报成「PGlite is closed」并把失败记在无关的用例上
  await n?.close()
  n = null
})

async function bootWith(script: MockScript, cfg = config()): Promise<Nucleus> {
  return boot({
    config: cfg,
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: script,
  })
}

const GOOD = {
  status: 'ok',
  summary: '调研完成',
  findings: [{ claim: '可行', sources: ['来源一'] }],
  artifacts: [],
}
/** 缺 sources —— researcher 的 requiredFields 要求每条 finding 都有来源 */
const BAD = {
  status: 'ok',
  summary: '调研完成',
  findings: [{ claim: '可行', sources: [] }],
  artifacts: [],
}

// ═══════════════════════════════════════════════════════
// 注册表
// ═══════════════════════════════════════════════════════

describe('规则注册表', () => {
  it('每条规则都能被枚举，不必靠触发才知道它存在', () => {
    expect(RULES.length).toBeGreaterThan(0)
    for (const r of RULES) {
      expect(r.id).toMatch(/^[a-z]+\.[a-z-]+$/)
      expect(r.what.length).toBeGreaterThan(0)
      expect(r.enforcedBy.length).toBeGreaterThan(0)
      expect(['capability', 'precondition', 'postcondition']).toContain(r.scope)
    }
  })

  it('id 无重复', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length)
  })

  it('常量与注册表一一对应 —— 手写字符串拼错会变成谁也不认识的规则', () => {
    for (const id of Object.values(RULE)) {
      expect(ruleSpec(id), id).not.toBeNull()
    }
    expect(RULES.every((r) => Object.values(RULE).includes(r.id as never))).toBe(true)
  })

  it('未注册的 id 返回 null，不是编个空壳', () => {
    expect(ruleSpec('made.up-rule')).toBeNull()
  })

  it('声明的强制工具必须真实注册 —— 工具改名要立刻红，而不是规则悄悄失效', async () => {
    n = await bootWith({ researcher: [{ submit: GOOD }] })
    for (const r of RULES) {
      for (const t of r.tools) {
        expect(n!.tools.get(t), `规则 ${r.id} 声明由 ${t} 强制，但没有这个工具`).toBeDefined()
      }
    }
  })

  it('可达性按声明算，不按工具名猜', async () => {
    n = await bootWith({ researcher: [{ submit: GOOD }] })
    const researcherTools = n!.tools
      .forAgent(['write_report'])
      .map((t) => t.name)
    const reachable = RULES.filter((r) => r.tools.some((t) => researcherTools.includes(t)))
    // write_report 自己构造路径、只写数据库，没有 workdir 前置检查 ——
    // 用 /^(read|write)_/ 猜会把它错算成受 fs.workdir-boundary 约束
    expect(reachable).toEqual([])
  })

  it('可配置的规则指向真实存在的配置项', () => {
    const cfg = defaultConfig as unknown as Record<string, unknown>
    for (const r of RULES) {
      if (!r.configurable) continue
      // 形如 defaults.maxDelegationDepth 或 agents
      const parts = r.configurable.split('.')
      let cur: unknown = cfg
      for (const p of parts) {
        expect(cur, r.configurable).toBeTypeOf('object')
        cur = (cur as Record<string, unknown>)[p]
      }
      expect(cur, r.configurable).not.toBeUndefined()
    }
  })
})

// ═══════════════════════════════════════════════════════
// 契约事件：遵守率的原始数据
// ═══════════════════════════════════════════════════════

describe('契约事件', () => {
  async function eventsOf(runId: string, kind: string) {
    const r = await n!.db.query<{ payload: Record<string, unknown> }>(
      `select e.payload from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 and e.kind = $2 order by e.id`,
      [runId, kind],
    )
    return r.rows.map((x) => x.payload)
  }

  it('一次就写对时发 contract.accepted，retries 为 0', async () => {
    n = await bootWith({ researcher: [{ submit: GOOD }] })
    const conv = await n!.conversations.create({ agentId: 'researcher' })
    const { runId } = await ask(n!, conv.id, '调研')

    const acc = await eventsOf(runId, 'contract.accepted')
    expect(acc).toHaveLength(1)
    expect(acc[0]!['retries']).toBe(0)
    expect(await eventsOf(runId, 'contract.rejected')).toHaveLength(0)
  })

  it('缺必填字段时先退回，改对后才 accepted，retries 记下退了几次', async () => {
    n = await bootWith({ researcher: [{ submit: BAD }, { submit: GOOD }] })
    const conv = await n!.conversations.create({ agentId: 'researcher' })
    const { runId } = await ask(n!, conv.id, '调研')

    const rej = await eventsOf(runId, 'contract.rejected')
    expect(rej).toHaveLength(1)
    // 退回时必须说清缺什么 —— 这是回喂给模型的内容
    const failures = rej[0]!['failures'] as Array<{ path: string }>
    expect(failures.map((f) => f.path)).toContain('findings[].sources')

    const acc = await eventsOf(runId, 'contract.accepted')
    expect(acc).toHaveLength(1)
    expect(acc[0]!['retries']).toBe(1)

    // 任务最终是成功的 —— 被退回不等于失败
    expect((await n!.runs.getRun(runId))!.status).toBe('succeeded')
  })

  it('反复不合格最终失败，错误码指向契约', async () => {
    n = await bootWith({ researcher: Array.from({ length: 8 }, () => ({ submit: BAD })) })
    const conv = await n!.conversations.create({ agentId: 'researcher' })
    const { runId } = await ask(n!, conv.id, '调研')

    const run = await n!.runs.getRun(runId)
    expect(run!.status).toBe('failed')
    expect(run!.errorCode).toBe('contract.postcondition_failed')
    expect(await eventsOf(runId, 'contract.accepted')).toHaveLength(0)
  })

  it('委派后挂起的 attempt 不产生契约事件 —— 它没有契约要满足', async () => {
    const cfg = config()
    cfg.defaults.entryAgent = 'orchestrator'
    n = await bootWith(
      {
        orchestrator: [
          { tool: { name: 'delegate', args: { agent: 'researcher', task: 'x' } } },
          { submit: { status: 'ok', summary: '整合完成', artifacts: [] } },
        ],
        researcher: [{ submit: GOOD }],
      },
      cfg,
    )
    const conv = await n!.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n!, conv.id, '调研')

    // 3 次 attempt（编排 #1 挂起 / 专家 / 编排 #2），但只有 2 次提交了结果。
    // 把挂起那次算进分母会让遵守率虚高 —— 这正是要用显式事件而不是推断的原因
    const attempts = await n!.db.query<{ n: number }>(
      `select count(*)::int n from run_attempts a join runs r on r.id = a.run_id
        where r.root_run_id = $1`,
      [runId],
    )
    expect(attempts.rows[0]!.n).toBe(3)
    expect(await eventsOf(runId, 'contract.accepted')).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════
// 遵守率的算法
// ═══════════════════════════════════════════════════════

describe('遵守率', () => {
  /** 与 cli/rules.ts 里同一段 SQL —— 算法本身要被测，不能只测它跑不跑 */
  async function adherence() {
    const r = await n!.db.query<{
      provider: string
      model: string
      attempts: number
      rejected_attempts: number
    }>(
      `with contracted as (
         select a.id, a.provider, a.model,
                count(e.id) filter (where e.kind = 'contract.rejected') as rejections
           from run_attempts a
           left join run_events e on e.run_attempt_id = a.id
          where a.provider is not null
          group by a.id, a.provider, a.model
         having count(e.id) filter (where e.kind in ('contract.accepted','contract.rejected')) > 0
            or bool_or(a.error_code like 'contract.%')
       )
       select provider, model, count(*)::int as attempts,
              count(*) filter (where rejections > 0)::int as rejected_attempts
         from contracted group by provider, model`,
    )
    return r.rows
  }

  it('全部一次过 → 100%', async () => {
    n = await bootWith({ researcher: [{ submit: GOOD }] })
    const conv = await n!.conversations.create({ agentId: 'researcher' })
    await ask(n!, conv.id, '调研')

    const [row] = await adherence()
    expect(row).toMatchObject({ provider: 'mock', model: 'local', attempts: 1, rejected_attempts: 0 })
  })

  it('被退回过的 attempt 计入分子外 —— 即使最终成功', async () => {
    n = await bootWith({ researcher: [{ submit: BAD }, { submit: GOOD }] })
    const conv = await n!.conversations.create({ agentId: 'researcher' })
    await ask(n!, conv.id, '调研')

    const [row] = await adherence()
    expect(row!.attempts).toBe(1)
    expect(row!.rejected_attempts).toBe(1)
  })

  it('挂起的 attempt 不进分母', async () => {
    const cfg = config()
    cfg.defaults.entryAgent = 'orchestrator'
    n = await bootWith(
      {
        orchestrator: [
          { tool: { name: 'delegate', args: { agent: 'researcher', task: 'x' } } },
          { submit: { status: 'ok', summary: '整合完成', artifacts: [] } },
        ],
        researcher: [{ submit: GOOD }],
      },
      cfg,
    )
    const conv = await n!.conversations.create({ agentId: 'orchestrator' })
    await ask(n!, conv.id, '调研')

    const [row] = await adherence()
    // 3 次 attempt，只有 2 次有契约
    expect(row!.attempts).toBe(2)
  })

  it('彻底失败的 attempt 进分母 —— 否则「教不会」会被统计忽略', async () => {
    n = await bootWith({ researcher: Array.from({ length: 8 }, () => ({ submit: BAD })) })
    const conv = await n!.conversations.create({ agentId: 'researcher' })
    await ask(n!, conv.id, '调研')

    const [row] = await adherence()
    expect(row!.attempts).toBeGreaterThan(0)
    expect(row!.rejected_attempts).toBe(row!.attempts)
  })

  it('没有任何契约事件时返回空，而不是 0/0 的假数字', async () => {
    n = await bootWith({ researcher: [{ submit: GOOD }] })
    // 不跑任何任务
    expect(await adherence()).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════
// 负责领域：编排者的选路依据
// ═══════════════════════════════════════════════════════

describe('whenToUse', () => {
  it('每个可委派的专家都声明了负责领域', () => {
    const entry = defaultConfig.defaults.entryAgent
    for (const a of defaultConfig.agents) {
      if (a.id === entry) continue
      // 没有它，编排者只能看着 id 猜派给谁
      expect(a.whenToUse, `${a.id} 没有 whenToUse`).toBeTruthy()
    }
  })

  it('delegate 的工具描述里带着每个专家的适用场景', async () => {
    const cfg = config()
    cfg.defaults.entryAgent = 'orchestrator'
    n = await bootWith({ orchestrator: [{ submit: { status: 'ok', summary: 'x', artifacts: [] } }] }, cfg)

    const def = n!.tools.get('delegate')!
    // 只给 id 列表时，模型没有任何选路依据
    expect(def.description).toContain('researcher')
    expect(def.description).toContain(
      defaultConfig.agents.find((a) => a.id === 'researcher')!.whenToUse!,
    )
  })

  it('入口 agent 不在可委派列表里 —— 派回用户入口没有意义', async () => {
    const cfg = config()
    cfg.defaults.entryAgent = 'orchestrator'
    n = await bootWith({ orchestrator: [{ submit: { status: 'ok', summary: 'x', artifacts: [] } }] }, cfg)

    const def = n!.tools.get('delegate')!
    const params = def.parameters as { properties: { agent: { enum: string[] } } }
    expect(params.properties.agent.enum).not.toContain('orchestrator')
    expect(params.properties.agent.enum).toContain('researcher')
  })

  it('换了 entryAgent，可委派列表跟着变 —— 这里曾硬编码 orchestrator', async () => {
    const cfg = config()
    cfg.defaults.entryAgent = 'researcher'
    n = await bootWith({ researcher: [{ submit: GOOD }] }, cfg)

    const def = n!.tools.get('delegate')!
    const params = def.parameters as { properties: { agent: { enum: string[] } } }
    expect(params.properties.agent.enum).not.toContain('researcher')
    expect(params.properties.agent.enum).toContain('orchestrator')
  })
})
