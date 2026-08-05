import { describe, expect, it } from 'vitest'
import { resultJsonSchema, validateResult, SUMMARY_MAX_CHARS } from '../src/runtime/result-schema.js'

describe('core schema', () => {
  it('接受最小合法结果并补齐默认值', () => {
    const r = validateResult({ status: 'ok', summary: '完成' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.artifacts).toEqual([])
      expect(r.value.open_questions).toEqual([])
    }
  })

  it('拒绝缺失字段并给出路径', () => {
    const r = validateResult({ status: 'ok' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures[0]!.path).toBe('summary')
  })

  it('拒绝超长 summary', () => {
    const r = validateResult({ status: 'ok', summary: 'x'.repeat(SUMMARY_MAX_CHARS + 1) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures[0]!.message).toMatch(/artifact/)
  })

  it('拒绝非法 status', () => {
    expect(validateResult({ status: 'maybe', summary: 'x' }).ok).toBe(false)
  })
})

describe('规则驱动的必填字段', () => {
  const spec = { capabilities: ['research'] as const, requiredFields: ['findings[].sources'] }

  it('启用规则后，缺 sources 被拒绝', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x', findings: [{ claim: 'A' }] },
      { ...spec, capabilities: ['research'] },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures[0]!.path).toBe('findings[].sources')
  })

  it('sources 为空数组同样被拒绝', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x', findings: [{ claim: 'A', sources: [] }] },
      { ...spec, capabilities: ['research'] },
    )
    expect(r.ok).toBe(false)
  })

  it('任一条 finding 缺 sources 即拒绝', () => {
    const r = validateResult(
      {
        status: 'ok',
        summary: 'x',
        findings: [{ claim: 'A', sources: ['u'] }, { claim: 'B', sources: [] }],
      },
      { ...spec, capabilities: ['research'] },
    )
    expect(r.ok).toBe(false)
  })

  it('全部带 sources 则通过', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x', findings: [{ claim: 'A', sources: ['u1', 'u2'] }] },
      { ...spec, capabilities: ['research'] },
    )
    expect(r.ok).toBe(true)
  })

  it('不启用该规则时，缺 sources 也通过', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x', findings: [{ claim: 'A' }] },
      { capabilities: ['research'] },
    )
    expect(r.ok).toBe(true)
  })

  /**
   * ── 两种语义，各有正当用途 ────────────────────────────
   *
   * `a[].b`   **条件**必填：a 为空/缺失时通过；有内容时每条都要有 b
   * `a[]!.b`  **无条件**：a 必须非空，且每条都要有 b
   *
   * 原先只有后一种，而它把前一种的用途也占了 —— 见下面那组实测。
   */
  it('findings 本身缺失：`[]!` 拒绝（研究专家交不出结论是可疑的）', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x' },
      { capabilities: ['research'], requiredFields: ['findings[]!.sources'] },
    )
    expect(r.ok).toBe(false)
  })

  it('findings 本身缺失：`[]` 通过 —— 没有那种数据时这条要求是满足的', () => {
    const r = validateResult({ status: 'ok', summary: 'x' }, { ...spec, capabilities: ['research'] })
    expect(r.ok).toBe(true)
  })
})

/**
 * ── 无条件必填把不相关的任务全锁死了 ──────────────────────
 *
 * 实测（常驻进程 + 一条每分钟的计划）：编排者按「金融数据必须标明来源和抓取
 * 时间」造了一条规则，写成 `appliesTo: ['*']` +
 * `requiredFields: [financial_metrics[].source, financial_metrics[].timestamp]`。
 *
 * 而「用一句话报告你还活着」这个定时任务**根本无法满足** —— 它没有任何金融
 * 数据，但契约要求它交出 `financial_metrics[].source`。于是那条计划每一次触发
 * 都 `contract.postcondition_failed`：
 *
 *     ⎿ be47969c failed contract.postcondition_failed
 *
 * 而规则原文写的是「**凡是涉及**金融数据的输出」—— 那是个**条件**。
 * 无条件必填表达不了条件，于是模型只有两条路：**编造空数据，或者一直失败**。
 * 两条都比「这条要求在这次任务里不适用」糟。
 */
describe('条件必填', () => {
  const rule = { requiredFields: ['financial_metrics[].source', 'financial_metrics[].timestamp'] }
  const decl = {
    fields: {
      financial_metrics: {
        type: 'object[]' as const,
        fields: { source: 'string' as const, timestamp: 'string' as const, value: 'string' as const },
      },
    },
  }

  it('没有那种数据 → 通过（这才是「凡是涉及…」的意思）', () => {
    const r = validateResult({ status: 'ok', summary: '我还活着' }, { ...rule, ...decl })
    expect(r.ok, '一条不相关的任务被一条金融规则锁死了').toBe(true)
  })

  it('空数组 → 通过', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x', financial_metrics: [] },
      { ...rule, ...decl },
    )
    expect(r.ok).toBe(true)
  })

  it('有数据但缺字段 → 拒绝（规则该管的正是这一种）', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x', financial_metrics: [{ value: '3.2' }] },
      { ...rule, ...decl },
    )
    expect(r.ok).toBe(false)
  })

  it('有数据且字段齐全 → 通过', () => {
    const r = validateResult(
      {
        status: 'ok',
        summary: 'x',
        financial_metrics: [{ value: '3.2', source: '10-K', timestamp: '2026-08-01' }],
      },
      { ...rule, ...decl },
    )
    expect(r.ok).toBe(true)
  })

  /** 一条数据齐全、另一条缺 —— 每条都要满足 */
  it('只要有一条缺就拒绝', () => {
    const r = validateResult(
      {
        status: 'ok',
        summary: 'x',
        financial_metrics: [
          { value: '1', source: 'a', timestamp: 't' },
          { value: '2', source: 'b' },
        ],
      },
      { ...rule, ...decl },
    )
    expect(r.ok).toBe(false)
  })

  it('`[]!` 仍然要求至少有一条', () => {
    const r = validateResult(
      { status: 'ok', summary: 'x' },
      { requiredFields: ['financial_metrics[]!.source'], ...decl },
    )
    expect(r.ok).toBe(false)
  })
})

describe('给模型的 JSON Schema', () => {
  it('core 字段始终必填', () => {
    const s = resultJsonSchema()
    expect(s['required']).toEqual(['status', 'summary'])
  })

  it('能力字段按需叠加', () => {
    const s = resultJsonSchema({ capabilities: ['research', 'code'] })
    const props = s['properties'] as Record<string, unknown>
    expect(props['findings']).toBeDefined()
    expect(props['files_changed']).toBeDefined()
  })

  it('summary 的描述里说明了超长要写 artifact', () => {
    const props = resultJsonSchema()['properties'] as Record<string, { description: string }>
    expect(props['summary']!.description).toMatch(/artifact/)
  })
})
