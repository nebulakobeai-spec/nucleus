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

  it('findings 本身缺失时也被拒绝', () => {
    const r = validateResult({ status: 'ok', summary: 'x' }, { ...spec, capabilities: ['research'] })
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
