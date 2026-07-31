import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { ModelRouter } from '../src/providers/router.js'
import type { ModelConfig } from '../src/providers/types.js'
import { cassetteFetch } from './harness/provider.js'

/**
 * tier 2：基于**真实模型响应**的离线回放。
 *
 * fixture 由 llama3.2 经 ollama 的 OpenAI 兼容端点真实产生
 * （采集方式见 test/live/build-fixtures.ts —— 本机对 Node 进程禁止出网，
 * 所以用 curl 采集后装配成 cassette）。
 *
 * 它验证的是**协议解析的正确性**：真实的 tool_calls 形状、真实的 SSE 分片
 * 边界、真实的 usage 字段。这些用手写 stub 很容易写成「我以为的样子」。
 *
 * 前沿模型的 schema 遵守率不在此列 —— 那只能在部署机上测。
 */

const MODELS = new Map<string, ModelConfig>([
  [
    'ollama:live',
    {
      key: 'ollama:live',
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434/v1',
      costPerMTokIn: 0,
      costPerMTokOut: 0,
    },
  ],
])

const TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

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

function router(cassette: string) {
  return new ModelRouter(db, deps, MODELS, () => null, {
    fetch: cassetteFetch(cassette),
    inPlaceRetries: 0,
  })
}

describe('真实响应回放', () => {
  it('基本对话：内容与真实 usage', async () => {
    const res = await router('live-basic').chat(['ollama:live'], {
      messages: [
        { role: 'system', content: 'Answer with exactly one word.' },
        { role: 'user', content: 'What is the capital of Japan?' },
      ],
      temperature: 0,
      maxTokens: 16,
    })

    expect(res.content.toLowerCase()).toContain('tokyo')
    expect(res.finishReason).toBe('stop')
    // 真实 usage：成本核算依赖它
    expect(res.usage).toEqual({ tokensIn: 38, tokensOut: 4, cacheRead: 0 })
  })

  it('工具调用：真实 tool_calls 形状能被正确解析', async () => {
    const res = await router('live-tools').chat(['ollama:live'], {
      messages: [{ role: 'user', content: 'What is the weather in Tokyo? Use the tool.' }],
      temperature: 0,
      tools: [TOOL],
    })

    expect(res.finishReason).toBe('tool_calls')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]!.name).toBe('get_weather')
    expect(res.toolCalls[0]!.id).toBe('call_1tgpoe4x')
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({ city: 'Tokyo' })
  })

  it('多轮：工具结果回灌后模型给出最终答复', async () => {
    const call = { id: 'call_1tgpoe4x', name: 'get_weather', arguments: '{"city":"Tokyo"}' }
    const res = await router('live-roundtrip').chat(['ollama:live'], {
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo? Use the tool.' },
        { role: 'assistant', content: '', toolCalls: [call] },
        {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: '{"tempC":18,"sky":"clear"}',
        },
      ],
      temperature: 0,
      maxTokens: 64,
      tools: [TOOL],
    })

    // 模型确实读到了工具返回的数据
    expect(res.content).toMatch(/18/)
    expect(res.content).toMatch(/clear/i)
    expect(res.finishReason).toBe('stop')
  })

  it('流式：真实 SSE 分片累积后与完整内容一致', async () => {
    const chunks: string[] = []
    const res = await router('live-stream').chat(['ollama:live'], {
      messages: [{ role: 'user', content: 'Count from 1 to 5, comma separated.' }],
      temperature: 0,
      maxTokens: 32,
      onDelta: (d) => {
        if (d.text) chunks.push(d.text)
      },
    })

    // 真实分片：一次一个 token 左右
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.join('')).toBe(res.content)
    expect(res.content).toMatch(/1.*2.*3.*4.*5/s)
  })

  it('成功调用后 provider 健康状态被写入', async () => {
    const r = router('live-basic')
    await r.chat(['ollama:live'], {
      messages: [
        { role: 'system', content: 'Answer with exactly one word.' },
        { role: 'user', content: 'What is the capital of Japan?' },
      ],
      temperature: 0,
      maxTokens: 16,
    })
    const h = await r.health.get('ollama:live')
    expect(h.breakerState).toBe('closed')
    expect(h.consecutiveErrors).toBe(0)
  })

  it('未命中 fixture 时给出可操作的报错，而不是静默通过', async () => {
    await expect(
      router('live-basic').chat(['ollama:live'], {
        messages: [{ role: 'user', content: '一个从未录制过的问题' }],
      }),
    ).rejects.toThrow(/未命中|NUCLEUS_RECORD/)
  })
})
