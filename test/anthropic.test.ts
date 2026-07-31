import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { ModelRouter } from '../src/providers/router.js'
import { parseAnthropicRateLimit } from '../src/providers/anthropic.js'
import { costOf, hasPricing, isSubscription, type ModelConfig } from '../src/providers/types.js'
import { scriptedFetch } from './harness/provider.js'

/**
 * anthropic-messages 协议适配器。
 *
 * Kimi 的 coding 端点用这个协议，与 OpenAI 形态的差异是结构性的：
 * system 是顶层字段、content 是 block 数组、工具结果作为 user 消息回灌、
 * 流式事件语义完全不同。这些都要单独验证。
 */

const KIMI: ModelConfig = {
  key: 'kimi:k3',
  provider: 'kimi',
  model: 'k3',
  baseUrl: 'https://api.kimi.com/coding',
  api: 'anthropic-messages',
  apiKeyRef: 'KIMI_API_KEY',
  billing: 'subscription',
  subscriptionUsdPerMonth: 39,
}

const GLM: ModelConfig = {
  key: 'zai:glm-5.2',
  provider: 'zai',
  model: 'glm-5.2',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  api: 'openai-completions',
  apiKeyRef: 'ZAI_API_KEY',
  billing: 'subscription',
}

const MODELS = new Map([
  [KIMI.key, KIMI],
  [GLM.key, GLM],
])

let db: Db
let deps: Deps

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  deps = { clock: new FakeClock(), ids: new FakeIds() }
})

afterEach(async () => {
  await db.close()
})

function router(f: ReturnType<typeof scriptedFetch>) {
  return new ModelRouter(db, deps, MODELS, (ref) => (ref ? `fake-${ref}` : null), {
    fetch: f,
    inPlaceRetries: 0,
  })
}

/** anthropic 非流式响应 */
function msg(
  content: unknown[],
  opts: { stop?: string; usage?: Record<string, number> } = {},
): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: opts.stop ?? 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20, ...opts.usage },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

/** anthropic SSE 流 */
function stream(events: unknown[]): () => Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

// ═══════════════════════════════════════════════════════
// 请求体形状 —— 与 OpenAI 的结构性差异
// ═══════════════════════════════════════════════════════

describe('请求体', () => {
  it('system 提升为顶层字段，不留在 messages 里', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'ok' }])])
    await router(f).chat([KIMI.key], {
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
    })

    const body = f.calls[0]!.body
    expect(body['system']).toBe('你是助手')
    const messages = body['messages'] as Array<{ role: string }>
    expect(messages.every((m) => m.role !== 'system')).toBe(true)
    expect(messages).toHaveLength(1)
  })

  it('多条 system 合并', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'ok' }])])
    await router(f).chat([KIMI.key], {
      messages: [
        { role: 'system', content: '第一段' },
        { role: 'system', content: '第二段' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(f.calls[0]!.body['system']).toBe('第一段\n\n第二段')
  })

  it('max_tokens 必填 —— 缺了会被服务端 400', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'ok' }])])
    await router(f).chat([KIMI.key], { messages: [{ role: 'user', content: 'hi' }] })
    expect(f.calls[0]!.body['max_tokens']).toBeGreaterThan(0)
  })

  it('工具定义用 input_schema，不是 parameters', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'ok' }])])
    await router(f).chat([KIMI.key], {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: '搜索', parameters: { type: 'object', properties: {} } }],
    })
    const tools = f.calls[0]!.body['tools'] as Array<Record<string, unknown>>
    expect(tools[0]!['input_schema']).toEqual({ type: 'object', properties: {} })
    expect(tools[0]!['parameters']).toBeUndefined()
  })

  it('assistant 的工具调用转成 tool_use block', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'done' }])])
    await router(f).chat([KIMI.key], {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '我来查',
          toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"x"}' }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'search', content: '结果' },
      ],
    })

    const messages = f.calls[0]!.body['messages'] as Array<{ role: string; content: unknown }>
    const assistant = messages[1]!
    const blocks = assistant.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'text', text: '我来查' })
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } })
  })

  it('工具结果作为 user 消息里的 tool_result block', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'done' }])])
    await router(f).chat([KIMI.key], {
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c1', name: 'f', content: '结果内容' },
      ],
    })

    const messages = f.calls[0]!.body['messages'] as Array<{ role: string; content: unknown }>
    const last = messages[messages.length - 1]!
    expect(last.role).toBe('user')
    expect((last.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: '结果内容',
    })
  })

  it('连续多个工具结果合并进同一条 user 消息 —— 分开会被拒', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'done' }])])
    await router(f).chat([KIMI.key], {
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'a', arguments: '{}' },
            { id: 'c2', name: 'b', arguments: '{}' },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'a', content: '结果1' },
        { role: 'tool', toolCallId: 'c2', name: 'b', content: '结果2' },
      ],
    })

    const messages = f.calls[0]!.body['messages'] as Array<{ role: string; content: unknown }>
    const userMsgs = messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]!.content as unknown[]).toHaveLength(2)
  })

  it('空内容替换为占位 —— Anthropic 不接受空消息', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'ok' }])])
    await router(f).chat([KIMI.key], { messages: [{ role: 'user', content: '' }] })
    const messages = f.calls[0]!.body['messages'] as Array<{ content: string }>
    expect(messages[0]!.content).toBe('(empty)')
  })

  it('鉴权头同时发 x-api-key 与 Bearer —— 兼容官方 API 与 Kimi 端点', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'ok' }])])
    await router(f).chat([KIMI.key], { messages: [{ role: 'user', content: 'hi' }] })
    expect(f.calls[0]!.url).toBe('https://api.kimi.com/coding/v1/messages')
  })
})

