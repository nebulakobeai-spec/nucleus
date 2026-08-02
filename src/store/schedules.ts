import type { Db, Queryable } from '../db/types.js'
import type { Deps } from '../seams.js'
import { ConversationStore } from './conversations.js'
import { RunStore } from './runs.js'
import { latestPlanned, nextFireAt, parseCron } from '../runtime/cron.js'

/**
 * 定时任务。
 *
 * ── 为什么不需要新进程 ────────────────────────────────────
 *
 * `run_queue.available_at` 早就存在，reconciler 已经在 worker tick 里跑。
 * 「定时」的本质就是**到点往队列塞一个 run**，和 reconciler 是同一个位置、
 * 同一套 lease 语义。另起一个 cron 守护进程只会多一个要对齐的时钟。
 *
 * ── 会话语义：每次都是新会话 ──────────────────────────────
 *
 * 每次触发建**一个新 conversation**，不注入上次结果。
 * 定时任务的每次运行是独立的一份工作 —— 它只知道目标是什么，与上次跑出
 * 什么无关。把上次摘要灌进去会让第二次之后的运行都在「继承上次的偏差」，
 * 而且十次之后 context 里全是自己的历史。要跨次积累的话，那是产物
 * （artifacts）该负责的事，不是会话历史。
 *
 * ── 幂等键用**计划**时刻，不用实际时刻 ─────────────────────
 *
 * `sched:<id>:<计划 ISO>`。`runs.idempotency_key` 有 unique 约束，所以
 * 「同一个计划点被触发两次」由数据库挡掉，不靠这里查重 —— 两个 worker
 * 同时到点是 TOCTOU，查重挡不住，唯一索引挡得住。
 *
 * 用计划时刻的另一半理由是补偿：关机三小时后补跑 8:00 那次，键仍然是
 * `…T08:00`，所以补跑与原定触发是同一件事，不会重复。
 */

export interface Schedule {
  id: string
  name: string
  cron: string
  timezone: string
  agentId: string
  goal: string
  context: string
  acceptance: string
  enabled: boolean
  catchUp: boolean
  catchUpMax: number
  lastFiredAt: Date | null
  lastPlannedAt: Date | null
  nextFireAt: Date | null
  createdAt: Date
}

function toSchedule(r: Record<string, unknown>): Schedule {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    cron: r['cron'] as string,
    timezone: r['timezone'] as string,
    agentId: r['agent_id'] as string,
    goal: r['goal'] as string,
    context: (r['context'] as string) ?? '',
    acceptance: (r['acceptance'] as string) ?? '',
    enabled: r['enabled'] as boolean,
    catchUp: r['catch_up'] as boolean,
    catchUpMax: r['catch_up_max'] as number,
    lastFiredAt: r['last_fired_at'] ? new Date(r['last_fired_at'] as string) : null,
    lastPlannedAt: r['last_planned_at'] ? new Date(r['last_planned_at'] as string) : null,
    nextFireAt: r['next_fire_at'] ? new Date(r['next_fire_at'] as string) : null,
    createdAt: new Date(r['created_at'] as string),
  }
}

export interface CreateScheduleInput {
  name: string
  cron: string
  timezone?: string
  agentId: string
  goal: string
  context?: string
  acceptance?: string
  catchUp?: boolean
  catchUpMax?: number
  enabled?: boolean
}

/** 一次触发的结果。skipped 时 runId 为 null，reason 说明为什么。 */
export interface FireResult {
  scheduleId: string
  name: string
  plannedAt: Date
  runId: string | null
  conversationId: string | null
  skipped: 'reentrant' | 'duplicate' | null
  reason?: string
}

export class ScheduleStore {
  #runs: RunStore
  #conversations: ConversationStore

  constructor(
    private db: Db,
    private deps: Deps,
  ) {
    this.#runs = new RunStore(db, deps)
    this.#conversations = new ConversationStore(db, deps)
  }

