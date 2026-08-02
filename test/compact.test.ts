import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { Compactor } from '../src/runtime/compactor.js'
import { DbEventSink } from '../src/runtime/events.js'
import { checkConstraints, seedConversation } from '../src/cli/seed.js'
import {
  DEFAULT_COMPACT_POLICY,
  decideCompact,
  reconcileArtifacts,
  renderSummary,
  validateSummary,
  type ConversationSummary,
} from '../src/context/compact.js'
import type { MockScript } from '../src/providers/mock.js'
import type { FetchLike } from '../src/providers/openai-compat.js'
import type { ChatMessage } from '../src/providers/types.js'

/**
 * Compact。
 *
 * 之前的行为是超预算就**丢**最旧的消息；装配器降级顺序里的
 * shrink_summary / drop_summary 两档永远不会触发，因为没有代码产生摘要。
 *
 * 这一组盯的是「压缩本身会怎么骗人」：
 *  - 摘要没变短（那不是压缩）
 *  - 摘要是空的（消息白白退役了）
 *  - **用户提过的约束在第二代压缩时丢了** —— 真实故障形状是
 *    「模型又开始建议我加 default 模型」
 *  - 压缩失败把任务也带挂了
 *  - 被摘要覆盖的消息还逐条进 context（同一段内容占两份预算）
 */

const msg = (seq: number, role: 'user' | 'assistant', content: string) => ({
  seq,
  message: { role, content } as ChatMessage,
})

/** 造一批够长的消息，让 token 数超过阈值 */
function longMessages(n: number, chars = 400) {
  return Array.from({ length: n }, (_, i) =>
    msg(i + 1, i % 2 === 0 ? 'user' : 'assistant', `第 ${i + 1} 条。${'内容'.repeat(chars / 2)}`),
  )
}

describe('decideCompact（纯判定）', () => {
  it('消息太少就不压缩 —— 不值得一次模型调用', () => {
    const d = decideCompact({
      messages: longMessages(3),
      summaryThroughSeq: 0,
      historyBudget: 100,
    })
    expect(d.compact).toBe(false)
    expect(d.reason).toMatch(/不值得/)
  })

  it('没到阈值就不压缩，而且**把数字说出来**', () => {
    const d = decideCompact({
      messages: longMessages(20, 10),
      summaryThroughSeq: 0,
      historyBudget: 1_000_000,
    })
    expect(d.compact).toBe(false)
    // 「为什么没压缩」和「为什么压缩了」一样需要能回答
    expect(d.reason).toMatch(/未到阈值 \d+/)
  })

  it('超阈值就压缩，且保留最近 keepRecent 条原文', () => {
    const messages = longMessages(30)
    const d = decideCompact({ messages, summaryThroughSeq: 0, historyBudget: 2_000 })
    expect(d.compact).toBe(true)
    // 30 条留最近 10 条 → 退役前 20 条 → through_seq = 20
    expect(d.throughSeq).toBe(30 - DEFAULT_COMPACT_POLICY.keepRecent)
  })

  it('只看没被摘要覆盖的部分 —— 否则每轮都会重压一遍', () => {
    const messages = longMessages(30)
    const d = decideCompact({ messages, summaryThroughSeq: 25, historyBudget: 2_000 })
    // 只剩 5 条未摘要，低于 minMessages
    expect(d.compact).toBe(false)
    expect(d.reason).toMatch(/只有 5 条/)
  })

  /**
   * 「压缩也救不了」的真实形状：退役完之后，**留下的那几条本身**就超预算
   * （贴了一大段日志）。这时压缩会成功，但装配器仍然要裁剪 —— 必须说出来，
   * 否则人会以为压缩过就够了。
   *
   * 原来这里有个分支叫「单条消息过大，压缩无从下手」，但它的条件
   * `retireCount <= 0` 等价于 `fresh.length <= keepRecent` —— 纯粹是条数，
   * 与大小毫无关系。**那句话从来没描述过它自己的条件**，而且确实在一个
   * 4 条消息、40 tok 的会话上被打出来过。已删掉。
   */
  it('保留的消息本身就超预算时，压缩成功但明说仍会裁剪', () => {
    const messages = longMessages(20, 4000)
    const d = decideCompact({
      messages,
      summaryThroughSeq: 0,
      historyBudget: 500,
      policy: { triggerRatio: 0.7, keepRecent: 10, minMessages: 8 },
    })
    expect(d.compact).toBe(true)
    expect(d.reason).toMatch(/保留的 10 条本身就占 \d+ tok/)
    expect(d.reason).toMatch(/仍会裁剪/)
  })

  it('留下的部分放得进预算时不加那句提醒', () => {
    const messages = longMessages(20, 20)
    const d = decideCompact({
      messages,
      summaryThroughSeq: 0,
      historyBudget: 4_000,
      policy: { triggerRatio: 0.01, keepRecent: 10, minMessages: 8 },
    })
    expect(d.compact).toBe(true)
    expect(d.reason).not.toMatch(/仍会裁剪/)
  })

  /**
   * 这两种情况原来共用一句「单条消息过大，压缩无从下手」。
   * 实测在一个 4 条消息、总共 40 tok 的会话上也打出了那句话
   * （手动压缩把 triggerRatio 设成 0，token 阈值形同虚设）——
   * 40 tok 显然不是「单条过大」。**说错原因的诊断会把人带去改错的东西。**
   */
  it('消息数少于 keepRecent 时说的是「没有可退役的」，不是「单条过大」', () => {
    const messages = longMessages(4, 10)
    const d = decideCompact({
      messages,
      summaryThroughSeq: 0,
      historyBudget: 4_000,
      // 手动压缩用的那份策略
      policy: { triggerRatio: 0, keepRecent: 10, minMessages: 2 },
    })
    expect(d.compact).toBe(false)
    expect(d.reason).toMatch(/只有 4 条/)
    expect(d.reason).toMatch(/没有可退役的/)
    expect(d.reason).not.toMatch(/单条消息过大/)
    // 而且给出下一步
    expect(d.reason).toMatch(/--keep/)
  })
})

