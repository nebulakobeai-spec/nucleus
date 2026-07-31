import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { NucleusError, recoveryOf, ERRORS } from '../src/errors.js'
import { ModelRouter, detectRepetition } from '../src/providers/router.js'
import { ProviderHealth } from '../src/providers/health.js'
import { parseDuration, parseRateLimitHeaders } from '../src/providers/openai-compat.js'
import type { ModelConfig } from '../src/providers/types.js'
import { scriptedFetch, stubCompletion, stubError, stubStream } from './harness/provider.js'

let db: Db
let clock: FakeClock
let deps: Deps

const MODELS = new Map<string, ModelConfig>([
  [
    'zai:glm',
    {
      key: 'zai:glm',
      provider: 'zai',
      model: 'glm-4.7',
      baseUrl: 'https://api.z.ai/v1',
      apiKeyRef: 'ZAI_API_KEY',
      costPerMTokIn: 0.6,
      costPerMTokOut: 2.2,
      costPerMTokCacheRead: 0.11,
    },
  ],
  [
    'kimi:k2',
    {
      key: 'kimi:k2',
      provider: 'kimi',
      model: 'k2',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKeyRef: 'MOONSHOT_API_KEY',
      costPerMTokIn: 1,
      costPerMTokOut: 3,
    },
  ],
  [
    'ollama:llama',
    {
      key: 'ollama:llama',
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434/v1',
      costPerMTokIn: 0,
      costPerMTokOut: 0,
    },
  ],
])

const CHAIN = ['zai:glm', 'kimi:k2', 'ollama:llama']
const secrets = (ref?: string) => (ref ? `fake-${ref}` : null)

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  clock = new FakeClock()
  deps = { clock, ids: new FakeIds() }
})

afterEach(async () => {
  await db.close()
})

function router(fetchImpl: ReturnType<typeof scriptedFetch>, opts = {}) {
  return new ModelRouter(db, deps, MODELS, secrets, {
    fetch: fetchImpl,
    inPlaceRetries: 0,
    ...opts,
  })
}

// ═══════════════════════════════════════════════════════
// 错误分类学
// ═══════════════════════════════════════════════════════

describe('error taxonomy', () => {
  it('每个 error_code 都声明了 recovery', () => {
    for (const [code, s] of ERRORS) {
      expect(['automatic', 'needs_user', 'terminal']).toContain(s.recovery)
      expect(s.code).toBe(code)
      expect(s.message.length).toBeGreaterThan(0)
    }
  })

  it('未注册的 code 会在 message 里暴露出来', () => {
    const e = new NucleusError('made.up')
    expect(e.message).toMatch(/未注册的 error_code/)
    expect(e.recovery).toBe('needs_user') // 保守默认
  })

  it('恢复性分类符合语义', () => {
    expect(recoveryOf('provider.rate_limited')).toBe('automatic')
    expect(recoveryOf('tool.side_effect_unknown')).toBe('needs_user')
    expect(recoveryOf('runtime.cancelled')).toBe('terminal')
  })
})

// ═══════════════════════════════════════════════════════
// 响应头解析（OpenAI/xAI 有，z.ai/Kimi 基本没有）
// ═══════════════════════════════════════════════════════

describe('rate limit 头解析', () => {
  it('解析 OpenAI 风格的时长格式', () => {
    expect(parseDuration('1s')).toBe(1000)
    expect(parseDuration('6m0s')).toBe(360_000)
    expect(parseDuration('300ms')).toBe(300)
    expect(parseDuration('1h2m3s')).toBe(3_723_000)
  })

  it('从响应头学到剩余额度与重置时间', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '42',
      'x-ratelimit-remaining-tokens': '9000',
      'x-ratelimit-reset-requests': '30s',
    })
    const info = parseRateLimitHeaders(h, 1_000_000)
    expect(info?.remainingRequests).toBe(42)
    expect(info?.remainingTokens).toBe(9000)
    expect(info?.resetAt).toBe(1_030_000)
  })

  it('没有相关头时返回 undefined（z.ai / Kimi 的情形）', () => {
    expect(parseRateLimitHeaders(new Headers({ 'content-type': 'application/json' }), 0)).toBeUndefined()
  })

  it('解析 retry-after', () => {
    expect(parseRateLimitHeaders(new Headers({ 'retry-after': '7' }), 0)?.retryAfterMs).toBe(7000)
  })
})

// ═══════════════════════════════════════════════════════
// 基本调用与成本
// ═══════════════════════════════════════════════════════

