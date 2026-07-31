import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 多专家并发委派。
 *
 * 为什么这组必须存在：加专家 agent 的**直接后果**就是一次派多个。
 * 而 `delegate` 带 `suspend`，当轮 attempt 会结束 —— 所以并发只可能靠
 * 模型在一次回复里返回多个 delegate。这条路径此前从没端到端测过：
 * store 层测了 `waitOnRunIds: [c1, c2]` 的递减，但「worker 把多个待完成
 * 子 run 收集起来 arm 一次 wake、两个专家各自跑完、最后一个才触发唤醒」
 * 这整条接线是空白的。
 *
 * 这里也是「加规则/加 agent 之前必须通过」的那条前置。
 */

/** 一次回复里同时派给两个专家 */
const FANOUT: MockScript = {
  orchestrator: [
    {
      text: '这件事要两路并行。',
      tools: [
        { name: 'delegate', args: { agent: 'researcher', task: '调研 A' } },
        { name: 'delegate', args: { agent: 'operator', task: '准备 B' } },
      ],
    },
    // ↓ 两个专家都完成后才会走到这里
    { submit: { status: 'ok', summary: '两路结果已整合：A 与 B 均完成。', artifacts: [] } },
  ],
  researcher: [
    {
      submit: {
        status: 'ok',
        summary: 'A 调研完成。',
        findings: [{ claim: 'A 可行', sources: ['来源1'] }],
        artifacts: [],
      },
    },
  ],
  operator: [{ submit: { status: 'ok', summary: 'B 准备完成。', artifacts: [] } }],
}

function config(): NucleusConfig {
  const c = structuredClone(defaultConfig)
  c.defaults.modelChain = ['mock:local']
  return c
}

let n: Nucleus

beforeEach(async () => {
  n = await boot({
    config: config(),
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: FANOUT,
  })
})

afterEach(async () => {
  await n.close()
})

describe('一次派给多个专家', () => {
  it('两个子 run 都被创建并跑完', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '两路并行')

    const tree = await n.runs.tree(runId)
    expect(tree.map((r) => `${r.agentId}:${r.depth}:${r.status}`).sort()).toEqual([
      'operator:1:succeeded',
      'orchestrator:0:succeeded',
      'researcher:1:succeeded',
    ])
  })

  it('只 arm 一次 wake，pending 从 2 递减到 0 后才唤醒', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '两路并行')

    const wakes = await n.db.query<{ status: string; pending_count: number }>(
      `select status, pending_count from wake_records where parent_run_id = $1`,
      [runId],
    )
    // 关键：一条 wake 记录，不是两条 —— 两条会导致编排者被唤醒两次
    expect(wakes.rows).toHaveLength(1)
    expect(wakes.rows[0]).toMatchObject({ status: 'fired', pending_count: 0 })
  })

  it('编排者只被唤醒一次 —— 两个专家不该各唤醒一遍', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '两路并行')

    const attempts = await n.runs.listAttempts(runId)
    // #1 委派并挂起，#2 整合。第三次就说明重复唤醒了
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2])
  })

  it('会话里只有一条最终回复，两个专家的中间结果不外泄', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '两路并行')

    const msgs = await n.conversations.recent(conv.id, 20)
    const assistant = msgs.filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toContain('两路')
  })

  it('两个专家的结果都进了编排者的输入', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '两路并行')

    // 第 2 次 attempt 的上下文里应当同时含两份摘要
    const tree = await n.runs.tree(runId)
    const children = tree.filter((r) => r.depth === 1)
    expect(children).toHaveLength(2)
    for (const ch of children) {
      expect((ch.result as { summary?: string } | null)?.summary).toBeTruthy()
    }
  })

  it('执行结束后无悬挂状态', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '两路并行')

    for (const [what, sql] of [
      ['未终态 attempt', `select count(*)::int n from run_attempts where status in ('queued','running')`],
      ['残留队列', `select count(*)::int n from run_queue`],
      ['未触发的 wake', `select count(*)::int n from wake_records where status = 'waiting'`],
      ['未完成工具调用', `select count(*)::int n from tool_invocations where outcome is null`],
    ] as const) {
      const r = await n.db.query<{ n: number }>(sql)
      expect(r.rows[0]!.n, what).toBe(0)
    }
  })

  it('两次 delegate 都留下了意图日志', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '两路并行')

    const inv = await n.db.query<{ tool_name: string; seq: number }>(
      `select i.tool_name, i.seq from tool_invocations i
         join run_attempts a on a.id = i.run_attempt_id
         join runs r on r.id = a.run_id
        where r.root_run_id = $1 and i.tool_name = 'delegate'
        order by i.seq`,
      [runId],
    )
    expect(inv.rows).toHaveLength(2)
    // seq 必须不同，否则唯一约束会让第二次委派根本写不进去
    expect(inv.rows[0]!.seq).not.toBe(inv.rows[1]!.seq)
  })
})

