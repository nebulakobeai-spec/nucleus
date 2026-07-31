import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { ModelRouter } from '../src/providers/router.js'
import type { ModelConfig } from '../src/providers/types.js'
import { RunStore } from '../src/store/runs.js'
import { Reconciler } from '../src/runtime/reconciler.js'
import { Runner, type AgentSpec } from '../src/runtime/runner.js'
import { ToolRegistry } from '../src/runtime/tools.js'
import { MemoryEventSink } from '../src/runtime/events.js'
import { stubCompletion } from './harness/provider.js'
import type { FetchLike } from '../src/providers/openai-compat.js'

/**
 * v1 验收路径（DESIGN.md §15）。
 *
 * 编排者收到任务 → 委派专家 → 专家写 artifact → 结果回到编排者（不是直发用户）
 * → 会话追加摘要 → 全过程 timeline 可见 → 中途 kill -9 能自动恢复且不重复外部副作用。
 */

const MODELS = new Map<string, ModelConfig>([
  ['test:m', { key: 'test:m', provider: 'test', model: 'm', baseUrl: 'http://x/v1', costPerMTokIn: 1, costPerMTokOut: 1 }],
])

let db: Db
let clock: FakeClock
let deps: Deps
let store: RunStore
let events: MemoryEventSink
let tools: ToolRegistry

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  clock = new FakeClock()
  deps = { clock, ids: new FakeIds() }
  store = new RunStore(db, deps)
  events = new MemoryEventSink()
  tools = new ToolRegistry()
})

afterEach(async () => {
  await db.close()
})

/** 按 agent 分派不同脚本的 fetch */
function byAgent(scripts: Record<string, Response[]>): FetchLike {
  const cursors: Record<string, number> = {}
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }
    const sys = body.messages.find((m) => m.role === 'system')?.content ?? ''
    const who = sys.includes('Albert') ? 'albert' : 'orchestrator'
    const i = cursors[who] ?? 0
    cursors[who] = i + 1
    const list = scripts[who]!
    return (list[Math.min(i, list.length - 1)] as Response).clone()
  }
}

function makeRunner(fetchImpl: FetchLike) {
  const router = new ModelRouter(db, deps, MODELS, () => null, { fetch: fetchImpl, inPlaceRetries: 0 })
  return new Runner(db, deps, router, tools, events, { heartbeatMs: 3_600_000 })
}

const ORCHESTRATOR: AgentSpec = {
  id: 'orchestrator',
  systemPrompt: 'You are Nebula, the orchestrator.',
  modelChain: ['test:m'],
  toolsAllow: ['delegate'],
  maxSteps: 10,
}

const ALBERT: AgentSpec = {
  id: 'albert',
  systemPrompt: 'You are Albert, the researcher.',
  modelChain: ['test:m'],
  toolsAllow: ['write_report'],
  maxSteps: 10,
}