describe('chat', () => {
  it('返回内容、用量与成本', async () => {
    const f = scriptedFetch([stubCompletion({ content: 'hi' }, { in: 1000, out: 500 })])
    const res = await router(f).chat(CHAIN, { messages: [{ role: 'user', content: 'yo' }] })

    expect(res.content).toBe('hi')
    expect(res.modelKey).toBe('zai:glm')
    expect(res.usage).toEqual({ tokensIn: 1000, tokensOut: 500, cacheRead: 0 })
    // 1000/1e6*0.6 + 500/1e6*2.2
    expect(res.costUsd).toBeCloseTo(0.0017, 6)
  })

  it('缓存读取按更低单价计费', async () => {
    const f = scriptedFetch([stubCompletion({ content: 'x' }, { in: 1000, out: 0, cached: 800 })])
    const res = await router(f).chat(CHAIN, { messages: [] })
    // 200 未命中 *0.6 + 800 命中 *0.11
    expect(res.costUsd).toBeCloseTo((200 * 0.6 + 800 * 0.11) / 1e6, 9)
  })

  it('解析工具调用', async () => {
    const f = scriptedFetch([
      stubCompletion({ toolCalls: [{ name: 'get_weather', args: { city: 'Tokyo' } }] }),
    ])
    const res = await router(f).chat(CHAIN, { messages: [] })
    expect(res.finishReason).toBe('tool_calls')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]!.name).toBe('get_weather')
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({ city: 'Tokyo' })
  })

  it('不发送 api key 到没有 apiKeyRef 的 provider', async () => {
    const f = scriptedFetch([stubError(500), stubError(500), stubCompletion({ content: 'local' })])
    const res = await router(f).chat(CHAIN, { messages: [] })
    expect(res.modelKey).toBe('ollama:llama')
    expect(f.calls).toHaveLength(3)
  })
})

// ═══════════════════════════════════════════════════════
// 流式：工具参数分片累积（最易出静默 bug 的地方）
// ═══════════════════════════════════════════════════════

