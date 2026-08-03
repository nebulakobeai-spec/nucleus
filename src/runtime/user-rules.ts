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
  /**
   * T1 正文。没有正文说明这条规则纯靠 T2/T3 强制。
   *
   * **可以很长。** 真实的规则往往是文档：实测一份规则集 18 个文件、
   * 共 28k token，单个最大 7k。一两句话说得清的规则是少数。
   *
   * 长正文**不会**每轮进 context —— 见 `gist`。
   */
  constraint: string | null
  /**
   * 索引行 —— **永远在 context 里的那一句**，正文按需加载。
   *
   * ── 为什么必须有这个字段 ──────────────────────────────
   *
   * 把整段正文每轮塞进末尾约束块是行不通的：约束块预算只有 ~2000 token
   * （131k 窗口），而 18 条规则就是 28k。超了会被**静默砍半**
   * （`shrink_constraints`）—— 对一份文档来说砍半等于毁掉，而且不报错。
   *
   * ── 索引行里必须带触发条件 ────────────────────────────
   *
   * 「工作区路径规则」这种索引是没用的 —— 模型不知道什么时候该去读。
   * 有用的是「**创建或部署文件前必读**」「**禁止推测硬件参数**」：
   * 那既是提醒也是触发条件。一句话同时干两件事，这是它值得占常驻预算的理由。
   */
  gist: string | null
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

const KNOWN_KEYS = ['appliesTo', 'denyTools', 'requiredFields', 'id', 'gist']

/**
 * 正文超过这么多 token 就必须给 `gist`，正文改为按需加载。
 *
 * 120 token 大约是三四行中文 —— 能一口气读完、放进常驻预算也不心疼的量。
 * 实测的真实规则最小的一个是 320 token，也就是说**几乎所有真规则都需要 gist**。
 * 那不是负担：写索引行的过程本身就是在回答「什么时候该看这条规则」，
 * 而那个答案不写下来，规则就只是一堆没人读的文档。
 */
export const INLINE_MAX_TOKENS = 120

/** 粗估 token —— 中文约 2 字符 1 token，英文约 4 */
export function roughTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x2e80 && c <= 0x9fff) cjk++
  }
  const other = text.length - cjk
  return Math.ceil(cjk / 1.6 + other / 4)
}

/** 这条规则的正文是内联还是按需 */
export function presenceOf(r: UserRule): 'inline' | 'indexed' | 'none' {
  if (!r.constraint) return 'none'
  return roughTokens(r.constraint) <= INLINE_MAX_TOKENS && !r.gist ? 'inline' : 'indexed'
}

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
  const gist = typeof data['gist'] === 'string' ? data['gist'].trim() || null : null
  const check: RuleCheck | null = requiredFields.length ? { requiredFields } : null

  /**
   * 长正文没有索引行 → 拒绝。
   *
   * 不是「警告然后照样塞进去」：约束块预算是 ~2000 token，一条 3000 token 的
   * 规则进去之后会被砍半，而砍半的文档比没有更糟 —— 前半段读起来像完整的规则，
   * 后半段（往往是例外与反例）不见了，而且**不报错**。
   */
  if (constraint && !gist && roughTokens(constraint) > INLINE_MAX_TOKENS) {
    problems.push({
      path,
      message:
        `正文约 ${roughTokens(constraint)} token，超过内联上限 ${INLINE_MAX_TOKENS} ——` +
        ` 必须给一个 gist（索引行），正文改为按需加载。\n` +
        `    gist 要**同时是提醒和触发条件**，模型才知道什么时候去读正文：\n` +
        `      gist: 创建或部署文件前必读 —— 路径规则\n` +
        `      gist: 禁止推测硬件参数，必须先验证\n` +
        `    反例（没有触发条件，等于没说）：「工作区路径规则」`,
      fatal: true,
    })
  }
  /**
   * gist 有没有说清「什么时候该读」。
   *
   * **这是筛查，不是判定** —— 机器判不了一句话是否真的可行动。
   * 但最懒的那种失败可以筛：把规则名重复一遍当索引行。
   *
   *   ✗ 「communication —— 相关操作前必读」  重复了 id，没说什么时候
   *   ✓ 「禁止推测硬件参数，必须先验证」      立刻可行动
   *   ✓ 「创建或部署文件前必读 —— 路径规则」   给了触发时机
   *
   * 判据：**不含任何触发词**就提醒。
   *
   * 一开始我还要求「gist 里抄了 id」才报，想少些误报 —— 但那漏掉了最典型的
   * 坏例子「工作区路径规则」（纯名词短语、没抄 id）。而中文的祈使句几乎必然
   * 带「要 / 必须 / 前 / 禁止」之一，纯名词短语才没有 —— 那正是要抓的形状。
   */
  if (gist) {
    const TRIGGER = /前|时|之后|涉及|禁止|不要|必须|不得|一律|只能|超过|遇到|发现|需要|要/
    if (!TRIGGER.test(gist)) {
      problems.push({
        path,
        message:
          `gist「${gist}」没说**什么时候**该读正文 —— 看起来只是给规则起了个名字。\n` +
          `    模型看到的只有这一行 —— 它据此决定要不要花一次工具调用去取正文。\n` +
          `    有用的写法带触发时机：「创建或部署文件前必读」「禁止推测硬件参数」`,
        fatal: false,
      })
    }
  }

  // 短正文又给了 gist：那两句会同时出现在约束块里，其中一句是白花的
  if (constraint && gist && roughTokens(constraint) <= INLINE_MAX_TOKENS) {
    problems.push({
      path,
      message:
        `正文只有约 ${roughTokens(constraint)} token，短到可以直接内联 ——` +
        ` 给了 gist 反而多占一行常驻预算。要么删掉 gist（正文直接内联），` +
        `要么把正文写全（那时 gist 才有意义）`,
      fatal: false,
    })
  }

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
    rule: { id, constraint, gist, check, denyTools, appliesTo, path },
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

/**
 * 这个 agent 的 T1 —— **注入末尾约束块的那几行**。
 *
 * 短规则给全文；长规则只给索引行加一句「正文在哪」。
 * 后者是这套设计的全部意义：28k 的规则压成 1k 左右的常驻成本。
 */
export function constraintsForAgent(rules: UserRule[], agentId: string): string[] {
  const out: string[] = []
  for (const r of rulesForAgent(rules, agentId)) {
    const how = presenceOf(r)
    if (how === 'inline') out.push(r.constraint!)
    else if (how === 'indexed') {
      // 索引行 + 怎么取正文。规则 id 要写出来 —— 否则模型不知道该 read_rule 什么
      out.push(`${r.gist ?? r.id}（完整规则：read_rule("${r.id}")）`)
    }
  }
  return out
}

/** 正文按需加载的那些规则 —— `read_rule` 的可取清单 */
export function indexedRulesForAgent(rules: UserRule[], agentId: string): UserRule[] {
  return rulesForAgent(rules, agentId).filter((r) => presenceOf(r) === 'indexed')
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
