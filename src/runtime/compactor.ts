import type { ModelRouter } from '../providers/router.js'
import type { ConversationStore, Message } from '../store/conversations.js'
import type { RunEventSink } from './events.js'
import type { ChatMessage } from '../providers/types.js'
import { parseArgs } from './tools.js'
import { countMessage, heuristicTokenizer, type Tokenizer } from '../context/tokenizer.js'
import {
  buildCompactPrompt,
  decideCompact,
  renderSummary,
  summarySchema,
  validateSummary,
  type CompactDecision,
  type CompactPolicy,
  type ConversationSummary,
} from '../context/compact.js'

/**
 * Compactor —— 压缩的执行侧（判定与渲染都在 `context/compact.ts`，纯函数）。
 *
 * ── 三条不变量 ─────────────────────────────────────────
 *
 * 1. **消息永不删除。** 压缩只写 summary 与 summary_through_seq。
 *    摘要失败时退化成装配器照常裁剪，而不是数据丢失。
 *
 * 2. **压缩失败不能让任务失败。** 它是一次锦上添花的模型调用：成功了 context
 *    更省，失败了退回原来的行为。所以整条路径 catch 到底，只记账不抛。
 *    （反例就在隔壁：定时任务里一条坏计划若不 catch 会拖死整个 worker。）
 *
 * 3. **压缩必须发生在装配之前。** 等装配器报 trim_history 才动手的话，
 *    消息**这一轮已经被丢了** —— 摘要救不回这一轮。
 *
 * ── 用哪个模型 ─────────────────────────────────────────
 *
 * 用 agent 自己的模型链，不特意挑便宜的。摘要决定了**之后每一轮记得什么**，
 * 省这一次的钱会在后面所有轮里付出代价。链上降级的顺序也照旧，
 * 所以限流时它和正常调用一起降级，不会出现「主调用还活着但摘要挂了」。
 */

export interface CompactResult {
  compacted: boolean
  decision: CompactDecision
  generation?: number
  tokensBefore?: number
  tokensAfter?: number
  /** 失败原因。压缩失败**不是任务失败** —— 只是这一轮省不下 context */
  error?: string
}

export class Compactor {
  #tokenizer: Tokenizer

  constructor(
    private conversations: ConversationStore,
    private router: ModelRouter,
    private events: RunEventSink,
    private opts: {
      policy?: CompactPolicy
      tokenizer?: Tokenizer
      /** 摘要调用自己的输出上限 —— 摘要写太长就不叫压缩了 */
      maxTokens?: number
    } = {},
  ) {
    this.#tokenizer = opts.tokenizer ?? heuristicTokenizer
  }

  /**
   * 需要时压缩一次。
   *
   * `attemptId` 只用于把事件与用量挂到具体 attempt 上 —— 「这一轮多花的那次
   * 调用是压缩」要能看出来，否则 token 账对不上。
   */
  async maybeCompact(input: {
    conversationId: string
    messages: Message[]
    historyBudget: number
    modelChain: string[]
    /**
     * 挂事件的 attempt。**手动压缩时给 null。**
     *
     * 原来这里是必填，于是 `conv compact` 只能借最近一个 attempt 来挂 ——
     * 直接撞了 `unique(run_attempt_id, seq)`。而借用本身就是错的：手动压缩
     * 不属于任何一次尝试。持久记录在 `compactions` 表里，不依赖 run_events。
     */
    attemptId: string | null
    runId: string | null
  }): Promise<CompactResult> {
    const conv = await this.conversations.get(input.conversationId)
    if (!conv) {
      return { compacted: false, decision: { compact: false, throughSeq: 0, reason: '会话不存在' } }
    }

    const withSeq = input.messages.map((m) => ({
      seq: m.seq,
      message: this.conversations.toChatMessages([m])[0]!,
    }))

    const decision = decideCompact({
      messages: withSeq,
      summaryThroughSeq: conv.summaryThroughSeq,
      historyBudget: input.historyBudget,
      ...(this.opts.policy ? { policy: this.opts.policy } : {}),
      tokenizer: this.#tokenizer,
    })
    if (!decision.compact) return { compacted: false, decision }

    const retiring = withSeq.filter(
      (m) => m.seq > conv.summaryThroughSeq && m.seq <= decision.throughSeq,
    )
    const fromSeq = retiring[0]?.seq ?? conv.summaryThroughSeq + 1
    const tokensBefore = retiring.reduce((n, m) => n + countMessage(this.#tokenizer, m.message), 0)

    await this.#emit(input, 'compact.started', {
      conversationId: input.conversationId,
      fromSeq,
      throughSeq: decision.throughSeq,
      messages: retiring.length,
      tokensBefore,
      reason: decision.reason,
      generation: conv.summaryGeneration + 1,
    })

    try {
      const { summary, modelKey } = await this.#summarize(
        conv.summary,
        retiring.map((m) => m.message),
        input.modelChain,
        input.attemptId,
        tokensBefore,
      )

      const tokensAfter = this.#tokenizer.count(
        renderSummary(summary, conv.summaryGeneration + 1),
      )
      const [provider, model] = splitKey(modelKey)
      const written = await this.conversations.recordCompaction({
        conversationId: input.conversationId,
        summary,
        fromSeq,
        throughSeq: decision.throughSeq,
        messageCount: retiring.length,
        tokensBefore,
        tokensAfter,
        provider,
        model,
      })