// ═══════════════════════════════════════════════════════
// 委派的两道闸门
// ═══════════════════════════════════════════════════════

/**
 * 这两条测试对应一个实测过的故障：给 researcher 加上 delegate 权限、
 * 让它不断派给自己，结果造出 95 个 run，**零个终态** ——
 * 全停在 waiting_children/pending。用户看到的就是「任务永远不动」，
 * 而长驻 worker 下它不会停在 95，会一直派下去烧真钱。
 */
describe('委派闸门', () => {
  /** 让某个 agent 能委派，并把上限调小以便快速触达 */
  async function recursive(limits: { maxDelegationDepth?: number; maxRunsPerRoot?: number }) {
    const c = config()
    c.agents.find((a) => a.id === 'researcher')!.toolsAllow.push('delegate')
    Object.assign(c.defaults, limits)

    return boot({
      config: c,
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [
          { tool: { name: 'delegate', args: { agent: 'researcher', task: 'x' } } },
          { submit: { status: 'ok', summary: '收尾', artifacts: [] } },
        ],
        // 每个 researcher 先试着再派一个，被拒后才 submit ——
        // 这正是我们希望模型做的：拿到拒绝原因就改路
        researcher: Array.from({ length: 40 }, (_, i) =>
          i % 2 === 0
            ? { tool: { name: 'delegate', args: { agent: 'researcher', task: 'x' } } }
            : {
                submit: {
                  status: 'ok',
                  summary: '到底了，自己做完',
                  findings: [{ claim: 'ok', sources: ['s'] }],
                  artifacts: [],
                },
              },
        ),
      },
    })
  }

  it('深度到顶时拒绝委派，任务照样跑到终态', async () => {
    const m = await recursive({ maxDelegationDepth: 2 })
    try {
      const conv = await m.conversations.create({ agentId: 'orchestrator' })
      const { runId } = await ask(m, conv.id, 'go')

      const tree = await m.runs.tree(runId)
      expect(Math.max(...tree.map((r) => r.depth))).toBeLessThanOrEqual(2)
      // 最要紧的一条：全部落终态，没有任何东西悬着
      expect(tree.every((r) => ['succeeded', 'failed'].includes(r.status))).toBe(true)

      const pending = await m.db.query<{ n: number }>(
        `select count(*)::int n from runs where root_run_id = $1
          and status not in ('succeeded','failed','cancelled')`,
        [runId],
      )
      expect(pending.rows[0]!.n).toBe(0)
    } finally {
      await m.close()
    }
  })

  it('拒绝会记成 rule.violation，看得出是哪条规则拦的', async () => {
    const m = await recursive({ maxDelegationDepth: 1 })
    try {
      const conv = await m.conversations.create({ agentId: 'orchestrator' })
      const { runId } = await ask(m, conv.id, 'go')

      const v = await m.db.query<{ payload: { rule: string } }>(
        `select e.payload from run_events e join runs r on r.id = e.run_id
          where r.root_run_id = $1 and e.kind = 'rule.violation'`,
        [runId],
      )
      expect(v.rows.length).toBeGreaterThan(0)
      expect(v.rows.map((x) => x.payload.rule)).toContain('delegate.max-depth')
    } finally {
      await m.close()
    }
  })

  it('被拒的委派不留意图记录 —— 它从未发生', async () => {
    const m = await recursive({ maxDelegationDepth: 1 })
    try {
      const conv = await m.conversations.create({ agentId: 'orchestrator' })
      const { runId } = await ask(m, conv.id, 'go')

      const inv = await m.db.query<{ n: number }>(
        `select count(*)::int n from tool_invocations i
           join run_attempts a on a.id = i.run_attempt_id
           join runs r on r.id = a.run_id
          where r.root_run_id = $1 and i.tool_name = 'delegate'`,
        [runId],
      )
      // 只有编排者那一次真的派出去了
      expect(inv.rows[0]!.n).toBe(1)
    } finally {
      await m.close()
    }
  })

  it('扇出到顶时拒绝委派，run 总数不超上限', async () => {
    const m = await recursive({ maxDelegationDepth: 10, maxRunsPerRoot: 4 })
    try {
      const conv = await m.conversations.create({ agentId: 'orchestrator' })
      const { runId } = await ask(m, conv.id, 'go')

      const tree = await m.runs.tree(runId)
      expect(tree.length).toBeLessThanOrEqual(4)
      expect(tree.every((r) => ['succeeded', 'failed'].includes(r.status))).toBe(true)
    } finally {
      await m.close()
    }
  })
})