  async create(input: CreateScheduleInput): Promise<Schedule> {
    // 表达式先解析 —— 写进库的表达式必须是能算出下次时刻的
    parseCron(input.cron)
    const tz = input.timezone ?? 'UTC'
    assertTimeZone(tz)
    const now = new Date(this.deps.clock.now())
    const next = nextFireAt(input.cron, tz, now)
    if (!next) {
      throw new Error(`「${input.cron}」在未来一年内永不触发（比如 2 月 30 号）`)
    }

    const r = await this.db.query(
      `insert into schedules
         (id, name, cron, timezone, agent_id, goal, context, acceptance,
          enabled, catch_up, catch_up_max, next_fire_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       returning *`,
      [
        this.deps.ids.uuid(),
        input.name,
        input.cron,
        tz,
        input.agentId,
        input.goal,
        input.context ?? '',
        input.acceptance ?? '',
        input.enabled ?? true,
        input.catchUp ?? false,
        input.catchUpMax ?? 3,
        next.toISOString(),
        now.toISOString(),
      ],
    )
    return toSchedule(r.rows[0]!)
  }

  async list(): Promise<Schedule[]> {
    const r = await this.db.query(
      `select * from schedules order by enabled desc, next_fire_at nulls last, name`,
    )
    return r.rows.map(toSchedule)
  }

  async byName(name: string): Promise<Schedule | null> {
    const r = await this.db.query(`select * from schedules where name = $1`, [name])
    return r.rows[0] ? toSchedule(r.rows[0]) : null
  }

  async remove(name: string): Promise<boolean> {
    const r = await this.db.query(`delete from schedules where name = $1 returning id`, [name])
    return r.rows.length > 0
  }

  /**
   * 启用/停用。
   *
   * 重新启用时**重算 next_fire_at**，不沿用停用前的旧值 —— 否则停用一周再
   * 打开会立刻触发（而且如果开了 catch_up，会一次补出一周的量）。
   * 停用期间的计划点就是不该跑的，这不是「欠账」。
   */
  async setEnabled(name: string, enabled: boolean): Promise<Schedule | null> {
    const s = await this.byName(name)
    if (!s) return null
    const now = new Date(this.deps.clock.now())
    const next = enabled ? nextFireAt(s.cron, s.timezone, now) : null
    const r = await this.db.query(
      `update schedules set enabled = $2, next_fire_at = $3, last_planned_at = case when $2 then null else last_planned_at end,
         updated_at = $4 where name = $1 returning *`,
      [name, enabled, next?.toISOString() ?? null, now.toISOString()],
    )
    return r.rows[0] ? toSchedule(r.rows[0]) : null
  }

  /** 到点的计划。`for update skip locked` 让多 worker 不会抢同一条。 */
  async claimDue(now: Date, limit = 10, q: Queryable = this.db): Promise<Schedule[]> {
    const r = await q.query(
      `select * from schedules
        where enabled and next_fire_at is not null and next_fire_at <= $1
        order by next_fire_at
        limit ${Number(limit) | 0}
        for update skip locked`,
      [now.toISOString()],
    )
    return r.rows.map(toSchedule)
  }