describe('端到端：编排者 → 专家 → 结果回流', () => {
  it('专家结果回到编排者，且专家全程没有对外身份', async () => {
    // 会话：唯一的对外身份，只挂在 root run 上
    const convId = crypto.randomUUID()
    await db.query(`insert into conversations(id, agent_id, title) values ($1,'orchestrator','调研任务')`, [convId])
    await db.query(
      `insert into messages(id, conversation_id, seq, role, content) values ($1,$2,1,'user','帮我调研一下 X')`,
      [crypto.randomUUID(), convId],
    )

    // ── 工具：委派 + 写报告 ──────────────────────────
    let delegatedRunId: string | null = null
    tools.register({
      name: 'delegate',
      description: '把任务委派给专家',
      parameters: {
        type: 'object',
        properties: { agent: { type: 'string' }, task: { type: 'string' } },
        required: ['agent', 'task'],
      },
      sideEffect: 'idempotent',
      execute: async (args, ctx) => {
        const a = args as { agent: string; task: string }
        const child = await store.createRun({
          agentId: a.agent,
          parentRunId: ctx.runId,
          depth: 1,
          input: { task: a.task },
          // 注意：子 run **没有** conversationId —— 结构上无法直发用户
        })
        await store.enqueueAttempt(child.id)
        delegatedRunId = child.id
        return { ok: true, content: `已委派给 ${a.agent}，run=${child.id}` }
      },
    })

    tools.register({
      name: 'write_report',
      description: '写调研报告',
      parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      sideEffect: 'idempotent',
      execute: async (args, ctx) => {
        const ref = await ctx.writeArtifact({
          path: 'report.md',
          content: (args as { content: string }).content,
          summary: 'X 的调研报告',
        })
        return { ok: true, content: `报告已写入 ${ref}` }
      },
    })

    const scripts = {
      orchestrator: [
        stubCompletion({ toolCalls: [{ name: 'delegate', args: { agent: 'albert', task: '调研 X' } }] }),
        // 被唤醒后的第二次 attempt：整合并提交
        stubCompletion({
          toolCalls: [{ name: 'submit_result', args: { status: 'ok', summary: 'X 的调研已完成，结论见报告' } }],
        }),
      ],
      albert: [
        stubCompletion({ toolCalls: [{ name: 'write_report', args: { content: '# X 调研\n结论：可行。' } }] }),
        stubCompletion({
          toolCalls: [
            {
              name: 'submit_result',
              args: { status: 'ok', summary: 'X 可行，详见报告', artifacts: ['report.md'] },
            },
          ],
        }),
      ],
    }
    const runner = makeRunner(byAgent(scripts))

    // ── 1. 编排者第一次 attempt：委派后挂起 ──────────
    const root = await store.createRun({ agentId: 'orchestrator', conversationId: convId })
    await store.enqueueAttempt(root.id)
    const a1 = (await store.claimNext('w1'))!
    await runner.execute({
      attemptId: a1.id,
      fenceToken: a1.fenceToken!,
      runId: root.id,
      agent: { ...ORCHESTRATOR, maxSteps: 1 },
      history: [],
      input: [{ role: 'user', content: '帮我调研一下 X' }],
      workdir: '/tmp',
    })

    expect(delegatedRunId).not.toBeNull()
    const childId = delegatedRunId!

    // 编排者挂起等待 —— attempt 已终结，逻辑 run 转 waiting_children
    const wake = await store.armWake({
      parentRunId: root.id,
      parentAgentId: 'orchestrator',
      parentConversationId: convId,
      waitOnRunIds: [childId],
      resumePayload: { goal: '调研 X' },
    })
    expect((await store.getRun(root.id))!.status).toBe('waiting_children')
    expect(wake.status).toBe('waiting')

    // ── 2. 专家执行 ─────────────────────────────────
    const a2 = (await store.claimNext('w2'))!
    expect(a2.runId).toBe(childId)
    const childOut = await runner.execute({
      attemptId: a2.id,
      fenceToken: a2.fenceToken!,
      runId: childId,
      agent: ALBERT,
      history: [],
      input: [{ role: 'user', content: '调研 X' }],
      workdir: '/tmp',
    })
    expect(childOut.status).toBe('succeeded')

    // 专家产出了 artifact
    const artifacts = await db.query<{ ref: string }>(`select ref from artifacts where run_id = $1`, [childId])
    expect(artifacts.rows).toHaveLength(1)

    // ── 3. 子 run 终态 → 同事务唤醒编排者 ────────────
    const firedWake = await store.getWake(wake.id)
    expect(firedWake!.status).toBe('fired')
    expect(firedWake!.firedAttemptId).not.toBeNull()

    // 关键：专家没有 conversation，结果不可能直发用户
    expect((await store.getRun(childId))!.conversationId).toBeNull()
    const msgsAfterChild = await db.query(`select 1 from messages where conversation_id = $1`, [convId])
    expect(msgsAfterChild.rowCount).toBe(1) // 仍然只有用户那一条

    // ── 4. 编排者被唤醒，整合并提交 ──────────────────
    const a3 = (await store.claimNext('w1'))!
    expect(a3.runId).toBe(root.id)
    expect(a3.attemptNo).toBe(2)

    const childResult = (await store.getRun(childId))!.result as { summary: string }
    const rootOut = await runner.execute({
      attemptId: a3.id,
      fenceToken: a3.fenceToken!,
      runId: root.id,
      agent: ORCHESTRATOR,
      history: [],
      input: [
        { role: 'user', content: '帮我调研一下 X' },
        { role: 'user', content: `[专家结果] albert: ${childResult.summary}` },
      ],
      workdir: '/tmp',
    })
    expect(rootOut.status).toBe('succeeded')

    // ── 5. 摘要追加进会话（由编排者的结果驱动）───────
    await db.query(
      `insert into messages(id, conversation_id, seq, role, content, run_id) values ($1,$2,2,'assistant',$3,$4)`,
      [crypto.randomUUID(), convId, rootOut.result!.summary, root.id],
    )
    const finalMsgs = await db.query<{ role: string; content: string }>(
      `select role, content from messages where conversation_id = $1 order by seq`,
      [convId],
    )
    expect(finalMsgs.rows).toHaveLength(2)
    expect(finalMsgs.rows[1]!.content).toContain('调研已完成')

    // ── 6. run 树可见 ───────────────────────────────
    const tree = await store.tree(root.id)
    expect(tree.map((r) => `${r.agentId}:${r.depth}:${r.status}`)).toEqual([
      'orchestrator:0:succeeded',
      'albert:1:succeeded',
    ])

    // ── 7. timeline 完整 ────────────────────────────
    const kinds = new Set(events.kinds())
    for (const k of ['llm.call.started', 'llm.call.finished', 'tool.intent', 'tool.outcome', 'artifact.written']) {
      expect(kinds).toContain(k)
    }
  })
})

