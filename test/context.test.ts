import { describe, expect, it } from 'vitest'
import {
  assemble,
  buildPrefix,
  buildTail,
  clampToTokens,
  DEFAULT_BUDGET,
  type AssembleInput,
} from '../src/context/assemble.js'
import { heuristicTokenizer as T, countMessage } from '../src/context/tokenizer.js'
import type { ChatMessage } from '../src/providers/types.js'
import {
  renderSummary,
  renderSummaryMinimal,
  type ConversationSummary,
} from '../src/context/compact.js'

const BASE: AssembleInput = {
  contract: '# 运行时契约\n你必须调用 submit_result 结束任务。',
  identity: '# Albert\n你是研究专家。',
  policy: '# 规则\n结论先行。',
  history: [],
  input: [{ role: 'user', content: '开始' }],
  budget: DEFAULT_BUDGET,
}

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })

// ═══════════════════════════════════════════════════════
// 强断言 #1：不可变前缀 byte-identical
// ═══════════════════════════════════════════════════════

describe('缓存前缀不可变', () => {
  it('跨回合、跨 run 状态变化，前缀逐字节相同', () => {
    const a = assemble(BASE)
    const b = assemble({
      ...BASE,
      // 所有会变的东西全都变一遍
      summary: '之前聊了很多',
      history: [msg('user', '第一轮'), msg('assistant', '回答')],
      constraints: ['脚本必须写入 scripts/', '结论先行'],
      input: [{ role: 'user', content: '完全不同的输入' }],
      facts: { version: 'v7', text: 'timezone=America/Los_Angeles' },
    })

    expect(b.prefix).toBe(a.prefix)
    expect(b.breakdown.prefix).toBe(a.breakdown.prefix)
    // 动态部分必须真的变了，否则上面那条断言没有意义
    expect(b.tail).not.toBe(a.tail)
    expect(b.messages.length).toBeGreaterThan(a.messages.length)
  })

  it('前缀只由 agent 定义决定，与 run 状态无关', () => {
    const p1 = buildPrefix(BASE)
    const p2 = buildPrefix({ contract: BASE.contract, identity: BASE.identity, policy: BASE.policy })
    expect(p1).toBe(p2)
  })

  it('前缀不含任何时间戳或随机 id —— 那会让缓存全部落空', () => {
    const { prefix } = assemble({
      ...BASE,
      facts: { version: '2026-07-30T12:00:00Z', text: 'x' },
      constraints: ['c'],
    })
    expect(prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(prefix).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
    // 事实快照带 as_of，所以它必须在前缀**之外**
    expect(prefix).not.toContain('as_of')
  })

  it('事实变更只影响第二段，不污染前缀', () => {
    const a = assemble({ ...BASE, facts: { version: 'v1', text: 'tz=A' } })
    const b = assemble({ ...BASE, facts: { version: 'v2', text: 'tz=B' } })
    expect(b.prefix).toBe(a.prefix)
    expect(b.breakdown.facts).not.toBe(0)
    expect(b.messages[0]!.content).not.toBe(a.messages[0]!.content) // system 整体变了
  })

  it('约束块位于消息序列末尾，在本回合输入之后', () => {
    const r = assemble({ ...BASE, constraints: ['结论先行'] })
    const last = r.messages[r.messages.length - 1]!
    expect(last.content).toBe(r.tail)
    expect(last.content).toContain('当前生效约束')
  })
})

// ═══════════════════════════════════════════════════════
// 强断言 #6：预算降级顺序
// ═══════════════════════════════════════════════════════

describe('预算降级顺序', () => {
  const tiny = {
    ...DEFAULT_BUDGET,
    contextWindow: 1_200,
    reserveForOutput: 200,
    maxHistoryTokens: 400,
    maxSummaryTokens: 100,
  }

  it('宽裕时不降级', () => {
    const r = assemble({ ...BASE, history: [msg('user', 'hi')], summary: '短摘要' })
    expect(r.degradations).toEqual([])
    expect(r.droppedMessages).toBe(0)
  })

  it('先裁历史，摘要与约束不动', () => {
    const history = Array.from({ length: 40 }, (_, i) => msg('user', `第 ${i} 轮对话的内容`.repeat(10)))
    const r = assemble({ ...BASE, budget: tiny, history, summary: '摘要', constraints: ['约束一'] })

    expect(r.degradations).toContain('trim_history')
    expect(r.degradations).not.toContain('drop_summary')
    expect(r.droppedMessages).toBeGreaterThan(0)
    expect(r.tail).toContain('约束一')
  })

  it('摘要超上限时先压缩而非丢弃', () => {
    const r = assemble({ ...BASE, budget: tiny, summary: '很长的摘要内容。'.repeat(200) })
    expect(r.degradations).toContain('shrink_summary')
    expect(r.degradations).not.toContain('drop_summary')
    expect(r.breakdown.summary).toBeLessThanOrEqual(tiny.maxSummaryTokens)
  })

  it('降级严格按顺序：裁历史 → 压摘要 → 丢摘要 → 收约束 → checkpoint', () => {
    const brutal = { ...tiny, contextWindow: 420, reserveForOutput: 60, maxHistoryTokens: 60 }
    const r = assemble({
      ...BASE,
      budget: brutal,
      summary: '摘要内容'.repeat(100),
      history: Array.from({ length: 20 }, (_, i) => msg('user', `轮次 ${i}`.repeat(20))),
      constraints: ['约束一', '约束二', '约束三'],
      input: [{ role: 'user', content: '本回合输入'.repeat(30) }],
    })

    const order = ['shrink_summary', 'trim_history', 'drop_summary', 'shrink_constraints', 'needs_checkpoint']
    const seen = r.degradations.filter((d) => order.includes(d))
    // 出现的降级必须是 order 的子序列 —— 顺序本身是被约束的行为
    let cursor = -1
    for (const d of seen) {
      const idx = order.indexOf(d)
      expect(idx).toBeGreaterThan(cursor)
      cursor = idx
    }
    expect(seen).toContain('trim_history')
  })

  it('实在放不下时标记 needs_checkpoint 而非静默截断输入', () => {
    const r = assemble({
      ...BASE,
      budget: { ...tiny, contextWindow: 300, reserveForOutput: 100 },
      input: [{ role: 'user', content: '超长输入'.repeat(200) }],
    })
    expect(r.degradations).toContain('needs_checkpoint')
    // 本回合输入永远不被丢弃
    expect(r.messages.some((m) => m.content.includes('超长输入'))).toBe(true)
  })

  it('约束块超上限时按条截断，不截断单条', () => {
    const tail = buildTail(['短的', '很长的一条约束'.repeat(50), '另一条短的'], T, 40)
    expect(tail).toContain('短的')
    expect(tail).not.toContain('很长的一条约束很长的一条约束')
    expect(T.count(tail)).toBeLessThanOrEqual(40)
  })

  it('breakdown 的各层之和等于 total', () => {
    const r = assemble({
      ...BASE,
      summary: '摘要',
      history: [msg('user', 'a'), msg('assistant', 'b')],
      constraints: ['c'],
      facts: { version: 'v1', text: 'f' },
    })
    const b = r.breakdown
    expect(b.prefix + b.facts + b.summary + b.history + b.constraints + b.input).toBe(b.total)
  })
})

// ═══════════════════════════════════════════════════════
// 历史裁剪的正确性：tool 消息不能成为孤儿
// ═══════════════════════════════════════════════════════

describe('历史裁剪', () => {
  it('保留最新的消息，丢弃最旧的', () => {
    const history = Array.from({ length: 10 }, (_, i) => msg('user', `第${i}条`))
    const r = assemble({
      ...BASE,
      budget: { ...DEFAULT_BUDGET, maxHistoryTokens: 30 },
      history,
    })
    const kept = r.messages.filter((m) => m.content.startsWith('第'))
    expect(kept.length).toBeLessThan(10)
    expect(kept[kept.length - 1]!.content).toBe('第9条')
  })

  it('不留下孤儿 tool 消息 —— provider 会拒绝这种请求', () => {
    const history: ChatMessage[] = [
      msg('user', '很长的第一轮'.repeat(50)),
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'search', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'search', content: '结果' },
      msg('assistant', '基于结果的回答'),
    ]
    const r = assemble({
      ...BASE,
      budget: { ...DEFAULT_BUDGET, maxHistoryTokens: 20 },
      history,
    })
    const kept = r.messages.filter((m) => m.role === 'tool' || m.toolCalls)
    // 要么 assistant+tool 成对保留，要么都不留
    const hasTool = kept.some((m) => m.role === 'tool')
    const hasCall = kept.some((m) => m.toolCalls?.length)
    expect(hasTool).toBe(hasCall)
  })

  it('不留下末尾悬空的 tool_calls —— 它的结果已被截断', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] },
    ]
    const r = assemble({ ...BASE, history, budget: { ...DEFAULT_BUDGET, maxHistoryTokens: 500 } })
    const dangling = r.messages.filter((m) => m.toolCalls?.length && !r.messages.some((x) => x.role === 'tool'))
    expect(dangling).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════
