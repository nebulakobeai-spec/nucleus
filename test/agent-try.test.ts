import { afterEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { summarize, type RunStat } from '../src/cli/agent-try.js'
import { parseCases } from '../src/config/agent-files.js'

/**
 * `agent try` 的判据。
 *
 * 这个命令承诺的**不是**「证明新版更好」—— 单跑一次证明不了任何事（模型有
 * 随机性），三道题上更好的定义在第四道题上可能更差。它承诺的是
 * **让退步无法悄悄溜过去**。
 *
 * 所以要测的是：统计口径对不对（一次过 = 成功且零退回）、
 * 权限面变宽这种纯静态信号能不能独立于试题表现被抓到。
 */

const stat = (o: Partial<RunStat> = {}): RunStat => ({
  ok: true,
  rejections: 0,
  steps: 2,
  tokens: 100,
  ms: 50,
  denied: [],
  artifacts: 1,
  errorCode: null,
  ...o,
})

describe('summarize', () => {
  it('「一次过」= 成功且零退回', () => {
    const s = summarize([stat(), stat({ rejections: 1 }), stat({ ok: false })])
    expect(s.total).toBe(3)
    // 退回后成功的不算一次过 —— 它需要纠正一轮
    expect(s.clean).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.rate).toBeCloseTo(1 / 3)
  })

  it('平均值按运行次数算', () => {
    const s = summarize([stat({ steps: 2, tokens: 100 }), stat({ steps: 4, tokens: 300 })])
    expect(s.steps).toBe(3)
    expect(s.tokens).toBe(200)
  })

  it('越权尝试是累加而不是取平均 —— 一次都不该有', () => {
    const s = summarize([stat({ denied: ['shell'] }), stat({ denied: ['shell', 'exec'] })])
    expect(s.denied).toBe(3)
  })

  it('空数组不除零', () => {
    const s = summarize([])
    expect(s.total).toBe(0)
    expect(Number.isFinite(s.rate)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// 试题集是版本对比的地基
// ═══════════════════════════════════════════════════════

describe('试题集', () => {
  it('从 cases.md 读出来，跨版本用同一批题', () => {
    // 在**不同任务**上比两个定义，「更好」这个词没有意义
    const cases = parseCases('- 第一题\n- 第二题\n  续行\n')
    expect(cases).toHaveLength(2)
    expect(cases[1]).toContain('续行')
  })
})

// ═══════════════════════════════════════════════════════
// 单独试跑：不经编排者、不写会话
// ═══════════════════════════════════════════════════════

let n: Nucleus | null = null
afterEach(async () => {
  await n?.close()
  n = null
})

describe('单独试跑一个专家', () => {
  function solo(): NucleusConfig {
    const c = structuredClone(defaultConfig)
    c.defaults.modelChain = ['mock:local']
    c.defaults.entryAgent = 'lonely'
    c.agents = [
      {
        id: 'lonely',
        name: '独立专家',
        whenToUse: '测试用',
        identity: '你是测试专家。',
        permissions: ['artifact'],
      },
    ]
    return c
  }

  it('只有一个 agent 时 delegate 不注册 —— 试跑不该有委派这条路', async () => {
    n = await boot({ config: solo(), deps: { clock: new FakeClock(), ids: new FakeIds() }, mock: {} })
    expect(n.tools.get('delegate')).toBeUndefined()
  })

  it('试跑不建会话 —— 与「子 run 无对外身份」保持一致', async () => {
    n = await boot({ config: solo(), deps: { clock: new FakeClock(), ids: new FakeIds() }, mock: {} })
    const run = await n.runs.createRun({
      agentId: 'lonely',
      input: { goal: '干活', context: '试跑', acceptance: '提交' },
    })
    await n.runs.enqueueAttempt(run.id)
    await n.worker.drain(20)

    const after = await n.runs.getRun(run.id)
    expect(after!.status).toBe('succeeded')
    expect(after!.conversationId).toBeNull()
    // 没有会话，也就没有助手消息
    const msgs = await n.db.query<{ n: number }>(`select count(*)::int n from messages`)
    expect(msgs.rows[0]!.n).toBe(0)
  })

  it('空 mock 脚本下任何 agent 都能跑完 —— 试新专家时正需要这个', async () => {
    // whichAgent 曾在脚本里找不到时退回第一个 agent，于是新专家会拿到
    // 别人的剧本（比如编排者的 delegate，而那个工具根本没注册）
    n = await boot({ config: solo(), deps: { clock: new FakeClock(), ids: new FakeIds() }, mock: {} })
    const run = await n.runs.createRun({
      agentId: 'lonely',
      input: { goal: 'x', context: 'y', acceptance: 'z' },
    })
    await n.runs.enqueueAttempt(run.id)
    await n.worker.drain(20)
    expect((await n.runs.getRun(run.id))!.status).toBe('succeeded')
  })
})

// ═══════════════════════════════════════════════════════
// 权限面：与试题表现无关的静态信号
// ═══════════════════════════════════════════════════════

describe('权限面变化', () => {
  /** 与 agent-try 里同一段判断 */
  function diff(before: string[], after: string[]) {
    const b = new Set(before)
    const a = new Set(after)
    return {
      added: [...a].filter((x) => !b.has(x)),
      removed: [...b].filter((x) => !a.has(x)),
    }
  }

  it('变宽要能被单独抓出来 —— 不管试题跑得多好，那都是退步', () => {
    expect(diff(['read'], ['read', 'execute']).added).toEqual(['execute'])
  })

  it('收紧是好事', () => {
    expect(diff(['read', 'execute'], ['read']).removed).toEqual(['execute'])
  })

  it('顺序不同不算变化', () => {
    const d = diff(['read', 'artifact'], ['artifact', 'read'])
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
  })
})
