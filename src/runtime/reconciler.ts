import type { Db } from '../db/types.js'
import type { Deps } from '../seams.js'
import { RunStore } from '../store/runs.js'
import { TERMINAL_RUN_SQL, recoveryFor, type SideEffectClass } from '../domain.js'

export interface ReconcileReport {
  /** lease 过期 → attempt 判 lost */
  lostAttempts: string[]
  /** 超过 deadline_at → attempt 判 timed_out */
  timedOutAttempts: string[]
  /** 自动重试而重新入队的 run */
  requeued: string[]
  /** 因不可幂等的 UNKNOWN 调用而升级人工确认的 run */
  escalated: string[]
  /** 子 run 全部终态但未触发的 wake（补触发） */
  repairedWakes: string[]
  /** 队列里 claim 后再无进展的僵尸条目（释放） */
  releasedQueueItems: number
}

export interface ReconcilerOptions {
  /** attempt 被判死后是否自动重试 */
  maxAttempts?: number
  /** 重试退避基数 */
  backoffMs?: number
}

/**
 * Reconciler：把「数据库里记录的状态」与「现实」对齐。
 *
 * 纯 SQL + 时钟，**零 LLM、零 token**。
 * 它的存在意义：任何单点失败都有一个不依赖该单点的东西负责收尾。
 * 没有它，被 kill -9 的 attempt 会永远停在 running。
 */
export class Reconciler {
  #store: RunStore

  constructor(
    private db: Db,
    private deps: Deps,
    private opts: ReconcilerOptions = {},
  ) {
    this.#store = new RunStore(db, deps)
  }

  async runOnce(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      lostAttempts: [],
      timedOutAttempts: [],
      requeued: [],
      escalated: [],
      repairedWakes: [],
      releasedQueueItems: 0,
    }

    await this.#expireLeases(report)
    await this.#expireDeadlines(report)
    await this.#handleDeadAttempts(report)
    await this.#repairWakes(report)
    await this.#repairStuckRetries(report)
    await this.#releaseOrphanedQueueItems(report)

