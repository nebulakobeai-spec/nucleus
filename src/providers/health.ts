import type { Db } from '../db/types.js'
import type { Clock } from '../seams.js'
import type { ModelConfig, RateLimitInfo } from './types.js'

export type BreakerState = 'closed' | 'open' | 'half_open'

export interface ModelHealth {
  key: string
  breakerState: BreakerState
  breakerUntil: Date | null
  remainingRequests: number | null
  remainingTokens: number | null
  quotaResetAt: Date | null
  consecutiveErrors: number
}

export interface PreflightPick {
  model: ModelConfig
  reason: string
  /**
   * 被跳过的候选及原因。
   *
   * 以前只在**全链失败**时才有这个信息，于是「为什么用了链上第 3 个」
   * 答不出来。选中时同样要记。
   */
  skipped: Array<{ key: string; reason: string; availableAt: Date | null }>
}

export interface PreflightUnavailable {
  /** 全链不可用时，最早可能恢复的时间 */
  earliestAvailableAt: Date | null
  perModel: Array<{ key: string; reason: string; availableAt: Date | null }>
}

export interface HealthOptions {
  /** 连续失败多少次后熔断 */
  errorThreshold?: number
  /** 熔断持续时间 */
  breakerMs?: number
  /** 令牌桶窗口 */
  windowMs?: number
}

/**
 * Provider 健康与选路。
 *
 * 核心是 **preflight：开始前一次性选出可用模型，而不是逐个试到成功**。
 * 逐个试的代价是每次失败都要等一个完整的超时/429，而且日志里看不出为什么慢。
 *
 * 现实前提：没有哪家提供可靠的「剩余额度」查询 API。所以是
 * **被动学习**（解析响应头 + 429）+ **本地令牌桶**（无响应头的家）。
 */
/**
 * provider 层事件的落点。
 *
 * 注入而不是让 ProviderHealth 直接写表：它同时被 router 与 reconciler 用，
 * 而后者的熔断状态变化与任何 run 都无关。
 */
export interface ProviderEventSink {
  record(e: {
    key: string
    kind: string
    errorCode?: string | null
    detail?: unknown
  }): Promise<void>
}

export class ProviderHealth {
  #errorThreshold: number
  #breakerMs: number
  #windowMs: number
  /** 本地令牌桶：无 rate-limit 响应头的家靠它 */
  #local = new Map<string, { reqTimes: number[]; tokens: number; windowStart: number }>()

  constructor(
    private db: Db,
    private clock: Clock,
    opts: HealthOptions = {},
  ) {
    this.#errorThreshold = opts.errorThreshold ?? 3
    this.#breakerMs = opts.breakerMs ?? 60_000
    this.#windowMs = opts.windowMs ?? 60_000
  }

  async get(key: string): Promise<ModelHealth> {
    const r = await this.db.query<{
      key: string
      breaker_state: BreakerState
      breaker_until: Date | null
      remaining_requests: number | null
      remaining_tokens: number | null
      quota_reset_at: Date | null
      consecutive_errors: number
    }>(`select * from provider_state where key = $1`, [key])
    const row = r.rows[0]
    if (!row) {
      return {
        key,
        breakerState: 'closed',
        breakerUntil: null,
        remainingRequests: null,
        remainingTokens: null,
        quotaResetAt: null,
        consecutiveErrors: 0,
      }
    }
    return {
      key: row.key,
      breakerState: row.breaker_state,
      breakerUntil: row.breaker_until,
      remainingRequests: row.remaining_requests,
      remainingTokens: row.remaining_tokens,
      quotaResetAt: row.quota_reset_at,
      consecutiveErrors: row.consecutive_errors,
    }
  }

  async all(): Promise<ModelHealth[]> {
    const r = await this.db.query(`select key from provider_state order by key`)
    return Promise.all(r.rows.map((x) => this.get((x as { key: string }).key)))
  }

  /**
   * Preflight：从 fallback 链中一次性选出可用模型。
   *
   * 打分维度：熔断状态 / 剩余额度 / 恢复时间 / 单价。
   * 全链不可用时返回「最早可用时间」，run 转 waiting_retry，**不浪费一次调用**。
   */
  async pick(chain: ModelConfig[]): Promise<PreflightPick | PreflightUnavailable> {
    const now = this.clock.now()
    const perModel: PreflightUnavailable['perModel'] = []
    const candidates: Array<{ cfg: ModelConfig; score: number; reason: string }> = []

    for (const cfg of chain) {
      const h = await this.get(cfg.key)

      if (h.breakerState === 'open' && h.breakerUntil && h.breakerUntil.getTime() > now) {
        perModel.push({ key: cfg.key, reason: '熔断中', availableAt: h.breakerUntil })
        continue
      }
      if (h.quotaResetAt && h.quotaResetAt.getTime() > now && h.remainingRequests === 0) {
        perModel.push({ key: cfg.key, reason: '额度用尽', availableAt: h.quotaResetAt })
        continue
      }
      const local = this.#localAvailability(cfg, now)
      if (!local.ok) {
        perModel.push({ key: cfg.key, reason: '本地限流', availableAt: local.availableAt })
        continue
      }

      // 分数越小越优先：链上顺序为主，剩余额度与单价为辅
      const order = chain.indexOf(cfg)
      const scarcity = h.remainingRequests === null ? 0 : h.remainingRequests < 5 ? 2 : 0
      const halfOpen = h.breakerState === 'half_open' ? 1 : 0
      candidates.push({
        cfg,
        score: order + scarcity + halfOpen,
        reason: halfOpen ? '半开探测' : '可用',
      })
    }

    if (candidates.length === 0) {
      const times = perModel.map((p) => p.availableAt?.getTime()).filter((t): t is number => !!t)
      return {
        earliestAvailableAt: times.length ? new Date(Math.min(...times)) : null,
        perModel,
      }
    }

    candidates.sort((a, b) => a.score - b.score)
    const best = candidates[0]!
    // 连同被跳过的原因一起返回 —— 「为什么用了链上第 3 个」要答得出
    return { model: best.cfg, reason: best.reason, skipped: perModel }
  }

