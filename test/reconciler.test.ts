import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { RunStore } from '../src/store/runs.js'
import { Reconciler } from '../src/runtime/reconciler.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'

let db: Db
let clock: FakeClock
let deps: Deps
let store: RunStore
let rec: Reconciler

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  clock = new FakeClock()
  deps = { clock, ids: new FakeIds() }
  store = new RunStore(db, deps)
  rec = new Reconciler(db, deps, { maxAttempts: 3, backoffMs: 5_000 })
})

afterEach(async () => {
  await db.close()
})

/** 起一个 run 并领取，模拟「正在跑」 */
async function running(agentId = 'ant', opts: { deadlineAt?: Date } = {}) {
  const run = await store.createRun({ agentId, deadlineAt: opts.deadlineAt ?? null })
  await store.enqueueAttempt(run.id)
  const attempt = await store.claimNext('worker-1', 60_000)
  return { run, attempt: attempt! }
}

// ═══════════════════════════════════════════════════════
// 强断言 #6 相关：reconciler 的时间边界
// ═══════════════════════════════════════════════════════

describe('lease 过期', () => {
  it('lease 未到期不判死', async () => {
    const { attempt } = await running()
    await clock.advance(59_999)
    const r = await rec.runOnce()
    expect(r.lostAttempts).toEqual([])
    expect((await store.getAttempt(attempt.id))!.status).toBe('running')
  })

  it('lease 到期即判 lost 并作废 fence', async () => {
    const { run, attempt } = await running()
    await clock.advance(60_001)

    const r = await rec.runOnce()
    expect(r.lostAttempts).toEqual([attempt.id])

    const a = await store.getAttempt(attempt.id)
    expect(a!.status).toBe('lost')
    expect(a!.errorCode).toBe('runtime.lease_expired')
    // fence 作废：旧 worker 复活也写不进
    expect(a!.fenceToken).toBeNull()

    // 自动重试：新 attempt 已入队
    expect(r.requeued).toEqual([run.id])
    expect(await store.listAttempts(run.id)).toHaveLength(2)
  })

  it('heartbeat 续租可以阻止判死', async () => {
    const { attempt } = await running()
    for (let i = 0; i < 5; i++) {
      await clock.advance(30_000)
      expect(await store.heartbeat(attempt.id, attempt.fenceToken!, 60_000)).toBe(true)
      expect((await rec.runOnce()).lostAttempts).toEqual([])
    }
    expect((await store.getAttempt(attempt.id))!.status).toBe('running')
  })

  it('重试用指数退避，未到时间不可领取', async () => {
    const { run } = await running()
    await clock.advance(60_001)
    await rec.runOnce() // attempt 1 → lost，attempt 2 入队，退避 5s

    expect(await store.claimNext('w2')).toBeNull()
    await clock.advance(5_001)
    const claimed = await store.claimNext('w2')
    expect(claimed).not.toBeNull()
    expect(claimed!.runId).toBe(run.id)
    expect(claimed!.attemptNo).toBe(2)
  })

  it('达到 maxAttempts 后落 failed 而不是无限重试', async () => {
    const { run } = await running()
    // 每轮：领取（若在退避期则拿不到，下一轮时钟推进后即可）→ 超时 → reconcile
    for (let i = 0; i < 8; i++) {
      await store.claimNext('w')
      await clock.advance(120_000)
      await rec.runOnce()
    }
    const finalRun = await store.getRun(run.id)
    expect(finalRun!.status).toBe('failed')
    expect(finalRun!.errorCode).toBe('runtime.max_attempts')
    expect(await store.listAttempts(run.id)).toHaveLength(3)
  })
})

describe('deadline', () => {
  it('超过 deadline_at 判 timed_out', async () => {
    const deadline = new Date(clock.now() + 10_000)
    const { attempt } = await running('ant', { deadlineAt: deadline })

    await clock.advance(9_000)
    expect((await rec.runOnce()).timedOutAttempts).toEqual([])

    await clock.advance(2_000)
    const r = await rec.runOnce()
    expect(r.timedOutAttempts).toEqual([attempt.id])
    expect((await store.getAttempt(attempt.id))!.errorCode).toBe('runtime.deadline_exceeded')
  })
})

// ═══════════════════════════════════════════════════════
// 强断言 #5：non_idempotent 的 UNKNOWN 绝不自动重跑
// ═══════════════════════════════════════════════════════

