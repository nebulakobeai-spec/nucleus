import { z } from 'zod'

/**
 * Result schema：分层组合（DESIGN.md §6）。
 *
 * core 是所有 agent 共有的最小集；能力字段按 agent 叠加。
 * **加字段必须可选**，破坏性改动升 major 并保留旧 reader，
 * 否则改完 schema 历史 run 的 result 解析不了，UI 与 checker 一起炸。
 */

export const RESULT_SCHEMA_VERSION = '1.0'

/** summary 的 token 上限。用字符数近似（CJK≈1 token/字，拉丁≈4 字/token）。 */
export const SUMMARY_MAX_CHARS = 2_000

export const coreResultSchema = z.object({
  status: z.enum(['ok', 'partial', 'failed']),
  summary: z
    .string()
    .min(1, 'summary 不能为空')
    .max(SUMMARY_MAX_CHARS, `summary 不得超过 ${SUMMARY_MAX_CHARS} 字符；完整内容写成 artifact 并在 artifacts[] 中引用`),
  artifacts: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  open_questions: z.array(z.string()).default([]),
})

/** 研究类能力字段 */
export const researchFields = z.object({
  findings: z
    .array(
      z.object({
        claim: z.string(),
        sources: z.array(z.string()).default([]),
      }),
    )
    .optional(),
})

/** 代码类能力字段 */
export const codeFields = z.object({
  files_changed: z.array(z.string()).optional(),
  tests_run: z.boolean().optional(),
  build_ok: z.boolean().optional(),
})

export type CoreResult = z.infer<typeof coreResultSchema>

export interface ResultSchemaSpec {
  /** 叠加哪些能力字段 */
  capabilities?: Array<'research' | 'code'>
  /** 由启用的规则推导出的必填字段（DESIGN.md §6：字段必填性由规则集推导） */
  requiredFields?: string[]
}

const CAPABILITY_SCHEMAS = { research: researchFields, code: codeFields } as const

export function buildResultSchema(spec: ResultSchemaSpec = {}): z.ZodType<CoreResult> {
  let schema: z.ZodType = coreResultSchema
  for (const c of spec.capabilities ?? []) {
    schema = (schema as z.ZodObject<z.ZodRawShape>).merge(CAPABILITY_SCHEMAS[c])
  }
  return schema as z.ZodType<CoreResult>
}

/** 生成给模型的 JSON Schema（provider function-calling 用）。 */
export function resultJsonSchema(spec: ResultSchemaSpec = {}): Record<string, unknown> {
  const props: Record<string, unknown> = {
    status: { type: 'string', enum: ['ok', 'partial', 'failed'], description: '本次任务的结果状态' },
    summary: {
      type: 'string',
      description: `结论摘要，不超过 ${SUMMARY_MAX_CHARS} 字符。完整内容写成 artifact 后在 artifacts 中引用，不要贴在这里。`,
    },
    artifacts: { type: 'array', items: { type: 'string' }, description: '产出文件的 ref 列表' },
    confidence: { type: 'number', description: '0-1 的置信度' },
    open_questions: { type: 'array', items: { type: 'string' }, description: '未解决的问题' },
  }
  const required = ['status', 'summary']

  for (const c of spec.capabilities ?? []) {
    if (c === 'research') {
      props['findings'] = {
        type: 'array',
        description: '结论列表，每条须标注来源',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['claim'],
        },
      }
    }
    if (c === 'code') {
      props['files_changed'] = { type: 'array', items: { type: 'string' } }
      props['tests_run'] = { type: 'boolean' }
      props['build_ok'] = { type: 'boolean' }
    }
  }
  for (const f of spec.requiredFields ?? []) {
    if (!required.includes(f) && f in props) required.push(f)
  }

  return { type: 'object', properties: props, required }
}

export interface ValidationFailure {
  /** 精确到字段路径的反馈 —— 模糊的错误信息模型改不动 */
  path: string
  message: string
}

export function validateResult(
  raw: unknown,
  spec: ResultSchemaSpec = {},
): { ok: true; value: CoreResult } | { ok: false; failures: ValidationFailure[] } {
  const parsed = buildResultSchema(spec).safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      failures: parsed.error.issues.map((i) => ({
        path: i.path.length ? i.path.join('.') : '(root)',
        message: i.message,
      })),
    }
  }

  // 规则驱动的必填检查：schema 之外的、由启用规则推导出来的约束
  const failures: ValidationFailure[] = []
  const val = parsed.data as CoreResult & Record<string, unknown>
  for (const f of spec.requiredFields ?? []) {
    if (!isPresent(val, f)) {
      failures.push({ path: f, message: `字段 ${f} 为必填（由启用的规则要求）` })
    }
  }
  if (failures.length) return { ok: false, failures }
  return { ok: true, value: val }
}

/** 非空判定：undefined / null / 空数组 / 空字符串都算缺失 */
function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'string') return v.trim().length > 0
  return true
}

/**
 * 路径存在性检查，支持 `findings[].sources` 这种数组元素级约束。
 *
 * `a[].b` 的语义是「a 必须非空，且**每一个**元素的 b 都非空」——
 * 只要有一条 finding 缺来源，整条规则就不算满足。
 */
export function isPresent(obj: unknown, path: string): boolean {
  const parts = path.split('.')
  let cur: unknown = obj

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.endsWith('[]')) {
      const key = p.slice(0, -2)
      const arr = key ? (cur as Record<string, unknown>)?.[key] : cur
      if (!Array.isArray(arr) || arr.length === 0) return false
      const rest = parts.slice(i + 1).join('.')
      // 没有后续路径 → 数组非空即可；否则每个元素都要满足
      return rest === '' || arr.every((el) => isPresent(el, rest))
    }
    if (cur == null) return false
    cur = (cur as Record<string, unknown>)[p]
  }
  return nonEmpty(cur)
}

export function formatFailures(failures: ValidationFailure[]): string {
  return (
    '提交的结果未通过校验，请修正后重新调用 submit_result：\n' +
    failures.map((f) => `  - ${f.path}: ${f.message}`).join('\n')
  )
}
