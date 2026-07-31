import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { ModelRouter } from '../src/providers/router.js'
import type { ModelConfig } from '../src/providers/types.js'
import { RunStore } from '../src/store/runs.js'
import { Runner, type AgentSpec } from '../src/runtime/runner.js'
import { ToolRegistry, type ToolDefinition } from '../src/runtime/tools.js'
import { MemoryEventSink } from '../src/runtime/events.js'
import { scriptedFetch, stubCompletion } from './harness/provider.js'

const MODELS = new Map<string, ModelConfig>([
  [
    'test:m',
    { key: 'test:m', provider: 'test', model: 'm', baseUrl: 'http://x/v1', costPerMTokIn: 1, costPerMTokOut: 1 },
  ],
])

let db: Db
let deps: Deps
let store: RunStore
let events: MemoryEventSink
let tools: ToolRegistry

const AGENT: AgentSpec = {
  id: 'albert',
  systemPrompt: 'You are Albert.',
  modelChain: ['test:m'],
  toolsAllow: ['*'],
  maxSteps: 10,
}

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  deps = { clock: new FakeClock(), ids: new FakeIds() }
  store = new RunStore(db, deps)
  events = new MemoryEventSink()
  tools = new ToolRegistry()
})

afterEach(async () => {
  await db.close()
})

/** 把模型的行为写成脚本 */
function runnerWith(script: Response[], opts = {}) {
  const router = new ModelRouter(db, deps, MODELS, () => null, {
    fetch: scriptedFetch(script),
    inPlaceRetries: 0,
  })
  return new Runner(db, deps, router, tools, events, { heartbeatMs: 3_600_000, ...opts })
}

async function startRun(agent = AGENT) {
  const run = await store.createRun({ agentId: agent.id })
  await store.enqueueAttempt(run.id)
  const attempt = await store.claimNext('w1')
  return { run, attempt: attempt! }
}

function exec(runner: Runner, ctx: { run: { id: string }; attempt: { id: string; fenceToken: string | null } }, agent = AGENT) {
  return runner.execute({
    attemptId: ctx.attempt.id,
    fenceToken: ctx.attempt.fenceToken!,
    runId: ctx.run.id,
    agent,
    messages: [{ role: 'user', content: '做这件事' }],
    workdir: '/tmp/nucleus-test',
  })
}

const submit = (r: Record<string, unknown>) =>
  stubCompletion({ toolCalls: [{ name: 'submit_result', args: r }] })

// ═══════════════════════════════════════════════════════
// 基本闭环
// ═══════════════════════════════════════════════════════

describe('agent loop', () => {
  it('提交合法结果即成功，终态与结果落库', async () => {
    const ctx = await startRun()
    const out = await exec(runnerWith([submit({ status: 'ok', summary: '做完了' })]), ctx)

    expect(out.status).toBe('succeeded')
    expect(out.result!.summary).toBe('做完了')

    const run = await store.getRun(ctx.run.id)
    expect(run!.status).toBe('succeeded')
    expect((run!.result as { summary: string }).summary).toBe('做完了')
    expect(run!.resultSchemaVersion).toBe('1.0')

    const attempt = await store.getAttempt(ctx.attempt.id)
    expect(attempt!.status).toBe('succeeded')
    expect(attempt!.stepsUsed).toBe(1)
  })

  it('工具调用后再提交结果', async () => {
    const calls: unknown[] = []
    tools.register({
      name: 'read_file',
      description: '读文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      sideEffect: 'pure',
      execute: async (args) => {
        calls.push(args)
        return { ok: true, content: '文件内容' }
      },
    })

    const ctx = await startRun()
    const out = await exec(
      runnerWith([
        stubCompletion({ toolCalls: [{ name: 'read_file', args: { path: 'a.md' } }] }),
        submit({ status: 'ok', summary: '读到了：文件内容' }),
      ]),
      ctx,
    )

    expect(out.status).toBe('succeeded')
    expect(calls).toEqual([{ path: 'a.md' }])
    expect(out.stepsUsed).toBe(2)
    expect(events.kinds()).toContain('tool.intent')
    expect(events.kinds()).toContain('tool.outcome')
  })

  it('累计 token 与成本', async () => {
    const ctx = await startRun()
    const out = await exec(
      runnerWith([
        stubCompletion({ content: '思考中' }, { in: 1000, out: 100 }),
        submit({ status: 'ok', summary: 'done' }),
      ]),
      ctx,
    )
    expect(out.tokensIn).toBeGreaterThanOrEqual(1000)
    expect(out.costUsd).toBeGreaterThan(0)
    const a = await store.getAttempt(ctx.attempt.id)
    expect(Number(a!.costUsd)).toBeCloseTo(out.costUsd, 9)
  })

  it('模型不调工具时被要求走 submit_result', async () => {
    const ctx = await startRun()
    const out = await exec(
      runnerWith([stubCompletion({ content: '我做完了' }), submit({ status: 'ok', summary: '真的做完了' })]),
      ctx,
    )
    expect(out.status).toBe('succeeded')
    expect(out.result!.summary).toBe('真的做完了')
  })
})

