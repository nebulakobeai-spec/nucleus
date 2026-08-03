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

/**
 * 可声明的结果字段。
 *
 * 词表刻意小 —— 不是完整 JSON Schema。理由：
 *  - 我们要能**校验声明本身**（保留名、未知类型），完整 JSON Schema 校验不了
 *  - 我们要能把它翻成 zod 和 provider 的 function-calling schema 两种形态
 *  - 结果字段的用途是「让结论可机器检查」，不是存任意结构 ——
 *    任意结构该写成 artifact
 *
 * 不够用时再加类型，比一开始就开放安全。
 */
export type ScalarType = 'string' | 'number' | 'boolean'

/**
 * object[] 元素里允许的类型。
 *
 * 比 ScalarType 多了数组 —— 一开始只允许标量，结果**连内置的 research 预设
 * 都表达不了**（`findings[{claim, sources[]}]` 里 sources 是字符串数组）。
 * 用同一套词表表达内置预设的好处就在这里：词表不够用会立刻暴露。
 */
export type ElementType = ScalarType | 'string[]' | 'number[]'

export type FieldDecl =
  | { type: ScalarType; description?: string }
  | { type: 'string[]' | 'number[]'; description?: string }
  | {
      type: 'object[]'
      description?: string
      /** 元素的字段。值可以是类型简写，也可以带说明 */
      fields: Record<string, ElementType | { type: ElementType; description?: string }>
    }

export type ResultFields = Record<string, FieldDecl>

/**
 * 核心字段名，不允许被声明覆盖。
 *
 * 覆盖 summary 或 status 会让 announceText / 遵守率统计一起失真 ——
 * 那些代码都假定核心字段的语义固定。
 */
/**
 * 结果字段名的写法。**snake_case** —— 核心字段就是这个约定
 * （`open_questions`），混用会让 schema 读起来像两个人写的。
 *
 * 导出成常量是为了让**输入时**就能校验：向导里现造一个正则，
 * 与这里漂开之后就会出现「向导让我这么填，加载器又说不行」。
 */
export const FIELD_NAME = /^[a-z][a-z0-9_]*$/
export const FIELD_NAME_HINT = '字段名只能是小写字母、数字与下划线（snake_case，与核心字段一致）'

export const RESERVED_FIELDS = ['status', 'summary', 'artifacts', 'confidence', 'open_questions']

/**
 * 内置预设。
 *
 * **用与用户声明完全相同的词表表达** —— 这样只有一条代码路径。
 * 以前 research/code 是硬编码的 zod 对象加 resultJsonSchema 里的 if/else，
 * 于是「自定义结果字段」就得再写一套，两套迟早不一致。
 */
export const RESULT_PRESETS: Record<'research' | 'code', ResultFields> = {
  research: {
    findings: {
      type: 'object[]',
      description: '结论列表，每条须标注来源',
      fields: {
        claim: { type: 'string', description: '结论本身' },
        sources: { type: 'string[]', description: '可验证的来源：URL 或文献标题' },
      },
    },
  },
  code: {
    files_changed: { type: 'string[]', description: '改动的文件' },
    tests_run: { type: 'boolean', description: '是否跑过测试' },
    build_ok: { type: 'boolean', description: '构建是否通过' },
  },
}

export type CoreResult = z.infer<typeof coreResultSchema>

export interface ResultSchemaSpec {
  /** 叠加哪些内置预设 */
  capabilities?: Array<'research' | 'code'>
  /** 自己声明的结果字段，与预设合并（同名时以自己声明的为准） */
  fields?: ResultFields
  /** 由启用的规则推导出的必填字段（DESIGN.md §6：字段必填性由规则集推导） */
  requiredFields?: string[]
}

/** 预设 + 自定义合并成一张表 */
export function effectiveFields(spec: ResultSchemaSpec = {}): ResultFields {
  const out: ResultFields = {}
  for (const c of spec.capabilities ?? []) Object.assign(out, RESULT_PRESETS[c])
  Object.assign(out, spec.fields ?? {})
  return out
}

function normElement(v: ElementType | { type: ElementType; description?: string }): {
  type: ElementType
  description?: string
} {
  return typeof v === 'string' ? { type: v } : v
}

/** 元素类型 → zod。数组一律 default([]) 而不是 optional —— 缺来源要能被
 *  `findings[].sources` 这种路径检查抓到，而 undefined 与空数组在
 *  isPresent 里等价，用 default 让形状更稳定。 */
function elementToZod(t: ElementType): z.ZodType {
  if (t === 'string[]') return z.array(z.string()).default([])
  if (t === 'number[]') return z.array(z.number()).default([])
  return SCALAR_ZOD[t]().optional()
}

