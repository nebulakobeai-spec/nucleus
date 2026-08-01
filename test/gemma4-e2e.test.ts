import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import type { FetchLike } from '../src/providers/openai-compat.js'

/**
 * 端到端：真实 gemma4 响应驱动**完整** Nucleus 流水线。
 *
 * 与 `gemma4.test.ts` 的区别很重要 —— 那组只测解析与校验，
 * 这组跑的是：
 *
 *   boot() → ask() → worker.drain() → runner 的 agent loop
 *   → 工具执行（真实 delegate / write_report）→ 子 run 创建
 *   → wake 同事务触发 → 编排者第二次 attempt → 结果回写会话
 *   → 全程落 PGlite
 *
 * **唯一被替换的是 HTTP socket**（注入 fetch 返回录制的响应）。
 * 其余每一行都是生产代码。
 *
 * 这是回答「Nucleus 能不能和 gemma4 一起工作」的测试；
 * 「gemma4 遵不遵守 schema」由 gemma4.test.ts 回答。两者不可互相替代。
 */

const FIXTURES = join(process.cwd(), 'test', 'fixtures', 'gemma4')

function fixture(name: string): string {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    response: unknown
  }
  return JSON.stringify(raw.response)
}

/**
 * 按「哪个 agent 在问 + 第几轮」分派录制的响应。
 *
 * 靠 system prompt 里的 `# <agentId>` 识别，与 mock provider 同一套约定。
 */