    return report
  }

  /**
   * 兜底：run 是 waiting_retry 但队列里没有它。
   *
   * 正常路径下重试的入队与终态写入在同一个事务里，所以这个状态不该出现。
   * 但「不该出现」不等于「不会出现」—— 数据库半途失败、手工改过状态、
   * 或者将来某处漏了事务，都会留下一个永远等不到重试的 run。
   * 而「任务挂住却看不出来」正是这个项目要消灭的东西。
   */
  async #repairStuckRetries(report: ReconcileReport): Promise<void> {
    const stuck = await this.db.query<{ id: string }>(
      `select r.id from runs r
        where r.status = 'waiting_retry'
          and not exists (select 1 from run_queue q where q.run_id = r.id)
          and not exists (
            select 1 from run_attempts a
             where a.run_id = r.id and a.status in ('queued', 'running')
          )`,
    )
    for (const row of stuck.rows) {
      // 立刻入队 —— 已经错过了原定的重试时刻，再等没有意义
      await this.#store.enqueueAttempt(row.id)
      report.requeued.push(row.id)
    }
  }

  /** lease 过期 = worker 死了。判 lost 并作废 fence（旧 worker 复活也写不进）。 */
  async #expireLeases(report: ReconcileReport): Promise<void> {
    const now = this.deps.clock.nowIso()
    const r = await this.db.query<{ id: string }>(
      `update run_attempts
          set status = 'lost',
              ended_at = $1,
              error_code = 'runtime.lease_expired',
              fence_token = null,
              lease_expires_at = null
        where status in ('queued','running')
          and lease_expires_at is not null
          and lease_expires_at < $1
        returning id`,
      [now],
    )
    report.lostAttempts.push(...r.rows.map((x) => x.id))
  }

  /** 超过 run 的 deadline。保留已有产出，不是「失败」而是「没做完」。 */
  async #expireDeadlines(report: ReconcileReport): Promise<void> {
    const now = this.deps.clock.nowIso()
    const r = await this.db.query<{ id: string }>(
      `update run_attempts a
          set status = 'timed_out',
              ended_at = $1,
              error_code = 'runtime.deadline_exceeded',
              fence_token = null,
              lease_expires_at = null
         from runs r
        where a.run_id = r.id
          and a.status in ('queued','running')
          and r.deadline_at is not null
          and r.deadline_at < $1
        returning a.id`,
      [now],
    )
    report.timedOutAttempts.push(...r.rows.map((x) => x.id))
  }

  /**
   * 处理刚被判死的 attempt：决定重试还是升级人工。
   *
   * 关键分流（DESIGN.md §3.2）：只要该 attempt 里存在 `non_idempotent` 的
   * UNKNOWN 调用，就**绝不自动重试** —— 外部副作用可能已经发生了。
   */
  async #handleDeadAttempts(report: ReconcileReport): Promise<void> {
    const maxAttempts = this.opts.maxAttempts ?? 3
    const backoff = this.opts.backoffMs ?? 5_000

    const dead = await this.db.query<{
      attempt_id: string
      run_id: string
      attempt_no: number
      run_status: string
    }>(
      `select a.id as attempt_id, a.run_id, a.attempt_no, r.status as run_status
         from run_attempts a
         join runs r on r.id = a.run_id
        where a.status in ('lost','timed_out')
          and a.ended_at is not null
          and r.status in ('running','pending')
          and not exists (
            select 1 from run_attempts n
             where n.run_id = a.run_id and n.attempt_no > a.attempt_no
          )`,
    )

    for (const d of dead.rows) {
      const unknown = await this.#store.unknownInvocations(d.attempt_id)
      const mustEscalate = unknown.some(
        (u) => recoveryFor(u.sideEffectClass as SideEffectClass) === 'escalate',
      )

      if (mustEscalate) {
        await this.db.query(
          `update runs
              set status = 'needs_human_confirmation',
                  error_code = 'tool.side_effect_unknown',
                  error_detail = $2::jsonb
            where id = $1`,
          [
            d.run_id,
            JSON.stringify({
              reason: '存在不可幂等的工具调用，无法确定外部副作用是否已发生',
              invocations: unknown.map((u) => ({ id: u.id, tool: u.toolName })),
            }),
          ],
        )
        report.escalated.push(d.run_id)
        continue
      }

      if (d.attempt_no >= maxAttempts) {
        await this.db.query(
          `update runs set status = 'failed', error_code = 'runtime.max_attempts', ended_at = $2
            where id = $1`,
          [d.run_id, this.deps.clock.nowIso()],
        )
        // 失败也要唤醒 parent —— parent 必须知道它失败了
        await this.#fireWakesFor(d.run_id, report)
        continue
      }

      const availableAt = new Date(this.deps.clock.now() + backoff * 2 ** (d.attempt_no - 1))
      await this.#store.enqueueAttempt(d.run_id, { availableAt })
      report.requeued.push(d.run_id)
    }
  }

  /**
   * 兜底：wake 的等待目标已全部终态，但 pending_count 没归零。
   *
   * 正常路径下递减与子 run 终态同事务，不该发生；
   * 这道防线覆盖「事务提交了但递减逻辑有 bug」或历史遗留数据。
   */
  async #repairWakes(report: ReconcileReport): Promise<void> {
    const stuck = await this.db.query<{ id: string; parent_run_id: string }>(
      `select w.id, w.parent_run_id
         from wake_records w
        where w.status = 'waiting'
          and w.kind = 'children_done'
          and not exists (
            select 1 from runs r
             where r.id = any(w.wait_on_run_ids)
               and r.status not in ${TERMINAL_RUN_SQL}
          )`,
    )

    for (const w of stuck.rows) {
      await this.db.tx(async (q) => {
        const marked = await q.query(
          `update wake_records set status = 'fired', fired_at = $1, pending_count = 0
            where id = $2 and status = 'waiting'
            returning id`,
          [this.deps.clock.nowIso(), w.id],
        )
        if (marked.rowCount === 0) return
        const attempt = await this.#store.enqueueAttempt(w.parent_run_id, { priority: 1 }, q)
        await q.query(`update wake_records set fired_attempt_id = $1 where id = $2`, [
          attempt.id,
          w.id,
        ])
        report.repairedWakes.push(w.id)
      })
    }
  }

  /** run 已终态时补触发其 wake（用于 reconciler 自己把 run 判失败的路径）。 */
  async #fireWakesFor(runId: string, report: ReconcileReport): Promise<void> {
    const now = this.deps.clock.nowIso()
    await this.db.tx(async (q) => {
      const dec = await q.query<{ id: string; pending_count: number; parent_run_id: string }>(
        `update wake_records
            set pending_count = pending_count - 1
          where status = 'waiting' and $1 = any(wait_on_run_ids)
          returning id, pending_count, parent_run_id`,
        [runId],
      )
      for (const w of dec.rows) {
        if (w.pending_count > 0) continue
        const marked = await q.query(
          `update wake_records set status = 'fired', fired_at = $1
            where id = $2 and status = 'waiting' returning id`,
          [now, w.id],
        )
        if (marked.rowCount === 0) continue
        const attempt = await this.#store.enqueueAttempt(w.parent_run_id, { priority: 1 }, q)
        await q.query(`update wake_records set fired_attempt_id = $1 where id = $2`, [
          attempt.id,
          w.id,
        ])
        report.repairedWakes.push(w.id)
      }
    })
  }

  /**
   * 队列条目被 claim 了，但对应 attempt 已终态或不存在 → 释放。
   * 进程重启后最常见的一类残留。
   */
  async #releaseOrphanedQueueItems(report: ReconcileReport): Promise<void> {
    const r = await this.db.query(
      `delete from run_queue q
        where exists (
          select 1 from run_attempts a
           where a.run_id = q.run_id and a.attempt_no = q.attempt_no
             and a.status in ('succeeded','failed','timed_out','lost','cancelled')
        )`,
    )
    report.releasedQueueItems += r.rowCount

    // claim 了但 attempt 还停在 queued（worker 崩在 claim 与 start 之间）→ 放回
    const released = await this.db.query(
      `update run_queue q
          set claimed_by = null, claimed_at = null
        from run_attempts a
        where a.run_id = q.run_id and a.attempt_no = q.attempt_no
          and q.claimed_by is not null
          and a.status = 'queued'`,
    )
    report.releasedQueueItems += released.rowCount
  }
}