describe('renderSummary', () => {
  const s: ConversationSummary = {
    constraints: ['不要有任何 default 模型'],
    decisions: ['幂等键用计划时刻'],
    open: ['还没确认 GLM 的窗口大小'],
    artifacts: ['reports/调研.md'],
    context: '在做一个多 agent 编排运行时。',
  }

  it('约束排在最前面 —— context 靠前的位置注意力更高', () => {
    const text = renderSummary(s)
    const iConstraint = text.indexOf('不要有任何 default 模型')
    const iContext = text.indexOf('多 agent 编排运行时')
    expect(iConstraint).toBeGreaterThan(0)
    expect(iConstraint).toBeLessThan(iContext)
  })

  it('标明是有损压缩与第几代 —— 增量摘要会逐代失真', () => {
    expect(renderSummary(s, 3)).toMatch(/第 3 代压缩，内容有损/)
  })

  it('空的段落不渲染，不留空标题', () => {
    const text = renderSummary({ ...s, open: [], artifacts: [] })
    expect(text).not.toMatch(/悬而未决/)
    expect(text).not.toMatch(/已产出/)
  })
})

describe('validateSummary', () => {
  const good = {
    constraints: ['不要 X'],
    decisions: [],
    open: [],
    artifacts: [],
    context: '背景',
  }

  it('正常通过', () => {
    expect(validateSummary(good).summary).toMatchObject({ constraints: ['不要 X'] })
  })

  it('全空的摘要被拒 —— 那些消息会白白退役', () => {
    const { problems } = validateSummary({
      constraints: [],
      decisions: [],
      open: [],
      artifacts: [],
      context: '  ',
    })
    expect(problems[0]!.message).toMatch(/白白退役/)
  })

  it('**没变短就不是压缩**', () => {
    const { problems } = validateSummary(good, { tokensBefore: 3 })
    expect(problems.some((p) => /不是压缩/.test(p.message))).toBe(true)
  })

  it('变短了就放行', () => {
    expect(validateSummary(good, { tokensBefore: 100_000 }).summary).toBeTruthy()
  })

  it('空白项被过滤，不算内容', () => {
    const { summary } = validateSummary({ ...good, constraints: ['不要 X', '   ', ''] })
    expect(summary!.constraints).toEqual(['不要 X'])
  })

  it('类型不对时报出字段名', () => {
    const { problems } = validateSummary({ ...good, constraints: 'not an array' })
    expect(problems.some((p) => p.field === 'constraints')).toBe(true)
  })
})

// ── 端到端 ─────────────────────────────────────────────

const SCRIPT: MockScript = {
  orchestrator: Array.from({ length: 40 }, (_, i) => ({
    submit: { status: 'ok', summary: `第 ${i + 1} 轮回答。`, artifacts: [] },
  })),
}

