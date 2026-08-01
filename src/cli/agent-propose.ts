import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { GRANTABLE, isPermission, PERMISSION_SPECS, type Permission } from '../runtime/permissions.js'
import {
  RESERVED_FIELDS,
  validateResultFields,
  type ResultFields,
} from '../runtime/result-schema.js'
import type { AgentConfig } from '../config.js'
import { c, line, resolveDb } from './ui.js'

/**
 * `agent new --describe` 的生成逻辑。
 *
 * 之所以比一般的「让 LLM 写 prompt」靠谱：**系统手里已经有它需要的全部素材**
 * —— 权限词表（连每一项的风险）、已注册工具（描述 + 所需权限 + 副作用等级）、
 * 现有专家名册（用来避开语义重叠）、结果字段的词表。
 *
 * 更要紧的是**生成完的东西能被真检查**：权限必须合法且可授予、引用的工具必须
 * 真实注册、结果字段声明必须过校验、whenToUse 与现有专家的重叠要报出来。
 * 模型只负责它擅长的（把一句话展开成丰富准确的正文），判定交给运行时。
 *
 * 这个文件里全是纯函数 —— 提示词的装配与产出的校验都能不调模型就测。
 */

export interface ProposedAgent {
  whenToUse: string
  identity: string
  permissions: string[]
  resultFields?: ResultFields
  requiredFields?: string[]
  cases?: string[]
  rationale?: string
}

/** 给模型的产出 schema。用 function calling 而不是让它吐 markdown —— 好校验。 */
export function proposalSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      whenToUse: {
        type: 'string',
        description:
          '一句话：什么时候该把任务派给它。**写成可判别的条件，不要写成名词。** ' +
          '反例「调研」「负责研究相关任务」；正例「需要查外部资料、且结论必须带可验证来源时」。' +
          '也要写清它做不到什么，用结果描述而不是工具名。',
      },
      identity: {
        type: 'string',
        description:
          '这个专家的 system prompt 正文。第二人称，写「你是谁、怎么做事」。' +
          '写具体的做事方式，不要写「请务必…」这类无法验证的话 —— ' +
          '能力边界由 permissions 强制，结果要求由 requiredFields 强制，都不依赖模型记得。' +
          '注意它**看不到会话历史**，只收到「任务/背景/验收标准」三段信封，' +
          '所以不要假设它知道任何上下文。',
      },
      permissions: {
        type: 'array',
        items: { type: 'string', enum: [...GRANTABLE] },
        description:
          '最小必要权限。**宁少勿多** —— 每一项都会被单独确认，多给的会被质疑。',
      },
      resultFields: {
        type: 'object',
        description:
          '可选：这个专家要交出的结构化字段。只在核心字段（status/summary/artifacts/' +
          'confidence/open_questions）不够时才加。' +
          '每个字段形如 {"type":"string|number|boolean|string[]|number[]|object[]", "description":"…"}；' +
          'object[] 还要有 fields（元素字段，值是类型名）。',
      },
      requiredFields: {
        type: 'array',
        items: { type: 'string' },
        description:
          '可选：哪些字段必填。`a[].b` 表示 a 非空且每一个元素的 b 都非空。' +
          '只写真正必须的 —— 每加一条都会提高被退回的概率。',
      },
      cases: {
        type: 'array',
        items: { type: 'string' },
        description:
          '3-5 道试题：一道典型任务，其余是边界情况（数据缺失 / 要求矛盾 / ' +
          '超出它能力范围时它该怎么做）。这些会成为回归集。',
      },
      rationale: {
        type: 'string',
        description: '为什么是这些权限与这个范围。一两句，给人看的。',
      },
    },
    required: ['whenToUse', 'identity', 'permissions', 'cases', 'rationale'],
  }
}

/**
 * 装配提示词。
 *
 * 把系统真实拥有的东西全部摊给模型：权限连风险、工具连所需权限、现有专家连
 * 职责。凭空写 prompt 与「照着真实目录写」的差别就在这里。
 */
