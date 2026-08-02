import type { ChatMessage } from '../providers/types.js'
import { countMessage, heuristicTokenizer, type Tokenizer } from './tokenizer.js'
import type { ContextBudget } from './budget.js'

/**
 * Context 装配（DESIGN.md §5）。
 *
 * 三段结构，**分段的唯一目的是保护 prompt cache**：
 *
 *   ① 不可变前缀   runtime 契约 / identity / 稳定 policy   ← byte-identical，永不变
 *   ② 版本化半静态 事实与长期偏好快照                      ← 仅内容变更时才变
 *   ③ 动态         摘要 / 近期消息 / 末尾约束块
 *
 * ① 中禁止出现时间戳、随机 id、步数、违规集合等任何随回合变化的东西 ——
 * 一旦混入，每回合前缀都不同，cache 全部落空（z.ai 的 cacheRead 与 input
 * 是 5 倍差价）。这条由强断言测试守护。
 */

export interface AssembleInput {
  /** ① 不可变前缀的组成部分 */
  contract: string
  identity: string
  policy: string

  /** ② 版本化半静态 */
  facts?: { version: string; text: string } | null

  /** ③ 动态 */
  summary?: string | null
  /**
   * 摘要的**最小形态**（只剩要求与未决）。
   *
   * 极端缺预算时用它替换完整摘要，而不是把摘要整个丢掉 ——
   * 后者会连用户约束一起丢。由调用方渲染（`renderSummaryMinimal`），
   * 装配器只按预算取舍，不懂摘要的内部结构。
   */
  summaryMinimal?: string | null
  /**
   * 会话历史，**按时间顺序传入（最旧的在前）**。
   *
   * 装配器从末尾往前填（即优先保留最新的），填不下就丢弃更旧的。
   * 顺序传反的后果是静默丢掉**最新**的消息 —— 不会报错，只会让模型
   * 看起来突然失忆，所以这条由测试钉住。
   */
  history: ChatMessage[]
  /** 末尾约束块（active constraints），已由规则层筛好 */
  constraints?: string[]
  /** 本回合输入 */
  input: ChatMessage[]

  budget: ContextBudget
  tokenizer?: Tokenizer
}

/**
 * 预算的定义与推导搬到了 `budget.ts` —— 因为它**必须按模型算**。
 *
 * 原来这里是一组常量，其中 `maxHistoryTokens: 40_000` 是与窗口无关的硬上限：
 * 1M 窗口的模型也只给 40k 历史，于是在用掉 3% 的时候就开始压缩。
 * 而每次压缩是一次模型调用加一次**不可逆的信息损失**。
 */
export { contextBudgetFor, type ContextBudget } from './budget.js'
/** 只在真的不知道模型是谁时用（纯函数测试）。运行路径必须走 contextBudgetFor */
export { FALLBACK_BUDGET as DEFAULT_BUDGET } from './budget.js'

/** 降级动作，按施加顺序记录 —— 顺序本身是被断言的行为 */
export type Degradation =
  | 'trim_history'
  | 'shrink_summary'
  /**
   * 摘要降到只剩「要求 + 未决」，丢掉散文背景与决定。
   *
   * 排在 `drop_summary` **之前**：整个丢掉摘要会连用户约束一起丢，
   * 而那正是 compact 想保住的东西。摘要是结构化的，所以能按段降级 ——
   * 不用它就等于白结构化了。
   */
  | 'summary_to_constraints'
  | 'drop_summary'
  | 'shrink_constraints'
  | 'needs_checkpoint'

export interface AssembledContext {
  messages: ChatMessage[]
  /** ① 的完整文本，用于断言 byte-identical */
  prefix: string
  /** ③ 末尾约束块文本 */
  tail: string
  breakdown: {
    prefix: number
    facts: number
    summary: number
    history: number
    constraints: number
    input: number
    total: number
  }
  /** 实际施加的降级，按顺序 */
  degradations: Degradation[]
  /** 被丢弃的历史消息条数 */
  droppedMessages: number
}

const FACTS_HEADER = '## 已知事实'
const CONSTRAINTS_HEADER = '## 当前生效约束'

