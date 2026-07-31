import { NucleusError } from '../errors.js'
import type { Deps } from '../seams.js'
import type { Db } from '../db/types.js'
import { ProviderHealth } from './health.js'
import { OpenAICompatProvider, type FetchLike } from './openai-compat.js'
import { AnthropicProvider } from './anthropic.js'
import { costOf, type ChatRequest, type ChatResponse, type ModelConfig, type Provider } from './types.js'

export interface RouterOptions {
  fetch?: FetchLike
  timeoutMs?: number
  /** 同一模型上的就地重试次数（可重试错误） */
  inPlaceRetries?: number
  /** 退化检测：滑窗内同一 n-gram 重复多少次即判定 */
  degenerate?: { ngram: number; threshold: number } | false
}

export interface RouteResult extends ChatResponse {
  /** 实际使用的模型 key */
  modelKey: string
  costUsd: number
  /** 本次为切换模型付出的失败尝试 */
  attempts: Array<{ key: string; errorCode: string }>
}

/**
 * 模型路由：preflight 选路 → 调用 → 学习限流 → 失败切换。
 *
 * 与「逐个试到成功」的区别：**先根据已知健康状态选，不拿失败当探测手段**。
 * 全链不可用时抛 `provider.all_exhausted` 并带上最早可用时间，
 * 由上层把 run 转成 waiting_retry，不浪费调用。
 */
export class ModelRouter {
  #health: ProviderHealth
  #fetch: FetchLike | undefined
  #timeoutMs: number | undefined
  #retries: number
  #degenerate: { ngram: number; threshold: number } | false

  constructor(
    private db: Db,
    private deps: Deps,
    private models: Map<string, ModelConfig>,
    private secrets: (ref: string | undefined) => string | null,
    private opts: RouterOptions = {},
  ) {
    this.#health = new ProviderHealth(db, deps.clock)
    this.#fetch = opts.fetch
    this.#timeoutMs = opts.timeoutMs
    this.#retries = opts.inPlaceRetries ?? 1
    this.#degenerate = opts.degenerate ?? { ngram: 12, threshold: 4 }
  }

  get health(): ProviderHealth {
    return this.#health
  }

  /**
   * 按 fallback 链执行一次对话。
   *
   * @param chainKeys 形如 ['zai:glm-4.7', 'kimi:k2', 'ollama:llama3.2']
   */
  /**
   * 一条降级链能安全使用的上下文窗口。
   *
   * 取**链上最小**的那个，不是第一个 —— attempt 中途可能降级到窗口更小的
   * 模型，按第一个模型的窗口装配的上下文到那时就放不进去了。
   *
   * 未声明窗口的模型按 `assumed` 计（见 defaults.assumedContextWindow）。
   */
  contextWindowFor(chain: string[], assumed: number): number {
    let min = Infinity
    for (const k of chain) {
      min = Math.min(min, this.models.get(k)?.contextWindow ?? assumed)
    }
    return Number.isFinite(min) ? min : assumed
  }