export function buildPrompt(n: Nucleus, id: string, description: string): string {
  const perms = PERMISSION_SPECS.filter((p) => GRANTABLE.includes(p.id))
    .map((p) => `- ${p.id}：${p.what}\n  风险：${p.risk}`)
    .join('\n')

  const tools = [...n.tools.all()]
    .map(
      (t) =>
        `- ${t.name}（需要 ${t.requires.join('+') || '无权限'}，副作用 ${t.sideEffect}）：${t.description.split('\n')[0]}`,
    )
    .join('\n')

  const others = n.config.agents
    .filter((a) => a.id !== id)
    .map((a) => `- ${a.id}${a.whenToUse ? `：${a.whenToUse}` : '（未声明职责）'}`)
    .join('\n')

  return [
    '你在为一个多 agent 编排系统设计一个新的专家 agent。',
    '',
    `## 使用者的描述`,
    description,
    '',
    `## 这个 agent 的 id`,
    id,
    '',
    '## 可授予的权限',
    perms,
    '',
    '## 已注册的工具（它只能看到权限覆盖到的那些）',
    tools || '（无）',
    '',
    '## 现有的 agent —— whenToUse **不要与它们语义重叠**',
    others || '（无）',
    '',
    '## 硬性约束',
    '- 权限**最小必要**。给了 execute 基本等于给了本机权限，除非描述里明确需要跑代码，不要给。',
    '- 声明了某个权限但系统里没有对应工具时，那个权限是空的 —— 会被指出来。',
    `- 结果字段不能覆盖核心字段：${RESERVED_FIELDS.join(' / ')}。`,
    '- 它看不到会话历史，只收到「任务 / 背景 / 验收标准」三段信封。',
    '',
    '调用 propose_agent 提交你的设计。',
  ].join('\n')
}

export interface ProposalProblem {
  field: string
  message: string
  /** 阻断性的（必须改）还是提醒 */
  fatal: boolean
}

/**
 * 拿真注册表校验产出。
 *
 * 这一步是「LLM 生成」与「黑盒」的分界线：生成之后的每一项判定都是确定性的。
 */
