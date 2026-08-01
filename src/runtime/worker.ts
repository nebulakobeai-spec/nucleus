import { NucleusError } from '../errors.js'
import type { Db } from '../db/types.js'
import type { Deps } from '../seams.js'
import { RunStore, StaleFenceError } from '../store/runs.js'
import { ConversationStore } from '../store/conversations.js'
import { Runner, type AgentSpec } from './runner.js'
import { Reconciler } from './reconciler.js'
import type { RunEventSink } from './events.js'
import { renderEnvelope } from './envelope.js'
import type { ChatMessage } from '../providers/types.js'

export interface WorkerOptions {
  workerId: string
  /** 空队列时的轮询间隔 */
  idleMs?: number
  leaseMs?: number
  /** 每隔多少次循环跑一次 reconciler */
  reconcileEvery?: number
  workdirRoot?: string
}

export interface WorkerHooks {
  onAttemptStart?(info: { runId: string; attemptId: string; agentId: string; attemptNo: number; depth: number }): void
  onAttemptEnd?(info: { runId: string; attemptId: string; status: string; errorCode?: string }): void
  onIdle?(): void
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
  #store: RunStore
  #conversations: ConversationStore
  #reconciler: Reconciler
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
    this.#store = new RunStore(db, deps)
    this.#conversations = new ConversationStore(db, deps)
    this.#reconciler = new Reconciler(db, deps)
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

    const attempt = await this.#store.claimNext(this.opts.workerId, this.opts.leaseMs ?? 60_000)
    if (!attempt) return false

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
          hint: 'agents 是整体替换而非合并；在 nucleus.config.json 里列出 agents 时要把入口 agent 一起列上',
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
      const { history, input: turnInput } = await this.#buildMessages(
        run.id,
        run.conversationId,
        run.input,
      )
      const out = await this.runner.execute({
        attemptId: attempt.id,
        fenceToken: attempt.fenceToken!,
        runId: run.id,
        agent,
        history,
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
        status: armed ? 'waiting_children' : out.status,
        errorCode: out.errorCode ?? null,
        tokens: out.tokensIn + out.tokensOut,
        costUsd: out.costUsd,
      })
      hooks.onAttemptEnd?.({
        runId: run.id,
        attemptId: attempt.id,
        status: armed ? 'waiting_children' : out.status,
        ...(out.errorCode ? { errorCode: out.errorCode } : {}),
      })
    } catch (e) {
      if (e instanceof StaleFenceError) return true // 已被接管
      const err = e instanceof NucleusError ? e : new NucleusError('runtime.internal', String(e))
      await this.#store
        .finishAttempt({
          attemptId: attempt.id,
          fenceToken: attempt.fenceToken!,
          status: 'failed',
          errorCode: err.code,
          errorDetail: { message: err.message },
        })
        .catch(() => {
          /* 交给 reconciler */
        })
      hooks.onAttemptEnd?.({
        runId: run.id,
        attemptId: attempt.id,
        status: 'failed',
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
  ): Promise<{ history: ChatMessage[]; input: ChatMessage[] }> {
    // history 与本回合输入必须分开返回 —— 装配器只裁剪 history，
    // 本回合的任务与专家结果是不能被裁掉的（裁了这一轮就没意义了）
    const history: ChatMessage[] = []
    const turn: ChatMessage[] = []

    if (conversationId) {
      // 取 50 条只是上限，真正的约束是装配器的 token 预算
      const recent = await this.#conversations.recent(conversationId, 50)
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

    return { history, input: turn }
  }
}
