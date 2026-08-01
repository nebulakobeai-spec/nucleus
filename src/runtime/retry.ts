import { errorSpec, recoveryOf } from '../errors.js'

/**
 * run 级重试的决策。
 *
 * ── 为什么这块之前是空的，以及为什么它是最大的可靠性洞 ──────────
 *
 * 真正的重试只发生在**一次 `chat()` 内部**：就地重试 + 模型链降级。
 * attempt 一旦失败，run 直接落 terminal `failed`，队列是空的，
 * 没有任何东西会再碰它。而 `recovery: 'automatic'` 的错误在界面上却显示
 * 「系统会自动重试」——**那句话是假的**。
 *
 * 后果就是最初要修的那类问题：四个模型同时被限流 → 整条链 exhausted →
 * run 死掉 → 得重新发一遍。而 `provider_events` 里明明写着「等到
 * 18:38:58 就恢复了」，系统却不会等。
 *
 * `runStatusOverride`（注释写着「failed 但还要重试 → waiting_retry」）与
 * `run_queue.available_at` 早就存在 —— 缺的只是这个决策。
 *
 * ── 判据 ───────────────────────────────────────────────
 *
 * 两种情况值得重试：
 *  1. 错误声明了 `runRetryable`（限流、额度、服务端错误、超时、全链不可用）——
 *     注意这与 `retryable`（就地重试，让模型重写）**不是一回事**
 *  2. 错误带了 `retryAfterMs` —— 我们**知道**什么时候回来。
 *     `all_exhausted` 属于这类：它本身标成 needs_user，但携带最早可用时间，
 *     而 DESIGN.md §7 明确要求「由上层把 run 转成 waiting_retry，不浪费调用」
 *
 * 不重试的：契约反复不过（换次数解决不了）、能力边界拒绝、取消、
 * 配置错误、连不上（要人去启动服务或改 baseUrl）。
 */

export interface RetryDecision {
  retry: boolean
  /** 等多久再试。已经含 retryAfterMs 与退避的较大者 */
  delayMs: number
  /** 给事件流与界面的一句话 */
  reason: string
}

export interface RetryPolicy {
  /** 一个 run 最多几次 attempt（含首次） */
  maxAttempts: number
  /** 退避基数 */
  baseMs: number
  /** 退避上限 —— 等一小时不如报给人 */
  capMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseMs: 2_000,
  capMs: 5 * 60_000,
}

/**
 * 指数退避，**不加抖动**。
 *
 * 抖动是为了防惊群，而这是单用户本地系统 —— 没有惊群。
 * 换来的是可测：同样的输入总是同样的延迟，测试不必容忍范围。
 */
export function backoffMs(attemptNo: number, policy: RetryPolicy): number {
  const exp = policy.baseMs * 2 ** Math.max(0, attemptNo - 1)
  return Math.min(policy.capMs, exp)
}

export function decideRetry(input: {
  errorCode: string
  /** provider 报的「什么时候能再来」 */
  retryAfterMs?: number | null
  /** 刚失败的这次是第几次 */
  attemptNo: number
  policy?: RetryPolicy
}): RetryDecision {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY
  const spec = errorSpec(input.errorCode)
  const after = input.retryAfterMs ?? null

  // 知道什么时候回来 → 值得等，即便错误本身标成 needs_user。
  // all_exhausted 就是这一类：链上全在熔断，但最早可用时间是确定的
  const knowsWhen = after !== null && after > 0
  // 用 runRetryable 而不是 retryable —— 后者是「就地可重试」（让模型重写），
  // 两者混用会把「模型答不对」变成「任务反复重跑，只是慢四倍」
  const retryable = spec?.runRetryable === true

  if (!retryable && !knowsWhen) {
    return {
      retry: false,
      delayMs: 0,
      reason: `${input.errorCode} 不可重试（${recoveryOf(input.errorCode) ?? '未知恢复性'}）`,
    }
  }

  if (input.attemptNo >= policy.maxAttempts) {
    return {
      retry: false,
      delayMs: 0,
      reason: `已重试 ${input.attemptNo} 次，达到上限 ${policy.maxAttempts}`,
    }
  }

  /**
   * provider 说的时间**不受退避上限约束**。
   *
   * `min(cap, max(backoff, after))` 是错的：额度一小时后才重置，而 cap 是
   * 5 分钟的话，我们会在 5 分钟后去撞一扇关着的门，然后把 attempt 预算烧完
   * ——「白等 15 分钟然后失败」比「等一小时然后成功」差得多。
   *
   * 上限只约束**我们自己猜的**退避；对方明确告知的时间就照它等。
   * 代价是任务可能静静躺很久，所以 waiting_retry 与「等到几点」必须可见
   * （事件流 + run 状态 + 终端）。
   */
  const delayMs = knowsWhen ? after! : Math.min(policy.capMs, backoffMs(input.attemptNo, policy))
  return {
    retry: true,
    delayMs,
    reason: knowsWhen
      ? `${input.errorCode}，provider 报 ${Math.round(delayMs / 1000)}s 后可用`
      : `${input.errorCode} 可重试，退避 ${Math.round(delayMs / 1000)}s`,
  }
}