// tokenizer
// ═══════════════════════════════════════════════════════

describe('tokenizer', () => {
  it('中文约 1 token/字', () => {
    expect(T.count('你好世界')).toBeGreaterThanOrEqual(4)
    expect(T.count('你好世界')).toBeLessThanOrEqual(5)
  })

  it('英文约 3.5-4 字符/token', () => {
    const n = T.count('the quick brown fox jumps over the lazy dog')
    expect(n).toBeGreaterThan(8)
    expect(n).toBeLessThan(20)
  })

  it('倾向高估而非低估 —— 低估会导致超窗被拒', () => {
    // 混合文本：不应显著低于字符数的合理下界
    const text = '这是 mixed 中英文 content 的测试'
    expect(T.count(text)).toBeGreaterThanOrEqual(text.length / 3.5)
  })

  it('空字符串为 0', () => {
    expect(T.count('')).toBe(0)
  })

  it('消息计入 role 开销', () => {
    expect(countMessage(T, msg('user', 'hi'))).toBeGreaterThan(T.count('hi'))
  })

  it('clampToTokens 不超上限', () => {
    const long = '内容'.repeat(500)
    const out = clampToTokens(long, 50, T)
    expect(T.count(out)).toBeLessThanOrEqual(50)
    expect(long.startsWith(out)).toBe(true)
  })
})