  /** 本地令牌桶：给没有 rate-limit 响应头的 provider 兜底。 */
  #localAvailability(cfg: ModelConfig, now: number): { ok: boolean; availableAt: Date | null } {
    if (!cfg.rpm) return { ok: true, availableAt: null }
    const b = this.#local.get(cfg.key)
    if (!b) return { ok: true, availableAt: null }
    const cutoff = now - this.#windowMs
    const recent = b.reqTimes.filter((t) => t > cutoff)
    if (recent.length < cfg.rpm) return { ok: true, availableAt: null }
    const oldest = Math.min(...recent)
    return { ok: false, availableAt: new Date(oldest + this.#windowMs) }
  }

  /** 每次请求发出时记一笔，供本地令牌桶计数。 */
  noteRequest(key: string, tokens = 0): void {
    const now = this.clock.now()
    const b = this.#local.get(key) ?? { reqTimes: [], tokens: 0, windowStart: now }
    const cutoff = now - this.#windowMs
    b.reqTimes = b.reqTimes.filter((t) => t > cutoff)
    b.reqTimes.push(now)
    b.tokens += tokens
    this.#local.set(key, b)
  }

  /** 成功：清零错误计数，关闭熔断，写入学到的限流信息。 */
  async noteSuccess(key: string, rl?: RateLimitInfo): Promise<void> {
    await this.#upsert(key, {
      breaker_state: 'closed',
      breaker_until: null,
      consecutive_errors: 0,
      remaining_requests: rl?.remainingRequests ?? null,
      remaining_tokens: rl?.remainingTokens ?? null,
      quota_reset_at: rl?.resetAt ? new Date(rl.resetAt) : null,
    })
  }

  /**
   * 失败：累计错误，达阈值即熔断。
   *
   * `quota_exhausted` 直接熔断到额度恢复 —— 不需要再试探，试也是浪费。
   */
  async noteFailure(
    key: string,
    errorCode: string,
    opts: { retryAfterMs?: number | null; rateLimit?: RateLimitInfo } = {},
  ): Promise<void> {
    const now = this.clock.now()
    const cur = await this.get(key)

    if (errorCode === 'provider.quota_exhausted') {
      const until = opts.rateLimit?.resetAt ?? now + (opts.retryAfterMs ?? this.#breakerMs * 10)
      await this.#upsert(key, {
        breaker_state: 'open',
        breaker_until: new Date(until),
        quota_reset_at: new Date(until),
        remaining_requests: 0,
        consecutive_errors: cur.consecutiveErrors + 1,
      })
      return
    }

    if (errorCode === 'provider.auth_failed') {
      // 凭据错了，重试没有意义，熔断久一点等人来修
      await this.#upsert(key, {
        breaker_state: 'open',
        breaker_until: new Date(now + this.#breakerMs * 10),
        consecutive_errors: cur.consecutiveErrors + 1,
      })
      return
    }

    const errors = cur.consecutiveErrors + 1
    const shouldOpen = errors >= this.#errorThreshold
    await this.#upsert(key, {
      consecutive_errors: errors,
      breaker_state: shouldOpen ? 'open' : cur.breakerState,
      breaker_until: shouldOpen
        ? new Date(now + (opts.retryAfterMs ?? this.#breakerMs))
        : cur.breakerUntil,
    })
  }

  /** 熔断到期 → 半开，允许一次探测。 */
  async tickBreakers(): Promise<string[]> {
    const now = this.clock.nowIso()
    const r = await this.db.query<{ key: string }>(
      `update provider_state
          set breaker_state = 'half_open', updated_at = $1
        where breaker_state = 'open'
          and breaker_until is not null
          and breaker_until <= $1
        returning key`,
      [now],
    )
    return r.rows.map((x) => x.key)
  }

  async #upsert(key: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields)
    const vals = Object.values(fields)
    const placeholders = cols.map((_, i) => `$${i + 2}`)
    const updates = cols.map((c, i) => `${c} = $${i + 2}`)
    await this.db.query(
      `insert into provider_state (key, ${cols.join(', ')}, updated_at)
       values ($1, ${placeholders.join(', ')}, $${cols.length + 2})
       on conflict (key) do update set
         ${updates.join(', ')}, updated_at = $${cols.length + 2}`,
      [key, ...vals, this.clock.nowIso()],
    )
  }
}
