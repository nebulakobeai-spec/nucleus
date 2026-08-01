import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { loadConfig } from '../src/config-file.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import {
  effectiveFields,
  RESERVED_FIELDS,
  RESULT_PRESETS,
  resultJsonSchema,
  validateResult,
  validateResultFields,
  type ResultFields,
} from '../src/runtime/result-schema.js'

/**
 * 可声明的结果段。
 *
 * 以前能力段写死在 TS 里（`'research' | 'code'` + 硬编码的 zod 对象 +
 * resultJsonSchema 里的 if/else），所以你没法让一个金融分析专家必须交出
 * `metrics[{name, value, asOf, source}]` —— 只能迁就那两个预设。
 *
 * 现在内置预设**用与用户声明完全相同的词表**表达，于是只有一条代码路径。
 * 这个决定立刻还了债：一开始我把元素字段限制成标量，结果连 research 预设
 * 自己都表达不了（`findings[].sources` 是字符串数组）—— 词表不够用当场暴露。
 */

const METRICS: ResultFields = {
  metrics: {
    type: 'object[]',
    description: '关键指标',
    fields: { name: 'string', value: 'number', asOf: 'string', source: 'string' },
  },
  verdict: { type: 'string', description: '一句话结论' },
}

// ═══════════════════════════════════════════════════════
// 声明本身要能被校验
// ═══════════════════════════════════════════════════════

