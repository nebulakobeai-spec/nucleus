import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, ask, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import type { MockScript } from '../src/providers/mock.js'
import { FakeIds, FakeClock } from '../src/seams.js'

/**
 * Worker loop 的接线测试。
 *
 * 这一层过去是缺口：`delegate` 创建子 run，但没人 arm wake，
 * 于是委派变成 fire-and-forget —— 机制本身正确（store 层测试全过），
 * 但从来没被调用。CLI 上跑一次才暴露出来。
 */

let n: Nucleus

const SCRIPT: MockScript = {
  orchestrator: [
    { tool: { name: 'delegate', args: { agent: 'researcher', goal: '去查', context: '（测试用信封）', acceptance: '给出结论', why: '测试' } } },
    { submit: { status: 'ok', summary: '整合完毕' } },
  ],
  researcher: [
    {
      submit: {
        status: 'ok',
        summary: '查到了',
        findings: [{ claim: 'A', sources: ['s1'] }],
      },
    },
  ],
}

async function bootWith(script: MockScript): Promise<Nucleus> {
  return boot({
    config: withExampleAgents(defaultConfig),
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: script,
  })
}

beforeEach(async () => {
  n = await bootWith(SCRIPT)
})

afterEach(async () => {
  await n.close()
})

describe('委派 → 挂起 → 唤醒', () => {
  it('委派后自动 arm wake，专家完成后编排者被唤醒', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我查一件事')

    // 编排者跑了两次 attempt：委派 / 整合
    const attempts = await n.runs.listAttempts(runId)
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2])
    expect(attempts.every((a) => a.status === 'succeeded')).toBe(true)

    // wake 被创建且已触发
    const wakes = await n.db.query<{ status: string; pending_count: number }>(
      `select status, pending_count from wake_records where parent_run_id = $1`,
      [runId],
    )
    expect(wakes.rows).toHaveLength(1)
    expect(wakes.rows[0]!.status).toBe('fired')
    expect(wakes.rows[0]!.pending_count).toBe(0)
  })

  it('挂起期间不向会话回写半成品', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '帮我查一件事')

    const msgs = await n.conversations.recent(conv.id, 20)
    const assistant = msgs.filter((m) => m.role === 'assistant')
    // 只有最终整合结果这一条，不含 attempt 1 的中间态
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('整合完毕')
  })

  it('专家没有对外身份，无法直发用户', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我查一件事')

    const tree = await n.runs.tree(runId)
    const child = tree.find((r) => r.depth === 1)!
    expect(child.agentId).toBe('researcher')
    expect(child.conversationId).toBeNull()
  })

  it('专家的结果作为信封传给编排者，而非会话历史', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我查一件事')

    const tree = await n.runs.tree(runId)
    const child = tree.find((r) => r.depth === 1)!
    // 子 run 的完整结果落库，编排者只拿摘要
    expect((child.result as { summary: string }).summary).toBe('查到了')
    expect((child.result as { findings: unknown[] }).findings).toHaveLength(1)
  })

  it('timeline 覆盖完整链路', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我查一件事')

    const ev = await n.db.query<{ kind: string }>(
      `select e.kind from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 order by e.id`,
      [runId],
    )
    const kinds = ev.rows.map((r) => r.kind)
    expect(kinds).toContain('wake.armed')
    expect(kinds.filter((k) => k === 'attempt.started')).toHaveLength(3) // 编排×2 + 专家×1
    expect(kinds).toContain('tool.intent')
  })

  it('没有委派时不 arm wake，一次 attempt 完成', async () => {
    await n.close()
    n = await bootWith({
      orchestrator: [{ submit: { status: 'ok', summary: '直接回答' } }],
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '简单问题')

    expect(await n.runs.listAttempts(runId)).toHaveLength(1)
    const wakes = await n.db.query(`select 1 from wake_records where parent_run_id = $1`, [runId])
    expect(wakes.rowCount).toBe(0)
  })

  it('执行结束后无悬挂状态', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '帮我查一件事')

    const stuck = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_attempts where status in ('queued','running')`,
    )
    expect(stuck.rows[0]!.n).toBe(0)

    const unknown = await n.db.query<{ n: number }>(
      `select count(*)::int n from tool_invocations where outcome is null`,
    )
    expect(unknown.rows[0]!.n).toBe(0)

    const queue = await n.db.query<{ n: number }>(`select count(*)::int n from run_queue`)
    expect(queue.rows[0]!.n).toBe(0)
  })
})

describe('worker 的能力边界', () => {
  it('编排者只有 delegate —— 物理上无法自己动手', async () => {
    const spec = n.config.agents.find((a) => a.id === 'orchestrator')!
    // 授予的是**权限**而不是工具名单：没有 read/write/execute，
    // 所以任何需要它们的工具（包括以后新接的 MCP 工具）都自动不可见
    expect(spec.permissions).toEqual(['delegate', 'user'])

    const visible = n.tools.forAgent(spec.permissions!).map((t) => t.name)
    expect(visible).toEqual(['delegate'])
    expect(visible).not.toContain('write_file')
  })

  it('未知 agent 的 run 落终态而非悬挂，且错误指向配置而不是代码', async () => {
    const run = await n.runs.createRun({ agentId: 'nonexistent' })
    await n.runs.enqueueAttempt(run.id)
    await n.worker.drain(5)

    const after = await n.runs.getRun(run.id)
    expect(after!.status).toBe('failed')
    // 曾经报 runtime.internal —— 那会把人引去查运行时代码，
    // 而真正的原因是配置里没有这个 agent
    expect(after!.errorCode).toBe('config.agent_not_found')

    const detail = after!.errorDetail as { known?: string[]; hint?: string }
    // 列出现有 agent，省得再去翻配置
    expect(detail.known).toContain('orchestrator')
    expect(detail.hint).toMatch(/整体替换/)
  })
})