function elementToJsonSchema(t: ElementType): Record<string, unknown> {
  if (t === 'string[]') return { type: 'array', items: { type: 'string' } }
  if (t === 'number[]') return { type: 'array', items: { type: 'number' } }
  return { type: t }
}

const SCALAR_ZOD: Record<ScalarType, () => z.ZodType> = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
}

/** 声明 → zod。所有声明字段都是**可选**的，必填性由 requiredFields 决定。 */
function fieldToZod(decl: FieldDecl): z.ZodType {
  switch (decl.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return SCALAR_ZOD[decl.type]().optional()
    case 'string[]':
      return z.array(z.string()).optional()
    case 'number[]':
      return z.array(z.number()).optional()
    case 'object[]': {
      // 元素字段也一律可选：缺哪个由 requiredFields 用 `a[].b` 表达，
      // 两处都能要求必填会让「为什么这里报错」变得难说清
      const shape = Object.fromEntries(
        Object.entries(decl.fields).map(([k, v]) => [k, elementToZod(normElement(v).type)]),
      )
      return z.array(z.object(shape)).optional()
    }
  }
}

/** 声明 → provider 的 function-calling schema */
function fieldToJsonSchema(decl: FieldDecl): Record<string, unknown> {
  const desc = decl.description ? { description: decl.description } : {}
  switch (decl.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return { type: decl.type, ...desc }
    case 'string[]':
      return { type: 'array', items: { type: 'string' }, ...desc }
    case 'number[]':
      return { type: 'array', items: { type: 'number' }, ...desc }
    case 'object[]': {
      const properties: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(decl.fields)) {
        const e = normElement(v)
        properties[k] = {
          ...elementToJsonSchema(e.type),
          ...(e.description ? { description: e.description } : {}),
        }
      }
      return { type: 'array', items: { type: 'object', properties }, ...desc }
    }
  }
}

export interface FieldDeclProblem {
  field: string
  message: string
}

/**
 * 校验声明本身。
 *
 * 挡在配置加载期 —— 声明写错时应当启动就报，而不是等某个 run 提交结果时
 * 才发现 schema 生成出来是坏的。
 */
export function validateResultFields(fields: ResultFields | undefined): FieldDeclProblem[] {
  const problems: FieldDeclProblem[] = []
  const KNOWN = ['string', 'number', 'boolean', 'string[]', 'number[]', 'object[]']

  for (const [name, decl] of Object.entries(fields ?? {})) {
    if (RESERVED_FIELDS.includes(name)) {
      problems.push({
        field: name,
        message: `${name} 是核心字段，不能重新声明（覆盖它会让结果呈现与遵守率统计一起失真）`,
      })
      continue
    }
    if (!FIELD_NAME.test(name)) {
      problems.push({ field: name, message: FIELD_NAME_HINT })
    }
    if (!decl || typeof decl !== 'object' || !KNOWN.includes((decl as FieldDecl).type)) {
      problems.push({
        field: name,
        message: `type 必须是 ${KNOWN.join(' / ')} 之一，收到 ${JSON.stringify((decl as { type?: unknown })?.type)}`,
      })
      continue
    }
    if (decl.type === 'object[]') {
      const els = (decl as { fields?: unknown }).fields
      if (!els || typeof els !== 'object' || Object.keys(els).length === 0) {
        problems.push({ field: name, message: `object[] 必须声明 fields（元素有哪些字段）` })
        continue
      }
      for (const [k, v] of Object.entries(els as Record<string, unknown>)) {
        const t = typeof v === 'string' ? v : (v as { type?: unknown })?.type
        const EL = ['string', 'number', 'boolean', 'string[]', 'number[]']
        if (typeof t !== 'string' || !EL.includes(t)) {
          problems.push({ field: `${name}[].${k}`, message: `元素字段只能是 ${EL.join(' / ')}` })
        }
      }
    }
  }
  return problems
}

export function buildResultSchema(spec: ResultSchemaSpec = {}): z.ZodType<CoreResult> {
  const shape = Object.fromEntries(
    Object.entries(effectiveFields(spec)).map(([name, decl]) => [name, fieldToZod(decl)]),
  )
  return (
    Object.keys(shape).length ? coreResultSchema.extend(shape) : coreResultSchema
  ) as unknown as z.ZodType<CoreResult>
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

  // 一条循环覆盖预设与自定义 —— 以前这里是 per-capability 的 if/else，
  // 于是「自定义结果字段」得再写一套翻译逻辑，两套迟早不一致
  for (const [name, decl] of Object.entries(effectiveFields(spec))) {
    props[name] = fieldToJsonSchema(decl)
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