  /**
   * 触发一条计划：算出该跑哪些计划点，各建一个新会话与 run。
   *
   * 返回每个计划点的结果（含被跳过的）—— 跳过必须是可见的事件，
   * 「今天早上那次没跑」不该只能靠「没看到产出」发现。
   */
  async fire(s: Schedule, now: Date): Promise<FireResult[]> {
    const planned = this.#plannedPoints(s, now)
    const out: FireResult[] = []

    // 重入：上一次的 run 还没到终态就跳过这一次。
    // 不排队等着 —— 每小时一次的任务如果单次要跑两小时，排队会越积越多，
    // 而「跳过」在语义上正确：这次的工作与上次是同一件，上次还在做
    const busy = await this.#activeRunId(s.id)

    for (const at of planned) {
      if (busy) {
        const reason = `上一次的 run ${busy.slice(0, 8)} 还在跑`
        await this.#record(this.db, s.id, at, 'reentrant', null, null, reason)
        out.push({
          scheduleId: s.id,
          name: s.name,
          plannedAt: at,
          runId: null,
          conversationId: null,
          skipped: 'reentrant',
          reason,
        })
        continue
      }
      out.push(await this.#fireOne(s, at))
    }

    // 无论跳过还是真跑，都要推进 next_fire_at，否则下一轮又是同一批计划点。
    //
    // **推进基准是 now，不是最后一个计划点。** 从计划点往后推的话，一个「已经
    // 逾期三小时」的每小时任务会在 next 仍然 <= now 时被下一个 tick 再次领走，
    // 一路补到追平 —— 那恰恰是 catch_up=false 想避免的「醒来突然跑 8 次」。
    // planned 里已经包含了所有该跑的点，剩下的 <= now 的点都是**故意丢掉的**。
    const last = planned[planned.length - 1] ?? now
    const base = now.getTime() > last.getTime() ? now : last
    const next = nextFireAt(s.cron, s.timezone, base)
    await this.db.query(
      `update schedules set next_fire_at = $2, last_planned_at = $3,
         last_fired_at = case when $4 then $5 else last_fired_at end, updated_at = $5
       where id = $1`,
      [
        s.id,
        next?.toISOString() ?? null,
        last.toISOString(),
        out.some((x) => x.runId),
        now.toISOString(),
      ],
    )
    return out
  }

  /**
   * 该跑哪些计划点。
   *
   * 不开 catch_up（默认）：只跑**一次**，而且用当前这个计划点，
   * 错过的直接丢。这是对的默认值 —— 笔记本合盖一晚上，醒来不该突然跑 8 次。
   *
   * 开了 catch_up：补 due 到现在之间的计划点，受 catch_up_max 约束，
   * 且**取最近的而不是最早的** —— 补跑日报你要昨天那份，不是三天前那份。
   * （所以是 latestPlanned 反向取，不是正向生成再截尾。）
   */
  #plannedPoints(s: Schedule, now: Date): Date[] {
    const due = s.nextFireAt ?? now
    if (!s.catchUp) return [due]

    const points = latestPlanned(s.cron, s.timezone, due, now, s.catchUpMax)
    return points.length ? points : [due]
  }

