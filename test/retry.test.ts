import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { RunStore } from '../src/store/runs.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { backoffMs, decideRetry, DEFAULT_RETRY_POLICY } from '../src/runtime/retry.js'
import { errorSpec } from '../src/errors.js'
import { Reconciler } from '../src/runtime/reconciler.js'

/**
 * run 级重试。
 *
 * 这是补的最大一个可靠性洞：真正的重试只发生在**一次 chat() 内部**
 * （就地重试 + 模型链降级），attempt 一失败 run 就落 terminal failed，
 * 队列是空的 —— 而界面却写着「系统会自动重试」。
 *
 * 后果就是最初要修的那类：四个模型同时限流 → 整条链 exhausted → run 死掉 →
 * 得重新发一遍，而 provider_events 里明明记着「等到 xx:xx 就恢复了」。
 */

const P = { maxAttempts: 4, baseMs: 1_000, capMs: 10_000 }

describe('decideRetry', () => {
  it('限流、额度、服务端错误、超时、全链不可用 → 值得等', () => {
    for (const code of [
      'provider.rate_limited',
      'provider.quota_exhausted',
      'provider.server_error',
      'provider.timeout',
      'provider.all_exhausted',
    ]) {
      expect(decideRetry({ errorCode: code, attemptNo: 1, policy: P }).retry, code).toBe(true)
    }
  })

  it('契约不过**不**重试 —— 同样的 prompt 只会得到同样的结果', () => {
    // retryable 与 runRetryable 是两件事：前者是「让模型重写」（attempt 内），
    // 混用会把「模型答不对」变成「任务反复重跑，只是慢四倍」
    expect(errorSpec('contract.postcondition_failed')!.retryable).toBe(true)
    expect(errorSpec('contract.postcondition_failed')!.runRetryable).toBe(false)
    expect(decideRetry({ errorCode: 'contract.postcondition_failed', attemptNo: 1, policy: P }).retry).toBe(
      false,
    )
  })

  it('连不上、预算超限、配置错误、取消都不重试', () => {
    for (const code of [
      'provider.unreachable',
      'budget.steps_exceeded',
      'config.agent_not_found',
      'runtime.cancelled',
      'provider.bad_request',
    ]) {
      expect(decideRetry({ errorCode: code, attemptNo: 1, policy: P }).retry, code).toBe(false)
    }
  })

  it('带了 retryAfterMs 就值得等，即便错误标成 needs_user', () => {
    // 我们**知道**什么时候回来，这比恢复性分类更具体
    const d = decideRetry({ errorCode: 'provider.unreachable', retryAfterMs: 5_000, attemptNo: 1, policy: P })
    expect(d.retry).toBe(true)
    expect(d.delayMs).toBe(5_000)
  })

  it('provider 说的时间**不受退避上限截断**', () => {
    // min(cap, max(backoff, after)) 是错的：额度一小时后才重置而 cap 是 10 秒时，
    // 会在 10 秒后去撞一扇关着的门，把 attempt 预算烧完。
    // 「白等 30 秒然后失败」比「等一小时然后成功」差得多
    const d = decideRetry({ errorCode: 'provider.rate_limited', retryAfterMs: 3_600_000, attemptNo: 1, policy: P })
    expect(d.delayMs).toBe(3_600_000)
    expect(d.reason).toContain('3600s')
  })

  it('自己猜的退避受上限约束', () => {
    expect(backoffMs(1, P)).toBe(1_000)
    expect(backoffMs(2, P)).toBe(2_000)
    expect(backoffMs(5, P)).toBe(10_000) // 撞到 cap
    expect(backoffMs(50, P)).toBe(10_000)
  })

  it('到达 maxAttempts 就停 —— 无限重试比失败更糟', () => {
    const d = decideRetry({ errorCode: 'provider.timeout', attemptNo: 4, policy: P })
    expect(d.retry).toBe(false)
    expect(d.reason).toContain('上限')
  })

  it('未注册的错误码不重试 —— 不认识的东西不该自动重来', () => {
    expect(decideRetry({ errorCode: 'made.up', attemptNo: 1, policy: P }).retry).toBe(false)
  })

  it('默认策略是保守的', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(5)
    expect(DEFAULT_RETRY_POLICY.capMs).toBeLessThanOrEqual(10 * 60_000)
  })
})

// ═══════════════════════════════════════════════════════
// 排重试与终态写入必须同事务
// ═══════════════════════════════════════════════════════

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

