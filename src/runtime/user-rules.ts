import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseFrontmatter } from '../config/agent-files.js'

/**
 * 用户自己写的规则 —— **一条规则同时携带三层**。
 *
 * ── 为什么是一个单元，而不是三处配置 ──────────────────────
 *
 * 「结论必须标来源」这一条要求，落地时是三件事：
 *
 *   T1  给模型的一句话（注入末尾约束块）
 *   T2  机械校验（`requiredFields: ["findings[].sources"]`）
 *   T3  能力边界（这条用不上；但「不许写文件」就只需要 T3）
 *
 * 分成三处配置的话，**没有任何东西保证它们说的是同一件事** ——
 * 改了 T1 的措辞而忘了 T2，规则就退化成一句没人强制的空话，
 * 而那正是这个项目要修的第一个问题。
 *
 * ── 两条原则，由校验强制而不是靠自觉 ─────────────────────
 *
 * **① T1 必须配 T2（或 T3）。** 只有 T1 的规则等于把「prompt 写满禁止但模型
 * 照犯」原样搬回来。所以那种规则会被**拒绝**，不是警告。
 *
 * **② 能用 T3 表达的绝不写成 T1。** T3 零成本且**不可违反**（工具根本不出现
 * 在模型看到的定义里）；T1 每一轮都占约束块的 token，而且是永久成本。
 * 所以只声明了 denyTools 的规则不需要正文 —— 那是好事，不是缺失。
 *
 * ── 为什么是 `rules/*.md` 而不是 JSON ───────────────────
 *
 * 与 `agents/*.md` 同样的理由：T1 正文是**改得最勤**的东西，
 * 写在 JSON 里是 `"每条…\n没有…"` 这种转义串，diff 读不出改了什么。
 * 而且文件天然增量 —— 加一条规则不可能删掉别人。
 */

export interface RuleCheck {
  /**
   * 结果里必须有的字段。`a[].b` 表示 a 非空且每个元素的 b 都非空。
   *
   * 这是目前唯一的 T2 形式 —— 刻意只做一种：结果契约是所有 agent 都有的
   * 收尾动作，所以这一种覆盖面最广。将来要加（比如「产出必须过某个检查器」）
   * 就在这里加字段，而不是让规则去引用一段代码。
   */
  requiredFields?: string[]
}

export interface UserRule {
  id: string
  /** T1：注入末尾约束块的原文。没有正文说明这条规则纯靠 T2/T3 强制 */
  constraint: string | null
  /** T2：机械校验 */
  check: RuleCheck | null
  /** T3：不给这些工具 —— 零成本、不可违反 */
  denyTools: string[]
  /** 作用于哪些 agent。`*` 或空表示全部 */
  appliesTo: string[]
  /** 来自哪个文件 */
  path: string
}

export interface RuleProblem {
  path: string
  message: string
  /** 阻断性的还是提醒 */
  fatal: boolean
}

const KNOWN_KEYS = ['appliesTo', 'denyTools', 'requiredFields', 'id']

export const DEFAULT_RULES_DIR = 'rules'
const SKIP = new Set(['readme.md', 'index.md', 'notes.md'])

/** 一个 `.md` → 规则。id 取自文件名，正文即 T1 约束原文。 */
export function parseRuleFile(path: string, text: string): { rule?: UserRule; problems: RuleProblem[] } {
  const id = basename(path).replace(/\.md$/, '')
  const { data, body, errors } = parseFrontmatter(text)
  const problems: RuleProblem[] = errors.map((message) => ({ path, message, fatal: true }))

  if (!/^[a-z][a-z0-9.-]*$/.test(id)) {
    problems.push({
      path,
      message: `文件名（即规则 id）只能是小写字母、数字、点与连字符：${id}`,
      fatal: true,
    })
  }
  for (const k of Object.keys(data)) {
    if (!KNOWN_KEYS.includes(k)) {
      problems.push({
        path,
        message: `未知的 frontmatter 键「${k}」（可用：${KNOWN_KEYS.join(', ')}）`,
        fatal: true,
      })
    }
  }

  const denyTools = Array.isArray(data['denyTools']) ? (data['denyTools'] as string[]) : []
  const requiredFields = Array.isArray(data['requiredFields'])
    ? (data['requiredFields'] as string[])
    : []
  const appliesTo = Array.isArray(data['appliesTo']) ? (data['appliesTo'] as string[]) : []
  const constraint = body.trim() || null
  const check: RuleCheck | null = requiredFields.length ? { requiredFields } : null

  /**
   * **只有 T1 的规则被拒绝。**
   *
   * 这是这个模块存在的核心理由。一条只写了正文、没有任何机械强制的规则，
   * 就是「prompt 里写满禁止但模型照犯」—— 它会显示在规则清单里、看起来
   * 系统在管这件事，而实际上什么都没管。**看起来有约束比没有约束更糟。**
   */
  if (constraint && !check && denyTools.length === 0) {
    problems.push({
      path,
      message:
        `只有 T1 正文，没有任何机械强制（check 或 denyTools）——` +
        ` 那等于一句没人强制的 prompt 文本。\n` +
        `    先问：能不能用「不给工具」表达？（denyTools，零成本且不可违反）\n` +
        `    再问：能不能机械校验？（requiredFields，被拒时原文回给模型让它重做）\n` +
        `    两个都不能的话，这条约束目前无法可靠强制 —— 与其假装管着，不如先不加`,
      fatal: true,
    })
  }
  if (!constraint && !check && denyTools.length === 0) {
    problems.push({ path, message: '空规则：既没有正文，也没有 check / denyTools', fatal: true })
  }

  if (problems.some((p) => p.fatal)) return { problems }

  return {
    rule: { id, constraint, check, denyTools, appliesTo, path },
    problems,
  }
}

