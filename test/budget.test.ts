import { describe, expect, it } from 'vitest'
import { contextBudgetFor, DEFAULT_SHAPE, describeBudget } from '../src/context/budget.js'

/**
 * 上下文预算必须**按模型算**。
 *
 * 原来是一组常量，其中 `maxHistoryTokens: 40_000` 与窗口无关：
 *
 *   | 窗口 | 历史预算 | 触发压缩 |
 *   |------|---------|---------|
 *   | 131k | 40k     | 28k     |
 *   | 500k | 40k     | 28k     |
 *   | 1M   | 40k     | 28k     |
 *
 * **1M 窗口的模型会在用掉 3% 的时候开始压缩** —— 每次压缩是一次模型调用
 * 加一次不可逆的信息损失，而窗口里还空着 97%。
 */

describe('contextBudgetFor', () => {
  /** 这一条是这个文件存在的理由 */
  it('历史预算随窗口线性增长，没有硬上限', () => {
    const small = contextBudgetFor(32_000, 4_096)
    const mid = contextBudgetFor(131_072, 8_192)
    const big = contextBudgetFor(1_048_576, 32_768)

    expect(mid.maxHistoryTokens).toBeGreaterThan(small.maxHistoryTokens * 3)
    expect(big.maxHistoryTokens).toBeGreaterThan(mid.maxHistoryTokens * 5)
    // 旧实现在这三种情况下都是 40000
    expect(big.maxHistoryTokens).toBeGreaterThan(400_000)
  })

  it('输出余量来自模型声明的 maxTokens，不是写死的 16k', () => {
    expect(contextBudgetFor(131_072, 8_192).reserveForOutput).toBe(
      Math.floor(8_192 * DEFAULT_SHAPE.outputMargin),
    )
    expect(contextBudgetFor(131_072, 32_768).reserveForOutput).toBe(
      Math.floor(32_768 * DEFAULT_SHAPE.outputMargin),
    )
  })

  /**
   * 小窗口模型上，写死的 16k 输出余量会吃掉 80% 的可用空间。
   * 所以余量有个「最多占窗口一半」的上限。
   */
  it('小窗口上输出余量不会吃光可用空间', () => {
    const b = contextBudgetFor(8_000, 32_768)
    expect(b.reserveForOutput).toBeLessThanOrEqual(4_000)
    expect(b.maxHistoryTokens).toBeGreaterThan(0)
  })

  it('模型没声明 maxTokens 时也留下限', () => {
    const b = contextBudgetFor(131_072, 0)
    expect(b.reserveForOutput).toBeGreaterThanOrEqual(DEFAULT_SHAPE.minReserve)
  })

  /**
   * 摘要与约束块按比例算但有上限：1M 窗口下让摘要涨到 80k 没有意义 ——
   * 摘要的价值在于短，长到那个程度不如直接放原文。
   */
  it('摘要与约束块有上限，不随窗口无限涨', () => {
    const big = contextBudgetFor(1_048_576, 32_768)
    expect(big.maxSummaryTokens).toBe(DEFAULT_SHAPE.maxSummary)
    expect(big.maxConstraintTokens).toBe(DEFAULT_SHAPE.maxConstraint)
  })

  it('摘要与约束块也有下限，小窗口上不至于归零', () => {
    const tiny = contextBudgetFor(4_000, 1_024)
    expect(tiny.maxSummaryTokens).toBeGreaterThan(0)
    expect(tiny.maxConstraintTokens).toBeGreaterThan(0)
  })

  it('各段加起来不超过窗口 —— 否则预算本身就是矛盾的', () => {
    for (const [w, out] of [
      [8_000, 2_048],
      [32_000, 4_096],
      [131_072, 8_192],
      [204_800, 16_384],
      [1_048_576, 32_768],
    ] as const) {
      const b = contextBudgetFor(w, out)
      const sum =
        b.reserveForOutput + b.maxHistoryTokens + b.maxSummaryTokens + b.maxConstraintTokens
      expect(sum, `窗口 ${w} 的各段之和超了`).toBeLessThanOrEqual(w)
    }
  })

  it('窗口极小时不产生负数', () => {
    const b = contextBudgetFor(500, 4_096)
    expect(b.reserveForOutput).toBeGreaterThan(0)
    expect(b.maxHistoryTokens).toBeGreaterThanOrEqual(0)
    expect(b.maxSummaryTokens).toBeGreaterThanOrEqual(0)
  })

  it('describeBudget 把来源摊出来 ——「为什么阈值是这个数」要能一眼看到', () => {
    const text = describeBudget(contextBudgetFor(131_072, 8_192))
    expect(text).toMatch(/窗口 131/)
    expect(text).toMatch(/输出留/)
    expect(text).toMatch(/历史/)
  })
})

describe('实际配置下的数字', () => {
  /**
   * 拿真实模型对一遍 —— 光有比例正确不够，得确认落到具体模型上是合理的。
   */
  it('gemma4:31b（131k / 8k 输出）', () => {
    const b = contextBudgetFor(131_072, 8_192)
    // 旧实现给 40000
    expect(b.maxHistoryTokens).toBeGreaterThan(80_000)
    console.log(`  gemma4:31b → ${describeBudget(b)}`)
  })

  it('1M 窗口的模型', () => {
    const b = contextBudgetFor(1_048_576, 32_768)
    console.log(`  1M 模型   → ${describeBudget(b)}`)
    // 触发压缩的历史量应该是几十万，不是 28k
    expect(Math.floor(b.maxHistoryTokens * 0.7)).toBeGreaterThan(400_000)
  })
})