describe('流式', () => {
  it('累积文本增量', async () => {
    const f = scriptedFetch([
      stubStream([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ]),
    ])
    const seen: string[] = []
    const res = await router(f).chat(CHAIN, {
      messages: [],
      onDelta: (d) => d.text && seen.push(d.text),
    })
    expect(res.content).toBe('Hello')
    expect(seen).toEqual(['Hel', 'lo'])
    expect(res.usage.tokensOut).toBe(2)
  })

  it('工具参数跨分片累积后仍是完整 JSON', async () => {
    const f = scriptedFetch([
      stubStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":' } }],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"foo ' } }] } },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'bar"}' } }] } },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    ])
    const res = await router(f).chat(CHAIN, { messages: [], onDelta: () => {} })
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]!.id).toBe('c1')
    expect(res.toolCalls[0]!.name).toBe('search')
    // 分片累积错误会让这里解析失败或内容截断
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({ q: 'foo bar' })
  })

  it('多个并行工具调用按 index 分别累积', async () => {
    const f = scriptedFetch([
      stubStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'a', function: { name: 'f1', arguments: '{"x":1' } },
                  { index: 1, id: 'b', function: { name: 'f2', arguments: '{"y":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, function: { arguments: '2}' } },
                  { index: 0, function: { arguments: '}' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    ])
    const res = await router(f).chat(CHAIN, { messages: [], onDelta: () => {} })
    expect(res.toolCalls.map((t) => t.name)).toEqual(['f1', 'f2'])
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({ x: 1 })
    expect(JSON.parse(res.toolCalls[1]!.arguments)).toEqual({ y: 2 })
  })
})

// ═══════════════════════════════════════════════════════
// 429 / 熔断 / preflight —— 「不逐个试」
// ═══════════════════════════════════════════════════════

describe('限流与熔断', () => {
  it('区分 rate_limited 与 quota_exhausted', async () => {
    const f1 = scriptedFetch([stubError(429, { error: { message: 'slow down' } }), stubCompletion({ content: 'ok' })])
    const r1 = await router(f1).chat(CHAIN, { messages: [] })
    expect(r1.attempts[0]!.errorCode).toBe('provider.rate_limited')

    await db.query(`delete from provider_state`)

    const f2 = scriptedFetch([
      stubError(429, { error: { message: "You've reached your usage limit" } }),
      stubCompletion({ content: 'ok' }),
    ])
    const r2 = await router(f2).chat(CHAIN, { messages: [] })
    expect(r2.attempts[0]!.errorCode).toBe('provider.quota_exhausted')
  })

  it('额度耗尽的模型立刻熔断，下次 preflight 直接跳过（不再浪费调用）', async () => {
    const f = scriptedFetch([
      stubError(429, { error: { message: 'usage limit exceeded' } }),
      stubCompletion({ content: 'from kimi' }),
    ])
    const r = router(f)
    const first = await r.chat(CHAIN, { messages: [] })
    expect(first.modelKey).toBe('kimi:k2')
    expect(f.calls).toHaveLength(2)

    // 第二次：zai 已熔断，preflight 应直接选 kimi —— 总调用数只 +1
    const f2 = scriptedFetch([stubCompletion({ content: 'again' })])
    const r2 = router(f2)
    const second = await r2.chat(CHAIN, { messages: [] })
    expect(second.modelKey).toBe('kimi:k2')
    expect(f2.calls).toHaveLength(1)
    expect(f2.calls[0]!.body['model']).toBe('k2')
  })

  it('连续失败达阈值后熔断', async () => {
    const health = new ProviderHealth(db, clock, { errorThreshold: 3, breakerMs: 60_000 })
    for (let i = 0; i < 2; i++) await health.noteFailure('zai:glm', 'provider.server_error')
    expect((await health.get('zai:glm')).breakerState).toBe('closed')

    await health.noteFailure('zai:glm', 'provider.server_error')
    expect((await health.get('zai:glm')).breakerState).toBe('open')
  })

  it('熔断到期转半开，成功后恢复 closed', async () => {
    const health = new ProviderHealth(db, clock, { errorThreshold: 1, breakerMs: 60_000 })
    await health.noteFailure('zai:glm', 'provider.server_error')
    expect((await health.get('zai:glm')).breakerState).toBe('open')

    await clock.advance(59_000)
    expect(await health.tickBreakers()).toEqual([])

    await clock.advance(2_000)
    expect(await health.tickBreakers()).toEqual(['zai:glm'])
    expect((await health.get('zai:glm')).breakerState).toBe('half_open')

    await health.noteSuccess('zai:glm')
    const h = await health.get('zai:glm')
    expect(h.breakerState).toBe('closed')
    expect(h.consecutiveErrors).toBe(0)
  })

  it('全链不可用时抛 all_exhausted 并带最早可用时间，不发任何请求', async () => {
    const health = new ProviderHealth(db, clock, { errorThreshold: 1, breakerMs: 60_000 })
    for (const k of CHAIN) await health.noteFailure(k, 'provider.server_error')

    const f = scriptedFetch([stubCompletion({ content: 'should not be called' })])
    await expect(router(f).chat(CHAIN, { messages: [] })).rejects.toMatchObject({
      code: 'provider.all_exhausted',
    })
    expect(f.calls).toHaveLength(0) // 关键：一次调用都没浪费

    const err = await router(f)
      .chat(CHAIN, { messages: [] })
      .catch((e: NucleusError) => e)
    expect((err as NucleusError).retryAfterMs).toBeGreaterThan(0)
    expect((err as NucleusError).recovery).toBe('needs_user')
  })

  it('鉴权失败熔断更久 —— 重试没有意义', async () => {
    const health = new ProviderHealth(db, clock, { errorThreshold: 3, breakerMs: 60_000 })
    await health.noteFailure('zai:glm', 'provider.auth_failed')
    const h = await health.get('zai:glm')
    expect(h.breakerState).toBe('open')
    expect(h.breakerUntil!.getTime() - clock.now()).toBeGreaterThan(60_000)
  })

  it('bad_request 不切换模型 —— 换了也没用', async () => {
    const f = scriptedFetch([stubError(400, { error: { message: 'bad schema' } })])
    await expect(router(f).chat(CHAIN, { messages: [] })).rejects.toMatchObject({
      code: 'provider.bad_request',
    })
    expect(f.calls).toHaveLength(1)
  })

  it('成功后把学到的额度写入 provider_state', async () => {
    const f = scriptedFetch([
      stubCompletion({ content: 'ok' }, {}, {
        'x-ratelimit-remaining-requests': '17',
        'x-ratelimit-reset-requests': '10s',
      }),
    ])
    const r = router(f)
    await r.chat(CHAIN, { messages: [] })
    const h = await r.health.get('zai:glm')
    expect(h.remainingRequests).toBe(17)
    expect(h.quotaResetAt).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// 退化检测
// ═══════════════════════════════════════════════════════

describe('退化检测', () => {
  it('识别重复输出', () => {
    expect(detectRepetition('好的，我来帮你处理。'.repeat(10))).toBe(true)
    expect(detectRepetition('I will now proceed. '.repeat(8))).toBe(true)
  })

  it('不误判正常文本', () => {
    const normal =
      '这是一段正常的技术说明，讨论了系统的可靠性契约、状态机设计以及重试策略的取舍。' +
      '其中提到 reconciler 的作用是把数据库记录的状态与现实对齐，而心跳由进程写库来证明。'
    expect(detectRepetition(normal)).toBe(false)
    expect(detectRepetition('short')).toBe(false)
  })

  it('退化输出触发换 provider 重试', async () => {
    const f = scriptedFetch([
      stubCompletion({ content: '重复重复重复重复'.repeat(20) }),
      stubCompletion({ content: '正常回答' }),
    ])
    const res = await router(f).chat(CHAIN, { messages: [] })
    expect(res.attempts[0]!.errorCode).toBe('provider.degenerate_output')
    expect(res.content).toBe('正常回答')
    expect(res.modelKey).toBe('kimi:k2')
  })
})

// ═══════════════════════════════════════════════════════
// 就地重试与取消
// ═══════════════════════════════════════════════════════

describe('重试与取消', () => {
  it('可重试错误在同一模型上先就地重试', async () => {
    const f = scriptedFetch([stubError(500), stubCompletion({ content: 'recovered' })])
    const r = new ModelRouter(db, deps, MODELS, secrets, { fetch: f, inPlaceRetries: 1 })
    const p = r.chat(CHAIN, { messages: [] })
    // 等 router 真正进入退避 sleep 再推进时钟，避免 advance 跑在注册之前
    await clock.advanceWhenPending(1000)
    const res = await p
    expect(res.modelKey).toBe('zai:glm')
    expect(res.content).toBe('recovered')
    expect(res.attempts).toEqual([])
  })

  it('取消直接上抛，不当作 provider 故障', async () => {
    const ctl = new AbortController()
    const f = scriptedFetch([
      () => {
        ctl.abort()
        throw new Error('aborted')
      },
    ])
    await expect(
      router(f).chat(CHAIN, { messages: [], signal: ctl.signal }),
    ).rejects.toMatchObject({ code: 'runtime.cancelled' })

    // 不应因取消而记为 provider 失败
    const h = await new ProviderHealth(db, clock).get('zai:glm')
    expect(h.consecutiveErrors).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════
// 推理模型：thinking 与最终回复分离
// ═══════════════════════════════════════════════════════

describe('推理模型的 reasoning 字段', () => {
  /** ollama 对 gemma4 / deepseek-r1 这类模型的真实响应形状 */
  function reasoningResponse(opts: {
    content?: string
    reasoning?: string
    toolCalls?: Array<{ name: string; args: unknown }>
    finish?: string
  }): () => Response {
    return () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: opts.content ?? '',
                ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
                ...(opts.toolCalls
                  ? {
                      tool_calls: opts.toolCalls.map((t, i) => ({
                        id: `call_${i}`,
                        type: 'function',
                        function: { name: t.name, arguments: JSON.stringify(t.args) },
                      })),
                    }
                  : {}),
              },
              finish_reason: opts.finish ?? (opts.toolCalls ? 'tool_calls' : 'stop'),
            },
          ],
          usage: { prompt_tokens: 29, completion_tokens: 132 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
  }

  it('reasoning 与 content 分开解析，不混进 content', async () => {
    const f = scriptedFetch([
      reasoningResponse({ content: '最终答案是 4', reasoning: '用户问 2+2，计算得 4。' }),
    ])
    const res = await router(f).chat(CHAIN, { messages: [] })

    expect(res.content).toBe('最终答案是 4')
    expect(res.reasoning).toBe('用户问 2+2，计算得 4。')
    // 关键：思考不能出现在 content 里，否则会被存入会话历史
    expect(res.content).not.toContain('用户问')
  })

  it('也识别 reasoning_content（部分实现用这个名字）', async () => {
    const f = scriptedFetch([
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { role: 'assistant', content: 'ok', reasoning_content: '思考中' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ])
    const res = await router(f).chat(CHAIN, { messages: [] })
    expect(res.reasoning).toBe('思考中')
  })

  it('content 为空但有 tool_calls 时正常工作 —— gemma4 的典型形状', async () => {
    const f = scriptedFetch([
      reasoningResponse({
        content: '',
        reasoning: '应该调用 get_weather 工具。',
        toolCalls: [{ name: 'get_weather', args: { city: 'Tokyo' } }],
      }),
    ])
    const res = await router(f).chat(CHAIN, { messages: [] })

    expect(res.content).toBe('')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.finishReason).toBe('tool_calls')
    expect(res.reasoning).toContain('get_weather')
  })

  it('非推理模型不产生 reasoning 字段', async () => {
    const f = scriptedFetch([stubCompletion({ content: 'plain' })])
    const res = await router(f).chat(CHAIN, { messages: [] })
    expect(res.reasoning).toBeUndefined()
  })

  it('流式下 reasoning 增量单独累积，不推给 UI', async () => {
    const seen: string[] = []
    const f = scriptedFetch([
      stubStream([
        { choices: [{ delta: { reasoning: '先想' } }] },
        { choices: [{ delta: { reasoning: '一想' } }] },
        { choices: [{ delta: { content: '答案' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    ])
    const res = await router(f).chat(CHAIN, {
      messages: [],
      onDelta: (d) => d.text && seen.push(d.text),
    })

    expect(res.content).toBe('答案')
    expect(res.reasoning).toBe('先想一想')
    // 思考不属于最终回复，不该推给前端渲染
    expect(seen).toEqual(['答案'])
  })
})
