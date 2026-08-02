import { NucleusError } from '../errors.js'
import type { Db } from '../db/types.js'
import type { Deps } from '../seams.js'
import { RunStore, StaleFenceError } from '../store/runs.js'
import { ConversationStore } from '../store/conversations.js'
import { Runner, type AgentSpec } from './runner.js'
import { Reconciler } from './reconciler.js'
import { ScheduleStore, type FireResult, type Schedule } from '../store/schedules.js'
import type { RunEventSink } from './events.js'
import { renderEnvelope } from './envelope.js'
import { Compactor } from './compactor.js'
import { renderSummary, type CompactPolicy } from '../context/compact.js'
import { DEFAULT_BUDGET } from '../context/assemble.js'
import { decideRetry, DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry.js'
import type { ChatMessage } from '../providers/types.js'

export interface WorkerOptions {
  /** run 级重试策略；不给则用 DEFAULT_RETRY_POLICY */
  retryPolicy?: RetryPolicy
  workerId: string
  /** 空队列时的轮询间隔 */
  idleMs?: number
  leaseMs?: number
  /** 每隔多少次循环跑一次 reconciler */
  reconcileEvery?: number
  workdirRoot?: string
  /** 压缩策略；不给则用 DEFAULT_COMPACT_POLICY */
  compactPolicy?: CompactPolicy
}

export interface WorkerHooks {
  onAttemptStart?(info: { runId: string; attemptId: string; agentId: string; attemptNo: number; depth: number }): void
  onAttemptEnd?(info: { runId: string; attemptId: string; status: string; errorCode?: string }): void
  onIdle?(): void
  /** 定时任务触发（含被跳过的）—— 终端与诊断包据此显示「哪次跑了、哪次没跑」 */
  onScheduleFire?(info: FireResult): void
}

/**
 * Worker loop：claim → 执行 → 循环。
 *
 * 这是让 wake 真正生效的那一环 —— 子 run 终态时 parent 的新 attempt 被入队，
 * 必须有人把它领出来执行，否则「唤醒」只是数据库里的一行记录。
 *
 * 内嵌 reconciler：单进程部署时不需要另起守护进程。
 */
/**
 * 把结果渲染成给用户看的一段话。
 *
 * 三条都要出现在**会话消息本身**里，而不是只在数据库或只在终端里：
 *  - `status` 不是 ok —— 否则「部分完成」看起来和「完成」一样
 *  - `open_questions` —— 用户判断能不能采信的依据，静默丢掉最糟
 *  - `confidence` 偏低时说出来
 *
 * 放进 content 而不是只放 meta，是因为会话历史会回灌给下一轮：
 * 上一轮留下的未决项，下一轮的上下文里就该看得见。
 */
export function announceText(result: {
  status?: string
  summary: string
  confidence?: number | undefined
  open_questions?: string[]
}): string {
  const parts: string[] = []
  if (result.status && result.status !== 'ok') {
    parts.push(result.status === 'partial' ? '（部分完成）' : '（未完成）')
  }
  parts.push(result.summary)

  let text = parts.join(' ')
  if (result.confidence !== undefined && result.confidence < 0.6) {
    text += `\n\n把握不大（${Math.round(result.confidence * 100)}%）。`
  }
  const open = (result.open_questions ?? []).filter((q) => q.trim())
  if (open.length) {
    text += `\n\n未解决：\n${open.map((q) => `- ${q}`).join('\n')}`
  }
  return text
}

export class Worker {
  #retryPolicy: RetryPolicy
  #store: RunStore
  #conversations: ConversationStore
  #reconciler: Reconciler
  #schedules: ScheduleStore
  #compactor: Compactor | null
  #stopped = false
  #loops = 0

  constructor(
    private db: Db,
    private deps: Deps,
    private runner: Runner,
    private agents: Map<string, AgentSpec>,
    private events: RunEventSink,
    private opts: WorkerOptions,
  ) {
    this.#retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY
    this.#store = new RunStore(db, deps)
    this.#conversations = new ConversationStore(db, deps)
    this.#reconciler = new Reconciler(db, deps)
    this.#schedules = new ScheduleStore(db, deps)
    // compactor 需要 router；runner 持有它。没有就退回「不压缩」——
    // 这条路径下行为与压缩上线前完全一致
    this.#compactor = runner.router
      ? new Compactor(this.#conversations, runner.router, events, {
          ...(opts.compactPolicy ? { policy: opts.compactPolicy } : {}),
        })
      : null
  }

  stop(): void {
    this.#stopped = true
  }

  /**
   * 已生效的 agent spec。
   *
   * 暴露出来是为了让运行中的进程能改模型链（chat 的 /model）——
   * spec 在构造时已固化，只改 config 对已启动的 worker 无效。
   */
  get agentSpecs(): Map<string, AgentSpec> {
    return this.agents
  }

  /** 跑到队列空为止。测试与一次性任务用。 */
  async drain(maxLoops = 100, hooks: WorkerHooks = {}): Promise<number> {
    let done = 0
    for (let i = 0; i < maxLoops; i++) {
      const worked = await this.tick(hooks)
      if (!worked) break
      done++
    }
    return done
  }

  /** 长驻循环。 */
  async run(hooks: WorkerHooks = {}): Promise<void> {
    const idle = this.opts.idleMs ?? 500
    while (!this.#stopped) {
      const worked = await this.tick(hooks)
      if (!worked) {
        hooks.onIdle?.()
        await this.deps.clock.sleep(idle)
      }
    }
  }

  /** 领一个 attempt 执行。返回 false 表示队列空。 */
  async tick(hooks: WorkerHooks = {}): Promise<boolean> {
    if (++this.#loops % (this.opts.reconcileEvery ?? 20) === 0) {
      await this.#reconciler.runOnce().catch(() => {
        /* reconciler 失败不应打断 worker */
      })
    }

    // 定时触发与 reconciler 同一个位置：两者都是「到点往队列塞东西」。
    // 放在 claim 之前，所以刚到点的任务这一轮就能被领走，不用多等一圈
    const fired = await this.#fireDueSchedules(hooks)

    const attempt = await this.#store.claimNext(this.opts.workerId, this.opts.leaseMs ?? 60_000)
    // 只触发了但没领到 attempt 也算「干了活」—— 否则 run() 会去 sleep，
    // 而队列里刚被塞进去的东西要等一个 idle 周期才动
    if (!attempt) return fired

    const run = await this.#store.getRun(attempt.runId)
    if (!run) return true

    const agent = this.agents.get(run.agentId)
    if (!agent) {
      await this.#store.finishAttempt({
        attemptId: attempt.id,
        fenceToken: attempt.fenceToken!,
        status: 'failed',
        errorCode: 'config.agent_not_found',
        errorDetail: {
          message: `配置里没有 agent「${run.agentId}」`,
          known: [...this.agents.keys()],
          // 两个真实成因：agents/<id>.md 被删或改名；定时任务指向了已删掉的 agent。
          // （旧提示说的「JSON 里的 agents 是整体替换」已经不成立 —— 现在直接被拒）
          hint:
            `检查 agents/${run.agentId}.md 是否存在（改名后要同步引用它的地方）` +
            (run.scheduleId ? '。这个 run 由定时任务触发：nucleus schedule list 会标出指向不存在 agent 的计划' : ''),
        },
      })
      return true
    }

    hooks.onAttemptStart?.({
      runId: run.id,
      attemptId: attempt.id,
      agentId: run.agentId,
      attemptNo: attempt.attemptNo,
      depth: run.depth,
    })
    await this.events.emit(attempt.id, run.id, 'attempt.started', {
      agent: run.agentId,
      attemptNo: attempt.attemptNo,
      // depth 进 payload：让读事件流的人（终端渲染、诊断包）不必再回查
      // runs 表就能还原树形结构
      depth: run.depth,
    })

    try {
      const { history, input: turnInput, summary } = await this.#buildMessages(
        run.id,
        run.conversationId,
        run.input,
        {
          attemptId: attempt.id,
          modelChain: agent.modelChain,
          contextWindow: this.runner.contextWindowFor(agent.modelChain),
        },
      )
      const out = await this.runner.execute({
        attemptId: attempt.id,
        fenceToken: attempt.fenceToken!,
        attemptNo: attempt.attemptNo,
        runId: run.id,
        agent,
        history,
        summary,
        input: turnInput,
        workdir: `${this.opts.workdirRoot ?? '/tmp/nucleus'}/${run.id}`,
      })

      // 本次 attempt 里派生出了尚未完成的子 run → 挂起等待。
      // 没有这一步，委派就是 fire-and-forget：编排者不会拿到专家的结果。
      const armed = await this.#armWakeIfPending(run.id, run.agentId, run.conversationId, attempt.id)

      // root run 的结果回写会话 —— 只有它有对外身份；
      // 但等待子 run 期间不回写，否则用户会看到半成品。
      if (run.conversationId && out.result && !armed) {
        await this.#conversations.append({
          conversationId: run.conversationId,
          role: 'assistant',
          // 只发 summary 会把结果最要紧的部分吞掉：status='partial' 时看起来
          // 像做完了，open_questions 里「没查到 2026 年的实测数据」这种话
          // 直接消失 —— 而那恰恰是用户判断能不能采信的依据。
          content: announceText(out.result),
          runId: run.id,
          artifacts: out.result.artifacts,
          // 结构化原文进 meta：终端与将来的前端可以自己渲染，
          // 不必去反解上面那段人类可读文本
          meta: { result: out.result },
        })
      }

      await this.events.emit(attempt.id, run.id, 'attempt.finished', {
        status: armed ? 'waiting_children' : out.willRetry ? 'waiting_retry' : out.status,
        errorCode: out.errorCode ?? null,
        tokens: out.tokensIn + out.tokensOut,
        costUsd: out.costUsd,
      })
      hooks.onAttemptEnd?.({
        runId: run.id,
        attemptId: attempt.id,
        status: armed ? 'waiting_children' : out.willRetry ? 'waiting_retry' : out.status,
        ...(out.errorCode ? { errorCode: out.errorCode } : {}),
      })
    } catch (e) {
      if (e instanceof StaleFenceError) return true // 已被接管
      const err = e instanceof NucleusError ? e : new NucleusError('runtime.internal', String(e))

      // run 级重试的决策。
      //
      // 以前这里一律落 terminal failed —— 而 `recovery: 'automatic'` 的错误
      // 在界面上却写着「系统会自动重试」。四个模型同时限流 → 整条链
      // exhausted → run 死掉 → 得重新发一遍，而 provider_events 里明明记着
      // 「等到 xx:xx 就恢复了」。
      const decision = decideRetry({
        errorCode: err.code,
        retryAfterMs: err.retryAfterMs ?? null,
        attemptNo: attempt.attemptNo,
        policy: this.#retryPolicy,
      })

      await this.events.emit(attempt.id, run.id, 'attempt.failed', {
        errorCode: err.code,
        willRetry: decision.retry,
        delayMs: decision.retry ? decision.delayMs : null,
        reason: decision.reason,
        attemptNo: attempt.attemptNo,
      })

      await this.#store
        .finishAttempt({
          attemptId: attempt.id,
          fenceToken: attempt.fenceToken!,
          status: 'failed',
          errorCode: err.code,
          errorDetail: { message: err.message, ...(err.detail ?? {}) },
          ...(decision.retry
            ? {
                // 逻辑 run 还没结束 —— 它在等下一次物理尝试
                runStatusOverride: 'waiting_retry' as const,
                retryAt: new Date(this.deps.clock.now() + decision.delayMs),
              }
            : {}),
        })
        .catch(() => {
          /* 交给 reconciler */
        })
      hooks.onAttemptEnd?.({
        runId: run.id,
        attemptId: attempt.id,
        status: decision.retry ? 'waiting_retry' : 'failed',
        errorCode: err.code,
      })
    }
    return true
  }

  /**
   * 若本 run 有尚未终态的子 run，挂起等待它们。
   *
   * 这是委派与 wake 之间的接线：`delegate` 工具只负责创建子 run，
   * 「谁来等」由这里统一决定 —— 否则委派会变成 fire-and-forget，
   * 编排者永远拿不到专家的结果。
   */
  async #armWakeIfPending(
    runId: string,
    agentId: string,
    conversationId: string | null,
    attemptId: string,
  ): Promise<boolean> {
    const pending = await this.db.query<{ id: string }>(
      `select id from runs
        where parent_run_id = $1
          and status not in ('succeeded','failed','cancelled')`,
      [runId],
    )
    if (pending.rowCount === 0) return false

    // 已经有在等的 wake 就不重复 arm（同一 run 多次 attempt 的情形）
    const existing = await this.db.query(
      `select 1 from wake_records where parent_run_id = $1 and status = 'waiting'`,
      [runId],
    )
    if (existing.rowCount > 0) return true

    await this.#store.armWake({
      parentRunId: runId,
      parentAgentId: agentId,
      parentConversationId: conversationId,
      waitOnRunIds: pending.rows.map((r) => r.id),
    })
    await this.events.emit(attemptId, runId, 'wake.armed', { waitOn: pending.rows.length })
    return true
  }

  /**
   * 到点的定时任务 → 队列。返回是否触发了任何东西。
   *
   * 不需要单独的 cron 进程：`run_queue.available_at` 与 lease 语义已经在这里，
   * 「定时」就是「到点往队列塞一个 run」。多一个守护进程只会多一个要对齐的时钟。
   *
   * **一条计划出错不能打断 worker。** 这个循环跑在每个 tick 上，一条坏计划
   * （比如 agent 被删了）会让整个系统停摆。所以逐条 catch，坏的记进
   * schedule_fires 的 error，剩下的照跑。
   */
  async #fireDueSchedules(hooks: WorkerHooks = {}): Promise<boolean> {
    const now = new Date(this.deps.clock.now())
    let due: Schedule[]
    try {
      due = await this.#schedules.claimDue(now)
    } catch {
      // schedules 表还没 migrate 的旧库：定时不可用，但别拖死其他功能
      return false
    }
    if (due.length === 0) return false

    let fired = false
    for (const s of due) {
      try {
        const results = await this.#schedules.fire(s, now)
        for (const r of results) {
          if (r.runId) fired = true
          hooks.onScheduleFire?.(r)
        }
      } catch (e) {
        await this.#schedules
          .recordError(s.id, s.nextFireAt ?? now, (e as Error).message)
          .catch(() => {
            /* 记账失败也不能打断 */
          })
      }
    }
    return fired
  }

  /**
   * 构造本次 attempt 的输入消息。
   *
   * - root run：会话历史
   * - 子 run：任务信封（intent + 上游摘要），**没有会话历史**
   * - 被 wake 唤醒的 root run：追加子 run 的结果摘要
   */
  async #buildMessages(
    runId: string,
    conversationId: string | null,
    input: unknown,
    ctx: { attemptId: string; modelChain: string[]; contextWindow: number } | null = null,
  ): Promise<{ history: ChatMessage[]; input: ChatMessage[]; summary: string | null }> {
    // history 与本回合输入必须分开返回 —— 装配器只裁剪 history，
    // 本回合的任务与专家结果是不能被裁掉的（裁了这一轮就没意义了）
    const history: ChatMessage[] = []
    const turn: ChatMessage[] = []
    let summary: string | null = null

    if (conversationId) {
      // 取 50 条只是上限，真正的约束是装配器的 token 预算
      let recent = await this.#conversations.recent(conversationId, 50)

      /**
       * 压缩**在装配之前**。
       *
       * 等装配器报 trim_history 才动手是没用的 —— 那时消息这一轮已经被丢了，
       * 摘要救不回这一轮。所以判定放在这里，在历史交给装配器之前。
       *
       * 失败不影响任务：compactor 内部 catch 到底，返回 compacted: false，
       * 于是这里照旧把全量历史交出去，由装配器按老办法裁。
       */
      if (ctx && this.#compactor) {
        await this.#compactor.maybeCompact({
          conversationId,
          messages: recent,
          historyBudget: historyBudgetFor(ctx.contextWindow),
          modelChain: ctx.modelChain,
          attemptId: ctx.attemptId,
          runId,
        })
      }

      const conv = await this.#conversations.get(conversationId)
      if (conv?.summary && conv.summaryThroughSeq > 0) {
        summary = renderSummary(conv.summary, conv.summaryGeneration)
        // **被摘要覆盖的消息不能再逐条进去** —— 否则同一段内容占两份预算，
        // 压缩反而让 context 变大
        recent = recent.filter((m) => m.seq > conv.summaryThroughSeq)
      }
      history.push(...this.#conversations.toChatMessages(recent))
    } else {
      // 子 run：任务信封。渲染集中在 envelope.ts —— 以前这里是
      // `task ?? JSON.stringify(input)`，信封一结构化就会变成一坨 JSON 怼给专家
      turn.push(renderEnvelope(input))
    }

    // 已完成的子 run：把结果作为信封的一部分传上来（引用而非全文）
    const children = await this.db.query<{
      agent_id: string
      status: string
      result: { summary?: string; artifacts?: string[] } | null
      error_code: string | null
    }>(
      `select agent_id, status, result, error_code from runs
        where parent_run_id = $1 and status in ('succeeded','failed','cancelled')
        order by created_at`,
      [runId],
    )
    for (const c of children.rows) {
      const body =
        c.status === 'succeeded'
          ? `${c.result?.summary ?? '(无摘要)'}${
              c.result?.artifacts?.length ? `\n产出：${c.result.artifacts.join(', ')}` : ''
            }`
          : `执行失败（${c.error_code ?? 'unknown'}）`
      turn.push({ role: 'user', content: `[专家结果 · ${c.agent_id}] ${body}` })
    }

    return { history, input: turn, summary }
  }
}

/**
 * 留给历史的 token 预算。
 *
 * 与装配器的 DEFAULT_BUDGET 保持一致的口径：窗口减去输出余量后，历史能占的上限。
 * 压缩阈值按它算 —— 按整个窗口算会让压缩触发得太晚（前缀、约束、本轮输入
 * 都还要占位置）。
 */
export function historyBudgetFor(contextWindow: number): number {
  const usable = contextWindow - DEFAULT_BUDGET.reserveForOutput
  return Math.max(0, Math.min(DEFAULT_BUDGET.maxHistoryTokens, usable))
}
