/**
 * MCP tool schema → provider function-calling schema。
 *
 * 各家对 JSON Schema 的支持子集不同（OpenAI 的严格模式尤其挑剔），
 * MCP server 又常给出宽松的 schema。这里做保守归一化：
 * **宁可丢掉表达力，也不要让 provider 400。**
 *
 * 丢掉的约束由 runtime 侧再校验（DESIGN.md §6：不信 provider）。
 */

export interface FlattenResult {
  schema: Record<string, unknown>
  /** 被丢弃或降级的构造，用于诊断与 UI 提示 */
  warnings: string[]
}

const SUPPORTED_KEYS = new Set([
  'type',
  'description',
  'enum',
  'const',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
])

/** 会被丢弃的组合子 —— provider 支持度参差，且模型也不太理解 */
const DROPPED_COMBINATORS = ['allOf', 'anyOf', 'not', 'if', 'then', 'else', 'dependentSchemas']

export function flattenSchema(input: unknown, maxDepth = 8): FlattenResult {
  const warnings: string[] = []
  const defs = collectDefs(input)
  const schema = walk(input, defs, warnings, maxDepth, new Set(), 'root')

  // provider 要求顶层必须是 object
  const top = schema as Record<string, unknown>
  if (top['type'] !== 'object') {
    return {
      schema: { type: 'object', properties: {}, required: [] },
      warnings: [...warnings, `顶层不是 object（收到 ${String(top['type'])}），已替换为空对象`],
    }
  }
  if (!top['properties']) top['properties'] = {}
  return { schema: top, warnings }
}

/** 收集 $defs / definitions，供 $ref 内联 */
function collectDefs(input: unknown): Record<string, unknown> {
  if (!isObj(input)) return {}
  return {
    ...(isObj(input['$defs']) ? input['$defs'] : {}),
    ...(isObj(input['definitions']) ? input['definitions'] : {}),
  }
}

function walk(
  node: unknown,
  defs: Record<string, unknown>,
  warnings: string[],
  depth: number,
  seenRefs: Set<string>,
  path: string,
): unknown {
  if (!isObj(node)) return { type: 'string' }
  if (depth <= 0) {
    warnings.push(`${path}: 嵌套过深，已截断`)
    return { type: 'string', description: '(嵌套过深，已简化)' }
  }

  // $ref：内联展开；循环引用则降级
  const ref = node['$ref']
  if (typeof ref === 'string') {
    const key = ref.replace(/^#\/(\$defs|definitions)\//, '')
    if (seenRefs.has(key)) {
      warnings.push(`${path}: 循环引用 ${ref}，已降级为字符串`)
      return { type: 'string', description: '(循环引用，已简化)' }
    }
    const target = defs[key]
    if (!target) {
      warnings.push(`${path}: 无法解析 ${ref}，已降级为字符串`)
      return { type: 'string' }
    }
    return walk(target, defs, warnings, depth - 1, new Set([...seenRefs, key]), path)
  }

  const out: Record<string, unknown> = {}

  // oneOf：取第一个分支（保留最可能正确的形状），其余丢弃
  const oneOf = node['oneOf']
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    warnings.push(`${path}: oneOf 有 ${oneOf.length} 个分支，仅保留第一个`)
    const first = walk(oneOf[0], defs, warnings, depth - 1, seenRefs, `${path}.oneOf[0]`)
    return { ...(isObj(first) ? first : {}), ...(node['description'] ? { description: node['description'] } : {}) }
  }

  for (const combinator of DROPPED_COMBINATORS) {
    if (combinator in node) warnings.push(`${path}: 已丢弃不支持的 ${combinator}`)
  }

  for (const [k, v] of Object.entries(node)) {
    if (!SUPPORTED_KEYS.has(k)) continue

    if (k === 'properties' && isObj(v)) {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v)) {
        props[pk] = walk(pv, defs, warnings, depth - 1, seenRefs, `${path}.${pk}`)
      }
      out['properties'] = props
    } else if (k === 'items') {
      // 元组形式的 items（数组）provider 普遍不支持，取第一项
      if (Array.isArray(v)) {
        warnings.push(`${path}: 元组式 items 不受支持，仅保留第一项`)
        out['items'] = walk(v[0], defs, warnings, depth - 1, seenRefs, `${path}[]`)
      } else {
        out['items'] = walk(v, defs, warnings, depth - 1, seenRefs, `${path}[]`)
      }
    } else if (k === 'type' && Array.isArray(v)) {
      // 联合类型 ["string","null"] → 取第一个非 null
      const first = v.find((t) => t !== 'null') ?? 'string'
      if (v.length > 1) warnings.push(`${path}: 联合类型 [${v.join(',')}] 已简化为 ${String(first)}`)
      out['type'] = first
    } else {
      out[k] = v
    }
  }

  if (!out['type']) {
    out['type'] = out['properties'] ? 'object' : out['enum'] ? 'string' : 'string'
  }
  // object 必须有 properties，否则部分 provider 会拒
  if (out['type'] === 'object' && !out['properties']) out['properties'] = {}
  // required 必须是 properties 的子集
  if (Array.isArray(out['required']) && isObj(out['properties'])) {
    const keys = new Set(Object.keys(out['properties']))
    const req = (out['required'] as unknown[]).filter((r): r is string => typeof r === 'string' && keys.has(r))
    if (req.length !== (out['required'] as unknown[]).length) {
      warnings.push(`${path}: required 中有未定义的字段，已剔除`)
    }
    out['required'] = req
  }

  return out
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
