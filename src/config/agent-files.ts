import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AgentConfig } from '../config.js'
import type { Permission } from '../runtime/permissions.js'
import type { ResultFields } from '../runtime/result-schema.js'

/**
 * `agents/*.md` —— 一个专家一个文件。
 *
 * 为什么不继续用 `nucleus.config.json` 里的 `agents` 数组：
 *
 *  - 那个数组是**整体替换**语义，所以「加一个专家」要把已有的全抄一遍。
 *    而加专家是你最常做的操作，最常做的操作不该是最别扭的
 *  - prompt 在 JSON 里是 `"你是…\n结论必须…"` 这种转义串。**prompt 是改得
 *    最勤的东西**，diff 可读性直接决定迭代速度
 *  - 文件天然增量：加一个文件不可能删掉别人
 *
 * 两种来源并存，不逼你二选一。`nucleus agent list` 会报出每个 agent 来自哪。
 *
 * **试题集刻意放在另一个文件**（`<id>.cases.md`）：
 *  - 定义保持短小可读 —— 定义才是你调优时要 diff 的东西
 *  - 加一道试题不会显示成「这个 agent 变了」
 *  - 而且「试题不进 context」这件事从文件布局上就看得出来，
 *    不用去读加载器才知道（有一条断言守着它）
 */

export interface AgentFile {
  /** 解析出的 agent 定义 */
  agent: AgentConfig
  /** 来自哪个文件，doctor 与 agent list 展示用 */
  path: string
  /** 试题集，来自同名的 `.cases.md`；没有则为空 */
  cases: string[]
}

export interface AgentLoadError {
  path: string
  message: string
}

export interface AgentLoadResult {
  files: AgentFile[]
  errors: AgentLoadError[]
}

/** frontmatter 里允许出现的键 —— 未知键报错而不是静默忽略 */
const KNOWN_KEYS = [
  'name',
  'whenToUse',
  'permissions',
  'toolsAllow',
  'toolsDeny',
  'capabilities',
  'resultFields',
  'requiredFields',
  'model',
  'maxSteps',
  'maxCostUsd',
  'maxTokens',
  'policy',
]

/**
 * 极简 frontmatter 解析。
 *
 * 只支持这份格式实际需要的东西：标量、行内数组 `[a, b]`、以及嵌套映射
 * （给 resultFields 用）。不引 YAML 依赖 —— 完整 YAML 有一堆会咬人的特性
 * （锚点、多文档、隐式类型转换），而我们需要的只是几个键值。
 *
 * 未知键、缩进不一致都会报错，不静默吞掉。
 */
export function parseFrontmatter(text: string): {
  data: Record<string, unknown>
  body: string
  errors: string[]
} {
  const errors: string[] = []
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: {}, body: text.trim(), errors: ['缺少 --- 包裹的 frontmatter'] }

  const body = text.slice(m[0].length).trim()
  const data: Record<string, unknown> = {}

  // 按缩进层级解析。栈里存 (缩进, 容器)
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: data }]

  for (const raw of m[1]!.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()

    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!kv) {
      errors.push(`无法解析这一行：${line}`)
      continue
    }
    const [, key, rest] = kv

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop()
    const parent = stack[stack.length - 1]!.obj

    if (rest === '') {
      // 空值 = 嵌套映射的开始
      const child: Record<string, unknown> = {}
      parent[key!] = child
      stack.push({ indent, obj: child })
      continue
    }
    parent[key!] = parseScalar(rest!)
  }

  return { data, body, errors }
}

