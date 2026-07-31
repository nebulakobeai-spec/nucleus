import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { RunStore, splitModelKey, StaleFenceError } from '../src/store/runs.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'

let db: Db
let clock: FakeClock
let store: RunStore
let deps: Deps

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  clock = new FakeClock()
  deps = { clock, ids: new FakeIds() }
  store = new RunStore(db, deps)
})

afterEach(async () => {
  await db.close()
})

async function conversation(): Promise<string> {
  const id = crypto.randomUUID()
  await db.query(`insert into conversations(id, agent_id) values ($1, 'orchestrator')`, [id])
  return id
}

// ═══════════════════════════════════════════════════════
// 逻辑 run 与物理 attempt 的分离（§3.3）
// ═══════════════════════════════════════════════════════

describe('run / attempt 分离', () => {
  it('重试新建 attempt，不新建 run，idempotency_key 保持唯一', async () => {
    const run = await store.createRun({ agentId: 'albert', idempotencyKey: 'k1' })

    const a1 = await store.enqueueAttempt(run.id)
    const claimed1 = await store.claimNext('w1')
    await store.finishAttempt({
      attemptId: claimed1!.id,
      fenceToken: claimed1!.fenceToken!,
      status: 'failed',
      errorCode: 'provider.timeout',
      runStatusOverride: 'waiting_retry',
    })

    const a2 = await store.enqueueAttempt(run.id)
    expect(a2.attemptNo).toBe(a1.attemptNo + 1)

    const attempts = await store.listAttempts(run.id)
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2])
    expect(attempts[0]!.status).toBe('failed')
    expect(attempts[1]!.status).toBe('queued')

    // 同一 key 再建逻辑 run 会撞唯一约束 —— 这正是我们要的
    await expect(store.createRun({ agentId: 'albert', idempotencyKey: 'k1' })).rejects.toThrow()
  })

  it('failed attempt 可映射为 waiting_retry 而非 failed run', async () => {
    const run = await store.createRun({ agentId: 'ant' })
    await store.enqueueAttempt(run.id)
    const c = await store.claimNext('w1')
    const r = await store.finishAttempt({
      attemptId: c!.id,
      fenceToken: c!.fenceToken!,
      status: 'failed',
      errorCode: 'provider.quota_exhausted',
      runStatusOverride: 'waiting_retry',
    })
    expect(r.runStatus).toBe('waiting_retry')
    expect((await store.getRun(run.id))!.endedAt).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// 强断言 #4：过期 fence token 的写入必须被拒绝（§3.4）
// ═══════════════════════════════════════════════════════

describe('lease + fencing', () => {
  it('被判死的 worker 复活后写入被拒绝', async () => {
    const run = await store.createRun({ agentId: 'ant' })
    await store.enqueueAttempt(run.id)
    const claimed = await store.claimNext('worker-A', 60_000)
    const staleFence = claimed!.fenceToken!

    // reconciler 判死并重发 fence（模拟 lease 过期后的接管）
    await db.query(
      `update run_attempts set fence_token = 'fence-new', worker_id = 'worker-B' where id = $1`,
      [claimed!.id],
    )

    await expect(
      store.finishAttempt({ attemptId: claimed!.id, fenceToken: staleFence, status: 'succeeded' }),
    ).rejects.toBeInstanceOf(StaleFenceError)

    // 新 fence 可以正常收尾
    const ok = await store.finishAttempt({
      attemptId: claimed!.id,
      fenceToken: 'fence-new',
      status: 'succeeded',
    })
    expect(ok.runStatus).toBe('succeeded')
  })

  it('heartbeat 在 fence 失效后返回 false', async () => {
    const run = await store.createRun({ agentId: 'ant' })
    await store.enqueueAttempt(run.id)
    const c = await store.claimNext('worker-A')

    expect(await store.heartbeat(c!.id, c!.fenceToken!)).toBe(true)

    await db.query(`update run_attempts set fence_token = 'other' where id = $1`, [c!.id])
    expect(await store.heartbeat(c!.id, c!.fenceToken!)).toBe(false)
  })

  it('heartbeat 推进 lease 到期时间', async () => {
    const run = await store.createRun({ agentId: 'ant' })
    await store.enqueueAttempt(run.id)
    const c = await store.claimNext('w1', 60_000)
    const before = (await store.getAttempt(c!.id))!.leaseExpiresAt!.getTime()

    await clock.advance(30_000)
    await store.heartbeat(c!.id, c!.fenceToken!, 60_000)

    const after = (await store.getAttempt(c!.id))!.leaseExpiresAt!.getTime()
    expect(after - before).toBe(30_000)
  })

  it('两个 worker 并发领取不会拿到同一个 attempt', async () => {
    const runs = await Promise.all([
      store.createRun({ agentId: 'a' }),
      store.createRun({ agentId: 'b' }),
    ])
    for (const r of runs) await store.enqueueAttempt(r.id)

    const [x, y] = await Promise.all([store.claimNext('w1'), store.claimNext('w2')])
    expect(x).not.toBeNull()
    expect(y).not.toBeNull()
    expect(x!.id).not.toBe(y!.id)
    expect(await store.claimNext('w3')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// 强断言 #3：wake 在子 run 终态的同一事务内触发（§3.5）
// ═══════════════════════════════════════════════════════

describe('wake / join', () => {
  it('最后一个子 run 终态时唤醒 parent 并入队新 attempt', async () => {
    const conv = await conversation()
    const parent = await store.createRun({ agentId: 'orchestrator', conversationId: conv })
    const c1 = await store.createRun({ agentId: 'albert', parentRunId: parent.id, depth: 1 })
    const c2 = await store.createRun({ agentId: 'ant', parentRunId: parent.id, depth: 1 })

    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      parentConversationId: conv,
      waitOnRunIds: [c1.id, c2.id],
      resumePayload: { goal: '整合两份结果' },
    })
    expect(wake.pendingCount).toBe(2)
    expect((await store.getRun(parent.id))!.status).toBe('waiting_children')

    // 第一个子 run 完成 → 还不触发
    await store.enqueueAttempt(c1.id)
    const a1 = await store.claimNext('w1')
    const r1 = await store.finishAttempt({
      attemptId: a1!.id,
      fenceToken: a1!.fenceToken!,
      status: 'succeeded',
      result: { summary: 'albert done' },
    })
    expect(r1.firedWakeIds).toEqual([])
    expect((await store.getWake(wake.id))!.pendingCount).toBe(1)

    // 第二个完成 → 同事务内触发唤醒
    await store.enqueueAttempt(c2.id)
    const a2 = await store.claimNext('w1')
    const r2 = await store.finishAttempt({
      attemptId: a2!.id,
      fenceToken: a2!.fenceToken!,
      status: 'succeeded',
      result: { summary: 'ant done' },
    })

    expect(r2.firedWakeIds).toEqual([wake.id])
    expect(r2.enqueuedParents).toEqual([{ runId: parent.id, attemptNo: 1 }])

    const fired = await store.getWake(wake.id)
    expect(fired!.status).toBe('fired')
    expect(fired!.firedAttemptId).not.toBeNull()

    // parent 的新 attempt 确实可被领取
    const resumed = await store.claimNext('w2')
    expect(resumed!.runId).toBe(parent.id)
  })

  it('失败的子 run 同样触发唤醒 —— parent 必须知道它失败了', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    const child = await store.createRun({ agentId: 'albert', parentRunId: parent.id, depth: 1 })
    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      waitOnRunIds: [child.id],
    })

    await store.enqueueAttempt(child.id)
    const a = await store.claimNext('w1')
    const r = await store.finishAttempt({
      attemptId: a!.id,
      fenceToken: a!.fenceToken!,
      status: 'failed',
      errorCode: 'tool.crashed',
    })

    expect(r.firedWakeIds).toEqual([wake.id])
    expect((await store.getWake(wake.id))!.status).toBe('fired')
  })

  it('waiting_retry 的子 run 不触发唤醒（还没到终态）', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    const child = await store.createRun({ agentId: 'albert', parentRunId: parent.id, depth: 1 })
    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      waitOnRunIds: [child.id],
    })

    await store.enqueueAttempt(child.id)
    const a = await store.claimNext('w1')
    const r = await store.finishAttempt({
      attemptId: a!.id,
      fenceToken: a!.fenceToken!,
      status: 'failed',
      runStatusOverride: 'waiting_retry',
    })

    expect(r.firedWakeIds).toEqual([])
    expect((await store.getWake(wake.id))!.pendingCount).toBe(1)
  })

  it('竞态：arm 时子 run 已全部终态则立刻触发', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    const child = await store.createRun({ agentId: 'albert', parentRunId: parent.id, depth: 1 })

    await store.enqueueAttempt(child.id)
    const a = await store.claimNext('w1')
    await store.finishAttempt({
      attemptId: a!.id,
      fenceToken: a!.fenceToken!,
      status: 'succeeded',
    })

    // 子 run 已经跑完了才 arm —— 不能永远等下去
    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      waitOnRunIds: [child.id],
    })
    expect(wake.status).toBe('fired')
    expect(wake.firedAttemptId).not.toBeNull()
  })

  it('禁止 fire-and-forget 委派', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    await expect(
      store.armWake({ parentRunId: parent.id, parentAgentId: 'o', waitOnRunIds: [] }),
    ).rejects.toThrow(/fire-and-forget/)
  })

  it('唤醒失败则整体回滚，不会出现「子 run 已完成但 parent 没被唤醒」', async () => {
    const parent = await store.createRun({ agentId: 'orchestrator' })
    const child = await store.createRun({ agentId: 'albert', parentRunId: parent.id, depth: 1 })
    const wake = await store.armWake({
      parentRunId: parent.id,
      parentAgentId: 'orchestrator',
      waitOnRunIds: [child.id],
    })

    await store.enqueueAttempt(child.id)
    const a = await store.claimNext('w1')

    // 注入故障：让唤醒 parent 时的 enqueueAttempt 必然失败。
    // `not valid` 只约束新插入的行，不影响已存在的 attempt。
    await db.query(
      `alter table run_attempts add constraint no_new_attempts check (false) not valid`,
    )

    await expect(
      store.finishAttempt({
        attemptId: a!.id,
        fenceToken: a!.fenceToken!,
        status: 'succeeded',
      }),
    ).rejects.toThrow()

    // 子 attempt 必须还停在 running，wake 必须还是 waiting —— 整个事务回滚了
    expect((await store.getAttempt(a!.id))!.status).toBe('running')
    const w = await store.getWake(wake.id)
    expect(w!.status).toBe('waiting')
    expect(w!.pendingCount).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════
// 强断言 #5：non_idempotent 的 UNKNOWN 结果绝不自动重跑（§3.2）
// ═══════════════════════════════════════════════════════

describe('工具调用意图日志', () => {
  it('意图先于调用记录，崩溃后可识别为 UNKNOWN', async () => {
    const run = await store.createRun({ agentId: 'ant' })
    await store.enqueueAttempt(run.id)
    const a = await store.claimNext('w1')

    const pureId = await store.recordIntent({
      runAttemptId: a!.id,
      seq: 1,
      toolName: 'read_file',
      argsHash: 'h1',
      sideEffectClass: 'pure',
    })
    await store.recordOutcome(pureId, 'ok')

    // 这一个「崩在中间」：意图已写，结果未写
    await store.recordIntent({
      runAttemptId: a!.id,
      seq: 2,
      toolName: 'send_email',
      argsHash: 'h2',
      sideEffectClass: 'non_idempotent',
    })

    const unknown = await store.unknownInvocations(a!.id)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.toolName).toBe('send_email')
    expect(unknown[0]!.sideEffectClass).toBe('non_idempotent')
  })
})

// ═══════════════════════════════════════════════════════
// 「谁真的干了这活」—— 订阅判定与事后追责的唯一凭据
// ═══════════════════════════════════════════════════════

describe('实际服务的模型落库', () => {
  it('modelKey 被拆成 provider + model 存下来', async () => {
    const run = await store.createRun({ agentId: 'albert' })
    await store.enqueueAttempt(run.id)
    const a = await store.claimNext('w1')
    await store.finishAttempt({
      attemptId: a!.id,
      fenceToken: a!.fenceToken!,
      status: 'succeeded',
      modelKey: 'zai:glm-5.2',
    })

    const [row] = await store.listAttempts(run.id)
    expect(row!.provider).toBe('zai')
    expect(row!.model).toBe('glm-5.2')
    // 关键：拼回去必须等于配置里的 key，否则查不到单价与计费方式，
    // 「订阅制显示订阅而不是 $0」就会静默失效
    expect(`${row!.provider}:${row!.model}`).toBe('zai:glm-5.2')
  })

  it('本地模型名自带冒号也能原样拼回', () => {
    expect(splitModelKey('ollama:gemma4:31b')).toEqual(['ollama', 'gemma4:31b'])
    const [p, m] = splitModelKey('ollama:gemma4:31b')
    expect(`${p}:${m}`).toBe('ollama:gemma4:31b')
  })

  it('没给 modelKey 就留空，绝不从别的 attempt 继承 —— 编造凭据比没有更糟', async () => {
    const run = await store.createRun({ agentId: 'albert' })

    // 第 1 次：kimi 服务，失败
    await store.enqueueAttempt(run.id)
    const a1 = await store.claimNext('w1')
    await store.finishAttempt({
      attemptId: a1!.id,
      fenceToken: a1!.fenceToken!,
      status: 'failed',
      errorCode: 'provider.timeout',
      modelKey: 'kimi:k3',
    })

    // 第 2 次：一次模型都没调成（如全链熔断），没有 modelKey 可报
    await store.enqueueAttempt(run.id)
    const a2 = await store.claimNext('w1')
    await store.finishAttempt({
      attemptId: a2!.id,
      fenceToken: a2!.fenceToken!,
      status: 'failed',
      errorCode: 'provider.all_exhausted',
    })

    const rows = await store.listAttempts(run.id)
    expect(rows[0]!.provider).toBe('kimi')
    // 第 2 次必须是 null 而不是继承 kimi —— 它根本没调到模型
    expect(rows[1]!.provider).toBeNull()
    expect(rows[1]!.model).toBeNull()
  })

  it('splitModelKey 处理空值与无冒号的输入', () => {
    expect(splitModelKey(null)).toEqual([null, null])
    expect(splitModelKey(undefined)).toEqual([null, null])
    expect(splitModelKey('')).toEqual([null, null])
    expect(splitModelKey('bare')).toEqual([null, 'bare'])
  })
})
