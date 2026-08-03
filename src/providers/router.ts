import { NucleusError } from '../errors.js'
import type { Deps } from '../seams.js'
import type { Db } from '../db/types.js'
import { ProviderHealth, type ProviderEventSink } from './health.js'
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
/**
 * provider 层事件落库。
 *
 * 与 run_events 分开：熔断状态变化可能发生在 reconciler 里，与任何 run 无关；
 * 而「最近一小时 provider 出了什么问题」这个问题也不该按 run 去翻。
 */
class DbProviderEvents {
  constructor(
    private db: Db,
    private clock: Deps['clock'],
    private attemptId: string | null = null,
  ) {}

  async record(e: { key: string; kind: string; errorCode?: string | null; detail?: unknown }): Promise<void> {
    await this.db
      .query(
        `insert into provider_events (at, key, kind, error_code, run_attempt_id, detail)
         values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          this.clock.nowIso(),
          e.key,
          e.kind,
          e.errorCode ?? null,
          this.attemptId,
          JSON.stringify(e.detail ?? {}),
        ],
      )
      .catch(() => {
        /* 记录失败不该拖垮调用 —— 但错误本身仍会照常上抛 */
      })
  }
}

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
    opts: RouterOptions = {},
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

  /**
   * 这条链上**最大**的输出上限。
   *
   * 窗口取链上最小值（降级到小窗口模型时上下文还得放得进去），
   * 输出上限取**最大**值 —— 两个方向都保守。降级到一个配了更大 maxTokens 的
   * 模型时，如果按小的那个留余量，它一吐长就撞窗口。
   */
  maxOutputTokensFor(chain: string[], assumed: number): number {
    let max = 0
    for (const k of chain) max = Math.max(max, this.models.get(k)?.maxTokens ?? assumed)
    return max > 0 ? max : assumed
  }

  /** 逐次调用的用量明细 —— usage_log 建了从来没人写 */
  async #recordUsage(
    cfg: ModelConfig,
    res: { usage: { tokensIn: number; tokensOut: number; cacheRead: number } },
    req: { attemptId?: string | null },
  ): Promise<void> {
    await this.db
      .query(
        `insert into usage_log (run_attempt_id, provider, model, tokens_in, tokens_out, cache_read, cost_usd, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          req.attemptId ?? null,
          cfg.provider,
          cfg.model,
          res.usage.tokensIn,
          res.usage.tokensOut,
          res.usage.cacheRead,
          costOf(cfg, res.usage),
          this.deps.clock.nowIso(),
        ],
      )
      .catch(() => {
        /* 用量记录失败不该拖垮调用 */
      })
  }