// ═══════════════════════════════════════════════════════
// 降级顺序：摘要按段降级，而不是整个丢
// ═══════════════════════════════════════════════════════

describe('摘要的降级顺序', () => {
  const SUM: ConversationSummary = {
    constraints: ['不要有任何 default 模型', '规则要能被运行时强制'],
    decisions: ['判定与执行分离，因为判定要能单测'],
    open: ['GLM 的窗口大小还没确认'],
    artifacts: ['reports/x.md'],
    context: '在做一个多 agent 编排运行时，'.repeat(40),
  }

  /** 造一个「连历史全丢也放不下」的局面 */
  function tight(extra: Partial<AssembleInput> = {}) {
    return assemble({
      contract: '系统提示',
      identity: '',
      policy: '',
      history: [{ role: 'user', content: '历史'.repeat(200) }],
      input: [{ role: 'user', content: '本回合'.repeat(300) }],
      summary: renderSummary(SUM),
      budget: {
        contextWindow: 2_400,
        reserveForOutput: 1_000,
        maxConstraintTokens: 300,
        maxHistoryTokens: 40_000,
        maxSummaryTokens: 1_500,
      },
      ...extra,
    })
  }

  /**
   * **这条是这一组存在的理由。**
   *
   * 原来降级只有「整个丢掉摘要」一档，于是最缺预算时第一个被丢的就是
   * 用户约束 —— 而 compact 存在的唯一理由就是保住它们。自相矛盾。
   *
   * 摘要是结构化的，本来就能按段降级 —— 不用这一点就等于白结构化了。
   */
  it('给了最小形态时先降到只剩要求，不整个丢', () => {
    const r = tight({ summaryMinimal: renderSummaryMinimal(SUM) })
    expect(r.degradations).toContain('summary_to_constraints')
    expect(r.degradations).not.toContain('drop_summary')

    // 约束还在 context 里
    const text = r.messages.map((m) => m.content).join('\n')
    expect(text).toContain('不要有任何 default 模型')
    // 散文背景被丢了
    expect(text).not.toContain('多 agent 编排运行时')
  })

  it('没给最小形态时退回老行为（整个丢）—— 不能因此报错', () => {
    const r = tight()
    expect(r.degradations).toContain('drop_summary')
    expect(r.messages.map((m) => m.content).join('')).not.toContain('不要有任何 default 模型')
  })

  it('最小形态还是放不下时才整个丢', () => {
    const r = assemble({
      contract: '系统提示',
      identity: '',
      policy: '',
      history: [],
      input: [{ role: 'user', content: '本回合'.repeat(400) }],
      summary: renderSummary(SUM),
      summaryMinimal: renderSummaryMinimal(SUM),
      budget: {
        contextWindow: 1_300,
        reserveForOutput: 1_000,
        maxConstraintTokens: 300,
        maxHistoryTokens: 40_000,
        maxSummaryTokens: 1_500,
      },
    })
    expect(r.degradations).toContain('drop_summary')
  })

  it('预算够时两档都不触发', () => {
    const r = assemble({
      contract: '系统提示',
      identity: '',
      policy: '',
      history: [{ role: 'user', content: '一句话' }],
      input: [{ role: 'user', content: '问题' }],
      summary: renderSummary(SUM),
      summaryMinimal: renderSummaryMinimal(SUM),
      budget: { ...DEFAULT_BUDGET },
    })
    expect(r.degradations).not.toContain('summary_to_constraints')
    expect(r.degradations).not.toContain('drop_summary')
  })
})