describe('端到端：kill -9 后自动恢复', () => {
  it('worker 猝死 → reconciler 判 lost → 新 attempt 完成任务', async () => {
    tools.register({
      name: 'work',
      description: 'w',
      parameters: {},
      sideEffect: 'pure',
      execute: async () => ({ ok: true, content: 'done' }),
    })

    const runner = makeRunner(
      byAgent({
        orchestrator: [
          stubCompletion({ toolCalls: [{ name: 'submit_result', args: { status: 'ok', summary: '恢复后完成' } }] }),
        ],
      }),
    )

    const run = await store.createRun({ agentId: 'orchestrator' })
    await store.enqueueAttempt(run.id)
    const dead = (await store.claimNext('worker-doomed'))!

    // 模拟 kill -9：worker 拿了 lease 就消失，什么都没写
    await clock.advance(60_001)
    const rec = new Reconciler(db, deps, { maxAttempts: 3, backoffMs: 1000 })
    const report = await rec.runOnce()
    expect(report.lostAttempts).toEqual([dead.id])
    expect(report.requeued).toEqual([run.id])

    // 旧 worker 复活后写入被拒绝
    await expect(
      store.finishAttempt({ attemptId: dead.id, fenceToken: dead.fenceToken!, status: 'succeeded' }),
    ).rejects.toThrow()

    // 新 attempt 接手完成
    await clock.advance(2000)
    const fresh = (await store.claimNext('worker-new'))!
    expect(fresh.attemptNo).toBe(2)
    const out = await runner.execute({
      attemptId: fresh.id,
      fenceToken: fresh.fenceToken!,
      runId: run.id,
      agent: ORCHESTRATOR,
      history: [],
      input: [{ role: 'user', content: 'go' }],
      workdir: '/tmp',
    })

    expect(out.status).toBe('succeeded')
    expect((await store.getRun(run.id))!.status).toBe('succeeded')
    expect((await store.listAttempts(run.id)).map((a) => a.status)).toEqual(['lost', 'succeeded'])
  })

  it('不可幂等的工具崩在中间 → 升级人工确认，绝不自动重跑', async () => {
    let sendCount = 0
    tools.register({
      name: 'send_email',
      description: '发邮件',
      parameters: {},
      sideEffect: 'non_idempotent',
      execute: async () => {
        sendCount++
        // 模拟：邮件真的发出去了，但进程在写结果前崩溃
        throw Object.assign(new Error('process died mid-flight'), { __simulateCrash: true })
      },
    })

    const run = await store.createRun({ agentId: 'orchestrator' })
    await store.enqueueAttempt(run.id)
    const a = (await store.claimNext('w1'))!

    // 只写意图，不写结果 —— 精确模拟「发出去了但没记下」
    await store.recordIntent({
      runAttemptId: a.id,
      seq: 1,
      toolName: 'send_email',
      argsHash: 'h',
      sideEffectClass: 'non_idempotent',
    })

    await clock.advance(60_001)
    const rec = new Reconciler(db, deps, { maxAttempts: 3, backoffMs: 1000 })
    const report = await rec.runOnce()

    expect(report.escalated).toEqual([run.id])
    expect(report.requeued).toEqual([])

    const finalRun = await store.getRun(run.id)
    expect(finalRun!.status).toBe('needs_human_confirmation')
    expect(finalRun!.errorCode).toBe('tool.side_effect_unknown')
    expect((finalRun!.errorDetail as { invocations: unknown[] }).invocations).toHaveLength(1)

    // 关键：没有新 attempt，邮件不会被发第二次
    await clock.advance(10_000)
    expect(await store.claimNext('w2')).toBeNull()
    expect(sendCount).toBe(0) // 本测试里工具没被真正调用过
  })
})
