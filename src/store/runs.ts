import type { Db, Queryable } from '../db/types.js'
import type { Deps } from '../seams.js'
import {
  type AttemptStatus,
  type Run,
  type RunAttempt,
  type RunStatus,
  type SideEffectClass,
  type WakeRecord,
  isTerminalAttempt,
  runStatusForAttempt,
} from '../domain.js'

// ── 行 → 领域对象 ───────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const toRun = (r: any): Run => ({
  id: r.id,
  parentRunId: r.parent_run_id,
  rootRunId: r.root_run_id,
  conversationId: r.conversation_id,
  taskId: r.task_id,
  agentId: r.agent_id,
  depth: r.depth,
  status: r.status,
  errorCode: r.error_code,
  errorDetail: r.error_detail,
  idempotencyKey: r.idempotency_key,
  input: r.input,
  result: r.result,
  resultRef: r.result_ref,
  resultSchemaVersion: r.result_schema_version,
  deadlineAt: r.deadline_at,
  createdAt: r.created_at,
  endedAt: r.ended_at,
})

const toAttempt = (r: any): RunAttempt => ({
  id: r.id,
  runId: r.run_id,
  attemptNo: r.attempt_no,
  status: r.status,
  workerId: r.worker_id,
  leaseExpiresAt: r.lease_expires_at,
  fenceToken: r.fence_token,
  promptVersionId: r.prompt_version_id,
  configHash: r.config_hash,
  toolSnapshotId: r.tool_snapshot_id,
  model: r.model,
  provider: r.provider,
  heartbeatAt: r.heartbeat_at,
  cancelRequestedAt: r.cancel_requested_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  errorCode: r.error_code,
  errorDetail: r.error_detail,
  stepsUsed: r.steps_used,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  cacheRead: r.cache_read,
  costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
  contextBreakdown: r.context_breakdown,
  createdAt: r.created_at,
})

const toWake = (r: any): WakeRecord => ({
  id: r.id,
  kind: r.kind,
  parentRunId: r.parent_run_id,
  parentConversationId: r.parent_conversation_id,
  parentAgentId: r.parent_agent_id,
  waitOnRunIds: r.wait_on_run_ids ?? [],
  pendingCount: r.pending_count,
  resumePayload: r.resume_payload,
  status: r.status,
  fireAt: r.fire_at,
  firedAttemptId: r.fired_attempt_id,
  createdAt: r.created_at,
  firedAt: r.fired_at,
})
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 输入类型 ────────────────────────────────────────────

export interface CreateRunInput {
  agentId: string
  parentRunId?: string | null
  rootRunId?: string | null
  conversationId?: string | null
  taskId?: string | null
  depth?: number
  idempotencyKey?: string | null
  input?: unknown
  deadlineAt?: Date | null
}

/**
 * `provider:model` → [provider, model]。
 *
 * 只切**第一个**冒号：本地模型名自带冒号（`ollama:gemma4:31b`），
 * 切多了就拼不回原样的 key，而下游要靠 `provider + ':' + model`
 * 反查配置里的单价与计费方式。
 */
export function splitModelKey(key: string | null | undefined): [string | null, string | null] {
  if (!key) return [null, null]
  const i = key.indexOf(':')
  if (i < 0) return [null, key]
  return [key.slice(0, i), key.slice(i + 1)]
}

export interface FinishAttemptInput {
  attemptId: string
  fenceToken: string
  status: AttemptStatus
  errorCode?: string | null
  errorDetail?: unknown
  result?: unknown
  resultRef?: string | null
  resultSchemaVersion?: string | null
  stepsUsed?: number
  tokensIn?: number
  tokensOut?: number
  cacheRead?: number
  costUsd?: number
  contextBreakdown?: unknown
  /**
   * 实际服务的模型键（`provider:model`）。
   *
   * 拆成两列存：`provider` 取第一个冒号之前，`model` 取之后 ——
   * 本地模型名自带冒号（`ollama:gemma4:31b`），只切第一个才能原样拼回，
   * 而拼回后要能对上配置里的 key，否则计费与订阅判定都会失准。
   */
  modelKey?: string | null
  /** 覆盖默认的 attempt→run 状态映射，例如 failed 但还要重试 → waiting_retry */
  runStatusOverride?: RunStatus
  /**
   * 排一次重试。
   *
   * 与终态写入在**同一个事务**里 —— 否则中间崩溃会留下
   * 「run 是 waiting_retry 但队列里什么都没有」的悬挂状态，
   * 那正是这个项目要消灭的那类问题。
   */
  retryAt?: Date
}