/** ① 不可变前缀。**只依赖 agent 定义，不依赖任何 run 状态。** */
export function buildPrefix(input: Pick<AssembleInput, 'contract' | 'identity' | 'policy'>): string {
  return [input.contract, input.identity, input.policy]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** ③ 末尾约束块。每回合重算，位于最后，不影响前面的缓存前缀。 */
export function buildTail(constraints: string[], t: Tokenizer, maxTokens: number): string {
  if (constraints.length === 0) return ''
  const lines: string[] = []
  let used = t.count(CONSTRAINTS_HEADER)
  for (const c of constraints) {
    const line = `- ${c}`
    const cost = t.count(line) + 1
    if (used + cost > maxTokens) break
    lines.push(line)
    used += cost
  }
  return lines.length ? `${CONSTRAINTS_HEADER}\n${lines.join('\n')}` : ''
}

/**
 * 装配。
 *
 * 超预算时按**固定顺序**降级，不靠模型「注意简洁」：
 *   1. 裁剪历史（从最旧的丢）
 *   2. 压缩摘要
 *   3. 丢弃摘要
 *   4. 收缩约束块
 *   5. 仍然超 → 标记 needs_checkpoint，由上层触发续跑
 */
export function assemble(input: AssembleInput): AssembledContext {
  const t = input.tokenizer ?? heuristicTokenizer
  const b = input.budget
  const degradations: Degradation[] = []

  const prefix = buildPrefix(input)
  const prefixTokens = t.count(prefix)

  const factsText = input.facts ? `${FACTS_HEADER}（as_of ${input.facts.version}）\n${input.facts.text}` : ''
  const factsTokens = factsText ? t.count(factsText) : 0

  const inputTokens = input.input.reduce((n, m) => n + countMessage(t, m), 0)

  let constraints = input.constraints ?? []
  let tail = buildTail(constraints, t, b.maxConstraintTokens)
  let constraintTokens = tail ? t.count(tail) : 0

  let summary = input.summary ?? ''
  let summaryTokens = summary ? t.count(summary) : 0
  if (summaryTokens > b.maxSummaryTokens) {
    summary = clampToTokens(summary, b.maxSummaryTokens, t)
    summaryTokens = t.count(summary)
    degradations.push('shrink_summary')
  }

  // 历史：从最新往旧填，填不下就丢弃更旧的
  const available = () =>
    b.contextWindow -
    b.reserveForOutput -
    prefixTokens -
    factsTokens -
    summaryTokens -
    constraintTokens -
    inputTokens

  const historyCap = Math.min(b.maxHistoryTokens, Math.max(0, available()))
  const { kept, dropped, tokens: historyTokens } = fillHistory(input.history, historyCap, t)
  if (dropped > 0) degradations.push('trim_history')

  /**
   * 历史全丢了还不够 → 依次牺牲摘要、约束。
   *
   * **先降到最小形态，再整个丢。** 原来只有「整个丢」一档，于是最缺预算时
   * 第一个被丢的就是用户约束 —— 而 compact 存在的理由就是保住它们。
   */
  if (available() - historyTokens < 0 && summaryTokens > 0 && input.summaryMinimal) {
    const minimal = input.summaryMinimal
    const minimalTokens = t.count(minimal)
    if (minimalTokens < summaryTokens) {
      summary = minimal
      summaryTokens = minimalTokens
      degradations.push('summary_to_constraints')
    }
  }
  if (available() - historyTokens < 0 && summaryTokens > 0) {
    summary = ''
    summaryTokens = 0
    degradations.push('drop_summary')
  }
  if (available() - historyTokens < 0 && constraintTokens > 0) {
    const shrunk = Math.floor(b.maxConstraintTokens / 2)
    tail = buildTail(constraints, t, shrunk)
    constraintTokens = tail ? t.count(tail) : 0
    degradations.push('shrink_constraints')
  }
  if (available() - historyTokens < 0) {
    // 连本回合输入都放不下 —— 靠裁剪救不回来了
    degradations.push('needs_checkpoint')
  }

  const system = [prefix, factsText].filter(Boolean).join('\n\n')
  const messages: ChatMessage[] = [{ role: 'system', content: system }]
  if (summary) messages.push({ role: 'system', content: `## 此前对话摘要\n${summary}` })
  messages.push(...kept)
  messages.push(...input.input)
  if (tail) messages.push({ role: 'system', content: tail })

  return {
    messages,
    prefix,
    tail,
    breakdown: {
      prefix: prefixTokens,
      facts: factsTokens,
      summary: summaryTokens,
      history: historyTokens,
      constraints: constraintTokens,
      input: inputTokens,
      total: prefixTokens + factsTokens + summaryTokens + historyTokens + constraintTokens + inputTokens,
    },
    degradations,
    droppedMessages: dropped,
  }
}

/**
 * 从最新往旧填历史。
 *
 * 关键约束：**tool 消息不能与它的 assistant 调用分离** ——
 * 只有 tool 结果而没有对应的 tool_calls，provider 会直接拒绝请求。
 */
function fillHistory(
  history: ChatMessage[],
  cap: number,
  t: Tokenizer,
): { kept: ChatMessage[]; dropped: number; tokens: number } {
  if (cap <= 0) return { kept: [], dropped: history.length, tokens: 0 }

  const kept: ChatMessage[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    const cost = countMessage(t, m)
    if (used + cost > cap) break
    kept.push(m)
    used += cost
  }
  kept.reverse()

  // 修剪开头：丢掉孤儿 tool 消息，以及尾随的、其 tool 结果已被截断的 assistant 调用
  while (kept.length && kept[0]!.role === 'tool') {
    used -= countMessage(t, kept.shift()!)
  }
  const last = kept[kept.length - 1]
  if (last?.role === 'assistant' && last.toolCalls?.length) {
    used -= countMessage(t, kept.pop()!)
  }

  return { kept, dropped: history.length - kept.length, tokens: used }
}

/** 按 token 上限截断文本，保留头部 */
export function clampToTokens(text: string, maxTokens: number, t: Tokenizer): string {
  if (t.count(text) <= maxTokens) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (t.count(text.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}