function config(): NucleusConfig {
  const c = structuredClone(defaultConfig)
  c.defaults.modelChain = ['mock:local']
  // 用**真实配置路径**把窗口收窄，而不是给 worker 塞一个测试专用的预算参数：
  // 20k 窗口 - 16k 输出余量 = 4k 给历史，阈值 0.2 → 800 tok 就触发。
  // 这也顺带说明了 reserveForOutput 固定 16k 在小窗口模型上会吃掉大半预算
  c.defaults.assumedContextWindow = 20_000
  return c
}

let n: Nucleus

/** 压缩阈值调得很低，否则一个测试要灌几十轮才触发 */
const TEST_POLICY = { triggerRatio: 0.2, keepRecent: 4, minMessages: 6 }

beforeEach(async () => {
  n = await boot({
    config: config(),
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: SCRIPT,
    worker: { compactPolicy: TEST_POLICY },
  })
})

afterEach(async () => {
  await n.close()
  n = null as unknown as Nucleus
})

describe('端到端', () => {
  it('长会话会被压缩，并落账', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    for (let i = 0; i < 8; i++) {
      await ask(n, conv.id, `第 ${i + 1} 个问题。${'一些内容'.repeat(100)}`)
    }

    const after = await n.conversations.get(conv.id)
    expect(after!.summaryGeneration).toBeGreaterThan(0)
    expect(after!.summaryThroughSeq).toBeGreaterThan(0)

    const log = await n.conversations.compactions(conv.id)
    expect(log.length).toBeGreaterThan(0)
    expect(log[0]!.outcome).toBe('ok')
    // 压缩比要真的是压缩
    expect(log[0]!.tokensAfter).toBeLessThan(log[0]!.tokensBefore)
    expect(log[0]!.model).toBe('local')
    expect(log[0]!.provider).toBe('mock')
  })

  /**
   * 这条是整块的核心。真实故障形状是「模型忘了我三轮前说过不要用 default 模型，
   * 又开始建议我加」—— 散文摘要挡不住，因为它没有任何地方**必须**写下约束。
   */
  it('用户提过的约束活过压缩', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '不要有任何 default 模型，都要用户自己设置。')
    for (let i = 0; i < 7; i++) {
      await ask(n, conv.id, `继续第 ${i + 1} 步。${'一些内容'.repeat(100)}`)
    }

    const after = await n.conversations.get(conv.id)
    expect(after!.summaryGeneration).toBeGreaterThan(0)
    expect(after!.summary!.constraints.join(' ')).toMatch(/不要有任何 default 模型/)

    // 而且它进了渲染结果 —— 存下来但没注入等于没有
    expect(renderSummary(after!.summary!)).toMatch(/不要有任何 default 模型/)
  })

  /**
   * **第二代压缩必须继承第一代的约束。**
   *
   * 这是「模型忘了我三轮前说过什么」真正发生的地方：第一代摘要里有约束，
   * 但第二代压缩时如果只喂新退役的消息、不喂旧摘要，约束就在这一步蒸发了。
   * 而症状要到第五轮才显形，那时已经没人会想到是压缩的问题。
   */
  it('第二代压缩继承第一代的约束', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '不要有任何 default 模型，都要用户自己设置。')
    // 灌到至少压缩两次
    for (let i = 0; i < 20; i++) {
      await ask(n, conv.id, `继续第 ${i + 1} 步。${'一些内容'.repeat(100)}`)
    }

    const after = await n.conversations.get(conv.id)
    expect(after!.summaryGeneration).toBeGreaterThanOrEqual(2)
    // 那句话在第一代之后的每一代里都还在
    expect(after!.summary!.constraints.join(' ')).toMatch(/不要有任何 default 模型/)

    // 每一代的账里都能看到它 —— 哪一代丢的要能定位
    const log = await n.conversations.compactions(conv.id, 50)
    const ok = log.filter((x) => x.outcome === 'ok')
    expect(ok.length).toBeGreaterThanOrEqual(2)
    for (const entry of ok) {
      expect(entry.summary).toMatch(/default 模型/)
    }
  })

  it('压缩推进 through_seq，不会来回重压同一段', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    for (let i = 0; i < 20; i++) {
      await ask(n, conv.id, `问题 ${i + 1}。${'一些内容'.repeat(100)}`)
    }
    const log = await n.conversations.compactions(conv.id, 50)
    const ok = log.filter((x) => x.outcome === 'ok').reverse() // 按代数升序
    // through_seq 严格递增；from_seq 接着上一代的 through_seq
    for (let i = 1; i < ok.length; i++) {
      expect(ok[i]!.throughSeq).toBeGreaterThan(ok[i - 1]!.throughSeq)
      expect(ok[i]!.fromSeq).toBe(ok[i - 1]!.throughSeq + 1)
    }
  })

  it('被摘要覆盖的消息不再逐条进 context —— 否则占两份预算', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    for (let i = 0; i < 8; i++) {
      await ask(n, conv.id, `第 ${i + 1} 个问题。${'一些内容'.repeat(100)}`)
    }
    const after = await n.conversations.get(conv.id)
    const through = after!.summaryThroughSeq
    expect(through).toBeGreaterThan(0)

    // 最后一次 attempt 的 context 里，history 段应该只装了 through 之后的消息
    const ev = await n.db.query<{ payload: { breakdown: { summary: number; history: number } } }>(
      `select payload from run_events where kind = 'context.assembled' order by id desc limit 1`,
    )
    const bd = ev.rows[0]!.payload.breakdown
    // 摘要真的占了位置（说明注入生效了）
    expect(bd.summary).toBeGreaterThan(0)
  })

  it('事件流记下压缩，含压缩前后的 token', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    for (let i = 0; i < 8; i++) {
      await ask(n, conv.id, `问题 ${i + 1}。${'一些内容'.repeat(100)}`)
    }
    const ev = await n.db.query<{ kind: string; payload: Record<string, unknown> }>(
      `select kind, payload from run_events where kind like 'compact.%' order by id`,
    )
    const kinds = ev.rows.map((r) => r.kind)
    expect(kinds).toContain('compact.started')
    expect(kinds).toContain('compact.finished')
    const done = ev.rows.find((r) => r.kind === 'compact.finished')!
    expect(Number(done.payload['saved'])).toBeGreaterThan(0)
  })

  it('短会话不压缩 —— 不该为了压缩而多调一次模型', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '一个短问题')

    const after = await n.conversations.get(conv.id)
    expect(after!.summaryGeneration).toBe(0)
    expect(await n.conversations.compactions(conv.id)).toEqual([])
  })
})

