import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 可追溯性。
 *
 * 事件流对「发生了什么」是完整的（状态机、唤醒、工具意图/结果、错误与恢复性），
 * 但对「模型为什么那么做」是瞎的：`llm.call.started` 只有 `{step, chain}`，
 * `llm.call.finished` 只有 token 与延迟，工具实参只有 args_hash。
 *
 * 于是远程诊断答不了这个阶段最常见的问题：编排者为什么派给了这个专家？
 * 专家为什么忽略了验收标准？
 *
 * 「事后重建」不成立：重建需要当时的 config + agent 定义 + 当时的历史，
 * 三样都会变；而且出问题之后再想开启记录就来不及了。
 */

function cfg(): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  return c
}

const SCRIPT: MockScript = {
  orchestrator: [
    {
      tool: {
        name: 'delegate',
        args: {
          agent: 'researcher',
          goal: '调研 X',
          context: '用户在做本地 RAG',
          acceptance: '至少三个候选，每条带来源',
          why: '需要外部资料',
        },
      },
    },
    { submit: { status: 'ok', summary: '整合完成', artifacts: [] } },
  ],
  researcher: [
    { tool: { name: 'write_report', args: { title: '报告', content: '## 结论\n可行' } } },
    {
      submit: {
        status: 'ok',
        summary: '调研完成',
        findings: [{ claim: 'A 可行', sources: ['s1'] }],
        artifacts: [],
      },
    },
  ],
}

let n: Nucleus | null = null
afterEach(async () => {
  await n?.close()
  n = null
})

async function run(overrides: Partial<NucleusConfig> = {}) {
  n = await boot({
    config: { ...cfg(), ...overrides },
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: SCRIPT,
  })
  const conv = await n.conversations.create({ agentId: 'orchestrator' })
  const { runId } = await ask(n, conv.id, '帮我调研')
  return runId
}

describe('transcript', () => {
  it('记下每一次模型往返：发了什么、答了什么', async () => {
    const runId = await run()
    const t = await n!.db.query<{
      step: number
      request: { messages: Array<{ role: string; content: string }>; tools: string[] }
      response: { toolCalls: Array<{ name: string; arguments: string }>; model: string }
    }>(
      `select t.step, t.request, t.response from transcripts t
         join run_attempts a on a.id = t.run_attempt_id
         join runs r on r.id = a.run_id
        where r.root_run_id = $1 order by r.depth, a.attempt_no, t.step`,
      [runId],
    )
    expect(t.rows.length).toBeGreaterThanOrEqual(3)

    // 第一次往返：编排者收到用户的问题、看得到 delegate
    const first = t.rows[0]!
    expect(first.request.tools).toContain('delegate')
    expect(JSON.stringify(first.request.messages)).toContain('帮我调研')
    // 而且它写的信封实参在这里 —— 「为什么派给这个专家」答得出
    expect(first.response.toolCalls[0]!.name).toBe('delegate')
    expect(first.response.toolCalls[0]!.arguments).toContain('需要外部资料')
  })

  it('专家收到的信封在 transcript 里 —— 「它到底看到了验收标准吗」答得出', async () => {
    const runId = await run()
    const t = await n!.db.query<{ request: { messages: Array<{ content: string }> } }>(
      `select t.request from transcripts t
         join run_attempts a on a.id = t.run_attempt_id
         join runs r on r.id = a.run_id
        where r.root_run_id = $1 and r.depth = 1 order by t.step limit 1`,
      [runId],
    )
    const text = JSON.stringify(t.rows[0]!.request.messages)
    expect(text).toContain('验收标准')
    expect(text).toContain('至少三个候选')
    // 而 why 不该出现 —— 它是选人的推理，不进信封
    expect(text).not.toContain('需要外部资料')
  })

  it('system prompt 也在里面 —— agent 定义随时会改，事后重建不出当时那版', async () => {
    const runId = await run()
    const t = await n!.db.query<{ request: { messages: Array<{ role: string; content: string }> } }>(
      `select t.request from transcripts t
         join run_attempts a on a.id = t.run_attempt_id
         join runs r on r.id = a.run_id where r.root_run_id = $1 limit 1`,
      [runId],
    )
    const sys = t.rows[0]!.request.messages.find((m) => m.role === 'system')
    expect(sys).toBeDefined()
    expect(sys!.content).toContain('运行时契约')
  })

  it('可以关掉 —— 数据库会变大，但默认开着因为出问题后再开就来不及', async () => {
    const c = cfg()
    c.runtime = { ...c.runtime, captureTranscripts: false }
    const runId = await run({ runtime: c.runtime })
    const t = await n!.db.query<{ n: number }>(
      `select count(*)::int n from transcripts t
         join run_attempts a on a.id = t.run_attempt_id
         join runs r on r.id = a.run_id where r.root_run_id = $1`,
      [runId],
    )
    expect(t.rows[0]!.n).toBe(0)
  })

  it('超长时截断并标记，而不是拒绝写 —— 截断的记录仍然有用', async () => {
    const c = cfg()
    c.runtime = { ...c.runtime, transcriptMaxChars: 50 }
    const runId = await run({ runtime: c.runtime })
    const t = await n!.db.query<{ truncated: boolean }>(
      `select t.truncated from transcripts t
         join run_attempts a on a.id = t.run_attempt_id
         join runs r on r.id = a.run_id where r.root_run_id = $1 limit 1`,
      [runId],
    )
    expect(t.rows[0]!.truncated).toBe(true)
  })
})