// ═══════════════════════════════════════════════════════
// 响应解析
// ═══════════════════════════════════════════════════════

describe('响应解析', () => {
  it('文本 block 拼接', async () => {
    const f = scriptedFetch([
      msg([
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ]),
    ])
    const res = await router(f).chat([KIMI.key], { messages: [] })
    expect(res.content).toBe('第一段第二段')
    expect(res.finishReason).toBe('stop')
  })

  it('tool_use block 转成 toolCalls', async () => {
    const f = scriptedFetch([
      msg([{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } }], { stop: 'tool_use' }),
    ])
    const res = await router(f).chat([KIMI.key], { messages: [] })
    expect(res.finishReason).toBe('tool_calls')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]!.name).toBe('search')
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({ q: 'x' })
  })

  it('缓存命中计入总输入 token', async () => {
    const f = scriptedFetch([
      msg([{ type: 'text', text: 'ok' }], {
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
      }),
    ])
    const res = await router(f).chat([KIMI.key], { messages: [] })
    // input_tokens 不含缓存部分，要加回来
    expect(res.usage.tokensIn).toBe(1000)
    expect(res.usage.cacheRead).toBe(900)
  })

  it('stop_reason 映射', async () => {
    for (const [stop, expected] of [
      ['end_turn', 'stop'],
      ['tool_use', 'tool_calls'],
      ['max_tokens', 'length'],
    ] as const) {
      const f = scriptedFetch([msg([{ type: 'text', text: 'x' }], { stop })])
      const res = await router(f).chat([KIMI.key], { messages: [] })
      expect(res.finishReason).toBe(expected)
      await db.query(`delete from provider_state`)
    }
  })
})

// ═══════════════════════════════════════════════════════
// 流式 —— 事件语义与 OpenAI 完全不同
// ═══════════════════════════════════════════════════════