describe('手动压缩（conv compact）', () => {
  /**
   * 自动压缩的阈值在大窗口模型上非常高：131k 窗口下要 28000 tokens 的历史
   * 才触发，也就是四五十轮。后果是**这条路径在真实使用中很久都不会被执行到**
   * —— 而没被执行过的路径不能算验证过。所以要有一个能立刻触发的入口。
   */
  it('triggerRatio: 0 时立刻压，但仍然保留最近 keepRecent 条', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '不要用任何 default 模型。')
    for (let i = 0; i < 4; i++) await ask(n, conv.id, `第 ${i + 1} 步`)

    const msgs = await n.conversations.recent(conv.id, 500)
    const compactor = new Compactor(n.conversations, n.runner.router, n.events, n.db, {
      policy: { triggerRatio: 0, keepRecent: 2, minMessages: 2 },
    })
    const r = await compactor.maybeCompact({
      conversationId: conv.id,
      messages: msgs,
      historyBudget: 40_000,
      modelChain: ['mock:local'],
      // 手动压缩不属于任何 attempt
      attemptId: null,
      runId: null,
    })

    expect(r.compacted).toBe(true)
    const after = await n.conversations.get(conv.id)
    // 保留最近 2 条：through_seq = 总数 - 2
    expect(after!.summaryThroughSeq).toBe(msgs.length - 2)
    expect(after!.summary!.constraints.join(' ')).toMatch(/不要用任何 default 模型/)
  })

  /**
   * 原来 attemptId 是必填，于是手动压缩只能借最近一个 attempt 来挂事件 ——
   * 直接撞 `unique(run_attempt_id, seq)`：DbEventSink 的 seq 计数器是**进程内**的，
   * 新进程往已有 attempt 写事件必然从 seq 1 开始。
   */
  it('attemptId 为 null 时不发事件，也不报错', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '一句话')
    for (let i = 0; i < 4; i++) await ask(n, conv.id, `第 ${i + 1} 步`)

    const before = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_events where kind like 'compact.%'`,
    )
    const compactor = new Compactor(n.conversations, n.runner.router, n.events, n.db, {
      policy: { triggerRatio: 0, keepRecent: 2, minMessages: 2 },
    })
    const r = await compactor.maybeCompact({
      conversationId: conv.id,
      messages: await n.conversations.recent(conv.id, 500),
      historyBudget: 40_000,
      modelChain: ['mock:local'],
      attemptId: null,
      runId: null,
    })

    expect(r.compacted).toBe(true)
    const after = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_events where kind like 'compact.%'`,
    )
    // 一条事件都没多 —— 持久记录在 compactions 表里，不依赖 run_events
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
    expect((await n.conversations.compactions(conv.id)).length).toBeGreaterThan(0)
  })
})