describe('renderSummaryMinimal', () => {
  it('只留要求与未决，丢掉背景、决定、产出', () => {
    const text = renderSummaryMinimal({
      constraints: ['不要 X'],
      decisions: ['决定了 Y'],
      open: ['Z 没定'],
      artifacts: ['a.md'],
      context: '一大段背景',
    })
    expect(text).toContain('不要 X')
    expect(text).toContain('Z 没定')
    expect(text).not.toContain('决定了 Y')
    expect(text).not.toContain('一大段背景')
    expect(text).not.toContain('a.md')
  })

  it('标明「已进一步压缩」—— 模型该知道自己看到的是残缺版', () => {
    expect(renderSummaryMinimal({ constraints: ['不要 X'], decisions: [], open: [], artifacts: [], context: '' }))
      .toMatch(/已进一步压缩/)
  })

  /** 连约束都没有时返回空串，让上层直接走 drop —— 一个只有标题的摘要是纯浪费 */
  it('没有要求也没有未决时返回空串', () => {
    expect(
      renderSummaryMinimal({ constraints: [], decisions: ['x'], open: [], artifacts: [], context: 'y' }),
    ).toBe('')
  })
})

/**
 * ── 工具定义必须进预算 ──────────────────────────────
 *
 * 实测（最小配置：一个 ask_user 加上 submit_result 的结果 schema）：
 *
 *     修之前  total = 167
 *     修之后  total = 590   其中 tools = 423
 *
 * **少报了 3.5 倍**，而工具占了真实用量的七成 —— 不是零头。
 *
 * `nucleus chat` 显示的 `ctx 167/131K` 就是这个数，而 `decideCompact` 与
 * `needs_checkpoint`（「连本回合输入都放不进去」）也都读它。
 *
 * 装配器原先完全不知道工具存在：`available()` 减掉了前缀、事实、摘要、约束、
 * 本回合输入，**独独没有工具**。于是历史被允许填进工具占着的那块空间。
 * 131k 窗口下无害；而 ollama 的默认 num_ctx 常常只有 4096。
 *
 * **这一组之前是空的** —— 全套 998 条测试没有一条钉过这个总量，
 * 所以少报了一半也没人发现。
 */
describe('工具定义占的预算', () => {
  const TOOLS = [
    { name: 'delegate', description: '把一件事委派给专家'.repeat(20), parameters: { type: 'object' } },
    { name: 'ask_user', description: '向用户提一个问题'.repeat(20), parameters: { type: 'object' } },
  ]
  const base = {
    contract: '你是助手。',
    identity: '',
    policy: '',
    history: [{ role: 'user' as const, content: '你好' }],
    input: [],
    budget: DEFAULT_BUDGET,
  }

  it('breakdown 里有 tools 这一段，且计入 total', () => {
    const without = assemble(base)
    const withTools = assemble({ ...base, tools: TOOLS })

    expect(without.breakdown.tools).toBe(0)
    expect(withTools.breakdown.tools).toBeGreaterThan(50)
    expect(withTools.breakdown.total - without.breakdown.total).toBe(withTools.breakdown.tools)
  })

  /**
   * **这才是它值得修的原因。**
   *
   * 少算工具不只是显示偏小 —— 历史会填进那块空间，于是真正发出去的
   * 请求比装配器以为的大。窗口紧的时候就是超限，而症状是模型莫名其妙地
   * 看不见前面的消息。
   */
  it('窗口紧时，工具占掉的空间不再被历史填走', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: `第 ${i} 条消息，内容大概这么长，用来把预算填满。`,
    }))
    const tiny = { ...DEFAULT_BUDGET, contextWindow: 1200, reserveForOutput: 200, maxHistoryTokens: 900 }

    const without = assemble({ ...base, history: long, budget: tiny })
    const withTools = assemble({ ...base, history: long, budget: tiny, tools: TOOLS })

    // 工具占了空间 → 留给历史的更少
    expect(withTools.breakdown.history).toBeLessThan(without.breakdown.history)
    // 而两者都不该超出窗口
    expect(withTools.breakdown.total).toBeLessThanOrEqual(tiny.contextWindow - tiny.reserveForOutput)
  })

  /**
   * 工具**不可裁剪** —— 少给一个工具模型就用不了它，那不是降级而是能力缺失。
   * 所以它只从可用空间里扣掉，不参与任何降级档位。
   */
  it('工具不会被当成可降级的段', () => {
    const tiny = { ...DEFAULT_BUDGET, contextWindow: 700, reserveForOutput: 100 }
    const r = assemble({
      ...base,
      history: Array.from({ length: 30 }, () => ({ role: 'user' as const, content: '很长的一条消息'.repeat(5) })),
      budget: tiny,
      tools: TOOLS,
    })
    // 该降级的是历史 / 摘要 / 约束，不该有「砍工具」这一档
    expect(r.breakdown.tools).toBe(assemble({ ...base, tools: TOOLS }).breakdown.tools)
    expect(r.degradations).not.toContain('shrink_tools' as never)
  })

  it('空工具列表与不传是同一回事', () => {
    expect(assemble({ ...base, tools: [] }).breakdown.tools).toBe(0)
  })
})