export interface FinishAttemptResult {
  /** 排了重试时，新 attempt 的编号 */
  retryAttemptNo?: number | null
  runId: string
  runStatus: RunStatus
  /** 本次终态触发了哪些 wake（pending_count 归零者），已入队 */
  firedWakeIds: string[]
  /** 因这些 wake 而入队的 parent attempt */
  enqueuedParents: Array<{ runId: string; attemptNo: number }>
}

/**
 * Run / Attempt / Wake 的持久化。
 *
 * 这是整个系统可靠性契约的落点，几条不变量都在这里强制：
 *  - 逻辑 run 与物理 attempt 分离（§3.3）
 *  - 终态 attempt 不可回改（DB trigger + 这里的 fence 校验）
 *  - lease + fencing：被判死的 worker 复活后写入被拒（§3.4）
 *  - **子 run 终态与 parent 唤醒在同一事务**（§3.5）
 */
export class RunStore {
  constructor(
    private db: Db,
    private deps: Deps,
  ) {}

  // ── 创建 ──────────────────────────────────────────────

  async createRun(input: CreateRunInput): Promise<Run> {
    const id = this.deps.ids.uuid()
    const rootRunId = input.rootRunId ?? input.parentRunId ?? id
    const r = await this.db.query(
      `insert into runs
         (id, parent_run_id, root_run_id, conversation_id, task_id, agent_id, depth,
          idempotency_key, input, deadline_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       returning *`,
      [
        id,
        input.parentRunId ?? null,
        rootRunId,
        input.conversationId ?? null,
        input.taskId ?? null,
        input.agentId,
        input.depth ?? 0,
        input.idempotencyKey ?? null,
        JSON.stringify(input.input ?? {}),
        input.deadlineAt ?? null,
        this.deps.clock.nowIso(),
      ],
    )
    return toRun(r.rows[0])
  }

  /**
   * 新建一次尝试并入队。attempt_no 由 DB 侧计算，避免并发下重号。
   */
  async enqueueAttempt(
    runId: string,
    opts: { priority?: number; availableAt?: Date } = {},
    q: Queryable = this.db,
  ): Promise<RunAttempt> {
    const id = this.deps.ids.uuid()
    const now = this.deps.clock.nowIso()
    const a = await q.query(
      `insert into run_attempts (id, run_id, attempt_no, status, created_at)
       select $1, $2, coalesce(max(attempt_no), 0) + 1, 'queued', $3
         from run_attempts where run_id = $2
       returning *`,
      [id, runId, now],
    )
    const attempt = toAttempt(a.rows[0])
    await q.query(
      `insert into run_queue (id, run_id, attempt_no, priority, available_at, created_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (run_id, attempt_no) do nothing`,
      [
        this.deps.ids.uuid(),
        runId,
        attempt.attemptNo,
        opts.priority ?? 5,
        opts.availableAt?.toISOString() ?? now,
        now,
      ],
    )
    // 排到未来的重试**不改** waiting_retry —— 那个状态的含义就是
    // 「在等下一次尝试」，翻成 pending 会让「任务在等什么」看不出来。
    // 立刻可执行时才翻（reconciler 兜底重排走这条）
    const readyNow = !opts.availableAt || opts.availableAt.getTime() <= this.deps.clock.now()
    if (readyNow) {
      await q.query(`update runs set status = 'pending' where id = $1 and status = 'waiting_retry'`, [
        runId,
      ])
    }
    return attempt
  }

  // ── 领取与心跳 ────────────────────────────────────────