export interface RuleLoadResult {
  rules: UserRule[]
  problems: RuleProblem[]
}

export function loadRuleFiles(dir: string = DEFAULT_RULES_DIR): RuleLoadResult {
  const root = resolve(dir)
  if (!existsSync(root)) return { rules: [], problems: [] }

  const rules: UserRule[] = []
  const problems: RuleProblem[] = []

  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith('.md')) continue
    // 目录里放说明是很自然的事。跳过一个**明确的**名单而不是「解析不出就跳过」——
    // 后者会把 frontmatter 写错的真规则也静默跳掉
    if (SKIP.has(name.toLowerCase()) || name.startsWith('_') || name.startsWith('.')) continue
    const path = join(root, name)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (e) {
      problems.push({ path, message: `读不出来：${(e as Error).message}`, fatal: true })
      continue
    }
    const { rule, problems: ps } = parseRuleFile(path, text)
    problems.push(...ps)
    if (rule) rules.push(rule)
  }

  return { rules, problems }
}

/**
 * 拿真实注册表校验。
 *
 * 与 `agent new --describe` 同一套分工：内容可以由人或 LLM 写，
 * **判定全部由运行时做**。引用不存在的 agent / 工具是最常见的错，
 * 而它**不会报错**，只会让规则静默失效。
 */
export function validateRules(
  rules: UserRule[],
  known: { agents: string[]; tools: string[]; resultFieldPaths?: string[] },
): RuleProblem[] {
  const out: RuleProblem[] = []
  const agents = new Set(known.agents)
  const tools = new Set(known.tools)
  const seen = new Set<string>()

  for (const r of rules) {
    if (seen.has(r.id)) {
      out.push({ path: r.path, message: `规则 id 重复：${r.id}`, fatal: true })
    }
    seen.add(r.id)

    for (const a of r.appliesTo) {
      if (a === '*') continue
      if (!agents.has(a)) {
        out.push({
          path: r.path,
          message: `appliesTo 里的「${a}」不是已有 agent（现有：${known.agents.join(', ')}）—— 这条规则不会对任何人生效`,
          fatal: true,
        })
      }
    }

    for (const t of r.denyTools) {
      // 通配符不校验 —— `mcp__*` 这种是合理写法
      if (t.includes('*')) continue
      if (!tools.has(t)) {
        out.push({
          path: r.path,
          message: `denyTools 里的「${t}」不是已注册的工具（MCP 工具名形如 server__tool）—— 拼错了不会报错，只会让这条 T3 形同虚设`,
          fatal: true,
        })
      }
    }

    // T3 已经挡住的东西不必再写 T1 —— 那是白花每轮的 token
    if (r.constraint && r.denyTools.length > 0 && !r.check) {
      out.push({
        path: r.path,
        message:
          `既有 denyTools 又有 T1 正文。T3 已经让这些工具不出现在模型看到的定义里，` +
          `再写一句「不要用它们」是白花每轮的约束块预算 —— 除非那句话讲的是别的事`,
        fatal: false,
      })
    }
  }
  return out
}

/**
 * 这个 agent 受哪些规则约束。
 *
 * `appliesTo` 为空或含 `*` 视为全局 —— 「对所有人生效」是常见意图，
 * 而让人把每个 agent 列一遍会在加新 agent 时静默漏掉。
 */
export function rulesForAgent(rules: UserRule[], agentId: string): UserRule[] {
  return rules.filter(
    (r) => r.appliesTo.length === 0 || r.appliesTo.includes('*') || r.appliesTo.includes(agentId),
  )
}

/** 这个 agent 的 T1 约束原文（注入末尾约束块） */
export function constraintsForAgent(rules: UserRule[], agentId: string): string[] {
  return rulesForAgent(rules, agentId)
    .map((r) => r.constraint)
    .filter((x): x is string => Boolean(x))
}

/** 这个 agent 因规则而必填的字段（T2），与 agent 自己声明的合并 */
export function requiredFieldsForAgent(rules: UserRule[], agentId: string): string[] {
  const out = new Set<string>()
  for (const r of rulesForAgent(rules, agentId)) {
    for (const f of r.check?.requiredFields ?? []) out.add(f)
  }
  return [...out]
}

/** 这个 agent 被规则禁掉的工具（T3），与 agent 自己的 toolsDeny 合并 */
export function denyToolsForAgent(rules: UserRule[], agentId: string): string[] {
  const out = new Set<string>()
  for (const r of rulesForAgent(rules, agentId)) {
    for (const t of r.denyTools) out.add(t)
  }
  return [...out]
}

/**
 * 一条规则落在哪几层 —— 给清单与向导用。
 *
 * 这个函数存在的意义是让「这条规则靠什么强制」变成可显示的事实，
 * 而不是要人去读 frontmatter 自己推断。
 */
export function tiersOf(r: UserRule): Array<'T1' | 'T2' | 'T3'> {
  const out: Array<'T1' | 'T2' | 'T3'> = []
  if (r.constraint) out.push('T1')
  if (r.check) out.push('T2')
  if (r.denyTools.length) out.push('T3')
  return out
}
