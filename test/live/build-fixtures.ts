import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fingerprint, type RecordedExchange } from '../harness/provider.js'

/**
 * 把 curl 抓下来的真实 ollama 响应转成 cassette fixture。
 *
 * 为什么需要这一步：这台开发机对 **Node 进程**禁止一切出网（包括 localhost），
 * 但 curl 不受限。所以真实交互只能用 curl 采集，再手工装配成 fixture，
 * 让 tier 2 的离线测试仍然基于真实响应而不是我编的响应。
 *
 * 这个文件是一次性工具，跑过之后 fixture 进 git 即可。
 * 在能出网的机器上，直接用 `npm run test:record` 代替。
 */

const BASE = 'http://localhost:11434/v1'
const URL = `${BASE}/chat/completions`
const TOOL_DEF = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
}

const JSON_HEADERS = { 'content-type': 'application/json' }
const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function build(name: string, request: Record<string, unknown>, bodyPath: string, headers: Record<string, string>) {
  const body = readFileSync(bodyPath, 'utf8')
  const entry: RecordedExchange = {
    key: fingerprint(URL, request),
    request: { url: URL, body: request },
    response: { status: 200, headers, body },
  }
  const dir = join(process.cwd(), 'test', 'fixtures', 'provider')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), JSON.stringify([entry], null, 2) + '\n')
  return entry
}

it('装配 ollama fixture', () => {
  const basicReq = {
    model: 'llama3.2',
    messages: [
      { role: 'system', content: 'Answer with exactly one word.' },
      { role: 'user', content: 'What is the capital of Japan?' },
    ],
    temperature: 0,
    max_tokens: 16,
  }
  const toolsReq = {
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'What is the weather in Tokyo? Use the tool.' }],
    temperature: 0,
    tools: [TOOL_DEF],
  }
  const streamReq = {
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'Count from 1 to 5, comma separated.' }],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
    max_tokens: 32,
  }
  const roundReq = {
    model: 'llama3.2',
    messages: [
      { role: 'user', content: 'What is the weather in Tokyo? Use the tool.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1tgpoe4x',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"tempC":18,"sky":"clear"}',
        tool_call_id: 'call_1tgpoe4x',
        name: 'get_weather',
      },
    ],
    temperature: 0,
    max_tokens: 64,
    tools: [TOOL_DEF],
  }

  const out = [
    build('live-basic', basicReq, '/tmp/r_basic.json', JSON_HEADERS),
    build('live-tools', toolsReq, '/tmp/r_tools.json', JSON_HEADERS),
    build('live-stream', streamReq, '/tmp/r_stream.sse', SSE_HEADERS),
    build('live-roundtrip', roundReq, '/tmp/r_round.json', JSON_HEADERS),
  ]

  for (const e of out) {
    expect(e.response.body.length).toBeGreaterThan(0)
    expect(e.key).toMatch(/^[0-9a-f]{16}$/)
  }
})