  /** 这条计划有没有还没结束的 run */
  async #activeRunId(scheduleId: string): Promise<string | null> {
    const r = await this.db.query<{ id: string }>(
      `select id from runs
        where schedule_id = $1
          and status not in ('succeeded','failed','cancelled')
        order by created_at desc limit 1`,
      [scheduleId],
    )
    return r.rows[0]?.id ?? null
  }

  async #fireOne(s: Schedule, plannedAt: Date): Promise<FireResult> {
    const key = idempotencyKey(s.id, plannedAt)
    try {
      return await this.db.tx(async (tx: Queryable) => {
        // 每次新会话。标题带上计划时刻，列表里一眼看出是哪一次
        const conv = await this.#conversations.create(
          {
            agentId: s.agentId,
            title: `${s.name} · ${plannedAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          },
          tx,
        )
        const run = await this.#runs.createRun({
          agentId: s.agentId,
          conversationId: conv.id,
          scheduleId: s.id,
          idempotencyKey: key,
          input: {
            goal: s.goal,
            // 定时运行这件事本身要告诉 agent —— 没有人在等着回答追问，
            // 所以它不该在信封里留「需要你确认」这种话
            context:
              (s.context ? `${s.context}\n\n` : '') +
              `这是定时任务「${s.name}」的一次运行（计划时刻 ${plannedAt.toISOString()}，${s.timezone}）。` +
              `没有人在线，不要提问、不要等确认；缺信息就在结果里写进 open_questions。`,
            acceptance: s.acceptance || '按你的职责完成并调用 submit_result 提交。',
          },
        }, tx)
        await this.#runs.enqueueAttempt(run.id, {}, tx)
        // 记账与建 run 同一事务：不可能出现「跑了但没记」或「记了但没跑」
        await this.#record(tx, s.id, plannedAt, 'fired', run.id, conv.id, null)
        return {
          scheduleId: s.id,
          name: s.name,
          plannedAt,
          runId: run.id,
          conversationId: conv.id,
          skipped: null,
        }
      })
    } catch (e) {
      // unique 约束撞了 = 这个计划点已经被触发过。这是幂等生效，不是错误
      if (isUniqueViolation(e)) {
        return {
          scheduleId: s.id,
          name: s.name,
          plannedAt,
          runId: null,
          conversationId: null,
          skipped: 'duplicate',
          reason: `计划点 ${plannedAt.toISOString()} 已触发过`,
        }
      }
      throw e
    }
  }

  /**
   * 记一笔。`on conflict do nothing` 而不是报错 —— 记账表的唯一约束是
   * 「同一计划点只记一次」，撞上说明幂等生效了，不是故障。
   */
  async #record(
    q: Queryable,
    scheduleId: string,
    plannedAt: Date,
    outcome: FireOutcome,
    runId: string | null,
    conversationId: string | null,
    reason: string | null,
  ): Promise<void> {
    await q.query(
      `insert into schedule_fires
         (schedule_id, planned_at, fired_at, outcome, run_id, conversation_id, reason)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (schedule_id, planned_at) do nothing`,
      [
        scheduleId,
        plannedAt.toISOString(),
        this.deps.clock.nowIso(),
        outcome,
        runId,
        conversationId,
        reason,
      ],
    )
  }

  /**
   * 触发失败也要记 —— 「agent 被删了所以每天早上都没跑」必须查得到，
   * 否则症状是「产出静默消失」，最难查的那种。
   */
  async recordError(scheduleId: string, plannedAt: Date, message: string): Promise<void> {
    await this.#record(this.db, scheduleId, plannedAt, 'error', null, null, message)
  }

  /**
   * 触发历史。
   *
   * 这是「今天早上 8 点那次跑了吗」的答案所在 —— 被跳过的触发没有 run，
   * 所以除了这张表以外没有任何痕迹。
   */
  async history(name: string, limit = 20): Promise<FireRecord[]> {
    const r = await this.db.query<Record<string, unknown>>(
      // left join runs：触发成功但 run 失败是最需要看见的组合
      `select f.*, r.status as run_status, r.error_code as run_error_code
         from schedule_fires f
         join schedules s on s.id = f.schedule_id
         left join runs r on r.id = f.run_id
        where s.name = $1
        order by f.planned_at desc
        limit ${Number(limit) | 0}`,
      [name],
    )
    return r.rows.map((x) => ({
      plannedAt: new Date(x['planned_at'] as string),
      firedAt: new Date(x['fired_at'] as string),
      outcome: x['outcome'] as FireOutcome,
      runId: (x['run_id'] as string) ?? null,
      conversationId: (x['conversation_id'] as string) ?? null,
      reason: (x['reason'] as string) ?? null,
      runStatus: (x['run_status'] as string) ?? null,
      runErrorCode: (x['run_error_code'] as string) ?? null,
    }))
  }
}

export type FireOutcome = 'fired' | 'reentrant' | 'duplicate' | 'error'

export interface FireRecord {
  plannedAt: Date
  firedAt: Date
  outcome: FireOutcome
  runId: string | null
  conversationId: string | null
  reason: string | null
  /**
   * 那个 run 最后怎么样了。
   *
   * `outcome: 'fired'` 只说明**触发**成功，run 可能随后就失败了 ——
   * 「上次跑了吗」这个问题要的是结果，光给一个绿勾是骗人的。
   */
  runStatus: string | null
  runErrorCode: string | null
}

export function idempotencyKey(scheduleId: string, plannedAt: Date): string {
  // 截到分钟：cron 的精度就是分钟，秒级差异不该产生新的键
  return `sched:${scheduleId}:${plannedAt.toISOString().slice(0, 16)}`
}

function isUniqueViolation(e: unknown): boolean {
  // 23505 = unique_violation。PGlite 有时只带 message，所以两条都看
  return (
    (e as { code?: string })?.code === '23505' ||
    /duplicate key|unique constraint/i.test(String((e as Error)?.message))
  )
}

/** 时区名先验证 —— 写进库的坏时区会让每次 tick 都抛 */
export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new Error(`未知时区「${tz}」（用 IANA 名，如 Asia/Shanghai、America/New_York、UTC）`)
  }
}
