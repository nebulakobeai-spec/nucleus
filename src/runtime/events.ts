import type { Db } from '../db/types.js'
import type { Clock } from '../seams.js'

/**
 * 事件流。
 *
 * append-only 的结构化事件，是可视化与过程诊断的唯一数据源
 * （DESIGN.md §9）。同一份流既是 UI 的进度条，也是「它当时为什么那样做」
 * 的证据。
 */
export interface RunEventSink {
  emit(attemptId: string, runId: string, kind: string, payload?: unknown): Promise<void>
}

export class DbEventSink implements RunEventSink {
  #seq = new Map<string, number>()

  constructor(
    private db: Db,
    private clock: Clock,
    /** 跨进程推送；API 进程据此向前端 SSE 广播 */
    private notifyChannel: string | null = 'nucleus_events',
  ) {}

  /**
   * seq 计数器是**进程内**的。
   *
   * 这依赖一个没被任何东西强制的假设：一个 attempt 的事件只由一个进程写。
   * 正常运行时成立（attempt 终态不可改，崩溃后是新 attempt），但一旦不成立
   * 就是 `duplicate key ... run_events_run_attempt_id_seq_key` 硬报错 ——
   * 而且报在一个与真正问题无关的地方。
   *
   * 所以第一次见到某个 attempt 时**从库里取当前最大值**播种，
   * 并且撞了之后重新播种再试一次。一个 attempt 一次额外查询，不是每个事件。
   */
  async #nextSeq(attemptId: string): Promise<number> {
    const cached = this.#seq.get(attemptId)
    if (cached !== undefined) {
      const next = cached + 1
      this.#seq.set(attemptId, next)
      return next
    }
    const r = await this.db.query<{ n: number }>(
      `select coalesce(max(seq), 0)::int n from run_events where run_attempt_id = $1`,
      [attemptId],
    )
    const next = (r.rows[0]?.n ?? 0) + 1
    this.#seq.set(attemptId, next)
    return next
  }

  async emit(attemptId: string, runId: string, kind: string, payload: unknown = {}): Promise<void> {
    let seq = await this.#nextSeq(attemptId)
    try {
      await this.#insert(attemptId, runId, seq, kind, payload)
    } catch (e) {
      if (!/duplicate key|unique constraint/i.test(String((e as Error).message))) throw e
      // 另一个写者插到中间了 —— 重新播种再试一次
      this.#seq.delete(attemptId)
      seq = await this.#nextSeq(attemptId)
      await this.#insert(attemptId, runId, seq, kind, payload)
    }
    if (this.notifyChannel) {
      // payload 不进 notify —— Postgres 的 NOTIFY 有 8000 字节上限，
      // 前端拿到 id 后回查即可
      await this.db
        .notify(this.notifyChannel, JSON.stringify({ runId, attemptId, seq, kind }))
        .catch(() => {
          /* 通知失败不影响事件已落库；前端轮询兜底 */
        })
    }
  }

  async #insert(
    attemptId: string,
    runId: string,
    seq: number,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    await this.db.query(
      `insert into run_events (run_attempt_id, run_id, seq, kind, payload, created_at)
       values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [attemptId, runId, seq, kind, JSON.stringify(payload), this.clock.nowIso()],
    )
  }
}

/** 测试用：只收集不落库 */
export class MemoryEventSink implements RunEventSink {
  readonly events: Array<{ attemptId: string; runId: string; kind: string; payload: unknown }> = []

  async emit(attemptId: string, runId: string, kind: string, payload: unknown = {}): Promise<void> {
    this.events.push({ attemptId, runId, kind, payload })
  }

  kinds(): string[] {
    return this.events.map((e) => e.kind)
  }

  find(kind: string): unknown {
    return this.events.find((e) => e.kind === kind)?.payload
  }

  all(kind: string): unknown[] {
    return this.events.filter((e) => e.kind === kind).map((e) => e.payload)
  }
}

export interface RunEvent {
  attemptId: string
  runId: string
  kind: string
  payload: unknown
}

/**
 * 旁路监听。
 *
 * 事件流是「可视化的唯一数据源」（DESIGN.md §9），所以终端的实时进度
 * 应当读这条流，而不是另开一套回调 —— 否则 CLI 看到的过程和诊断包里
 * 记录的过程会各说一套，而两者不一致的时候没人知道该信哪个。
 *
 * 监听器的异常被吞掉：渲染出错绝不能影响事件落库。
 */
export class TeeEventSink implements RunEventSink {
  #listeners = new Set<(e: RunEvent) => void>()

  constructor(private inner: RunEventSink) {}

  /** 返回退订函数 */
  subscribe(fn: (e: RunEvent) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  async emit(attemptId: string, runId: string, kind: string, payload: unknown = {}): Promise<void> {
    await this.inner.emit(attemptId, runId, kind, payload)
    for (const fn of this.#listeners) {
      try {
        fn({ attemptId, runId, kind, payload })
      } catch {
        /* 渲染失败不影响运行时 */
      }
    }
  }
}
