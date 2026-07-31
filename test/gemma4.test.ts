import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { ModelRouter } from '../src/providers/router.js'
import type { ModelConfig } from '../src/providers/types.js'
import { agentSpec, defaultConfig } from '../src/config.js'
import { validateResult } from '../src/runtime/result-schema.js'
import { scriptedFetch } from './harness/provider.js'

/**
 * Gemma 4 31B 的真实响应回归。
 *
 * fixture 由 `gemma4:31b` 真实产生（curl 采集 —— 开发 agent 的沙箱禁止
 * Node 出网），请求体完全按 runner 的组装方式构造：真实 system prompt +
 * 真实的 submit_result JSON Schema。
 *
 * 这组测试回答两个问题：
 *  1. 我们能否正确解析推理模型的响应（reasoning 与 content 分离）
 *  2. 真实模型的输出能否通过我们的 schema 校验
 *
 * 只固化**响应**、不固化请求 —— 否则改 prompt 就会红，而 prompt 本来
 * 就该能改。若要重新验证遵守率，重新采集 fixture。
 */

const FIXTURES = join(process.cwd(), 'test', 'fixtures', 'gemma4')

function loadFixture(name: string): unknown {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    response: unknown
  }
  return raw.response
}

function respond(name: string): () => Response {
  const body = JSON.stringify(loadFixture(name))
  return () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

const GEMMA: ModelConfig = {
  key: 'ollama:gemma4',
  provider: 'ollama',
  model: 'gemma4:31b',
  baseUrl: 'http://localhost:11434/v1',
  billing: 'usage',
  costPerMTokIn: 0,
  costPerMTokOut: 0,
  contextWindow: 256_000,
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

function router(fetchImpl: ReturnType<typeof scriptedFetch>) {
  return new ModelRouter(db, deps, new Map([[GEMMA.key, GEMMA]]), () => null, {
    fetch: fetchImpl,
    inPlaceRetries: 0,
  })
}

describe('gemma4 响应解析', () => {
  it('第一轮：先做实际工作，而不是急着 submit', async () => {
    const res = await router(scriptedFetch([respond('turn1-write-report')])).chat([GEMMA.key], {
      messages: [],
    })

    expect(res.finishReason).toBe('tool_calls')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]!.name).toBe('write_report')
    // 参数必须是可解析的完整 JSON —— 长内容最容易在这里出问题
    const args = JSON.parse(res.toolCalls[0]!.arguments) as { title: string; content: string }
    expect(args.content.length).toBeGreaterThan(500)
  })

  it('思考过程被捕获，且与 content 分离', async () => {
    const res = await router(scriptedFetch([respond('turn1-write-report')])).chat([GEMMA.key], {
      messages: [],
    })

    // gemma4 的典型形状：content 空、思考在 reasoning
    expect(res.content).toBe('')
    expect(res.reasoning).toBeDefined()
    expect(res.reasoning!.length).toBeGreaterThan(500)
  })

  it('真实用量被正确提取', async () => {
    const res = await router(scriptedFetch([respond('turn1-write-report')])).chat([GEMMA.key], {
      messages: [],
    })
    expect(res.usage.tokensIn).toBeGreaterThan(0)
    expect(res.usage.tokensOut).toBeGreaterThan(0)
  })
})

describe('gemma4 的 schema 遵守率', () => {
  it('submit_result 通过我们的校验器 —— 含规则驱动的必填字段', async () => {
    const res = await router(scriptedFetch([respond('turn2-submit-result')])).chat([GEMMA.key], {
      messages: [],
    })

    expect(res.toolCalls[0]!.name).toBe('submit_result')

    // 用真实的 researcher spec 校验（含 requiredFields: findings[].sources）
    const spec = agentSpec(
      defaultConfig.agents.find((a) => a.id === 'researcher')!,
      defaultConfig.defaults,
    )
    const payload = JSON.parse(res.toolCalls[0]!.arguments)
    const check = validateResult(payload, spec.resultSpec ?? {})

    expect(check.ok).toBe(true)
    if (!check.ok) {
      // 失败时把原因打出来，否则只看到 false 无从下手
      throw new Error(`校验失败：${JSON.stringify(check.failures)}`)
    }
  })

  it('每条 finding 都带来源 —— 这是 requiredFields 要求的', async () => {
    const res = await router(scriptedFetch([respond('turn2-submit-result')])).chat([GEMMA.key], {
      messages: [],
    })
    const payload = JSON.parse(res.toolCalls[0]!.arguments) as {
      findings: Array<{ claim: string; sources: string[] }>
    }

    expect(payload.findings.length).toBeGreaterThan(0)
    for (const f of payload.findings) {
      expect(f.sources.length).toBeGreaterThan(0)
    }
  })

  it('summary 在长度上限内 —— 全文进了 artifact', async () => {
    const res = await router(scriptedFetch([respond('turn2-submit-result')])).chat([GEMMA.key], {
      messages: [],
    })
    const payload = JSON.parse(res.toolCalls[0]!.arguments) as {
      summary: string
      artifacts: string[]
    }

    expect(payload.summary.length).toBeLessThan(2000)
    // 完整报告通过 artifact 引用，而不是塞进 summary
    expect(payload.artifacts.length).toBeGreaterThan(0)
  })
})

describe('gemma4 的输出预算', () => {
  it('预算不足时被识别为截断，而非「模型不肯调工具」', async () => {
    // 这条 fixture 是 max_tokens=64 时采集的：64 个 token 全被思考吃掉
    const res = await router(scriptedFetch([respond('truncated-by-budget')])).chat([GEMMA.key], {
      messages: [],
    })

    expect(res.finishReason).toBe('length')
    expect(res.content).toBe('')
    expect(res.toolCalls).toHaveLength(0)
    // 思考确实产生了 —— 只是没留下预算给答案
    expect(res.reasoning!.length).toBeGreaterThan(0)
  })
})