  async chat(chainKeys: string[], req: Omit<ChatRequest, 'model'>): Promise<RouteResult> {
    const chain = chainKeys.map((k) => {
      const m = this.models.get(k)
      if (!m) throw new NucleusError('runtime.internal', `未知模型 ${k}`)
      return m
    })

    /**
     * mock 模型必须在**发请求之前**被拦住。
     *
     * `provider: 'mock'` 不是一个 provider 实现 —— 它只是一条 baseUrl 指向
     * `mock.invalid` 的普通配置，mock 性完全来自 boot 时换掉 fetch。
     * 所以没装 mock fetch 就直接去做 DNS 解析，结果是：
     *
     *   provider.unreachable · reason: getaddrinfo ENOTFOUND mock.invalid
     *   hint: 域名解析不了 —— 检查 baseUrl 拼写与 DNS
     *
     * 那条提示把人指向 baseUrl 和 DNS，而真正的原因是**还没配置任何真实模型**
     * （常见成因：从项目外的目录跑 nucleus，配置文件没被找到）。
     * 一个正确的报错指向错误的方向，比没有报错更费时间。
     */
    if (!this.#fetch && chain.every((m) => m.provider === 'mock')) {
      throw new NucleusError(
        'config.no_real_model',
        `模型链里只有 mock（${chainKeys.join(', ')}），而没有开 --mock —— 还没有可用的真实模型`,
        {
          detail: {
            chain: chainKeys,
            hint:
              '两种可能：① 确实没配模型 → 在 nucleus.config.json 里声明（见 nucleus.config.example.json）；' +
              '② 配了但没被读到 → 跑 nucleus doctor 看它报的配置文件路径',
          },
        },
      )
    }

    const events: ProviderEventSink = new DbProviderEvents(
      this.db,
      this.deps.clock,
      req.attemptId ?? null,
    )
    const attempts: Array<{ key: string; errorCode: string }> = []
    const tried = new Set<string>()
    let lastError: NucleusError | null = null

    for (;;) {
      const remaining = chain.filter((c) => !tried.has(c.key))
      if (remaining.length === 0) break

      const pick = await this.#health.pick(remaining)
      if (!('model' in pick)) {
        // 全链不可用是**最该被记下的那一次** —— 「429 打挂整条 fallback 链」
        // 就是这一条。以前只抛错不落库，于是事后只能看到 run 失败，
        // 看不到当时每个模型各自为什么不可用、几点恢复
        await events.record({
          key: chainKeys.join(','),
          kind: 'exhausted',
          errorCode: 'provider.all_exhausted',
          detail: {
            chain: chainKeys,
            earliestAvailableAt: pick.earliestAvailableAt?.toISOString() ?? null,
            perModel: pick.perModel.map((p) => ({
              key: p.key,
              reason: p.reason,
              availableAt: p.availableAt?.toISOString() ?? null,
            })),
          },
        })
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

      // 选路决策：选了谁、为什么，以及**被跳过的候选与原因**。
      // 后者以前只在全链失败时才有，于是「为什么用了链上第 3 个」答不出
      await events.record({
        key: cfg.key,
        kind: 'picked',
        detail: {
          reason: pick.reason,
          chain: chainKeys,
          skipped: pick.skipped.map((sk) => ({
            key: sk.key,
            reason: sk.reason,
            availableAt: sk.availableAt?.toISOString() ?? null,
          })),
        },
      })

      const startedAt = this.deps.clock.now()
      try {
        const res = await this.#callWithRetry(cfg, req)
        await this.#health.noteSuccess(cfg.key, res.rateLimit)
        await events.record({
          key: cfg.key,
          kind: 'ok',
          detail: {
            latencyMs: this.deps.clock.now() - startedAt,
            tokensIn: res.usage.tokensIn,
            tokensOut: res.usage.tokensOut,
            cacheRead: res.usage.cacheRead,
            // 学到的额度 —— 下次 preflight 的依据
            remainingRequests: res.rateLimit?.remainingRequests ?? null,
            resetAt: res.rateLimit?.resetAt ? new Date(res.rateLimit.resetAt).toISOString() : null,
          },
        })
        // 逐次调用的用量明细。usage_log 这张表建了从来没人写过，
        // 于是成本分析只能到 attempt 级聚合
        await this.#recordUsage(cfg, res, req)
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
        const before = await this.#health.get(cfg.key)
        await this.#health.noteFailure(cfg.key, err.code, {
          retryAfterMs: err.retryAfterMs,
        })
        const after = await this.#health.get(cfg.key)
        await events.record({
          key: cfg.key,
          kind: 'failed',
          errorCode: err.code,
          detail: {
            latencyMs: this.deps.clock.now() - startedAt,
            message: err.message.slice(0, 500),
            retryAfterMs: err.retryAfterMs ?? null,
            consecutiveErrors: after.consecutiveErrors,
            hint: (err.detail as { hint?: string } | undefined)?.hint ?? null,
          },
        })
        // 熔断状态变化单独记一条 —— 「什么时候打开的、因为什么、开到几点」
        if (before.breakerState !== after.breakerState) {
          await events.record({
            key: cfg.key,
            kind: `breaker.${after.breakerState}`,
            errorCode: err.code,
            detail: {
              from: before.breakerState,
              until: after.breakerUntil?.toISOString() ?? null,
              consecutiveErrors: after.consecutiveErrors,
            },
          })
        }
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
    // 模型自己的超时优先 —— 本地 31B 与云端模型不该共用一个值
    const timeoutMs = cfg.timeoutMs ?? this.#timeoutMs
    const provider: Provider =
      cfg.api === 'anthropic-messages'
        ? new AnthropicProvider(cfg, key, {
            clock: this.deps.clock,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          })
        : new OpenAICompatProvider(cfg, key, {
            clock: this.deps.clock,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          })

    let lastError: unknown
    for (let i = 0; i <= this.#retries; i++) {
      // 按 provider 记 —— rpm/tpm 是账号级限制，同 provider 的模型共用一个桶
      this.#health.noteRequest(cfg.provider)
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