function gemma4Fetch(): FetchLike & { calls: Array<{ agent: string; turn: number }> } {
  const turns = new Map<string, number>()
  const calls: Array<{ agent: string; turn: number }> = []

  const f = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    const agent = /^#\s*orchestrator\b/im.test(system)
      ? 'orchestrator'
      : /^#\s*researcher\b/im.test(system)
        ? 'researcher'
        : 'unknown'

    const turn = (turns.get(agent) ?? 0) + 1
    turns.set(agent, turn)
    calls.push({ agent, turn })

    const name =
      agent === 'orchestrator'
        ? turn === 1
          ? 'orchestrator-delegate'
          : 'orchestrator-integrate'
        : turn === 1
          ? 'turn1-write-report'
          : 'turn2-submit-result'

    return new Response(fixture(name), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return Object.assign(f, { calls })
}

let n: Nucleus
let fetchImpl: ReturnType<typeof gemma4Fetch>

beforeEach(async () => {
  const config = withExampleAgents(structuredClone(defaultConfig))
  // 让所有 agent 都用 gemma4；模型键已在 defaultConfig 里声明
  config.defaults.modelChain = ['ollama:gemma4']
  fetchImpl = gemma4Fetch()

  n = await boot({
    config,
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    fetch: fetchImpl,
  })
})

afterEach(async () => {
  await n.close()
})

describe('gemma4 驱动完整编排', () => {
  it('委派 → 专家干活 → wake 唤醒 → 整合 → 回写会话', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator', title: '选型调研' })
    const { runId } = await ask(n, conv.id, '帮我调研一下向量数据库选型')

    // ── 调用序列：编排者委派 → 专家两轮 → 编排者被唤醒 ──
    expect(fetchImpl.calls).toEqual([
      { agent: 'orchestrator', turn: 1 },
      { agent: 'researcher', turn: 1 },
      { agent: 'researcher', turn: 2 },
      { agent: 'orchestrator', turn: 2 },
    ])

    // ── run 树 ──
    const tree = await n.runs.tree(runId)
    expect(tree.map((r) => `${r.agentId}:${r.depth}:${r.status}`)).toEqual([
      'orchestrator:0:succeeded',
      'researcher:1:succeeded',
    ])

    // ── 编排者跑了两次 attempt（第二次由 wake 触发）──
    const attempts = await n.runs.listAttempts(runId)
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2])

    // ── wake 已触发 ──
    const wakes = await n.db.query<{ status: string; pending_count: number }>(
      `select status, pending_count from wake_records where parent_run_id = $1`,
      [runId],
    )
    expect(wakes.rows[0]).toMatchObject({ status: 'fired', pending_count: 0 })

    // ── 会话里只有最终整合结果，没有中间态 ──
    const msgs = await n.conversations.recent(conv.id, 20)
    const assistant = msgs.filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toContain('向量数据库')
  })

  it('专家的完整报告进 artifact，不进会话', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我调研一下向量数据库选型')

    const artifacts = await n.db.query<{ path: string; bytes: number }>(
      `select a.path, a.bytes from artifacts a join runs r on r.id = a.run_id
        where r.root_run_id = $1`,
      [runId],
    )
    expect(artifacts.rows.length).toBeGreaterThan(0)
    // gemma4 写的报告很长；它必须走 artifact 而不是塞进消息
    expect(Math.max(...artifacts.rows.map((a) => a.bytes))).toBeGreaterThan(500)

    const msgs = await n.conversations.recent(conv.id, 20)
    for (const m of msgs) {
      expect(m.content.length).toBeLessThan(2000)
    }
  })

  it('思考过程进事件流，绝不进会话历史', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我调研一下向量数据库选型')

    // 事件流里有思考
    const reasoning = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 and e.kind = 'llm.reasoning'`,
      [runId],
    )
    expect(reasoning.rows[0]!.n).toBeGreaterThan(0)

    // 但会话里没有 —— gemma4 的多轮规范要求历史不含 thinking
    const msgs = await n.conversations.recent(conv.id, 20)
    for (const m of msgs) {
      expect(m.content).not.toContain('用户') // 思考里的自我陈述用词
      expect(m.content).not.toMatch(/我需要|首先，我/)
    }
  })

  it('专家没有对外身份 —— 结构上无法直发用户', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我调研一下向量数据库选型')

    const tree = await n.runs.tree(runId)
    const child = tree.find((r) => r.depth === 1)!
    expect(child.conversationId).toBeNull()
  })

  it('工具调用留下完整的意图日志', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我调研一下向量数据库选型')

    const inv = await n.db.query<{ tool_name: string; side_effect_class: string; outcome: string }>(
      // 按 (attempt, seq) 排序 —— intent_at 在同一毫秒内不可靠
      `select i.tool_name, i.side_effect_class, i.outcome
         from tool_invocations i
         join run_attempts a on a.id = i.run_attempt_id
         join runs r on r.id = a.run_id
        where r.root_run_id = $1
        order by r.depth, a.attempt_no, i.seq`,
      [runId],
    )

    // 编排者（depth 0）先委派，专家（depth 1）再写报告
    expect(inv.rows.map((r) => r.tool_name)).toEqual(['delegate', 'write_report'])
    // 每个调用都有结果，没有悬挂的 UNKNOWN
    expect(inv.rows.every((r) => r.outcome === 'ok')).toBe(true)
    // 副作用等级已声明
    expect(inv.rows.every((r) => r.side_effect_class === 'idempotent')).toBe(true)
  })

  it('执行结束后无悬挂状态', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '帮我调研一下向量数据库选型')

    for (const [what, sql] of [
      ['未终态 attempt', `select count(*)::int n from run_attempts where status in ('queued','running')`],
      ['未完成工具调用', `select count(*)::int n from tool_invocations where outcome is null`],
      ['残留队列', `select count(*)::int n from run_queue`],
      ['未触发的 wake', `select count(*)::int n from wake_records where status = 'waiting'`],
    ] as const) {
      const r = await n.db.query<{ n: number }>(sql)
      expect(r.rows[0]!.n, what).toBe(0)
    }
  })

  it('token 用量与成本被记录（订阅/本地模型成本为 0，用量仍要有）', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '帮我调研一下向量数据库选型')

    const tree = await n.runs.tree(runId)
    let tokens = 0
    for (const r of tree) {
      for (const a of await n.runs.listAttempts(r.id)) {
        tokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
      }
    }
    // 真实用量：4 次调用累计约 4000+ token
    expect(tokens).toBeGreaterThan(1000)
  })
})