  async chat(chainKeys: string[], req: Omit<ChatRequest, 'model'>): Promise<RouteResult> {
    const chain = chainKeys.map((k) => {
      const m = this.models.get(k)
      if (!m) throw new NucleusError('runtime.internal', `未知模型 ${k}`)
      return m
    })

    const attempts: Array<{ key: string; errorCode: string }> = []
    const tried = new Set<string>()
    let lastError: NucleusError | null = null

    for (;;) {
      const remaining = chain.filter((c) => !tried.has(c.key))
      if (remaining.length === 0) break

      const pick = await this.#health.pick(remaining)
      if (!('model' in pick)) {
        throw new NucleusError('provider.all_exhausted', '所有模型都不可用', {
          detail: {
            earliestAvailableAt: pick.earliestAvailableAt?.toISOString() ?? null,
            perModel: pick.perModel.map((p) => ({
              key: p.key,
              reason: p.reason,
              availableAt: p.availableAt?.toISOString() ?? null,
            })),
          },
          retryAfterMs: pick.earliestAvailableAt
            ? Math.max(0, pick.earliestAvailableAt.getTime() - this.deps.clock.now())
            : null,
        })
      }

      const cfg = pick.model
      tried.add(cfg.key)

      try {
        const res = await this.#callWithRetry(cfg, req)
        await this.#health.noteSuccess(cfg.key, res.rateLimit)
        return {
          ...res,
          modelKey: cfg.key,
          costUsd: costOf(cfg, res.usage),
          attempts,
        }
      } catch (e) {
        const err = e instanceof NucleusError ? e : new NucleusError('provider.server_error', String(e), { cause: e })
        // 取消不是 provider 的问题，直接上抛
        if (err.code === 'runtime.cancelled') throw err
        lastError = err
        await this.#health.noteFailure(cfg.key, err.code, {
          retryAfterMs: err.retryAfterMs,
        })
        attempts.push({ key: cfg.key, errorCode: err.code })
        if (err.code === 'provider.bad_request') throw err // 换模型也没用
      }
    }

    // 保留最后一个真实错误的 code、消息与 detail —— 否则根因被 all_exhausted
    // 吞掉，排查时只能看到「所有模型都失败」这种没有信息量的消息。
    throw new NucleusError(
      lastError?.code ?? 'provider.all_exhausted',
      lastError ? `链上所有模型均失败：${lastError.message}` : '链上所有模型均失败',
      {
        detail: { attempts, lastError: lastError?.detail },
        cause: lastError,
      },
    )
  }

  /** 同一模型上的就地重试：只对可重试错误，按 retry-after 退避。 */
  async #callWithRetry(cfg: ModelConfig, req: Omit<ChatRequest, 'model'>): Promise<ChatResponse> {
    const key = this.secrets(cfg.apiKeyRef)
    // 按线路协议分派：Kimi coding 端点与 Anthropic 官方 API 不是 OpenAI 兼容形态
    const provider: Provider =
      cfg.api === 'anthropic-messages'
        ? new AnthropicProvider(cfg, key, {
            clock: this.deps.clock,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
            ...(this.#timeoutMs ? { timeoutMs: this.#timeoutMs } : {}),
          })
        : new OpenAICompatProvider(cfg, key, {
            clock: this.deps.clock,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
            ...(this.#timeoutMs ? { timeoutMs: this.#timeoutMs } : {}),
          })

    let lastError: unknown
    for (let i = 0; i <= this.#retries; i++) {
      this.#health.noteRequest(cfg.key)
      try {
        const res = await provider.chat({ ...req, model: cfg.model })
        this.#assertNotDegenerate(res)
        return res
      } catch (e) {
        lastError = e
        const err = e instanceof NucleusError ? e : null
        if (!err?.retryable || i === this.#retries) throw e
        const wait = err.retryAfterMs ?? 500 * 2 ** i
        await this.deps.clock.sleep(wait, req.signal)
      }
    }
    throw lastError
  }

  /**
   * 退化检测：模型陷入重复输出。
   *
   * 观察到 GLM/Kimi 在长 context + 低温度下会一直重复同一段话。
   * 这通常是模型端的采样退化，但平台把重复输出又喂回去会自我强化 ——
   * 所以在这里截断，并让上层换 provider 重试。
   */
  #assertNotDegenerate(res: ChatResponse): void {
    if (!this.#degenerate) return
    const { ngram, threshold } = this.#degenerate
    if (detectRepetition(res.content, ngram, threshold)) {
      throw new NucleusError('provider.degenerate_output', '模型输出出现高频重复，已中断', {
        detail: { sample: res.content.slice(0, 200), length: res.content.length },
      })
    }
  }
}

/**
 * 滑窗 n-gram 重复检测。
 *
 * 按字符切 n-gram（对中英文都适用），任一 n-gram 出现次数达到阈值即判退化。
 * 对正常文本足够宽松：阈值默认 4 次相同 12 字窗口。
 */
export function detectRepetition(text: string, n = 12, threshold = 4): boolean {
  if (text.length < n * threshold) return false
  const seen = new Map<string, number>()
  for (let i = 0; i + n <= text.length; i++) {
    const g = text.slice(i, i + n)
    const c = (seen.get(g) ?? 0) + 1
    if (c >= threshold) return true
    seen.set(g, c)
  }
  return false
}