describe('reconcileArtifacts（核对声称的产出）', () => {
  /**
   * 实测踩到的：gemma4:31b 把 `DESIGN.md` 与 `agents/*.md` 写进了 artifacts。
   * 那是对话里顺口提到的文件名，不是这个系统登记过的产出。
   *
   * **是我的字段描述含糊，不是模型的错** —— 原文写的是「提到过的产出路径或
   * ref」，它照「提到过的路径」理解了。描述改清楚了，但光靠 prompt 不够：
   * 产出登记在 artifacts 表里，是可核对的事实。
   */
  it('对不上的被拿掉，并且报出来 —— 不静默丢弃', () => {
    const r = reconcileArtifacts(
      ['DESIGN.md', 'reports/调研.md', 'agents/*.md'],
      ['reports/调研.md', 'art_abc123'],
    )
    expect(r.kept).toEqual(['reports/调研.md'])
    expect(r.dropped).toEqual(['DESIGN.md', 'agents/*.md'])
  })

  it('ref 与路径都算 —— 模型写哪个都认', () => {
    const r = reconcileArtifacts(['art_abc123'], ['reports/x.md', 'art_abc123'])
    expect(r.kept).toEqual(['art_abc123'])
  })

  it('大小写与前后空白不影响匹配', () => {
    const r = reconcileArtifacts(['  Reports/X.md '], ['reports/x.md'])
    expect(r.kept).toEqual(['Reports/X.md'])
    expect(r.dropped).toEqual([])
  })

  it('声称为空时不做事', () => {
    expect(reconcileArtifacts([], ['a'])).toEqual({ kept: [], dropped: [] })
  })

  it('一个产出都没登记过时全部拿掉', () => {
    const r = reconcileArtifacts(['DESIGN.md', 'README.md'], [])
    expect(r.kept).toEqual([])
    expect(r.dropped).toHaveLength(2)
  })
})

describe('conv seed（合成历史）', () => {
  it('写入 N 轮，每轮一条 user + 一条 assistant', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const r = await seedConversation(n.conversations, conv.id, 15)
    expect(r.turns).toBe(15)
    expect(r.messages).toBe(30)
    expect((await n.conversations.recent(conv.id, 500)).length).toBe(30)
  })

  /**
   * 合成历史被当成真对话是很糟的事 —— 事后翻会话会以为自己真说过这些话。
   */
  it('每条都带 meta.synthetic —— 必须能和真对话区分开', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await seedConversation(n.conversations, conv.id, 4)
    const msgs = await n.conversations.recent(conv.id, 500)
    expect(msgs.every((m) => m.meta['synthetic'] === true)).toBe(true)
  })

  it('报出**实际埋进去的**约束 —— 轮数不够时不能列不存在的', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    // 约束在第 2 / 5 / 9 轮；只跑 6 轮 → 只有前两条
    const r = await seedConversation(n.conversations, conv.id, 6)
    expect(r.planted.map((p) => p.turn)).toEqual([2, 5])
  })

  it('约束消息带 constraint 标记，事后能还原对照清单', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await seedConversation(n.conversations, conv.id, 15)
    const msgs = await n.conversations.recent(conv.id, 500)
    const marked = msgs.filter((m) => m.meta['constraint'] === true)
    expect(marked.map((m) => m.meta['seedTurn'])).toEqual([2, 5, 9])
  })
})

describe('checkConstraints（筛查，不是判定）', () => {
  const planted = [
    { turn: 2, text: '不要有任何 default 模型', keywords: ['default', '模型'] },
    { turn: 5, text: '规则要能被运行时强制', keywords: ['运行时', '强制'] },
  ]

  it('关键词都在算活下来', () => {
    const r = checkConstraints(planted, '用户要求：不要 default 模型；规则由运行时强制执行')
    expect(r.map((x) => x.survived)).toEqual([true, true])
  })

  it('缺哪个词要报出来 —— 「丢了」得说清丢的是什么', () => {
    const r = checkConstraints(planted, '用户要求：不要 default 模型')
    expect(r[1]!.survived).toBe(false)
    expect(r[1]!.missing).toEqual(['运行时', '强制'])
  })

  /**
   * 这条钉住的是**这个检查的局限**：它查词不查意思。
   * 输出里必须说清这一点，否则「3 条都在」会被当成「压缩没问题」。
   */
  it('改写措辞会骗过它 —— 所以只能算筛查', () => {
    const r = checkConstraints(
      [{ turn: 1, text: '不要有任何 default 模型', keywords: ['default', '模型'] }],
      // 意思反了，但关键词都在
      '用户希望我们提供 default 模型清单',
    )
    expect(r[0]!.survived).toBe(true)
  })
})

