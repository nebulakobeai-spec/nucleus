import type { Tokenizer } from './tokenizer.js'
import { heuristicTokenizer } from './tokenizer.js'

/**
 * 上下文预算 —— **全部按模型窗口与输出上限推导，不写死数字**。
 *
 * ── 为什么必须改 ──────────────────────────────────────
 *
 * 原来 `DEFAULT_BUDGET` 里是一组常量：`maxHistoryTokens: 40_000`、
 * `reserveForOutput: 16_000`。而 `historyBudgetFor()` 取
 * `min(40000, window - 16000)` —— 那个 40000 是**硬上限，与窗口无关**：
 *
 *   | 窗口 | 历史预算 | 触发压缩 |
 *   |------|---------|---------|
 *   | 131k | 40k     | 28k     |
 *   | 500k | 40k     | 28k     |
 *   | 1M   | 40k     | 28k     |
 *
 * **1M 窗口的模型会在用掉 3% 的时候开始压缩。** 每压一次是一次模型调用 +
 * 一次不可逆的信息损失，而窗口里还空着 97%。
 *
 * `reserveForOutput` 写死同样错：对 maxTokens=8192 的模型多留一倍，
 * 而在 20k 窗口的模型上它一个人吃掉 80% 的可用空间。它的正确来源是
 * **这条链上模型自己声明的输出上限** —— 那才是「模型可能吐多少」。
 *
 * ── 比例的取法 ────────────────────────────────────────
 *
 * 窗口要装下：前缀 + 事实 + 摘要 + 历史 + 约束块 + 本回合输入 + 输出余量。
 * 其中**历史是唯一有弹性的那段**，其余都由内容决定。所以：
 *
 *   reserve = 声明的输出上限 × 1.25（工具调用与格式开销）
 *   usable  = window − reserve
 *   历史    = usable × 0.7      ← 剩下 30% 给前缀 / 摘要 / 约束 / 本轮输入
 *
 * 摘要与约束块另有上下限：它们**按比例算但不该无限长**。1M 窗口下让摘要涨到
 * 80k 没有意义 —— 摘要的价值在于短，长到那个程度不如直接放原文。
 */

export interface ContextBudget {
  /** 模型窗口 */
  contextWindow: number
  /** 给输出留的余量 */
  reserveForOutput: number
  /** 末尾约束块上限 */
  maxConstraintTokens: number
  /** 历史消息上限 */
  maxHistoryTokens: number
  /** 摘要上限 */
  maxSummaryTokens: number
}

/** 各段占「可用空间」的比例与上下限。改这里等于改整套预算的形状。 */
export interface BudgetShape {
  /** 输出余量 = 声明的输出上限 × 这个系数（工具调用与格式开销） */
  outputMargin: number
  /** 输出余量的下限 —— 模型没声明 maxTokens 时也得留点 */
  minReserve: number
  /** 输出余量最多占窗口的多少 —— 否则小窗口模型会被它吃光 */
  maxReserveRatio: number
  /** 历史占可用空间的比例 */
  historyRatio: number
  /** 摘要：比例 + 上下限。长到一定程度就不如放原文了 */
  summaryRatio: number
  minSummary: number
  maxSummary: number
  /** 约束块：比例 + 上下限 */
  constraintRatio: number
  minConstraint: number
  maxConstraint: number
}

export const DEFAULT_SHAPE: BudgetShape = {
  outputMargin: 1.25,
  minReserve: 1_024,
  // 小窗口模型上，输出余量最多占一半 —— 再多就没有历史可言了
  maxReserveRatio: 0.5,
  historyRatio: 0.7,
  summaryRatio: 0.08,
  minSummary: 500,
  maxSummary: 8_000,
  constraintRatio: 0.02,
  minConstraint: 200,
  maxConstraint: 2_000,
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * 按模型算出这一轮的预算。
 *
 * @param contextWindow  链上**最小**窗口 —— attempt 中途可能降级到更小的模型
 * @param maxOutputTokens 链上**最大**输出上限 —— 两个方向都取保守值
 */
export function contextBudgetFor(
  contextWindow: number,
  maxOutputTokens: number,
  shape: BudgetShape = DEFAULT_SHAPE,
): ContextBudget {
  const reserveForOutput = Math.floor(
    clamp(
      maxOutputTokens * shape.outputMargin,
      shape.minReserve,
      Math.max(shape.minReserve, contextWindow * shape.maxReserveRatio),
    ),
  )
  const usable = Math.max(0, contextWindow - reserveForOutput)

  return {
    contextWindow,
    reserveForOutput,
    maxHistoryTokens: Math.floor(usable * shape.historyRatio),
    maxSummaryTokens: Math.floor(
      clamp(usable * shape.summaryRatio, Math.min(shape.minSummary, usable), shape.maxSummary),
    ),
    maxConstraintTokens: Math.floor(
      clamp(usable * shape.constraintRatio, Math.min(shape.minConstraint, usable), shape.maxConstraint),
    ),
  }
}

/**
 * 兜底预算 —— 只在真的不知道模型是谁时用（比如纯函数测试）。
 *
 * **不要在运行路径上用它。** 运行路径必须走 `contextBudgetFor`，
 * 否则又会回到「1M 窗口按 40k 算」那种状态。
 */
export const FALLBACK_BUDGET: ContextBudget = contextBudgetFor(128_000, 8_192)

/**
 * `ctx: 84.6K/131K (65%)` —— **这一轮实际发出去了多少 context**。
 *
 * 分母是模型窗口而不是历史预算：用户关心的是「离撞墙还有多远」，
 * 而历史预算只是窗口里分给历史那一份。用预算做分母会显示成
 * 「65%」而实际只用了窗口的 40% —— 那会让人以为快满了。
 *
 * 超过 90% 标红、超过 70% 标黄：这两条线不是随便定的 ——
 * 70% 是压缩的触发线附近（意味着「接下来会开始压」），
 * 90% 意味着「再长一点这一轮就装不下了」。
 */
export function formatCtx(
  usedTokens: number,
  contextWindow: number,
): { text: string; ratio: number; level: 'ok' | 'warn' | 'high' } {
  const ratio = contextWindow > 0 ? usedTokens / contextWindow : 0
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n))
  return {
    text: `ctx ${k(usedTokens)}/${k(contextWindow)} (${Math.round(ratio * 100)}%)`,
    ratio,
    level: ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'warn' : 'ok',
  }
}

/** 给人看的一行 */
export function describeBudget(b: ContextBudget, t: Tokenizer = heuristicTokenizer): string {
  void t
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return (
    `窗口 ${k(b.contextWindow)} · 输出留 ${k(b.reserveForOutput)} · ` +
    `历史 ${k(b.maxHistoryTokens)} · 摘要 ${k(b.maxSummaryTokens)} · 约束 ${k(b.maxConstraintTokens)}`
  )
}