describe('validateResultFields', () => {
  it('合法声明放行', () => {
    expect(validateResultFields(METRICS)).toEqual([])
  })

  it('核心字段不许被重新声明 —— 覆盖它会让结果呈现与统计一起失真', () => {
    for (const name of RESERVED_FIELDS) {
      const p = validateResultFields({ [name]: { type: 'string' } })
      expect(p.map((x) => x.field), name).toContain(name)
    }
  })

  it('未知类型报错并列出可用的', () => {
    const p = validateResultFields({ x: { type: 'date' } as never })
    expect(p[0]!.message).toContain('object[]')
  })

  it('object[] 必须声明 fields', () => {
    expect(validateResultFields({ x: { type: 'object[]' } as never })[0]!.message).toContain('fields')
    expect(validateResultFields({ x: { type: 'object[]', fields: {} } })[0]!.message).toContain('fields')
  })

  it('元素字段允许数组 —— 否则连 research 预设都表达不了', () => {
    expect(
      validateResultFields({ x: { type: 'object[]', fields: { a: 'string[]' } } }),
    ).toEqual([])
    // 但不允许嵌套对象：结果字段是给机器检查的，任意结构该写成 artifact
    expect(
      validateResultFields({ x: { type: 'object[]', fields: { a: 'object[]' } } as never }).length,
    ).toBe(1)
  })

  it('字段名限制成小写下划线', () => {
    expect(validateResultFields({ Metrics: { type: 'string' } }).length).toBeGreaterThan(0)
    expect(validateResultFields({ 'a-b': { type: 'string' } }).length).toBeGreaterThan(0)
  })

  it('没有声明时不报错', () => {
    expect(validateResultFields(undefined)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════
// 内置预设与自定义走同一条路
// ═══════════════════════════════════════════════════════

describe('预设与自定义合并', () => {
  it('预设本身是合法的声明 —— 一条代码路径的证明', () => {
    for (const [name, fields] of Object.entries(RESULT_PRESETS)) {
      expect(validateResultFields(fields), name).toEqual([])
    }
  })

  it('research 预设仍然产出 findings[{claim, sources[]}]', () => {
    const schema = resultJsonSchema({ capabilities: ['research'] }) as {
      properties: { findings: { items: { properties: Record<string, { type: string }> } } }
    }
    const el = schema.properties.findings.items.properties
    expect(el['claim']!.type).toBe('string')
    // sources 必须是数组而不是字符串 —— 这是我第一版翻译错的地方
    expect(el['sources']!.type).toBe('array')
  })

  it('同名时自定义覆盖预设', () => {
    const f = effectiveFields({
      capabilities: ['code'],
      fields: { build_ok: { type: 'string', description: '改成字符串' } },
    })
    expect(f['build_ok']).toMatchObject({ type: 'string' })
    // 其余预设字段还在
    expect(f['files_changed']).toBeDefined()
  })

  it('自定义字段进了给模型的 schema', () => {
    const schema = resultJsonSchema({ fields: METRICS }) as {
      properties: Record<string, { type: string; description?: string }>
    }
    expect(schema.properties['metrics']!.type).toBe('array')
    expect(schema.properties['metrics']!.description).toBe('关键指标')
    expect(schema.properties['verdict']!.type).toBe('string')
  })
})

// ═══════════════════════════════════════════════════════
// 必填性仍然由 requiredFields 决定
// ═══════════════════════════════════════════════════════

describe('自定义字段的必填', () => {
  const spec = { fields: METRICS, requiredFields: ['metrics[].source', 'verdict'] }

  it('齐全时通过', () => {
    const r = validateResult(
      {
        status: 'ok',
        summary: 's',
        verdict: '看多',
        metrics: [{ name: 'PE', value: 12.3, asOf: '2026-Q1', source: 'https://x' }],
      },
      spec,
    )
    expect(r.ok).toBe(true)
  })

  it('有一个元素缺 source 就整体不通过 —— a[].b 是「每一个」的语义', () => {
    const r = validateResult(
      {
        status: 'ok',
        summary: 's',
        verdict: '看多',
        metrics: [
          { name: 'PE', value: 12.3, source: 'https://x' },
          { name: 'PB', value: 1.1 },
        ],
      },
      spec,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures.map((f) => f.path)).toContain('metrics[].source')
  })

  it('声明只描述形状，不声明必填 —— 不填 requiredFields 时缺了也放行', () => {
    const r = validateResult({ status: 'ok', summary: 's' }, { fields: METRICS })
    expect(r.ok).toBe(true)
  })

  it('类型不对时报到字段路径上', () => {
    const r = validateResult(
      { status: 'ok', summary: 's', metrics: [{ name: 'PE', value: '不是数字' }] },
      { fields: METRICS },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures[0]!.path).toContain('metrics')
  })
})

// ═══════════════════════════════════════════════════════
// 配置加载与端到端
// ═══════════════════════════════════════════════════════

describe('配置里声明结果段', () => {
  /** agents 只能来自 md —— JSON 里定义会被拒 */
  async function withAgentMd(frontmatter: string, body = '你是金融数据分析专家。') {
    const dir = await mkdtemp(join(tmpdir(), 'nuc-rf-'))
    await mkdir(join(dir, 'agents'), { recursive: true })
    await writeFile(
      join(dir, 'nucleus.config.json'),
      JSON.stringify({
        models: [{ key: 'mock:local', provider: 'mock', model: 'mock', baseUrl: 'http://mock.invalid/v1' }],
        defaults: { modelChain: ['mock:local'], entryAgent: 'analyst' },
      }),
    )
    await writeFile(join(dir, 'agents', 'analyst.md'), `---\n${frontmatter}\n---\n${body}\n`)
    process.env['NUCLEUS_AGENTS_DIR'] = join(dir, 'agents')
    try {
      return await loadConfig(join(dir, 'nucleus.config.json'))
    } finally {
      delete process.env['NUCLEUS_AGENTS_DIR']
    }
  }

  const FM = `name: 分析师
whenToUse: 需要带出处的量化结论时
permissions: [read, artifact]
requiredFields: [metrics[].source]
resultFields:
  verdict:
    type: string
    description: 一句话结论
  metrics:
    type: object[]
    fields:
      name: string
      value: number
      source: string`

  it('声明写错时**启动就报**，而不是等某个 run 提交结果', async () => {
    await expect(
      withAgentMd('resultFields:\n  summary:\n    type: string'),
    ).rejects.toThrow(/核心字段/)
    await expect(withAgentMd('resultFields:\n  x:\n    type: date')).rejects.toThrow(/resultFields\.x/)
  })

  it('合法声明加载成功并进 agentSpec', async () => {
    const { config } = await withAgentMd(FM)
    const { agentSpec } = await import('../src/config.js')
    const a = config.agents.find((x) => x.id === 'analyst')!
    const spec = agentSpec(a, config.defaults)
    expect(spec.resultSpec?.fields).toMatchObject({ verdict: { type: 'string' } })
    expect(spec.resultSpec?.requiredFields).toEqual(['metrics[].source'])
  })
})

let n: Nucleus | null = null
afterEach(async () => {
  await n?.close()
  n = null
})

describe('端到端：自定义结果段被强制', () => {
  function cfg(): NucleusConfig {
    const c = structuredClone(defaultConfig)
    c.defaults.modelChain = ['mock:local']
    c.defaults.entryAgent = 'analyst'
    c.agents = [
      {
        id: 'analyst',
        name: '分析师',
        whenToUse: '量化结论',
        identity: '你是金融数据分析专家。',
        permissions: ['artifact'],
        resultFields: METRICS,
        requiredFields: ['metrics[].source'],
      },
    ]
    return c
  }

  it('缺 source 时被退回，补上后通过', async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        analyst: [
          { submit: { status: 'ok', summary: 's', metrics: [{ name: 'PE', value: 12 }] } },
          {
            submit: {
              status: 'ok',
              summary: 's',
              metrics: [{ name: 'PE', value: 12, source: 'https://x' }],
            },
          },
        ],
      },
    })
    const conv = await n.conversations.create({ agentId: 'analyst' })
    const { runId } = await ask(n, conv.id, '看一下 PE')

    const rej = await n.db.query<{ payload: { failures: Array<{ path: string }> } }>(
      `select e.payload from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 and e.kind = 'contract.rejected'`,
      [runId],
    )
    expect(rej.rows).toHaveLength(1)
    expect(rej.rows[0]!.payload.failures.map((f) => f.path)).toContain('metrics[].source')
    expect((await n.runs.getRun(runId))!.status).toBe('succeeded')
  })
})