  /**
   * 领取一个待执行的 attempt，签发 lease 与 fence token。
   *
   * `for update skip locked` 保证多 worker 并发领取时不会撞车。
   */
  async claimNext(workerId: string, leaseMs = 60_000): Promise<RunAttempt | null> {
    const now = new Date(this.deps.clock.now())
    const fence = this.deps.ids.token()

    return this.db.tx(async (q) => {
      const picked = await q.query<{ run_id: string; attempt_no: number; id: string }>(
        `select id, run_id, attempt_no from run_queue
          where claimed_by is null and available_at <= $1
          order by priority asc, available_at asc
          limit 1
          for update skip locked`,
        [now.toISOString()],
      )
      const row = picked.rows[0]
      if (!row) return null

      await q.query(`update run_queue set claimed_by = $1, claimed_at = $2 where id = $3`, [
        workerId,
        now.toISOString(),
        row.id,
      ])

      const a = await q.query(
        `update run_attempts
            set status = 'running',
                worker_id = $1,
                fence_token = $2,
                lease_expires_at = $3,
                started_at = coalesce(started_at, $4),
                heartbeat_at = $4
          where run_id = $5 and attempt_no = $6 and status = 'queued'
          returning *`,
        [
          workerId,
          fence,
          new Date(now.getTime() + leaseMs).toISOString(),
          now.toISOString(),
          row.run_id,
          row.attempt_no,
        ],
      )
      const attempt = a.rows[0]
      if (!attempt) return null // 竞态：已被别人领走

      await q.query(`update runs set status = 'running' where id = $1`, [row.run_id])
      return toAttempt(attempt)
    })
  }

  /**
   * 续租 + 心跳。返回 false 表示 fence 已失效（被 reconciler 判死并重发过），
   * 此时 worker 必须立刻停止工作 —— 它的写入都会被拒绝。
   */
  async heartbeat(attemptId: string, fenceToken: string, leaseMs = 60_000): Promise<boolean> {
    const now = this.deps.clock.now()
    const r = await this.db.query(
      `update run_attempts
          set heartbeat_at = $1, lease_expires_at = $2
        where id = $3 and fence_token = $4 and status = 'running'`,
      [
        new Date(now).toISOString(),
        new Date(now + leaseMs).toISOString(),
        attemptId,
        fenceToken,
      ],
    )
    return r.rowCount > 0
  }

  // ── 终态 + wake（核心事务）────────────────────────────

