import { createHash } from 'node:crypto'
import { NucleusError } from '../errors.js'
import type { Deps } from '../seams.js'
import type { Db } from '../db/types.js'
import { RunStore, StaleFenceError } from '../store/runs.js'
import type { ModelRouter } from '../providers/router.js'
import type { ChatMessage, ToolDef } from '../providers/types.js'
import {
  DEFAULT_MAX_OUTPUT,
  hashArgs,
  parseArgs,
  truncateOutput,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
} from './tools.js'
import {
  RESULT_SCHEMA_VERSION,
  formatFailures,
  resultJsonSchema,
  validateResult,
  type CoreResult,
  type ResultSchemaSpec,
  type ValidationFailure,
} from './result-schema.js'
import { assemble } from '../context/assemble.js'
import { contextBudgetFor, type ContextBudget } from '../context/budget.js'
import { envelopeSizes } from './envelope.js'
import { decideRetry, DEFAULT_RETRY_POLICY, type RetryDecision, type RetryPolicy } from './retry.js'
import type { Permission } from './permissions.js'
import type { RunEventSink } from './events.js'

export interface AgentSpec {
  id: string
  /** 静态 prompt 前缀（identity + policy）。必须逐字节稳定，见 §5 */
  systemPrompt: string
  modelChain: string[]
  /** 授予的权限 —— 工具可见性的主关 */
  permissions: Permission[]
  /** 按名字收窄（可选），与权限是与关系 */
  toolsAllow?: string[]
  toolsDeny?: string[]
  resultSpec?: ResultSchemaSpec
  maxSteps?: number
  maxCostUsd?: number
  temperature?: number
  /**
   * 单次调用的输出上限。
   *
   * 推理模型需要给足 —— 思考过程会消耗这份预算，不够就会在给出
   * 答案前被截断（见 provider.output_truncated）。留空则用 provider 默认。
   */
  maxTokens?: number
}

export interface RunnerOptions {
  /** 同一 (tool, args) 重复多少次判定为循环 */
  loopThreshold?: number
  /** 连续多少步没有新产出判定为无进展 */
  noProgressSteps?: number
  /** schema 校验失败的重写次数上限 */
  schemaRetries?: number
  /** 模型未声明 contextWindow 时按这个值预算 */
  assumedContextWindow?: number
  /** run 级重试策略 */
  retryPolicy?: RetryPolicy
  /** 是否记录 transcript（默认开 —— 出问题后再开就来不及了） */
  captureTranscripts?: boolean
  transcriptMaxChars?: number
  heartbeatMs?: number
  leaseMs?: number
}

/** 一次 attempt 内跨多次模型调用累计的用量 */
interface UsageAcc {
  stepsUsed: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  costUsd: number
  /** 最后一次成功调用的模型键 */
  modelKey: string | null
  /** 上下文装配的分段用量，落库用于事后判断「是不是被裁掉了关键信息」 */
  contextBreakdown?: unknown
}

/** 委派的可统计事实：目标专家、选择理由、信封各段长度 */
function delegateFacts(args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as { agent?: string; why?: string }
  return {
    target: a.agent ?? null,
    why: typeof a.why === 'string' ? a.why : null,
    envelope: envelopeSizes(args),
  }
}

export interface RunOutcome {
  status: 'succeeded' | 'failed'
  /** 本轮主动挂起（如委派后等待子 run），下一次 attempt 由 wake 触发 */
  suspended?: boolean
  result?: CoreResult
  errorCode?: string
  errorDetail?: unknown
  stepsUsed: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  costUsd: number
  /** 实际产出结果的模型键，如 `zai:glm-5.2`；一次都没调成功时为 null */
  modelKey?: string | null
  /** 上下文装配的分段用量 */
  contextBreakdown?: unknown
  /** 这次失败已排了重试 —— 逻辑 run 还没结束 */
  willRetry?: boolean
}

/**
 * Agent loop。
 *
 * 一次 attempt 的完整生命周期：装配 → 调模型 → 执行工具 → 直到 submit_result。
 *
 * 三条纪律：
 *  - 工具调用**先写意图再执行**（§3.2），崩溃后可按副作用等级分流
 *  - 心跳由**本进程写库**证明，不是模型自述（§3.6）
 *  - 终态写入带 fence token，被判死的 worker 写不进去（§3.4）
 */