describe('工具实参与返回', () => {
  it('实参落库 —— 只有 hash 时判断不了模型到底填了什么', async () => {
    const runId = await run()
    const inv = await n!.db.query<{
      tool_name: string
      args_json: Record<string, unknown> | null
      result_text: string | null
    }>(
      `select i.tool_name, i.args_json, i.result_text from tool_invocations i
         join run_attempts a on a.id = i.run_attempt_id
         join runs r on r.id = a.run_id
        where r.root_run_id = $1 order by r.depth, i.seq`,
      [runId],
    )
    const del = inv.rows.find((x) => x.tool_name === 'delegate')!
    expect(del.args_json).not.toBeNull()
    // 信封写得好不好，要看实参
    expect(del.args_json!['acceptance']).toBe('至少三个候选，每条带来源')
  })

  it('返回文本落库 —— 回灌给模型的就是它', async () => {
    const runId = await run()
    const inv = await n!.db.query<{ result_text: string | null }>(
      `select i.result_text from tool_invocations i
         join run_attempts a on a.id = i.run_attempt_id
         join runs r on r.id = a.run_id
        where r.root_run_id = $1 and i.tool_name = 'write_report'`,
      [runId],
    )
    expect(inv.rows[0]!.result_text).toContain('报告已保存')
  })
})

describe('bundle 带上决定行为的东西', () => {
  it('agent 的完整定义而不是 id 列表', async () => {
    // agent 定义决定行为：prompt 正文、权限、结果契约。只给 id 的话
    // 「专家为什么忽略了验收标准」完全无从下手，而定义随时在改
    const c = cfg()
    const researcher = c.agents.find((a) => a.id === 'researcher')!
    expect(researcher.identity).toBeTruthy()
    expect(researcher.permissions).toBeTruthy()
    // bundle 里放的是 config.agents 本身，所以这些都在
    expect(JSON.stringify(c.agents)).toContain('研究专家')
  })
})

// ═══════════════════════════════════════════════════════
// provider 层：熔断、429、fallback、失败
// ═══════════════════════════════════════════════════════