      if (!written) {
        // 别人先压到更远的位置了。不是错误 —— 下一次读会拿到那个更好的摘要
        await this.#emit(input, 'compact.skipped', {
          reason: '已有更新的摘要（并发压缩，保留更远的那个）',
        })
        return { compacted: false, decision, tokensBefore }
      }

      await this.#emit(input, 'compact.finished', {
        generation: written.generation,
        tokensBefore,
        tokensAfter,
        saved: tokensBefore - tokensAfter,
        model: modelKey,
        constraints: summary.constraints.length,
        decisions: summary.decisions.length,
      })
      return {
        compacted: true,
        decision,
        generation: written.generation,
        tokensBefore,
        tokensAfter,
      }
    } catch (e) {
      const error = (e as Error).message
      // 记账再返回。**不抛** —— 压缩失败只是这一轮省不下 context，
      // 而「模型忘了我说过什么」的成因可能是压缩根本没成功；
      // 不留账的话这和「摘丢了」分不开
      await this.conversations
        .recordCompactionFailure({
          conversationId: input.conversationId,
          fromSeq,
          throughSeq: decision.throughSeq,
          messageCount: retiring.length,
          tokensBefore,
          error,
        })
        .catch(() => {
          /* 记账失败也不能打断任务 */
        })
      await this.#emit(input, 'compact.failed', {
        error,
        fromSeq,
        throughSeq: decision.throughSeq,
        // 说清后果，别让人以为任务要挂
        consequence: '历史照旧按 token 预算裁剪（会丢最旧的），任务继续',
      })
      return { compacted: false, decision, tokensBefore, error }
    }
  }

  /** attemptId 为 null（手动压缩）时不发事件 —— 持久记录在 compactions 表 */
  async #emit(
    input: { attemptId: string | null; runId: string | null },
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!input.attemptId || !input.runId) return
    await this.events.emit(input.attemptId, input.runId, kind, payload)
  }

  async #summarize(
    previous: ConversationSummary | null,
    retiring: ChatMessage[],
    chain: string[],
    attemptId: string | null,
    tokensBefore: number,
  ): Promise<{ summary: ConversationSummary; modelKey: string }> {
    const res = await this.router.chat(chain, {
      attemptId,
      messages: [{ role: 'user', content: buildCompactPrompt(previous, retiring) }],
      tools: [
        {
          name: 'submit_summary',
          description: '提交结构化摘要',
          parameters: summarySchema(),
        },
      ],
      // 强制走工具：要的是结构化产出，散文摘要恰好会丢掉要紧的部分
      toolChoice: { name: 'submit_summary' },
      maxTokens: this.opts.maxTokens ?? 2_000,
    })

    const call = res.toolCalls?.find((t) => t.name === 'submit_summary')
    if (!call) {
      throw new Error(`模型没有调用 submit_summary（${res.modelKey}）`)
    }
    // arguments 是 JSON 文本 —— 用与工具调用同一个宽容解析器，
    // 免得「参数不是合法 JSON」在这里变成一句看不懂的报错
    const parsed = parseArgs(call.arguments)
    if (!parsed.ok) throw new Error(`submit_summary ${parsed.error}`)

    const { summary, problems } = validateSummary(parsed.value, {
      tokensBefore,
      tokenizer: this.#tokenizer,
    })
    if (!summary) {
      throw new Error(problems.map((p) => `${p.field}: ${p.message}`).join('；'))
    }
    return { summary, modelKey: res.modelKey }
  }
}

/** `provider:model` —— 只切第一个冒号，模型名里可能还有 */
function splitKey(key: string): [string | null, string | null] {
  const i = key.indexOf(':')
  if (i < 0) return [null, key]
  return [key.slice(0, i), key.slice(i + 1)]
}