/**
 * 模型没声明 maxTokens 时的兜底输出上限（**token**）。
 *
 * 名字带 TOKENS 是因为 tools.js 里已经有个 `DEFAULT_MAX_OUTPUT`，
 * 那个是「工具输出的**字符**上限」—— 同名不同义最容易在几个月后被搞混。
 */
const FALLBACK_MAX_OUTPUT_TOKENS = 4_096

export class Runner {
  #store: RunStore
  #loopThreshold: number
  #noProgressSteps: number
  #schemaRetries: number
  #assumedContextWindow: number
  #retryPolicy: RetryPolicy
  #captureTranscripts: boolean
  #transcriptMaxChars: number
  #heartbeatMs: number
  #leaseMs: number

  constructor(
    private db: Db,
    private deps: Deps,
    readonly router: ModelRouter,
    private tools: ToolRegistry,
    private events: RunEventSink,
    opts: RunnerOptions = {},
  ) {
    this.#store = new RunStore(db, deps)
    this.#loopThreshold = opts.loopThreshold ?? 3
    this.#noProgressSteps = opts.noProgressSteps ?? 6
    this.#schemaRetries = opts.schemaRetries ?? 2
    this.#assumedContextWindow = opts.assumedContextWindow ?? 32_768
    this.#retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY
    this.#captureTranscripts = opts.captureTranscripts ?? true
    this.#transcriptMaxChars = opts.transcriptMaxChars ?? 200_000
    this.#heartbeatMs = opts.heartbeatMs ?? 15_000
    this.#leaseMs = opts.leaseMs ?? 60_000
  }

  /**
   * 执行一次 attempt。
   *
   * **永远不抛异常**（除 StaleFenceError）—— 所有失败路径都写终态，
   * 因为「不存在没收到」依赖的正是这一点。
   */
  /**
   * 这条链的有效窗口（取链上最小值）。
   *
   * 暴露出来是为了让压缩判定用**同一个口径** —— 两处各算一份的话，
   * 阈值和实际裁剪会对不上，而那种偏差只在长会话里才显形。
   */
  contextWindowFor(chain: string[]): number {
    return this.router.contextWindowFor(chain, this.#assumedContextWindow)
  }

  /**
   * 这条链的上下文预算 —— **按模型算，不用常量**。
   *
   * 暴露出来是为了让压缩判定与装配用**同一份**预算。两处各算一份的话，
   * 阈值和实际裁剪会对不上，而那种偏差只在长会话里才显形。
   */
  budgetFor(chain: string[]): ContextBudget {
    return contextBudgetFor(
      this.router.contextWindowFor(chain, this.#assumedContextWindow),
      // 输出上限取链上最大值 —— 降级到配了更大 maxTokens 的模型时，
      // 按小的那个留余量会让它一吐长就撞窗口
      this.router.maxOutputTokensFor(chain, FALLBACK_MAX_OUTPUT_TOKENS),
    )
  }

  async execute(input: {
    attemptId: string
    fenceToken: string
    /** 第几次尝试 —— run 级重试的决策要用它判断有没有超上限 */
    attemptNo: number
    runId: string
    agent: AgentSpec
    /** 会话历史，按时间顺序（最旧在前）。装配器按 token 预算从旧往新裁 */
    history: ChatMessage[]
    /**
     * 已压缩的历史摘要（已渲染成文本）。
     *
     * 它替代的是**已经退役的**那段历史 —— `history` 里不该再包含被摘要覆盖的
     * 消息，否则同一段内容会占两份预算。由调用方（worker）保证。
     */
    summary?: string | null
    /** 摘要的最小形态（只剩要求与未决）。极端缺预算时用它替换完整摘要 */
    summaryMinimal?: string | null
    /** 本回合输入（任务信封 / 专家结果）。不参与裁剪 */
    input: ChatMessage[]
    workdir: string
    signal?: AbortSignal
  }): Promise<RunOutcome> {
    const { attemptId, fenceToken, runId, agent } = input
    const ctl = new AbortController()
    input.signal?.addEventListener('abort', () => ctl.abort(), { once: true })

    const heart = this.#startHeartbeat(attemptId, fenceToken, ctl)
    // modelKey 记「最后一次成功调用的模型」——
    // 一次 attempt 可能跨模型（链上降级），落库的是产出最终结果的那个
    const acc: UsageAcc = { stepsUsed: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: 0, modelKey: null }

    try {
      const outcome = await this.#loop({ ...input, signal: ctl.signal }, acc)
      await this.#finish(attemptId, fenceToken, outcome)
      return outcome
    } catch (e) {
      if (e instanceof StaleFenceError) throw e // 已被接管，不要再写
      const err = e instanceof NucleusError ? e : new NucleusError('runtime.internal', String(e), { cause: e })
      const outcome: RunOutcome = {
        status: 'failed',
        errorCode: err.code,
        errorDetail: err.detail ?? { message: err.message },
        ...acc,
      }
      // run 级重试的决策就在这里做，因为**终态是这里写的**。
      // 放到 worker 的 catch 里是错的：失败被 runner 捕获并返回，
      // 异常根本传不到 worker（我第一版就犯了这个错，
      // 结果 all_exhausted 照旧落 failed）。
      const decision = decideRetry({
        errorCode: err.code,
        retryAfterMs: err.retryAfterMs ?? null,
        attemptNo: input.attemptNo,
        policy: this.#retryPolicy,
      })
      await this.events.emit(attemptId, runId, 'attempt.failed', {
        errorCode: err.code,
        willRetry: decision.retry,
        delayMs: decision.retry ? decision.delayMs : null,
        reason: decision.reason,
        attemptNo: input.attemptNo,
      })
      await this.#finish(attemptId, fenceToken, outcome, decision).catch(() => {
        /* 终态写失败交给 reconciler 兜底 */
      })
      return { ...outcome, ...(decision.retry ? { willRetry: true } : {}) }
    } finally {
      clearInterval(heart)
      void runId
    }
  }

