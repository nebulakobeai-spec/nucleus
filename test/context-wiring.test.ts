import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { assemble, DEFAULT_BUDGET } from '../src/context/assemble.js'
import type { ChatMessage } from '../src/providers/types.js'

/**
 * 上下文装配接入运行时。
 *
 * 这组测试的由来：`context/assemble.ts` 实现了设计里的三段式装配与
 * token 预算，却**只有它自己的测试在用** —— worker 直接按「条数取 50 条」
 * 裸拼接，没有任何 token 预算。也就是说「context 会不会爆」的答案一直是
 * 「靠每条消息都短」。这里钉住接线本身。
 */

function config(chain = ['mock:local']): NucleusConfig {
  const c = structuredClone(defaultConfig)
  c.defaults.modelChain = chain
  return c
}

let n: Nucleus

async function bootWith(cfg: NucleusConfig): Promise<Nucleus> {
  return boot({
    config: cfg,
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: {
      orchestrator: [{ submit: { status: 'ok', summary: '好了', artifacts: [] } }],
    },
  })
}

afterEach(async () => {
  await n?.close()
})

// ═══════════════════════════════════════════════════════
// 历史顺序 —— 传反了会静默丢掉最新的消息
// ═══════════════════════════════════════════════════════

describe('history 的方向', () => {
  const msg = (content: string): ChatMessage => ({ role: 'user', content })

  it('按时间顺序传入时，装不下就丢最旧的、留最新的', () => {
    // 每条都不短，预算只够留几条
    const history = Array.from({ length: 20 }, (_, i) => msg(`第${i}轮：${'内容'.repeat(30)}`))
    const r = assemble({
      contract: 'C',
      identity: '',
      policy: '',
      history,
      input: [msg('本轮')],
      budget: { ...DEFAULT_BUDGET, contextWindow: 2000, reserveForOutput: 200, maxHistoryTokens: 400 },
    })

    expect(r.droppedMessages).toBeGreaterThan(0)
    const kept = r.messages.filter((m) => m.role === 'user' && m.content.startsWith('第'))
    // 关键：留下的必须是**最新**的那几条。传反的话这里会是「第0轮」，
    // 表现为模型突然失忆，而且不会有任何报错
    expect(kept[kept.length - 1]!.content).toContain('第19轮')
    expect(kept[0]!.content).not.toContain('第0轮')
  })

  it('保留的历史仍是时间顺序，不是倒序', () => {
    const history = [msg('一'), msg('二'), msg('三')]
    const r = assemble({
      contract: 'C',
      identity: '',
      policy: '',
      history,
      input: [],
      budget: DEFAULT_BUDGET,
    })
    const kept = r.messages.filter((m) => m.role === 'user').map((m) => m.content)
    expect(kept).toEqual(['一', '二', '三'])
  })
})

// ═══════════════════════════════════════════════════════
// 接线
// ═══════════════════════════════════════════════════════

describe('装配器已接入 runner', () => {
  it('每次 attempt 都记录分段用量事件', async () => {
    n = await bootWith(config())
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '问一句')

    const ev = await n.db.query<{ payload: { window: number; breakdown: { total: number } } }>(
      `select e.payload from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 and e.kind = 'context.assembled'`,
      [runId],
    )
    expect(ev.rows).toHaveLength(1)
    expect(ev.rows[0]!.payload.window).toBeGreaterThan(0)
    expect(ev.rows[0]!.payload.breakdown.total).toBeGreaterThan(0)
  })

  it('分段用量落进 run_attempts —— 事后判断「是不是被裁掉了关键信息」的依据', async () => {
    n = await bootWith(config())
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '问一句')

    const r = await n.db.query<{ context_breakdown: { window: number; prefix: number } | null }>(
      `select context_breakdown from run_attempts a
         join runs r on r.id = a.run_id where r.root_run_id = $1`,
      [runId],
    )
    // 这个列以前是「读得出、没人写」
    expect(r.rows[0]!.context_breakdown).not.toBeNull()
    expect(r.rows[0]!.context_breakdown!.prefix).toBeGreaterThan(0)
  })

  it('system prompt 作为不可变前缀原样进入请求', async () => {
    n = await bootWith(config())
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '问一句')

    // 前缀必须逐字节稳定，否则 prompt cache 全部落空
    const spec = n.worker.agentSpecs.get('orchestrator')!
    const r = assemble({
      contract: spec.systemPrompt,
      identity: '',
      policy: '',
      history: [],
      input: [],
      budget: DEFAULT_BUDGET,
    })
    expect(r.prefix).toBe(spec.systemPrompt.trim())
    expect(r.prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T/) // 没有时间戳
  })
})

// ═══════════════════════════════════════════════════════
// 窗口取值：链上最小
// ═══════════════════════════════════════════════════════

describe('contextWindowFor', () => {
  it('取链上最小的窗口 —— 中途降级到小窗口模型时才不会溢出', async () => {
    const c = config(['big:model', 'small:model'])
    c.models = [
      { key: 'big:model', provider: 'mock', model: 'm', baseUrl: 'http://x/v1', contextWindow: 200_000 },
      { key: 'small:model', provider: 'mock', model: 'm', baseUrl: 'http://x/v1', contextWindow: 8_000 },
    ]
    n = await bootWith(c)
    expect(n.router.contextWindowFor(c.defaults.modelChain, 32_768)).toBe(8_000)
  })

  it('未声明窗口的模型按 assumedContextWindow 计，不编造每个模型的数字', async () => {
    n = await bootWith(config())
    // mock:local 没有声明 contextWindow
    expect(n.router.contextWindowFor(['mock:local'], 12_345)).toBe(12_345)
  })

  it('本地 ollama 模型同样走这个假设值 —— 换模型不必逐个声明', async () => {
    n = await bootWith(config())
    expect(n.router.contextWindowFor(['ollama:gemma4:31b'], 32_768)).toBe(32_768)
  })

  it('空链回落到假设值，不返回 Infinity', async () => {
    n = await bootWith(config())
    expect(n.router.contextWindowFor([], 4_096)).toBe(4_096)
  })
})

// ═══════════════════════════════════════════════════════
// 放不下时早失败
// ═══════════════════════════════════════════════════════

describe('本回合输入就超窗口', () => {
  it('报 budget.context_overflow 而不是发一个必然被拒的请求', async () => {
    const c = config()
    // 把假设窗口压到极小，让本轮输入直接放不下
    c.defaults.assumedContextWindow = 200
    n = await bootWith(c)

    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '一段很长的问题'.repeat(200))

    const run = await n.runs.getRun(runId)
    expect(run!.status).toBe('failed')
    expect(run!.errorCode).toBe('budget.context_overflow')

    const detail = run!.errorDetail as { window?: number; hint?: string }
    expect(detail.window).toBe(200)
    // 要告诉人怎么办，而不是只报一个错误码
    expect(detail.hint).toMatch(/contextWindow/)
  })

  it('窗口正常时不会误报', async () => {
    n = await bootWith(config())
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '正常长度的问题')
    expect((await n.runs.getRun(runId))!.status).toBe('succeeded')
  })
})