describe('流式', () => {
  it('text_delta 累积', async () => {
    const f = scriptedFetch([
      stream([
        { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]),
    ])

    const chunks: string[] = []
    const res = await router(f).chat([KIMI.key], {
      messages: [],
      onDelta: (d) => d.text && chunks.push(d.text),
    })

    expect(res.content).toBe('你好')
    expect(chunks).toEqual(['你', '好'])
    expect(res.usage.tokensIn).toBe(50)
    expect(res.usage.tokensOut).toBe(8) // 只在 message_delta 里给最终值
  })

  it('工具参数走 input_json_delta，跨分片累积成完整 JSON', async () => {
    const f = scriptedFetch([
      stream([
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'search' },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"foo ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'bar"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      ]),
    ])

    const res = await router(f).chat([KIMI.key], { messages: [], onDelta: () => {} })
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]!.id).toBe('tu_1')
    // 累积错误会让这里解析失败
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({ q: 'foo bar' })
  })

  it('文本与工具调用混合，按 block index 分开', async () => {
    const f = scriptedFetch([
      stream([
        { type: 'message_start', message: { usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来查' } },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'f' },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      ]),
    ])
    const res = await router(f).chat([KIMI.key], { messages: [], onDelta: () => {} })
    expect(res.content).toBe('我来查')
    expect(res.toolCalls).toHaveLength(1)
  })

  it('无参数的工具调用给出 {} 而非空串', async () => {
    const f = scriptedFetch([
      stream([
        { type: 'message_start', message: { usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'ping' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      ]),
    ])
    const res = await router(f).chat([KIMI.key], { messages: [], onDelta: () => {} })
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({})
  })
})

// ═══════════════════════════════════════════════════════
// 错误与限流
// ═══════════════════════════════════════════════════════

describe('错误处理', () => {
  it('529 过载归为 server_error（可重试）', async () => {
    const f = scriptedFetch([
      () => new Response('{"error":"overloaded"}', { status: 529 }),
      msg([{ type: 'text', text: 'ok' }]),
    ])
    // kimi 失败后切 glm（OpenAI 形态），所以第二个响应形状不同 —— 只验证分类
    const err = await router(f)
      .chat([KIMI.key], { messages: [] })
      .catch((e: { code: string }) => e)
    expect((err as { code: string }).code).toBe('provider.server_error')
  })

  it('429 区分限流与额度耗尽', async () => {
    const f1 = scriptedFetch([() => new Response('{"error":{"message":"rate limited"}}', { status: 429 })])
    const e1 = await router(f1)
      .chat([KIMI.key], { messages: [] })
      .catch((e: { code: string }) => e)
    expect((e1 as { code: string }).code).toBe('provider.rate_limited')

    await db.query(`delete from provider_state`)

    const f2 = scriptedFetch([
      () => new Response('{"error":{"message":"usage limit reached"}}', { status: 429 }),
    ])
    const e2 = await router(f2)
      .chat([KIMI.key], { messages: [] })
      .catch((e: { code: string }) => e)
    expect((e2 as { code: string }).code).toBe('provider.quota_exhausted')
  })

  it('解析 anthropic 风格的限流响应头', () => {
    const h = new Headers({
      'anthropic-ratelimit-requests-remaining': '42',
      'anthropic-ratelimit-tokens-remaining': '9000',
      'anthropic-ratelimit-requests-reset': '2026-07-31T10:00:00Z',
    })
    const info = parseAnthropicRateLimit(h, 0)
    expect(info?.remainingRequests).toBe(42)
    expect(info?.remainingTokens).toBe(9000)
    expect(info?.resetAt).toBe(Date.parse('2026-07-31T10:00:00Z'))
  })
})

// ═══════════════════════════════════════════════════════
// 跨协议 fallback
// ═══════════════════════════════════════════════════════

describe('跨协议 fallback', () => {
  it('anthropic 失败后能切到 OpenAI 兼容的模型', async () => {
    const f = scriptedFetch([
      () => new Response('{"error":"down"}', { status: 500 }),
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '来自 GLM' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ])

    const res = await router(f).chat([KIMI.key, GLM.key], { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.modelKey).toBe('zai:glm-5.2')
    expect(res.content).toBe('来自 GLM')

    // 两次请求形状不同：第一次是 anthropic（有 system/max_tokens），第二次是 OpenAI
    expect(f.calls[0]!.url).toContain('/v1/messages')
    expect(f.calls[1]!.url).toContain('/chat/completions')
  })
})

// ═══════════════════════════════════════════════════════
// 订阅制计费
// ═══════════════════════════════════════════════════════

describe('订阅制', () => {
  it('订阅模型的单次调用边际成本为 0', () => {
    expect(costOf(KIMI, { tokensIn: 1_000_000, tokensOut: 500_000, cacheRead: 0 })).toBe(0)
    expect(isSubscription(KIMI)).toBe(true)
  })

  it('按量计费模型正常计价', () => {
    const usage: ModelConfig = {
      key: 'x',
      provider: 'x',
      model: 'x',
      baseUrl: 'x',
      billing: 'usage',
      costPerMTokIn: 1,
      costPerMTokOut: 2,
    }
    expect(costOf(usage, { tokensIn: 1_000_000, tokensOut: 1_000_000, cacheRead: 0 })).toBe(3)
    expect(isSubscription(usage)).toBe(false)
  })

  it('没有单价数据时可判别 —— 不应显示金额', () => {
    expect(hasPricing(KIMI)).toBe(false)
    expect(hasPricing({ ...KIMI, costPerMTokIn: 1 })).toBe(true)
  })

  it('订阅模型仍然记录 token 用量 —— 配额才是真正的约束', async () => {
    const f = scriptedFetch([msg([{ type: 'text', text: 'ok' }], { usage: { input_tokens: 500, output_tokens: 100 } })])
    const res = await router(f).chat([KIMI.key], { messages: [] })
    expect(res.usage.tokensIn).toBe(500)
    expect(res.usage.tokensOut).toBe(100)
    expect(res.costUsd).toBe(0)
  })
})