// ═══════════════════════════════════════════════════════
// 输出契约：不信 provider，自己再校验
// ═══════════════════════════════════════════════════════

describe('submit_result 契约', () => {
  it('缺字段时退回重写，反馈精确到字段路径', async () => {
    const ctx = await startRun()
    const out = await exec(
      runnerWith([submit({ status: 'ok' }), submit({ status: 'ok', summary: '补上了' })]),
      ctx,
    )
    expect(out.status).toBe('succeeded')
    const rejected = events.all('contract.rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as { failures: Array<{ path: string }> }).failures[0]!.path).toBe('summary')
  })

  it('超长 summary 被拒绝 —— 全文该进 artifact', async () => {
    const ctx = await startRun()
    const out = await exec(
      runnerWith([
        submit({ status: 'ok', summary: 'x'.repeat(3000) }),
        submit({ status: 'ok', summary: '简短版', artifacts: ['r/full.md'] }),
      ]),
      ctx,
    )
    expect(out.status).toBe('succeeded')
    expect(out.result!.artifacts).toEqual(['r/full.md'])
  })

  it('超过重写次数上限则落 contract.postcondition_failed', async () => {
    const ctx = await startRun()
    const bad = submit({ status: 'ok' })
    const out = await exec(runnerWith([bad, bad, bad, bad]), ctx, { ...AGENT })
    expect(out.status).toBe('failed')
    expect(out.errorCode).toBe('contract.postcondition_failed')
    expect((await store.getRun(ctx.run.id))!.status).toBe('failed')
  })

  it('规则驱动的必填字段：启用规则后 sources 变必填', async () => {
    const agent: AgentSpec = {
      ...AGENT,
      resultSpec: { capabilities: ['research'], requiredFields: ['findings[].sources'] },
    }
    const ctx = await startRun(agent)
    const out = await exec(
      runnerWith([
        submit({ status: 'ok', summary: 'x', findings: [{ claim: 'A' }] }),
        submit({
          status: 'ok',
          summary: 'x',
          findings: [{ claim: 'A', sources: ['http://a', 'http://b'] }],
        }),
      ]),
      ctx,
      agent,
    )
    expect(out.status).toBe('succeeded')
    const f = events.all('contract.rejected')[0] as { failures: Array<{ path: string }> }
    expect(f.failures[0]!.path).toBe('findings[].sources')
  })

  it('参数不是合法 JSON 时给出可操作反馈', async () => {
    const ctx = await startRun()
    const broken = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'submit_result', arguments: '{"status":' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const out = await exec(runnerWith([broken, submit({ status: 'ok', summary: 'ok' })]), ctx)
    expect(out.status).toBe('succeeded')
    expect((events.all('contract.rejected')[0] as { failures: Array<{ message: string }> }).failures[0]!.message).toMatch(
      /合法 JSON/,
    )
  })
})

// ═══════════════════════════════════════════════════════
// 能力边界（T3）：不给工具就无从违反
// ═══════════════════════════════════════════════════════

describe('能力边界', () => {
  it('白名单外的工具不出现在给模型的定义中', async () => {
    tools.register({ name: 'read', description: 'r', parameters: {}, sideEffect: 'pure', execute: async () => ({ ok: true, content: '' }) })
    tools.register({ name: 'exec', description: 'e', parameters: {}, sideEffect: 'non_idempotent', execute: async () => ({ ok: true, content: '' }) })

    const f = scriptedFetch([submit({ status: 'ok', summary: 'ok' })])
    const router = new ModelRouter(db, deps, MODELS, () => null, { fetch: f, inPlaceRetries: 0 })
    const runner = new Runner(db, deps, router, tools, events, { heartbeatMs: 3_600_000 })

    const ctx = await startRun()
    await runner.execute({
      attemptId: ctx.attempt.id,
      fenceToken: ctx.attempt.fenceToken!,
      runId: ctx.run.id,
      agent: { ...AGENT, toolsAllow: ['read'] },
      messages: [{ role: 'user', content: 'go' }],
      workdir: '/tmp',
    })

    const sent = f.calls[0]!.body['tools'] as Array<{ function: { name: string } }>
    const names = sent.map((t) => t.function.name)
    expect(names).toContain('read')
    expect(names).toContain('submit_result')
    expect(names).not.toContain('exec') // 模型看不到就无从调用
  })

  it('调用被拒绝的工具时给出明确反馈而非崩溃', async () => {
    tools.register({ name: 'exec', description: 'e', parameters: {}, sideEffect: 'non_idempotent', execute: async () => ({ ok: true, content: 'ran' }) })
    const ctx = await startRun()
    const out = await exec(
      runnerWith([
        stubCompletion({ toolCalls: [{ name: 'exec', args: {} }] }),
        submit({ status: 'ok', summary: 'ok' }),
      ]),
      ctx,
      { ...AGENT, toolsAllow: ['read'] },
    )
    expect(out.status).toBe('succeeded')
    // 工具从未执行
    expect(await store.unknownInvocations(ctx.attempt.id)).toHaveLength(0)
  })

  it('未声明 sideEffect 的工具拒绝注册', () => {
    expect(() =>
      tools.register({ name: 'x', description: '', parameters: {}, execute: async () => ({ ok: true, content: '' }) } as unknown as ToolDefinition),
    ).toThrow(/sideEffect/)
  })
})

// ═══════════════════════════════════════════════════════
// 前置检查：规则文本贴在动作旁边（§6 机制一）
// ═══════════════════════════════════════════════════════

describe('前置检查', () => {
  it('被拒绝的调用不执行，规则原文回给模型，且不留意图记录', async () => {
    let executed = false
    tools.register({
      name: 'write',
      description: 'w',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      sideEffect: 'idempotent',
      precondition: (args) => {
        const p = (args as { path: string }).path
        if (p.endsWith('.py') && !p.startsWith('scripts/')) {
          return {
            ok: false,
            content: '脚本文件必须写入 scripts/ 目录下。',
            rule: 'fs.script-location',
            errorCode: 'tool.denied',
          }
        }
        return null
      },
      execute: async () => {
        executed = true
        return { ok: true, content: 'written' }
      },
    })

    const ctx = await startRun()
    const out = await exec(
      runnerWith([
        stubCompletion({ toolCalls: [{ name: 'write', args: { path: 'a.py' } }] }),
        stubCompletion({ toolCalls: [{ name: 'write', args: { path: 'scripts/a.py' } }] }),
        submit({ status: 'ok', summary: 'ok' }),
      ]),
      ctx,
    )

    expect(out.status).toBe('succeeded')
    expect(executed).toBe(true)

    const v = events.all('rule.violation')
    expect(v).toHaveLength(1)
    expect((v[0] as { rule: string }).rule).toBe('fs.script-location')

    // 被拒的调用没有意图记录 —— 它从未发生
    const invocations = await db.query(
      `select tool_name, outcome from tool_invocations where run_attempt_id = $1`,
      [ctx.attempt.id],
    )
    expect(invocations.rows).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════
// 意图日志：先写意图，再执行（§3.2）
// ═══════════════════════════════════════════════════════

describe('工具意图日志', () => {
  it('工具崩溃时意图已记录且 outcome 为 error', async () => {
    tools.register({
      name: 'flaky',
      description: 'f',
      parameters: {},
      sideEffect: 'non_idempotent',
      execute: async () => {
        throw new Error('boom')
      },
    })

    const ctx = await startRun()
    await exec(
      runnerWith([
        stubCompletion({ toolCalls: [{ name: 'flaky', args: {} }] }),
        submit({ status: 'partial', summary: '工具挂了' }),
      ]),
      ctx,
    )

    const r = await db.query<{ side_effect_class: string; outcome: string; error_code: string }>(
      `select side_effect_class, outcome, error_code from tool_invocations where run_attempt_id = $1`,
      [ctx.attempt.id],
    )
    expect(r.rows[0]!.side_effect_class).toBe('non_idempotent')
    expect(r.rows[0]!.outcome).toBe('error')
    expect(r.rows[0]!.error_code).toBe('tool.crashed')
  })

  it('idempotent 工具带上幂等键，供下游去重', async () => {
    tools.register({
      name: 'put',
      description: 'p',
      parameters: {},
      sideEffect: 'idempotent',
      execute: async () => ({ ok: true, content: 'ok' }),
    })
    const ctx = await startRun()
    await exec(
      runnerWith([
        stubCompletion({ toolCalls: [{ name: 'put', args: { k: 1 } }] }),
        submit({ status: 'ok', summary: 'ok' }),
      ]),
      ctx,
    )
    const r = await db.query<{ idempotency_key: string | null }>(
      `select idempotency_key from tool_invocations where run_attempt_id = $1`,
      [ctx.attempt.id],
    )
    expect(r.rows[0]!.idempotency_key).toContain(ctx.run.id)
  })
})

// ═══════════════════════════════════════════════════════
// 预算：循环 / 无进展 / 步数 / 成本
// ═══════════════════════════════════════════════════════

describe('预算护栏', () => {
  it('同参数重复调用先警告，再触发 loop_detected', async () => {
    let runs = 0
    tools.register({
      name: 'search',
      description: 's',
      parameters: {},
      sideEffect: 'pure',
      execute: async () => {
        runs++
        return { ok: true, content: '同样的结果' }
      },
    })

    const same = stubCompletion({ toolCalls: [{ name: 'search', args: { q: 'x' } }] })
    const ctx = await startRun()
    const out = await exec(runnerWith([same, same, same, same, same]), ctx, {
      ...AGENT,
      maxSteps: 10,
    })

    expect(out.status).toBe('failed')
    expect(out.errorCode).toBe('budget.loop_detected')
    // 只真正执行了一次，后续被拦
    expect(runs).toBe(1)
  })

  it('连续无进展触发 no_progress', async () => {
    const ctx = await startRun()
    const chatter = stubCompletion({ content: '我在想…' })
    const out = await exec(runnerWith([chatter, chatter, chatter, chatter, chatter]), ctx, {
      ...AGENT,
      maxSteps: 20,
    })
    expect(out.status).toBe('failed')
    expect(out.errorCode).toBe('budget.no_progress')
  })

  it('超过步数上限落 steps_exceeded', async () => {
    tools.register({
      name: 'tick',
      description: 't',
      parameters: {},
      sideEffect: 'pure',
      execute: async () => ({ ok: true, content: 'ok' }),
    })
    let n = 0
    const router = new ModelRouter(db, deps, MODELS, () => null, {
      fetch: (async () => {
        n++
        return stubCompletion({ toolCalls: [{ name: 'tick', args: { n } }] })
      }) as never,
      inPlaceRetries: 0,
    })
    const runner = new Runner(db, deps, router, tools, events, { heartbeatMs: 3_600_000 })
    const ctx = await startRun()
    const out = await runner.execute({
      attemptId: ctx.attempt.id,
      fenceToken: ctx.attempt.fenceToken!,
      runId: ctx.run.id,
      agent: { ...AGENT, maxSteps: 3 },
      messages: [{ role: 'user', content: 'go' }],
      workdir: '/tmp',
    })
    expect(out.status).toBe('failed')
    expect(out.errorCode).toBe('budget.steps_exceeded')
    expect(out.stepsUsed).toBe(3)
  })

  it('超过成本上限落 cost_exceeded', async () => {
    const ctx = await startRun()
    const expensive = stubCompletion({ content: '...' }, { in: 5_000_000, out: 0 })
    const out = await exec(runnerWith([expensive]), ctx, { ...AGENT, maxCostUsd: 1 })
    expect(out.status).toBe('failed')
    expect(out.errorCode).toBe('budget.cost_exceeded')
  })
})

// ═══════════════════════════════════════════════════════
// 大输出：截断 + 落 artifact，并标 untrusted
// ═══════════════════════════════════════════════════════

describe('工具输出处理', () => {
  it('超长输出落 artifact 并标记为 untrusted_tool_output', async () => {
    tools.register({
      name: 'fetch',
      description: 'f',
      parameters: {},
      sideEffect: 'pure',
      maxOutputChars: 200,
      execute: async () => ({ ok: true, content: '网页内容'.repeat(500) }),
    })

    const ctx = await startRun()
    await exec(
      runnerWith([
        stubCompletion({ toolCalls: [{ name: 'fetch', args: {} }] }),
        submit({ status: 'ok', summary: 'ok' }),
      ]),
      ctx,
    )

    const a = await db.query<{ ref: string; trust_level: string }>(
      `select ref, trust_level from artifacts where run_id = $1`,
      [ctx.run.id],
    )
    expect(a.rows).toHaveLength(1)
    // 持久化 prompt injection 的防线：工具输出不可信
    expect(a.rows[0]!.trust_level).toBe('untrusted_tool_output')
  })
})

// ═══════════════════════════════════════════════════════
// 失败路径：永远写终态
// ═══════════════════════════════════════════════════════

describe('失败即终态', () => {
  it('provider 全链失败也写终态，不留悬挂', async () => {
    const ctx = await startRun()
    const router = new ModelRouter(db, deps, MODELS, () => null, {
      fetch: scriptedFetch([new Response('{"error":{"message":"down"}}', { status: 500 })]),
      inPlaceRetries: 0,
    })
    const runner = new Runner(db, deps, router, tools, events, { heartbeatMs: 3_600_000 })
    const out = await exec(runner, ctx)

    expect(out.status).toBe('failed')
    const run = await store.getRun(ctx.run.id)
    expect(run!.status).toBe('failed')
    expect(run!.endedAt).not.toBeNull()
    expect((await store.getAttempt(ctx.attempt.id))!.status).toBe('failed')
  })

  it('取消时落终态且 error_code 正确', async () => {
    const ctl = new AbortController()
    tools.register({
      name: 'slow',
      description: 's',
      parameters: {},
      sideEffect: 'pure',
      execute: async () => {
        ctl.abort()
        return { ok: true, content: 'done' }
      },
    })
    const ctx = await startRun()
    const runner = runnerWith([
      stubCompletion({ toolCalls: [{ name: 'slow', args: {} }] }),
      submit({ status: 'ok', summary: 'never' }),
    ])
    const out = await runner.execute({
      attemptId: ctx.attempt.id,
      fenceToken: ctx.attempt.fenceToken!,
      runId: ctx.run.id,
      agent: AGENT,
      messages: [{ role: 'user', content: 'go' }],
      workdir: '/tmp',
      signal: ctl.signal,
    })
    expect(out.status).toBe('failed')
    expect(out.errorCode).toBe('runtime.cancelled')
  })
})

// ═══════════════════════════════════════════════════════
// 推理模型：截断诊断与 thinking 隔离
// ═══════════════════════════════════════════════════════

describe('推理模型', () => {
  /** 模拟 gemma4 的响应形状：思考在 reasoning，content 可能为空 */
  function reasoning(opts: {
    content?: string
    reasoning?: string
    submit?: Record<string, unknown>
    finish?: string
  }): Response {
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: opts.content ?? '',
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    }
    if (opts.submit) {
      message['tool_calls'] = [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'submit_result', arguments: JSON.stringify(opts.submit) },
        },
      ]
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message,
            finish_reason: opts.finish ?? (opts.submit ? 'tool_calls' : 'stop'),
          },
        ],
        usage: { prompt_tokens: 29, completion_tokens: 132 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  it('思考过程写进事件流，不进 messages —— 否则会污染会话历史', async () => {
    const ctx = await startRun()
    await exec(
      runnerWith([
        reasoning({
          reasoning: '这是内部推理，不该出现在历史里',
          submit: { status: 'ok', summary: '完成' },
        }),
      ]),
      ctx,
    )

    const emitted = events.find('llm.reasoning') as { excerpt: string; chars: number } | undefined
    expect(emitted).toBeDefined()
    expect(emitted!.excerpt).toContain('内部推理')
    expect(emitted!.chars).toBeGreaterThan(0)
  })

  it('输出截断报 output_truncated，而不是误报 no_progress', async () => {
    const ctx = await startRun()
    const truncated = reasoning({
      content: '',
      reasoning: '思考占满了预算…',
      finish: 'length',
    })

    const out = await exec(runnerWith([truncated, truncated, truncated]), ctx)

    // 真实原因是预算不够；报 no_progress 会让人查错方向
    expect(out.errorCode).toBe('provider.output_truncated')
    expect(out.status).toBe('failed')
  })

  it('截断错误带上诊断信息与可操作提示', async () => {
    const ctx = await startRun()
    const out = await exec(
      runnerWith([reasoning({ finish: 'length', reasoning: 'x'.repeat(100) })]),
      ctx,
    )

    const detail = out.errorDetail as { hint: string; reasoningChars: number; tokensOut: number }
    expect(detail.hint).toContain('maxTokens')
    expect(detail.reasoningChars).toBe(100)
    expect(detail.tokensOut).toBeGreaterThan(0)
  })

  it('截断但仍给出了工具调用时不算失败', async () => {
    const ctx = await startRun()
    const out = await exec(
      runnerWith([
        reasoning({ finish: 'length', submit: { status: 'ok', summary: '赶在截断前提交了' } }),
      ]),
      ctx,
    )
    expect(out.status).toBe('succeeded')
  })

  it('content 为空且无工具调用时不发空 assistant 消息', async () => {
    // 多数 provider 拒绝空 content 的 assistant 消息
    const ctx = await startRun()
    const out = await exec(
      runnerWith([
        reasoning({ content: '', reasoning: '想了但没说' }),
        reasoning({ submit: { status: 'ok', summary: '第二次说了' } }),
      ]),
      ctx,
    )
    expect(out.status).toBe('succeeded')
  })
})