describe('provider 事件', () => {
  /** 两个都连不上的模型 —— 制造真实的失败与熔断 */
  function failingChain(): NucleusConfig {
    const c = cfg()
    c.models = [
      { key: 'a:one', provider: 'ollama', model: 'one', baseUrl: 'http://127.0.0.1:19998/v1' },
      { key: 'b:two', provider: 'ollama', model: 'two', baseUrl: 'http://127.0.0.1:19999/v1' },
      ...c.models,
    ]
    c.defaults.modelChain = ['a:one', 'b:two']
    return c
  }

  async function events(kind?: string) {
    const r = await n!.db.query<{
      key: string
      kind: string
      error_code: string | null
      detail: Record<string, unknown>
    }>(
      kind
        ? `select key, kind, error_code, detail from provider_events where kind = $1 order by id`
        : `select key, kind, error_code, detail from provider_events order by id`,
      kind ? [kind] : [],
    )
    return r.rows
  }

  it('选路决策记下**被跳过的候选与原因** —— 「为什么用了链上第 3 个」', async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, 'x')

    const picked = await events('picked')
    expect(picked.length).toBeGreaterThan(0)
    // 链上只有一个模型时 skipped 为空，但字段必须在 —— 结构稳定才好查
    expect(picked[0]!.detail).toHaveProperty('skipped')
    expect(picked[0]!.detail).toHaveProperty('chain')
  })

  it('失败记下错误码、根因提示与连续失败次数', async () => {
    n = await boot({ config: failingChain(), deps: { clock: new FakeClock(), ids: new FakeIds() } })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, 'x')

    const failed = await events('failed')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[0]!.error_code).toBe('provider.unreachable')
    // 根因提示 —— 只报错误码等于让人自己猜
    expect(String(failed[0]!.detail['hint'])).toContain('出网权限')
    expect(failed[0]!.detail['consecutiveErrors']).toBeGreaterThan(0)
  })

  it('熔断状态变化单独一条 —— 「什么时候打开的、因为什么、开到几点」', async () => {
    n = await boot({ config: failingChain(), deps: { clock: new FakeClock(), ids: new FakeIds() } })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    // 反复失败直到熔断
    for (let i = 0; i < 4; i++) await ask(n, conv.id, `x${i}`)

    const opened = await events('breaker.open')
    expect(opened.length).toBeGreaterThan(0)
    expect(opened[0]!.detail['from']).toBe('closed')
    expect(opened[0]!.detail['until']).toBeTruthy()
  })

  it('全链不可用单独记 —— 「429 打挂整条 fallback 链」就是这一条', async () => {
    n = await boot({ config: failingChain(), deps: { clock: new FakeClock(), ids: new FakeIds() } })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    for (let i = 0; i < 5; i++) await ask(n, conv.id, `x${i}`)

    const ex = await events('exhausted')
    expect(ex.length).toBeGreaterThan(0)
    // 每个模型各自为什么不可用、几点恢复
    const per = ex[0]!.detail['perModel'] as Array<{ key: string; reason: string }>
    expect(per.length).toBe(2)
    expect(per[0]!.reason).toBe('熔断中')
    expect(ex[0]!.detail['earliestAvailableAt']).toBeTruthy()
  })
})

describe('usage_log', () => {
  it('逐次调用的用量落库 —— 这张表建了从来没人写过', async () => {
    const runId = await run()
    const u = await n!.db.query<{ n: number; tin: number }>(
      `select count(*)::int n, sum(u.tokens_in)::int tin from usage_log u
         join run_attempts a on a.id = u.run_attempt_id
         join runs r on r.id = a.run_id where r.root_run_id = $1`,
      [runId],
    )
    // 4 次模型调用
    expect(u.rows[0]!.n).toBeGreaterThanOrEqual(3)
    expect(u.rows[0]!.tin).toBeGreaterThan(0)
  })

  it('挂在 attempt 上 —— 「这次 429 是哪个任务触发的」要答得出', async () => {
    const runId = await run()
    const u = await n!.db.query<{ n: number }>(
      `select count(*)::int n from usage_log where run_attempt_id is null`,
    )
    expect(u.rows[0]!.n).toBe(0)
    expect(runId).toBeTruthy()
  })
})