  /**
   * 写 attempt 终态、推进逻辑 run、递减并触发 wake —— **全部在一个事务内**。
   *
   * 这是「不存在丢唤醒」的根据：子 run 的完成与 parent 的入队是原子的。
   * 任何一步失败则整体回滚，reconciler 之后会重新处理。
   */
  /**
   * 一棵 run 树当前的 run 总数。
   *
   * 给委派的扇出闸门用。按整棵树算而不是按单轮算 —— 只看单轮的话，
   * 多轮累加照样能把队列灌满。
   */
  async countRunsInTree(rootRunId: string): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `select count(*)::int as n from runs where root_run_id = $1`,
      [rootRunId],
    )
    return r.rows[0]?.n ?? 0
  }

  async finishAttempt(input: FinishAttemptInput): Promise<FinishAttemptResult> {
    if (!isTerminalAttempt(input.status)) {
      throw new Error(`finishAttempt 只接受终态，收到 ${input.status}`)
    }
    const now = this.deps.clock.nowIso()

    return this.db.tx(async (q) => {
      const upd = await q.query<{ run_id: string }>(
        `update run_attempts
            set status = $1, ended_at = $2,
                error_code = $3, error_detail = $4::jsonb,
                steps_used = coalesce($5, steps_used),
                tokens_in = coalesce($6, tokens_in),
                tokens_out = coalesce($7, tokens_out),
                cache_read = coalesce($8, cache_read),
                cost_usd = coalesce($9, cost_usd),
                context_breakdown = coalesce($10::jsonb, context_breakdown),
                provider = coalesce($13, provider),
                model = coalesce($14, model),
                lease_expires_at = null
          where id = $11 and fence_token = $12
          returning run_id`,
        [
          input.status,
          now,
          input.errorCode ?? null,
          input.errorDetail === undefined ? null : JSON.stringify(input.errorDetail),
          input.stepsUsed ?? null,
          input.tokensIn ?? null,
          input.tokensOut ?? null,
          input.cacheRead ?? null,
          input.costUsd ?? null,
          input.contextBreakdown === undefined ? null : JSON.stringify(input.contextBreakdown),
          input.attemptId,
          input.fenceToken,
          ...splitModelKey(input.modelKey),
        ],
      )
      const runId = upd.rows[0]?.run_id
      if (!runId) {
        // fence 不匹配 / attempt 已终态 → 这个 worker 的写入被拒绝
        throw new StaleFenceError(input.attemptId)
      }

      // 从队列移除
      await q.query(
        `delete from run_queue
          where run_id = $1
            and attempt_no = (select attempt_no from run_attempts where id = $2)`,
        [runId, input.attemptId],
      )

      const runStatus = input.runStatusOverride ?? runStatusForAttempt(input.status)
      const isTerminalRunStatus = ['succeeded', 'failed', 'cancelled'].includes(runStatus)
      await q.query(
        `update runs
            set status = $1,
                result = coalesce($2::jsonb, result),
                result_ref = coalesce($3, result_ref),
                result_schema_version = coalesce($4, result_schema_version),
                error_code = $5,
                error_detail = $6::jsonb,
                ended_at = case when $7 then $8::timestamptz else ended_at end
          where id = $9`,
        [
          runStatus,
          input.result === undefined ? null : JSON.stringify(input.result),
          input.resultRef ?? null,
          input.resultSchemaVersion ?? null,
          input.errorCode ?? null,
          input.errorDetail === undefined ? null : JSON.stringify(input.errorDetail),
          isTerminalRunStatus,
          now,
          runId,
        ],
      )

      // 排重试：与终态写入同事务。中间崩溃会留下「waiting_retry 但队列为空」
      // 的悬挂状态，而消灭这类状态正是这个项目的目的
      let retryAttemptNo: number | null = null
      if (input.retryAt) {
        const next = await this.enqueueAttempt(runId, { availableAt: input.retryAt }, q)
        retryAttemptNo = next.attemptNo
      }

      // run 未到终态就不触发 wake（例如 waiting_retry 还要再试）
      if (!isTerminalRunStatus) {
        return { runId, runStatus, firedWakeIds: [], enqueuedParents: [], retryAttemptNo }
      }

      return { runId, runStatus, retryAttemptNo, ...(await this.#fireWakes(q, runId, now)) }
    })
  }

  /** 递减所有等待该 run 的 wake，归零者标记 fired 并入队 parent。 */
  async #fireWakes(
    q: Queryable,
    childRunId: string,
    now: string,
  ): Promise<{ firedWakeIds: string[]; enqueuedParents: Array<{ runId: string; attemptNo: number }> }> {
    const dec = await q.query<{ id: string; pending_count: number; parent_run_id: string }>(
      `update wake_records
          set pending_count = pending_count - 1
        where status = 'waiting' and $1 = any(wait_on_run_ids)
        returning id, pending_count, parent_run_id`,
      [childRunId],
    )

    const firedWakeIds: string[] = []
    const enqueuedParents: Array<{ runId: string; attemptNo: number }> = []

    for (const w of dec.rows) {
      if (w.pending_count > 0) continue
      const marked = await q.query(
        `update wake_records set status = 'fired', fired_at = $1
          where id = $2 and status = 'waiting'
          returning id`,
        [now, w.id],
      )
      if (marked.rowCount === 0) continue // 已被 reconciler 抢先触发
      firedWakeIds.push(w.id)
      const attempt = await this.enqueueAttempt(w.parent_run_id, { priority: 1 }, q)
      await q.query(`update wake_records set fired_attempt_id = $1 where id = $2`, [
        attempt.id,
        w.id,
      ])
      enqueuedParents.push({ runId: w.parent_run_id, attemptNo: attempt.attemptNo })
    }

    return { firedWakeIds, enqueuedParents }
  }

  // ── Wake ──────────────────────────────────────────────

  /**
   * 挂起 parent 等待子 run。
   *
   * parent 的当前 attempt 会正常终结（succeeded），逻辑 run 转 waiting_children。
   * **parent 不保持活着** —— 不轮询、不占进程、不占 context。
   */
  async armWake(input: {
    parentRunId: string
    parentAgentId: string
    parentConversationId?: string | null
    waitOnRunIds: string[]
    resumePayload?: unknown
    kind?: 'children_done' | 'approval' | 'retry_timer'
    fireAt?: Date | null
  }): Promise<WakeRecord> {
    if (input.waitOnRunIds.length === 0) {
      throw new Error('armWake 需要至少一个等待目标；fire-and-forget 委派是被禁止的')
    }
    return this.db.tx(async (q) => {
      // 只统计尚未终态的子 run：可能在 arm 之前就已经跑完了
      const pending = await q.query<{ n: string }>(
        `select count(*)::int as n from runs
          where id = any($1::uuid[]) and status not in ('succeeded','failed','cancelled')`,
        [input.waitOnRunIds],
      )
      const pendingCount = Number(pending.rows[0]?.n ?? 0)
      const now = this.deps.clock.nowIso()

      const w = await q.query(
        `insert into wake_records
           (id, kind, parent_run_id, parent_conversation_id, parent_agent_id,
            wait_on_run_ids, pending_count, resume_payload, status, fire_at, created_at)
         values ($1,$2,$3,$4,$5,$6::uuid[],$7,$8::jsonb,'waiting',$9,$10)
         returning *`,
        [
          this.deps.ids.uuid(),
          input.kind ?? 'children_done',
          input.parentRunId,
          input.parentConversationId ?? null,
          input.parentAgentId,
          input.waitOnRunIds,
          pendingCount,
          JSON.stringify(input.resumePayload ?? {}),
          input.fireAt?.toISOString() ?? null,
          now,
        ],
      )
      await q.query(`update runs set status = 'waiting_children' where id = $1`, [
        input.parentRunId,
      ])

      const wake = toWake(w.rows[0])

      // 竞态兜底：arm 时子 run 已全部终态 → 立刻触发，否则永远等不到递减
      if (pendingCount === 0) {
        await q.query(`update wake_records set status = 'fired', fired_at = $1 where id = $2`, [
          now,
          wake.id,
        ])
        const attempt = await this.enqueueAttempt(input.parentRunId, { priority: 1 }, q)
        await q.query(`update wake_records set fired_attempt_id = $1 where id = $2`, [
          attempt.id,
          wake.id,
        ])
        return { ...wake, status: 'fired' as const, firedAttemptId: attempt.id }
      }
      return wake
    })
  }

  // ── 读取 ──────────────────────────────────────────────

  async getRun(id: string): Promise<Run | null> {
    const r = await this.db.query(`select * from runs where id = $1`, [id])
    return r.rows[0] ? toRun(r.rows[0]) : null
  }

  async getAttempt(id: string): Promise<RunAttempt | null> {
    const r = await this.db.query(`select * from run_attempts where id = $1`, [id])
    return r.rows[0] ? toAttempt(r.rows[0]) : null
  }

  async listAttempts(runId: string): Promise<RunAttempt[]> {
    const r = await this.db.query(
      `select * from run_attempts where run_id = $1 order by attempt_no`,
      [runId],
    )
    return r.rows.map(toAttempt)
  }

  async getWake(id: string): Promise<WakeRecord | null> {
    const r = await this.db.query(`select * from wake_records where id = $1`, [id])
    return r.rows[0] ? toWake(r.rows[0]) : null
  }

  /** run 树：编排者 → 专家 → 子专家 */
  async tree(rootRunId: string): Promise<Run[]> {
    const r = await this.db.query(
      `select * from runs where root_run_id = $1 order by depth, created_at`,
      [rootRunId],
    )
    return r.rows.map(toRun)
  }

  // ── 工具调用意图日志（§3.2）───────────────────────────

  /** 调用**之前**写。返回的 id 用于随后记录结果。 */
/**
   * 记一次模型往返。
   *
   * 存的是「模型被问了什么、答了什么」—— 事件流里只有 token 数与延迟，
   * 而 agent 定义调优阶段最常要回答的问题（为什么派给了这个专家、
   * 为什么忽略了验收标准）只有看到 prompt 与回复才答得出。
   *
   * 超长时截断并标记，而不是拒绝写 —— 截断的记录仍然有用，没有记录则完全瞎。
   */
  async recordTranscript(input: {
    runAttemptId: string
    step: number
    request: unknown
    response: unknown
    maxChars?: number
  }): Promise<void> {
    const cap = input.maxChars ?? 200_000
    let req = JSON.stringify(input.request)
    let res = JSON.stringify(input.response)
    let truncated = false
    if (req.length > cap) {
      req = JSON.stringify({ truncated: `请求超过 ${cap} 字符`, head: req.slice(0, cap) })
      truncated = true
    }
    if (res.length > cap) {
      res = JSON.stringify({ truncated: `回复超过 ${cap} 字符`, head: res.slice(0, cap) })
      truncated = true
    }
    await this.db.query(
      `insert into transcripts (id, run_attempt_id, step, request, response, truncated, created_at)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
       on conflict (run_attempt_id, step) do update
          set request = $4::jsonb, response = $5::jsonb, truncated = $6`,
      [this.deps.ids.uuid(), input.runAttemptId, input.step, req, res, truncated, this.deps.clock.nowIso()],
    )
  }

  async recordIntent(input: {
    runAttemptId: string
    seq: number
    toolName: string
    argsHash: string
    argsRef?: string | null
    /** 实参本身。只有 hash 时无法判断「模型到底填了什么」 */
    args?: unknown
    sideEffectClass: SideEffectClass
    idempotencyKey?: string | null
  }): Promise<string> {
    const id = this.deps.ids.uuid()
    await this.db.query(
      `insert into tool_invocations
         (id, run_attempt_id, seq, tool_name, args_hash, args_ref, args_json,
          side_effect_class, idempotency_key, intent_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [
        id,
        input.runAttemptId,
        input.seq,
        input.toolName,
        input.argsHash,
        input.argsRef ?? null,
        // 实参本身：委派信封写得好不好、路径为什么被规则拦下，都要看它
        input.args === undefined ? null : JSON.stringify(input.args),
        input.sideEffectClass,
        input.idempotencyKey ?? null,
        this.deps.clock.nowIso(),
      ],
    )
    return id
  }

  async recordOutcome(
    invocationId: string,
    outcome: 'ok' | 'error',
    extra: {
      resultRef?: string | null
      errorCode?: string | null
      /** 工具返回的文本。回灌给模型的就是它，所以诊断时必须看得到 */
      resultText?: string | null
    } = {},
  ): Promise<void> {
    await this.db.query(
      `update tool_invocations
          set outcome = $1, outcome_at = $2, result_ref = $3, error_code = $4,
              result_text = $6
        where id = $5`,
      [
        outcome,
        this.deps.clock.nowIso(),
        extra.resultRef ?? null,
        extra.errorCode ?? null,
        invocationId,
        // 回灌给模型的就是这段文本，诊断时必须看得到。截断避免大输出撑爆库
        extra.resultText === undefined || extra.resultText === null
          ? null
          : extra.resultText.slice(0, 20_000),
      ],
    )
  }

  /** 崩溃恢复用：某个 attempt 里意图已记录但结果未知的调用。 */
  async unknownInvocations(runAttemptId: string): Promise<
    Array<{ id: string; toolName: string; sideEffectClass: SideEffectClass; idempotencyKey: string | null }>
  > {
    const r = await this.db.query<{
      id: string
      tool_name: string
      side_effect_class: SideEffectClass
      idempotency_key: string | null
    }>(
      `select id, tool_name, side_effect_class, idempotency_key
         from tool_invocations
        where run_attempt_id = $1 and outcome is null
        order by seq`,
      [runAttemptId],
    )
    return r.rows.map((x) => ({
      id: x.id,
      toolName: x.tool_name,
      sideEffectClass: x.side_effect_class,
      idempotencyKey: x.idempotency_key,
    }))
  }
}

/** worker 的 fence 已失效：它被判死过，写入一律拒绝。 */
export class StaleFenceError extends Error {
  constructor(public attemptId: string) {
    super(`attempt ${attemptId} 的 fence token 已失效或已处于终态，写入被拒绝`)
    this.name = 'StaleFenceError'
  }
}
