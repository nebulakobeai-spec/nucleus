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

  async emit(attemptId: string, runId: string, kind: string, payload: unknown = {}): Promise<void> {
    const seq = (this.#seq.get(attemptId) ?? 0) + 1
    this.#seq.set(attemptId, seq)
    await this.db.query(
      `insert into run_events (run_attempt_id, run_id, seq, kind, payload, created_at)
       values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [attemptId, runId, seq, kind, JSON.stringify(payload), this.clock.nowIso()],
    )
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