function parseScalar(s: string): unknown {
  const t = s.trim()
  // 行内数组：[a, b] 或 [a, b, c]
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((x) => stripQuotes(x.trim()))
  }
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return stripQuotes(t)
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** 一个 `.md` → AgentConfig。id 取自文件名，正文即 identity。 */
export function parseAgentFile(path: string, text: string): { agent?: AgentConfig; errors: string[] } {
  const id = basename(path).replace(/\.md$/, '')
  const { data, body, errors } = parseFrontmatter(text)
  const out = [...errors]

  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    out.push(`文件名（即 agent id）只能是小写字母、数字与连字符：${id}`)
  }
  for (const k of Object.keys(data)) {
    if (!KNOWN_KEYS.includes(k)) {
      out.push(`未知的 frontmatter 键「${k}」（可用：${KNOWN_KEYS.join(', ')}）`)
    }
  }
  if (!body) {
    // identity 是模型收到的 prompt 正文，空的话这个专家什么也不是
    out.push('正文为空 —— 正文就是这个 agent 的 prompt（identity）')
  }
  if (out.length) return { errors: out }

  const agent: AgentConfig = {
    id,
    name: typeof data['name'] === 'string' ? data['name'] : id,
    identity: body,
  }
  if (typeof data['whenToUse'] === 'string') agent.whenToUse = data['whenToUse']
  if (typeof data['policy'] === 'string') agent.policy = data['policy']
  if (Array.isArray(data['permissions'])) agent.permissions = data['permissions'] as Permission[]
  if (Array.isArray(data['toolsAllow'])) agent.toolsAllow = data['toolsAllow'] as string[]
  if (Array.isArray(data['toolsDeny'])) agent.toolsDeny = data['toolsDeny'] as string[]
  if (Array.isArray(data['capabilities'])) {
    agent.capabilities = data['capabilities'] as Array<'research' | 'code'>
  }
  if (Array.isArray(data['requiredFields'])) agent.requiredFields = data['requiredFields'] as string[]
  if (data['resultFields'] && typeof data['resultFields'] === 'object') {
    agent.resultFields = data['resultFields'] as ResultFields
  }
  // `model` 是单数写法的便利：一个模型时不必写成数组
  const model = data['model']
  if (typeof model === 'string') agent.modelChain = [model]
  else if (Array.isArray(model)) agent.modelChain = model as string[]
  for (const k of ['maxSteps', 'maxCostUsd', 'maxTokens'] as const) {
    if (typeof data[k] === 'number') agent[k] = data[k] as number
  }

  return { agent, errors: [] }
}

/**
 * 试题集：`<id>.cases.md`。
 *
 * 格式刻意简单 —— 每个 `- ` 开头的段落是一道题，可以跨行。
 * 试题会越积越多（每踩一个坑就加一条，逐渐变成回归集），所以它必须
 * 与定义分开，也必须永远不进 prompt。
 */
export function parseCases(text: string): string[] {
  const cases: string[] = []
  let cur: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line)) {
      if (cur.length) cases.push(cur.join('\n').trim())
      cur = [line.replace(/^\s*-\s+/, '')]
    } else if (cur.length && line.trim() && !line.startsWith('#')) {
      cur.push(line.trim())
    }
  }
  if (cur.length) cases.push(cur.join('\n').trim())
  return cases.filter(Boolean)
}

/** 默认目录：项目根下的 `agents/` */
export const DEFAULT_AGENTS_DIR = 'agents'

export function loadAgentFiles(dir: string = DEFAULT_AGENTS_DIR): AgentLoadResult {
  const root = resolve(dir)
  if (!existsSync(root)) return { files: [], errors: [] }

  const files: AgentFile[] = []
  const errors: AgentLoadError[] = []

  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith('.md') || name.endsWith('.cases.md')) continue
    const path = join(root, name)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (e) {
      errors.push({ path, message: `读不出来：${(e as Error).message}` })
      continue
    }
    const { agent, errors: errs } = parseAgentFile(path, text)
    if (!agent) {
      for (const m of errs) errors.push({ path, message: m })
      continue
    }
    const casesPath = path.replace(/\.md$/, '.cases.md')
    const cases = existsSync(casesPath) ? parseCases(readFileSync(casesPath, 'utf8')) : []
    files.push({ agent, path, cases })
  }

  return { files, errors }
}
