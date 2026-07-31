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
import type { RunEventSink } from './events.js'

export interface AgentSpec {
  id: string
  /** 静态 prompt 前缀（identity + policy）。必须逐字节稳定，见 §5 */
  systemPrompt: string
  modelChain: string[]
  toolsAllow: string[]
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
export class Runner {
  #store: RunStore
  #loopThreshold: number
  #noProgressSteps: number
  #schemaRetries: number
  #heartbeatMs: number
  #leaseMs: number

  constructor(
    private db: Db,
    private deps: Deps,
    private router: ModelRouter,
    private tools: ToolRegistry,
    private events: RunEventSink,
    opts: RunnerOptions = {},
  ) {
    this.#store = new RunStore(db, deps)
    this.#loopThreshold = opts.loopThreshold ?? 3
    this.#noProgressSteps = opts.noProgressSteps ?? 6
    this.#schemaRetries = opts.schemaRetries ?? 2
    this.#heartbeatMs = opts.heartbeatMs ?? 15_000
    this.#leaseMs = opts.leaseMs ?? 60_000
  }

  /**
   * 执行一次 attempt。
   *
   * **永远不抛异常**（除 StaleFenceError）—— 所有失败路径都写终态，
   * 因为「不存在没收到」依赖的正是这一点。
   */
  async execute(input: {
    attemptId: string
    fenceToken: string
    runId: string
    agent: AgentSpec
    messages: ChatMessage[]
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
      await this.#finish(attemptId, fenceToken, outcome).catch(() => {
        /* 终态写失败交给 reconciler 兜底 */
      })
      return outcome
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
      messages: ChatMessage[]
      workdir: string
      signal: AbortSignal
    },
    acc: UsageAcc,
  ): Promise<RunOutcome> {
    const { agent, attemptId, runId, signal } = input
    const maxSteps = agent.maxSteps ?? 20
    const spec = agent.resultSpec ?? {}

    const toolDefs = this.tools.forAgent(agent.toolsAllow, agent.toolsDeny)
    const wire: ToolDef[] = [
      ...toolDefs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      {
        name: 'submit_result',
        description: '提交本次任务的最终结果。必须调用它来结束任务。',
        parameters: resultJsonSchema(spec),
      },
    ]

    const messages: ChatMessage[] = [
      { role: 'system', content: agent.systemPrompt },
      ...input.messages,
    ]

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
        ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
        ...(agent.maxTokens !== undefined ? { maxTokens: agent.maxTokens } : {}),
        signal,
      })
      acc.tokensIn += res.usage.tokensIn
      acc.tokensOut += res.usage.tokensOut
      acc.cacheRead += res.usage.cacheRead
      acc.costUsd += res.costUsd
      acc.modelKey = res.modelKey
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
        await this.db.query(
          `insert into artifacts (ref, run_id, path, kind, bytes, summary, trust_level, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (ref) do update set bytes = $5, summary = $6`,
          [
            ref,
            ctx.runId,
            a.path,
            a.kind ?? 'file',
            a.content.length,
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
    })
    const invocationId = await this.#store.recordIntent({
      runAttemptId: ctx.attemptId,
      seq: ctx.seq,
      toolName: def.name,
      argsHash: ctx.fingerprint,
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

  async #finish(attemptId: string, fence: string, o: RunOutcome): Promise<void> {
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
    })
  }
}