describe('副作用分流', () => {
  it('pure 的 UNKNOWN 调用照常重试', async () => {
    const { run, attempt } = await running()
    await store.recordIntent({
      runAttemptId: attempt.id,
      seq: 1,
      toolName: 'read_file',
      argsHash: 'h',
      sideEffectClass: 'pure',
    })

    await clock.advance(60_001)
    const r = await rec.runOnce()
    expect(r.requeued).toEqual([run.id])
    expect(r.escalated).toEqual([])
  })

  it('idempotent 的 UNKNOWN 调用照常重试', async () => {
    const { run, attempt } = await running()
    await store.recordIntent({
      runAttemptId: attempt.id,
      seq: 1,
      toolName: 'put_object',
      argsHash: 'h',
      sideEffectClass: 'idempotent',
      idempotencyKey: 'k',
    })

    await clock.advance(60_001)
    expect((await rec.runOnce()).requeued).toEqual([run.id])
  })

  it('non_idempotent 的 UNKNOWN 调用升级人工确认，绝不自动重跑', async () => {
    const { run, attempt } = await running()
    await store.recordIntent({
      runAttemptId: attempt.id,
      seq: 1,
      toolName: 'send_email',
      argsHash: 'h',
      sideEffectClass: 'non_idempotent',
    })

    await clock.advance(60_001)
    const r = await rec.runOnce()

    expect(r.escalated).toEqual([run.id])
    expect(r.requeued).toEqual([])

    const finalRun = await store.getRun(run.id)
    expect(finalRun!.status).toBe('needs_human_confirmation')
    expect(finalRun!.errorCode).toBe('tool.side_effect_unknown')

    // 没有新 attempt 被创建
    expect(await store.listAttempts(run.id)).toHaveLength(1)
    expect(await store.claimNext('w')).toBeNull()
  })

  it('non_idempotent 调用已有结果则不算 UNKNOWN，可正常重试', async () => {
    const { run, attempt } = await running()
    const id = await store.recordIntent({
      runAttemptId: attempt.id,
      seq: 1,
      toolName: 'send_email',
      argsHash: 'h',
      sideEffectClass: 'non_idempotent',
    })
    await store.recordOutcome(id, 'ok')

    await clock.advance(60_001)
    const r = await rec.runOnce()
    expect(r.escalated).toEqual([])
    expect(r.requeued).toEqual([run.id])
  })
})

// ═══════════════════════════════════════════════════════
// wake 补漏
// ═══════════════════════════════════════════════════════

describe('wake 修复', () => {
  it('子 run 全终态但 pending_count 未归零时补触发', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    const child = await store.createRun({ agentId: 'albert', parentRunId: parent.id, depth: 1 })
    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      waitOnRunIds: [child.id],
    })

    // 绕过 store，直接把子 run 置终态 —— 模拟递减逻辑漏掉的情形
    await db.query(`update runs set status = 'succeeded' where id = $1`, [child.id])
    expect((await store.getWake(wake.id))!.pendingCount).toBe(1)

    const r = await rec.runOnce()
    expect(r.repairedWakes).toEqual([wake.id])

    const w = await store.getWake(wake.id)
    expect(w!.status).toBe('fired')
    expect(w!.firedAttemptId).not.toBeNull()

    const resumed = await store.claimNext('w')
    expect(resumed!.runId).toBe(parent.id)
  })

  it('还有子 run 在跑时不补触发', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    const c1 = await store.createRun({ agentId: 'a', parentRunId: parent.id, depth: 1 })
    const c2 = await store.createRun({ agentId: 'b', parentRunId: parent.id, depth: 1 })
    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      waitOnRunIds: [c1.id, c2.id],
    })

    await db.query(`update runs set status = 'succeeded' where id = $1`, [c1.id])
    expect((await rec.runOnce()).repairedWakes).toEqual([])
    expect((await store.getWake(wake.id))!.status).toBe('waiting')
  })

  it('reconciler 判 run 失败时同样唤醒 parent', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    const child = await store.createRun({ agentId: 'albert', parentRunId: parent.id, depth: 1 })
    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      waitOnRunIds: [child.id],
    })

    // 子 run 反复失败直到耗尽重试预算
    await store.enqueueAttempt(child.id)
    for (let i = 0; i < 8; i++) {
      await store.claimNext('w')
      await clock.advance(120_000)
      await rec.runOnce()
    }

    expect((await store.getRun(child.id))!.status).toBe('failed')
    const w = await store.getWake(wake.id)
    expect(w!.status).toBe('fired')
    expect(w!.firedAttemptId).not.toBeNull()
  })
})

describe('队列清理', () => {
  it('终态 attempt 的队列条目被移除', async () => {
    const { run, attempt } = await running()
    await store.finishAttempt({
      attemptId: attempt.id,
      fenceToken: attempt.fenceToken!,
      status: 'succeeded',
    })
    // finishAttempt 已清理；reconciler 再跑不应报错也不重复计数
    const before = await db.query(`select count(*)::int n from run_queue where run_id = $1`, [run.id])
    expect((before.rows[0] as { n: number }).n).toBe(0)
    await rec.runOnce()
  })

  it('claim 后 attempt 仍是 queued 的僵尸条目被释放', async () => {
    const run = await store.createRun({ agentId: 'ant' })
    const a = await store.enqueueAttempt(run.id)
    // 模拟 worker 崩在 claim 与 start 之间
    await db.query(`update run_queue set claimed_by = 'dead', claimed_at = now() where run_id = $1`, [
      run.id,
    ])

    const r = await rec.runOnce()
    expect(r.releasedQueueItems).toBeGreaterThan(0)

    const claimed = await store.claimNext('w2')
    expect(claimed!.attemptNo).toBe(a.attemptNo)
  })
})

describe('幂等性', () => {
  it('连续跑两次 reconciler 不产生重复效果', async () => {
    const { run } = await running()
    await clock.advance(60_001)

    const first = await rec.runOnce()
    const second = await rec.runOnce()

    expect(first.lostAttempts).toHaveLength(1)
    expect(second.lostAttempts).toEqual([])
    expect(second.requeued).toEqual([])
    expect(await store.listAttempts(run.id)).toHaveLength(2)
  })
})