describe('finishAttempt 排重试', () => {
  async function failing() {
    const run = await store.createRun({ agentId: 'a' })
    await store.enqueueAttempt(run.id)
    const claimed = await store.claimNext('w1')
    return { run, claimed: claimed! }
  }

  it('run 转 waiting_retry，队列里有一条排在未来的 attempt', async () => {
    const { run, claimed } = await failing()
    const at = new Date(clock.now() + 60_000)
    const r = await store.finishAttempt({
      attemptId: claimed.id,
      fenceToken: claimed.fenceToken!,
      status: 'failed',
      errorCode: 'provider.rate_limited',
      runStatusOverride: 'waiting_retry',
      retryAt: at,
    })
    expect(r.retryAttemptNo).toBe(2)

    const after = await store.getRun(run.id)
    expect(after!.status).toBe('waiting_retry')
    // 逻辑 run 没结束 —— endedAt 不能被写
    expect(after!.endedAt).toBeNull()
    // attempt 本身是终态且不可变
    expect((await store.getAttempt(claimed.id))!.status).toBe('failed')

    const q = await db.query<{ n: number; at: Date }>(
      `select count(*)::int n, min(available_at) as at from run_queue where run_id = $1`,
      [run.id],
    )
    expect(q.rows[0]!.n).toBe(1)
    expect(new Date(q.rows[0]!.at).getTime()).toBe(at.getTime())
  })

  it('排在未来的重试**不会**被立刻领走', async () => {
    const { claimed } = await failing()
    await store.finishAttempt({
      attemptId: claimed.id,
      fenceToken: claimed.fenceToken!,
      status: 'failed',
      errorCode: 'provider.rate_limited',
      runStatusOverride: 'waiting_retry',
      retryAt: new Date(clock.now() + 60_000),
    })
    expect(await store.claimNext('w1')).toBeNull()

    // 时间到了才领得到
    await clock.advance(60_001)
    const next = await store.claimNext('w1')
    expect(next?.attemptNo).toBe(2)
  })

  it('排到未来时**不把** waiting_retry 翻成 pending —— 那样看不出在等什么', async () => {
    const { run, claimed } = await failing()
    await store.finishAttempt({
      attemptId: claimed.id,
      fenceToken: claimed.fenceToken!,
      status: 'failed',
      errorCode: 'provider.rate_limited',
      runStatusOverride: 'waiting_retry',
      retryAt: new Date(clock.now() + 60_000),
    })
    expect((await store.getRun(run.id))!.status).toBe('waiting_retry')
  })

  it('不排重试时照旧落 failed 并写 endedAt', async () => {
    const { run, claimed } = await failing()
    await store.finishAttempt({
      attemptId: claimed.id,
      fenceToken: claimed.fenceToken!,
      status: 'failed',
      errorCode: 'provider.unreachable',
    })
    const after = await store.getRun(run.id)
    expect(after!.status).toBe('failed')
    expect(after!.endedAt).not.toBeNull()
    const q = await db.query<{ n: number }>(`select count(*)::int n from run_queue where run_id = $1`, [
      run.id,
    ])
    expect(q.rows[0]!.n).toBe(0)
  })
})

describe('reconciler 兜底', () => {
  it('waiting_retry 但队列为空 → 立刻重排', async () => {
    // 正常路径下这个状态不该出现（同事务），但「不该出现」不等于「不会出现」——
    // 而「任务挂住却看不出来」正是这个项目要消灭的东西
    const run = await store.createRun({ agentId: 'a' })
    await store.enqueueAttempt(run.id)
    const claimed = await store.claimNext('w1')
    await store.finishAttempt({
      attemptId: claimed!.id,
      fenceToken: claimed!.fenceToken!,
      status: 'failed',
      errorCode: 'provider.rate_limited',
      runStatusOverride: 'waiting_retry',
    })
    // 手工制造悬挂：没有排重试
    let q = await db.query<{ n: number }>(`select count(*)::int n from run_queue where run_id = $1`, [run.id])
    expect(q.rows[0]!.n).toBe(0)

    const report = await new Reconciler(db, deps).runOnce()
    expect(report.requeued).toContain(run.id)
    q = await db.query<{ n: number }>(`select count(*)::int n from run_queue where run_id = $1`, [run.id])
    expect(q.rows[0]!.n).toBe(1)
  })
})