  /** 心跳：进程写库，零 token、零模型判断。fence 失效即中止本次执行。 */
  #startHeartbeat(attemptId: string, fence: string, ctl: AbortController): NodeJS.Timeout {
    return setInterval(() => {
      void this.#store.heartbeat(attemptId, fence, this.#leaseMs).then((alive) => {
        if (!alive) ctl.abort(new NucleusError('runtime.lease_expired', 'lease 已失效，停止工作'))
      })
    }, this.#heartbeatMs)
  }

  async #loop(
    input: {
      attemptId: string
      runId: string
      agent: AgentSpec
      history: ChatMessage[]
      summary?: string | null
      summaryMinimal?: string | null
      input: ChatMessage[]
      workdir: string
      signal: AbortSignal
    },
    acc: UsageAcc,
  ): Promise<RunOutcome> {
    const { agent, attemptId, runId, signal } = input
    const maxSteps = agent.maxSteps ?? 20
    const spec = agent.resultSpec ?? {}

    const toolDefs = this.tools.forAgent(agent.permissions, agent.toolsAllow, agent.toolsDeny)
    const wire: ToolDef[] = [
      ...toolDefs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      {
        name: 'submit_result',
        description: '提交本次任务的最终结果。必须调用它来结束任务。',
        parameters: resultJsonSchema(spec),
      },
    ]

    // ── 上下文装配（DESIGN.md §5）────────────────────────
    //
    // 过去这里是「system prompt + 会话历史」的裸拼接，历史只按**条数**
    // 截到 50 条，没有任何 token 预算 —— 也就是说「context 会不会爆」
    // 全靠每条消息都短。装配器一直存在但没接上线。
    //
    // systemPrompt 整体当作不可变前缀传入：它由 buildSystemPrompt 拼成
    // （契约 + identity + policy），本身已经逐字节稳定，这是 prompt cache
    // 命中的前提，不能在这里掺入任何随回合变化的东西。
    // 预算按模型算：窗口取链上最小、输出上限取链上最大，其余各段按比例。
    // 原来这里是 `{ ...DEFAULT_BUDGET, contextWindow: window }` —— 那会让
    // 1M 窗口的模型仍然只用 40k 历史（DEFAULT_BUDGET 里的硬上限）
    const budget = this.budgetFor(agent.modelChain)
    const window = budget.contextWindow
    const assembled = assemble({
      contract: agent.systemPrompt,
      identity: '',
      policy: '',
      history: input.history,
      // 摘要接上线。这两档降级（shrink_summary / drop_summary）在装配器里
      // 一直存在，但此前永远不会触发 —— 没有任何代码产生摘要
      summary: input.summary ?? null,
      // 只剩要求的那一版：整个丢掉摘要会连用户约束一起丢
      summaryMinimal: input.summaryMinimal ?? null,
      input: input.input,
      budget,
    })

    await this.events.emit(attemptId, runId, 'context.assembled', {
      window,
      // 预算本身要落进事件流 —— 「为什么这一轮裁得这么狠」要能回答，
      // 而那取决于当时算出来的预算，不是某个常量
      budget,
      breakdown: assembled.breakdown,
      degradations: assembled.degradations,
      droppedMessages: assembled.droppedMessages,
    })
    acc.contextBreakdown = { window, ...assembled.breakdown, degradations: assembled.degradations }

    // 连本回合输入都放不进去 —— 裁剪救不回来，早失败比发一个必然被拒的请求好
    if (assembled.degradations.includes('needs_checkpoint')) {
      throw new NucleusError(
        'budget.context_overflow',
        `本回合输入超出模型窗口（${window} tokens），已无可降级项`,
        {
          detail: {
            window,
            breakdown: assembled.breakdown,
            hint: '减少本轮输入，或换用窗口更大的模型（在 nucleus.config.json 里声明 contextWindow）',
          },
        },
      )
    }

    const messages: ChatMessage[] = assembled.messages

    const callCounts = new Map<string, number>()
    let invocationSeq = 0
    let schemaRetries = 0
    let stepsSinceProgress = 0

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) {
        throw new NucleusError('runtime.cancelled', '执行已取消')
      }
      acc.stepsUsed = step

      await this.events.emit(attemptId, runId, 'llm.call.started', { step, chain: agent.modelChain })
      const res = await this.router.chat(agent.modelChain, {
        messages,
        tools: wire,
        attemptId,
        ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
        ...(agent.maxTokens !== undefined ? { maxTokens: agent.maxTokens } : {}),
        signal,
      })
      acc.tokensIn += res.usage.tokensIn
      acc.tokensOut += res.usage.tokensOut
      acc.cacheRead += res.usage.cacheRead
      acc.costUsd += res.costUsd
      acc.modelKey = res.modelKey
      // transcript：模型被问了什么、答了什么。
      // 事件流只有 token 与延迟 —— 而「为什么派给了这个专家」只有看到
      // prompt 与回复才答得出，且出问题之后再想开启就来不及了
      if (this.#captureTranscripts) {
        await this.#store
          .recordTranscript({
            runAttemptId: attemptId,
            step,
            request: { messages, tools: wire.map((t) => t.name) },
            response: {
              content: res.content,
              // 思考只记长度与开头 —— 全文可能很长，而它不进历史
              reasoningChars: res.reasoning?.length ?? 0,
              reasoningHead: res.reasoning?.slice(0, 2_000) ?? null,
              toolCalls: res.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })),
              finishReason: res.finishReason,
              model: res.modelKey,
            },
            maxChars: this.#transcriptMaxChars,
          })
          .catch(() => {
            /* 记录失败不该影响执行 —— 但也不静默：下面的事件仍然会落 */
          })
      }

      await this.events.emit(attemptId, runId, 'llm.call.finished', {
        step,
        model: res.modelKey,
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        cacheRead: res.usage.cacheRead,
        costUsd: res.costUsd,
        latencyMs: res.latencyMs,
        finishReason: res.finishReason,
        switched: res.attempts,
      })

      // 推理模型的思考过程只进事件流，**不进 messages** ——
      // 它不属于最终回复，放进历史会违反多轮规范并浪费 context
      // （Gemma 4 的最佳实践明确要求历史里不含 thinking）。
      if (res.reasoning) {
        await this.events.emit(attemptId, runId, 'llm.reasoning', {
          step,
          chars: res.reasoning.length,
          // 只留开头，完整思考过程可能很长
          excerpt: res.reasoning.slice(0, 500),
        })
      }

      if (agent.maxCostUsd !== undefined && acc.costUsd > agent.maxCostUsd) {
        throw new NucleusError('budget.cost_exceeded', `成本 ${acc.costUsd.toFixed(4)} 超出上限 ${agent.maxCostUsd}`)
      }

      /**
       * 输出被截断。
       *
       * 推理模型（gemma4 / deepseek-r1）会先输出思考再给答案，思考本身
       * 消耗输出预算。预算不足时 content 与 tool_calls 都是空的 ——
       * 若按「模型没调工具」处理，会一路走到 budget.no_progress，
       * 而那个错误码完全指不到真实原因（预算不够）。
       */
      if (res.finishReason === 'length' && res.toolCalls.length === 0) {
        throw new NucleusError(
          'provider.output_truncated',
          `${res.modelKey} 输出在完成前被截断（tokens_out=${res.usage.tokensOut}）` +
            (res.reasoning ? '；思考过程占满了输出预算' : ''),
          {
            detail: {
              model: res.modelKey,
              tokensOut: res.usage.tokensOut,
              maxTokens: agent.maxTokens ?? null,
              reasoningChars: res.reasoning?.length ?? 0,
              hint: '提高该 agent 的 maxTokens，或改用非推理模型',
            },
          },
        )
      }

      // 没有工具调用 = 模型想直接结束，但它必须走 submit_result
      if (res.toolCalls.length === 0) {
        // content 为空时给个占位：多数 provider 拒绝空 assistant 消息
        messages.push({ role: 'assistant', content: res.content || '(无输出)' })
        messages.push({
          role: 'user',
          content: '请调用 submit_result 提交结果来结束任务，不要直接用文本回复。',
        })
        stepsSinceProgress++
        if (stepsSinceProgress >= this.#noProgressSteps) {
          throw new NucleusError('budget.no_progress', `连续 ${stepsSinceProgress} 步没有进展`)
        }
        continue
      }

      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls })

      let submitted: CoreResult | null = null
      let madeProgress = false
      let suspended = false

      for (const call of res.toolCalls) {
        // ── submit_result：契约校验 ──────────────────────
        if (call.name === 'submit_result') {
          const parsed = parseArgs(call.arguments)
          const check: { ok: true; value: CoreResult } | { ok: false; failures: ValidationFailure[] } =
            parsed.ok
              ? validateResult(parsed.value, spec)
              : { ok: false, failures: [{ path: '(root)', message: parsed.error }] }

          if (check.ok) {
            submitted = check.value
            // contract.rejected 的正面对应。
            //
            // 没有它的话「一次过的比例」只能靠推断（attempt 状态 + 有没有
            // 被退回过），而 run_attempts 上并不记录结果，推断必然把
            // 委派后挂起的 attempt 也算成「通过」—— 分母被冲淡，
            // 遵守率虚高。指标应当来自显式事件，不是猜。
            await this.events.emit(attemptId, runId, 'contract.accepted', {
              step,
              retries: schemaRetries,
            })
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'ok' })
            break
          }

          schemaRetries++
          await this.events.emit(attemptId, runId, 'contract.rejected', {
            step,
            failures: check.failures,
            retry: schemaRetries,
          })
          if (schemaRetries > this.#schemaRetries) {
            throw new NucleusError('contract.postcondition_failed', '结果多次未通过校验', {
              detail: { failures: check.failures },
            })
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: formatFailures(check.failures),
          })
          continue
        }

        // ── 普通工具 ────────────────────────────────────
        const def = this.tools.get(call.name)
        const allowed = toolDefs.some((t) => t.name === call.name)
        if (!def || !allowed) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: `工具 ${call.name} 不可用。可用工具：${toolDefs.map((t) => t.name).join(', ')}, submit_result`,
          })
          continue
        }

        const argsParsed = parseArgs(call.arguments)
        if (!argsParsed.ok) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: argsParsed.error,
          })
          continue
        }
        const args = argsParsed.value
        const fingerprint = hashArgs(call.name, args)

        // 循环检测：同一工具同一参数反复调用是最常见的烧钱方式
        const seen = (callCounts.get(fingerprint) ?? 0) + 1
        callCounts.set(fingerprint, seen)
        if (seen > this.#loopThreshold) {
          throw new NucleusError(
            'budget.loop_detected',
            `工具 ${call.name} 用相同参数已调用 ${seen} 次，结果相同`,
            { detail: { tool: call.name, times: seen } },
          )
        }
        if (seen > 1) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: `你已用完全相同的参数调用过 ${call.name} ${seen - 1} 次，结果不会变化。请换一种做法。`,
          })
          continue
        }

        const out = await this.#invokeTool(def, args, {
          attemptId,
          runId,
          agentId: agent.id,
          workdir: input.workdir,
          signal,
          seq: ++invocationSeq,
          fingerprint,
          step,
        })

        if (out.ok) madeProgress = true
        if (out.suspend) suspended = true
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: out.content,
        })
      }

      if (submitted) {
        return {
          status: submitted.status === 'failed' ? 'failed' : 'succeeded',
          result: submitted,
          ...(submitted.status === 'failed' ? { errorCode: 'contract.postcondition_failed' } : {}),
          ...acc,
        }
      }

      // 工具声明本轮到此为止（如委派）—— 编排者不该空转等待，
      // 它的下一次 attempt 由 wake 触发。
      if (suspended) {
        return { status: 'succeeded', suspended: true, ...acc }
      }

      stepsSinceProgress = madeProgress ? 0 : stepsSinceProgress + 1
      if (stepsSinceProgress >= this.#noProgressSteps) {
        throw new NucleusError('budget.no_progress', `连续 ${stepsSinceProgress} 步没有进展`)
      }
    }

    throw new NucleusError('budget.steps_exceeded', `超过步数上限 ${maxSteps}`)
  }

  /**
   * 执行一个工具：**先写意图，再调用，最后写结果**。
   *
   * 崩溃在中间会留下 outcome=NULL 的记录，reconciler 按副作用等级分流：
   * non_idempotent 的绝不自动重跑（§3.2）。
   */
  async #invokeTool(
    def: ToolDefinition,
    args: unknown,
    ctx: {
      attemptId: string
      runId: string
      agentId: string
      workdir: string
      signal: AbortSignal
      seq: number
      fingerprint: string
      step: number
    },
  ): Promise<ToolResult> {
    const toolCtx: ToolContext = {
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      agentId: ctx.agentId,
      workdir: ctx.workdir,
      signal: ctx.signal,
      writeArtifact: async (a) => {
        const ref = `${ctx.runId}/${a.path}`
        // content 必须真的存下来。它一度只被用来算 bytes ——
        // 于是「summary 写结论、完整内容进 artifact 后引用」这整套策略
        // 指向的是不存在的东西（实测一份 17KB 报告只剩长度数字）。
        const sha = createHash('sha256').update(a.content).digest('hex')
        await this.db.query(
          `insert into artifacts (ref, run_id, path, kind, bytes, sha256, content, summary, trust_level, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (ref) do update
              set bytes = $5, sha256 = $6, content = $7, summary = $8`,
          [
            ref,
            ctx.runId,
            a.path,
            a.kind ?? 'file',
            a.content.length,
            sha,
            a.content,
            a.summary ?? null,
            a.trustLevel ?? 'agent',
            this.deps.clock.nowIso(),
          ],
        )
        await this.events.emit(ctx.attemptId, ctx.runId, 'artifact.written', {
          ref,
          // path 与 bytes 单独给出：ref 前面挂着 runId，终端里显示全长是噪音，
          // 而「产出了多大的东西」恰恰是判断专家有没有真干活的一手信息
          path: a.path,
          bytes: a.content.length,
          trustLevel: a.trustLevel ?? 'agent',
        })
        return ref
      },
    }

    // 前置检查在写意图**之前** —— 被拒绝的调用从未发生，不该留意图记录
    if (def.precondition) {
      const rejected = await def.precondition(args, toolCtx)
      if (rejected) {
        await this.events.emit(ctx.attemptId, ctx.runId, 'rule.violation', {
          step: ctx.step,
          tool: def.name,
          rule: rejected.rule ?? null,
        })
        return rejected
      }
    }

    await this.events.emit(ctx.attemptId, ctx.runId, 'tool.intent', {
      step: ctx.step,
      tool: def.name,
      sideEffect: def.sideEffect,
      argsHash: ctx.fingerprint,
      // 委派额外记下：派给谁、为什么、信封各段多长。
      // 「派得对不对」与「信封写得够不够」都得靠这些才能事后统计 ——
      // 硬规则只挡空值，写得敷衍只能靠度量发现
      ...(def.name === 'delegate' ? delegateFacts(args) : {}),
    })
    const invocationId = await this.#store.recordIntent({
      runAttemptId: ctx.attemptId,
      seq: ctx.seq,
      toolName: def.name,
      argsHash: ctx.fingerprint,
      args,
      sideEffectClass: def.sideEffect,
      ...(def.sideEffect === 'idempotent' ? { idempotencyKey: `${ctx.runId}:${ctx.fingerprint}` } : {}),
    })

    const started = this.deps.clock.now()
    let out: ToolResult
    try {
      out = await this.#withTimeout(def, args, toolCtx)
    } catch (e) {
      const code =
        e instanceof NucleusError
          ? e.code
          : (e as Error)?.name === 'AbortError'
            ? 'runtime.cancelled'
            : 'tool.crashed'
      out = { ok: false, content: `工具 ${def.name} 执行失败：${(e as Error).message}`, errorCode: code }
    }

    // 大输出落盘，只把截断版回灌 —— 避免撑爆 context
    const max = def.maxOutputChars ?? DEFAULT_MAX_OUTPUT
    if (out.content.length > max) {
      const ref = await toolCtx.writeArtifact({
        path: `tool-output/${ctx.seq}-${def.name}.txt`,
        content: out.content,
        trustLevel: 'untrusted_tool_output',
        summary: `${def.name} 的完整输出`,
      })
      const { text } = truncateOutput(out.content, max)
      out = { ...out, content: `${text}\n\n[全文 artifact: ${ref}]`, artifactRef: ref }
    }

    await this.#store.recordOutcome(invocationId, out.ok ? 'ok' : 'error', {
      resultRef: out.artifactRef ?? null,
      errorCode: out.errorCode ?? null,
      // 回灌给模型的就是这段文本 —— 规则为什么拦下、工具报了什么，都在里面
      resultText: out.content ?? null,
    })
    await this.events.emit(ctx.attemptId, ctx.runId, 'tool.outcome', {
      step: ctx.step,
      tool: def.name,
      ok: out.ok,
      ms: this.deps.clock.now() - started,
      errorCode: out.errorCode ?? null,
    })

    return out
  }

  async #withTimeout(def: ToolDefinition, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const ms = def.timeoutMs
    if (!ms) return def.execute(args, ctx)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        def.execute(args, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new NucleusError('tool.timeout', `工具 ${def.name} 超时`)), ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async #finish(
    attemptId: string,
    fence: string,
    o: RunOutcome,
    retry?: RetryDecision,
  ): Promise<void> {
    await this.#store.finishAttempt({
      attemptId,
      fenceToken: fence,
      status: o.status === 'succeeded' ? 'succeeded' : 'failed',
      ...(o.errorCode ? { errorCode: o.errorCode } : {}),
      ...(o.errorDetail !== undefined ? { errorDetail: o.errorDetail } : {}),
      ...(o.result ? { result: o.result, resultSchemaVersion: RESULT_SCHEMA_VERSION } : {}),
      stepsUsed: o.stepsUsed,
      tokensIn: o.tokensIn,
      tokensOut: o.tokensOut,
      cacheRead: o.cacheRead,
      costUsd: o.costUsd,
      // 落库「谁真的干了这活」：链上降级时这是唯一的事后凭据，
      // 也是「订阅制显示订阅而不是 $0」的依据
      ...(o.modelKey ? { modelKey: o.modelKey } : {}),
      // 分段用量：事后判断「模型是不是因为历史被裁掉才答错」的唯一依据
      ...(o.contextBreakdown !== undefined ? { contextBreakdown: o.contextBreakdown } : {}),
      // 重试与终态写入同事务 —— 否则中间崩溃会留下「waiting_retry 但队列为空」
      ...(retry?.retry
        ? {
            runStatusOverride: 'waiting_retry' as const,
            retryAt: new Date(this.deps.clock.now() + retry.delayMs),
          }
        : {}),
    })
  }
}