describe('事件 seq 的跨进程安全', () => {
  /**
   * `DbEventSink` 的 seq 计数器是进程内的 Map，从 0 开始。这依赖一个没被任何
   * 东西强制的假设：一个 attempt 的事件只由一个进程写。不成立时就是
   * `duplicate key ... run_events_run_attempt_id_seq_key` 硬报错 ——
   * 而且报在与真正问题无关的地方（我第一次写手动压缩时就撞上了）。
   */
  it('新的 sink 往已有 attempt 写事件时从库里的最大值接着排', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '一句话')
    const attempts = await n.runs.listAttempts(runId)
    const a = attempts[0]!

    const existing = await n.db.query<{ n: number }>(
      `select max(seq)::int n from run_events where run_attempt_id = $1`,
      [a.id],
    )
    const maxSeq = existing.rows[0]!.n
    expect(maxSeq).toBeGreaterThan(0)

    // 全新的 sink，进程内计数器是空的
    const fresh = new DbEventSink(n.db, new FakeClock(), null)
    await fresh.emit(a.id, runId, 'test.marker', {})

    const after = await n.db.query<{ seq: number }>(
      `select seq from run_events where run_attempt_id = $1 and kind = 'test.marker'`,
      [a.id],
    )
    // 从 1 开始就会撞唯一约束
    expect(after.rows[0]!.seq).toBe(maxSeq + 1)
  })
})

describe('压缩失败不能拖垮任务', () => {
  /**
   * 压缩是一次锦上添花的模型调用：成功了 context 更省，失败了退回原来的行为
   * （装配器照常裁剪）。它绝不该让任务失败 —— 那是把一个优化变成一个故障源。
   */
  it('摘要调用挂掉时任务照样完成，且失败被记账', async () => {
    await n.close()
    // 让压缩那次调用返回一个不带 submit_summary 的回复
    n = await boot({
      config: config(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
      worker: { compactPolicy: TEST_POLICY },
      // 直接替掉 fetch：压缩请求认得出来（带 submit_summary 工具），
      // 给它一个「没调工具」的回复
      fetch: brokenCompactFetch(SCRIPT),
    })

    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    for (let i = 0; i < 8; i++) {
      await ask(n, conv.id, `问题 ${i + 1}。${'一些内容'.repeat(100)}`)
    }

    // 任务全都成功
    const runs = await n.db.query<{ status: string }>(`select status from runs`)
    expect(runs.rows.every((r) => r.status === 'succeeded')).toBe(true)

    // 但压缩失败留下了账 —— 「模型忘了我说过什么」的成因可能是压缩根本没成功，
    // 不留账的话这和「摘丢了」分不开
    const log = await n.conversations.compactions(conv.id)
    expect(log.some((x) => x.outcome === 'failed')).toBe(true)
    expect(log.find((x) => x.outcome === 'failed')!.summary).toMatch(/submit_summary/)

    // 摘要没生成，所以会话仍然是未压缩状态（退回老行为）
    const after = await n.conversations.get(conv.id)
    expect(after!.summaryGeneration).toBe(0)

    // 事件流要说清后果，别让人以为任务要挂
    const ev = await n.db.query<{ payload: Record<string, unknown> }>(
      `select payload from run_events where kind = 'compact.failed' limit 1`,
    )
    expect(String(ev.rows[0]!.payload['consequence'])).toMatch(/任务继续/)
  })
})

/** 正常回答走 mock 脚本，但压缩请求返回一个不调工具的回复 */
function brokenCompactFetch(script: MockScript): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(String(init.body)) as {
      tools?: Array<{ function?: { name?: string } }>
    }
    if (body.tools?.some((t) => t.function?.name === 'submit_summary')) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-broken',
          choices: [{ index: 0, message: { role: 'assistant', content: '我不想用工具' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const { mockProviderFetch } = await import('../src/providers/mock.js')
    return mockProviderFetch(script)(url, init)
  }
}