export function validateProposal(
  n: Nucleus,
  id: string,
  p: ProposedAgent,
): ProposalProblem[] {
  const out: ProposalProblem[] = []

  if (!p.whenToUse?.trim()) {
    out.push({ field: 'whenToUse', message: '不能为空 —— 编排者靠它选人', fatal: true })
  }
  if (!p.identity?.trim()) {
    out.push({ field: 'identity', message: '不能为空 —— 它就是模型收到的 prompt', fatal: true })
  }

  for (const perm of p.permissions ?? []) {
    if (!isPermission(perm)) {
      out.push({ field: 'permissions', message: `未知权限「${perm}」`, fatal: true })
    } else if (!GRANTABLE.includes(perm as Permission)) {
      out.push({ field: 'permissions', message: `${perm} 不可授予`, fatal: true })
    }
  }

  // 声明了权限但系统里没有对应工具 —— 那个权限是空的，值得说但不阻断
  const granted = (p.permissions ?? []).filter(isPermission)
  for (const perm of granted) {
    const covered = [...n.tools.all()].some((t) => t.requires.includes(perm))
    if (!covered && perm !== 'user' && perm !== 'delegate') {
      out.push({
        field: 'permissions',
        message: `授予了 ${perm}，但当前没有任何工具需要它 —— 这个权限现在是空的（配了相应 MCP 后会生效）`,
        fatal: false,
      })
    }
  }

  for (const fp of validateResultFields(p.resultFields)) {
    out.push({ field: `resultFields.${fp.field}`, message: fp.message, fatal: true })
  }

  // requiredFields 引用的顶层字段必须存在（核心字段或声明的字段）
  const known = new Set([...RESERVED_FIELDS, ...Object.keys(p.resultFields ?? {})])
  for (const f of p.requiredFields ?? []) {
    const top = f.split(/[.[]/)[0]!
    if (!known.has(top)) {
      out.push({
        field: 'requiredFields',
        message: `${f} 引用了未声明的字段「${top}」`,
        fatal: true,
      })
    }
  }

  if ((p.cases?.length ?? 0) < 2) {
    out.push({
      field: 'cases',
      message: '少于 2 道试题 —— 版本对比需要固定试题集，一道题看不出退步',
      fatal: false,
    })
  }

  out.push(...overlapWarnings(n, id, p.whenToUse ?? ''))
  return out
}

/**
 * 与现有专家的职责重叠。
 *
 * 语义相邻的专家必然被派错，而这件事在加第三、第四个专家时才显现 ——
 * 那时已经不好改了。所以生成时就要说。
 *
 * 判据故意粗糙（共同词 + 长度归一），因为它只是**提醒人去看**，
 * 不是自动拒绝。精确的语义相似度需要 embedding，而那属于 L3。
 */
export function overlapWarnings(n: Nucleus, id: string, whenToUse: string): ProposalProblem[] {
  const tokens = (s: string) =>
    new Set(
      s
        .replace(/[，。、；：（）()【】\s]+/g, ' ')
        .split(' ')
        .filter((x) => x.length >= 2),
    )
  const mine = tokens(whenToUse)
  if (mine.size === 0) return []

  const out: ProposalProblem[] = []
  for (const a of n.config.agents) {
    if (a.id === id || !a.whenToUse) continue
    const theirs = tokens(a.whenToUse)
    const shared = [...mine].filter((t) => theirs.has(t))
    const ratio = shared.length / Math.min(mine.size, theirs.size)
    if (ratio >= 0.4) {
      out.push({
        field: 'whenToUse',
        message:
          `与 ${a.id} 可能重叠（共同词：${shared.join('、')}）—— ` +
          `语义相邻的专家会被派错，考虑把两者的界限写明确`,
        fatal: false,
      })
    }
  }
  return out
}

/** 提案 → agent 定义（用于写文件前的预览与校验） */
export function toAgentConfig(id: string, p: ProposedAgent): AgentConfig {
  const a: AgentConfig = {
    id,
    name: id,
    identity: p.identity.trim(),
    whenToUse: p.whenToUse.trim(),
    permissions: (p.permissions ?? []).filter(isPermission),
  }
  if (p.resultFields && Object.keys(p.resultFields).length) a.resultFields = p.resultFields
  if (p.requiredFields?.length) a.requiredFields = p.requiredFields
  return a
}

/** 渲染成 md 文件内容 */
export function renderAgentMd(id: string, p: ProposedAgent): string {
  const fm: string[] = [`name: ${id}`, `whenToUse: ${p.whenToUse.trim()}`]
  fm.push(`permissions: [${(p.permissions ?? []).join(', ')}]`)
  if (p.requiredFields?.length) fm.push(`requiredFields: [${p.requiredFields.join(', ')}]`)
  if (p.resultFields && Object.keys(p.resultFields).length) {
    fm.push('resultFields:')
    for (const [name, decl] of Object.entries(p.resultFields)) {
      fm.push(`  ${name}:`)
      for (const [k, v] of Object.entries(decl as Record<string, unknown>)) {
        if (k === 'fields' && v && typeof v === 'object') {
          fm.push(`    fields:`)
          for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
            fm.push(`      ${ek}: ${typeof ev === 'string' ? ev : (ev as { type: string }).type}`)
          }
        } else {
          fm.push(`    ${k}: ${String(v)}`)
        }
      }
    }
  }
  return `---\n${fm.join('\n')}\n---\n\n${p.identity.trim()}\n`
}

export function renderCasesMd(id: string, cases: string[]): string {
  return (
    `# ${id} 的试题集\n\n` +
    `每个 \`- \` 开头的段落是一道题。**试题永远不进 prompt** ——\n` +
    `它只被 \`nucleus agent try\` 读，用来做重复跑与版本对比。\n\n` +
    `下面是生成时提议的。每踩一个坑就加一条，它会逐渐变成回归集。\n\n` +
    cases.map((x) => `- ${x.trim()}`).join('\n') +
    '\n'
  )
}

/** 打印权限连风险 —— 让人在确认前看清代价 */
export function printPermissions(perms: string[]): void {
  for (const p of perms) {
    const spec = PERMISSION_SPECS.find((x) => x.id === p)
    if (!spec) {
      line(`  ${c.red(p)} ${c.gray('未知权限')}`)
      continue
    }
    const dangerous = p === 'execute' || p === 'network'
    line(`  ${dangerous ? c.yellow(p.padEnd(9)) : p.padEnd(9)} ${spec.what}`)
    line(`  ${' '.repeat(9)} ${dangerous ? c.yellow('⚠ ' + spec.risk) : c.gray(spec.risk)}`)
  }
}

/** 便于测试：不依赖真实 boot 的最小接口 */
export type ToolCatalog = Pick<Nucleus, 'tools' | 'config'>
export async function bootForProposal(flags: Record<string, string | true>): Promise<Nucleus> {
  const { config } = await loadConfig(typeof flags['config'] === 'string' ? flags['config'] : undefined)
  return boot({
    config,
    ...resolveDb(flags),
    skipMcp: flags['mcp'] !== true,
  })
}
