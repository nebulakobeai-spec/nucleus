import type { Nucleus } from '../boot.js'
import { FIELD_NAME, FIELD_NAME_HINT, RESERVED_FIELDS } from '../runtime/result-schema.js'
import {
  INLINE_MAX_TOKENS,
  roughTokens,
  TIER_WHAT,
  type UserRule,
} from '../runtime/user-rules.js'

/**
 * `rule new --describe` 的生成逻辑。
 *
 * ── 为什么交给模型判层，而不是让人走决策树 ──────────────────
 *
 * 第一版是一棵问答树（先问边界、再问检查、最后提醒）。逻辑没错，但**不直觉**：
 * 它把我的分类过程强加给使用者，而使用者心里想的是一句具体的要求，
 * 不是「这属于哪一层」。
 *
 * 而「这条约束属于哪一层」恰好是模型擅长判的 —— 它只需要理解那句要求的含义。
 * 所以顺序反过来：**你说一句话，模型提议完整的规则（含分层），
 * 运行时校验，只有校验不过或模型自己拿不准时才问你。**
 *
 * 与 `agent new --describe` 完全同一套分工：模型负责它擅长的（理解与措辞），
 * 判定交给运行时（工具是否真实、字段名是否合法、是否只剩提醒）。
 *
 * ── 提示词里必须给的东西 ──────────────────────────────
 *
 * 不只是「有三层」，还要给**三层各自的代价**。否则模型会像人一样默认写提醒 ——
 * 那是最省事的一层。代价写清楚，它才有理由去找边界或检查。
 *
 * 还有一条反直觉的：**必须明确允许它回答「这条无法可靠强制」**。
 * 不然为了满足「提醒必须配检查」这条硬要求，它会编一个不相干的检查
 * 来凑数 —— 那比只有提醒更糟，因为看起来还多了一层保障。
 */

export interface RuleProposal {
  /** 模型判的层，以及为什么 */
  tier: Array<'boundary' | 'check' | 'reminder'>
  reasoning: string
  denyTools?: string[]
  requiredFields?: string[]
  resultFields?: Record<string, { type: string; description?: string; fields?: Record<string, string> }>
  gist?: string | null
  constraint?: string | null
  appliesTo?: string[]
  /**
   * 模型认为这条约束无法可靠强制。
   *
   * **这是一个合法答案，不是失败。** 没有这个出口的话，模型为了满足
   * 「提醒必须配检查」会编一个不相干的检查来凑数 —— 那比只有提醒更糟，
   * 因为看起来还多了一层保障。
   */
  cannotEnforce?: boolean
  /**
   * 强制不了**的两种原因**，给出的建议完全相反。
   *
   * ── 为什么这个区分是必须的 ────────────────────────────
   *
   * 实测：「每次执行前必须写计划，用户审核同意后再执行」被判成 cannotEnforce，
   * 理由（模型自己推出来的，完全正确）是——这是跨回合的状态流转，而 check
   * 只能验模型自己提交的字段，加一个 `plan_approved` 等于让它自己给自己签字。
   *
   * 但那时我给的建议是「写进 agent 的 identity」，**那是错的建议**。
   * identity 是提醒的一种，正是这套设计要减少依赖的东西。这条约束不是
   * 「本质上判不了」，而是**运行时缺一个原语**（用户审批 / 对运行时事实的检查）。
   *
   *   inherent           本质判不了：语气、行文、思路是否清晰。人来判都要商量。
   *                      → 写进 identity 是对的，它也只能在那儿。
   *   missing_mechanism  运行时缺原语：跨回合状态、用户审批、
   *                      「验运行时发生过什么」而不是「验提交了什么」。
   *                      → **不要写进 identity** —— 那是把一个能修的缺口
   *                        埋成一句没人强制的话。该报给运行时。
   */
  unenforceableKind?: 'inherent' | 'missing_mechanism'
  /** missing_mechanism 时：缺的是什么原语，一句话 */
  missingMechanism?: string
  /** 拿不准的地方 —— 有内容时向导会就这几点问你 */
  uncertain?: string[]
}

export function ruleProposalSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      tier: {
        type: 'array',
        items: { type: 'string', enum: ['boundary', 'check', 'reminder'] },
        description:
          '这条规则落在哪几层。**优先用强的**：能用 boundary 表达就别用 reminder。' +
          'reminder 不能单独出现 —— 它必须配 check 或 boundary。',
      },
      reasoning: {
        type: 'string',
        description:
          '为什么是这几层。要说清**为什么不能用更强的那层** ——' +
          '比如「无法用 boundary：没有任何工具开关能阻止『不标来源』」。',
      },
      denyTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'boundary：要禁掉的工具，必须是已注册的名字',
      },
      resultFields: {
        type: 'object',
        description:
          'check：要求结果里有的**新字段**声明。核心字段之外的都要在这里声明，' +
          '否则 requiredFields 会引用一个不存在的字段。' +
          '形如 {"data_points": {"type":"object[]","description":"…",' +
          '"fields":{"value":"number","source":"string"}}}。' +
          '**字段名必须 snake_case**。',
      },
      requiredFields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'check：必填字段路径。`a[].b` 表示 a 非空且每一条的 b 都非空。' +
          '引用的顶层字段要么是核心字段，要么在 resultFields 里声明过。',
      },
      constraint: {
        type: 'string',
        description:
          'reminder 正文：给模型的**解释**，不是强制手段（强制由前两层做）。' +
          '可以留空。写的话说清「为什么」而不是重复「必须怎样」——' +
          '「必须怎样」已经由 check 强制了，重复一遍只是白花每轮的预算。',
      },
      gist: {
        type: 'string',
        description:
          `正文超过约 ${INLINE_MAX_TOKENS} token 时必须给的索引行。` +
          '**必须带触发条件** —— 模型看到的只有这一行，它据此决定要不要读正文。' +
          '正例「创建或部署文件前必读 —— 路径规则」；反例「工作区路径规则」（没说什么时候）。',
      },
      appliesTo: {
        type: 'array',
        items: { type: 'string' },
        description: '作用于哪些 agent。`["*"]` 表示全部 —— 多数规则该用这个',
      },
      cannotEnforce: {
        type: 'boolean',
        description:
          '这条约束**无法可靠强制**时置 true。**这是合法答案。**' +
          '不要为了凑齐「提醒配检查」去编一个不相干的检查 ——' +
          '那比只有提醒更糟，因为看起来还多了一层保障。',
      },
      unenforceableKind: {
        type: 'string',
        enum: ['inherent', 'missing_mechanism'],
        description:
          'cannotEnforce 时必填，两者给出的建议完全相反。' +
          '`inherent`：本质判不了 —— 语气、行文、思路是否清晰，人来判都要商量。' +
          '`missing_mechanism`：**这条要求本身是可机械判定的，只是运行时缺原语** ——' +
          '典型是跨回合状态、需要用户审批、或者要验「运行时发生过什么」' +
          '（调了哪个工具、有没有人批准）而不是「提交了什么」。',
      },
      missingMechanism: {
        type: 'string',
        description: 'missing_mechanism 时：缺的到底是什么原语，一句话。会被报给运行时。',
      },
      uncertain: {
        type: 'array',
        items: { type: 'string' },
        description: '拿不准的地方，一条一句。会拿去问使用者。宁可多写。',
      },
    },
    required: ['tier', 'reasoning'],
  }
}

/**
 * 装配提示词。
 *
 * 把系统真实拥有的东西全部摊给模型：工具连描述、核心字段、字段名约定、
 * 以及**三层各自的代价**。代价是最容易漏又最关键的一项 ——
 * 不写清楚，模型会像人一样默认选最省事的那层（提醒）。
 */
export function buildRulePrompt(n: Nucleus, id: string, description: string): string {
  const tools = [...n.tools.all()]
    .map((t) => `- ${t.name}：${t.description.split('\n')[0]}`)
    .join('\n')
  const agents = n.config.agents.map((a) => `- ${a.id}${a.whenToUse ? `：${a.whenToUse}` : ''}`).join('\n')

  return [
    '你在为一个多 agent 编排运行时设计一条规则。',
    '',
    '## 使用者的要求',
    description,
    '',
    `## 规则 id`,
    id,
    '',
    '## 三层强制方式 —— **代价差好几个数量级**',
    ...(['boundary', 'check', 'reminder'] as const).map((t) => `- **${t}**：${TIER_WHAT[t]}`),
    '',
    '## 两条硬性原则',
    '1. **reminder 不能单独存在。** 只有 reminder 的规则等于一句没人强制的 prompt 文本 ——',
    '   它会出现在规则清单里、看起来系统在管这件事，实际什么都没管。',
    '   **看起来有约束比没有约束更糟。**',
    '2. **能用 boundary 表达的绝不写成 reminder。** 前者零成本且不可违反。',
    '',
    '## 已注册的工具（boundary 只能禁这些里面的）',
    tools || '（无）',
    '',
    '## 结果的核心字段（check 可以直接要求它们必填）',
    RESERVED_FIELDS.join(' / '),
    `其它字段要先在 resultFields 里声明。${FIELD_NAME_HINT}。`,
    '',
    '## 现有 agent',
    agents || '（无）',
    '',
    '## 判断顺序',
    '先问：这条约束是不是「不许用某个工具」？→ 是则 boundary，到此为止，不必写任何文本。',
    '再问：违反了之后，能不能**只看提交的结果**就机械判出来？→ 能则 check。',
    '最后：reminder 只负责解释「为什么」，而且必须已经有 check 或 boundary。',
    '',
    /**
     * **这个事实必须写出来。**
     *
     * 实测 gemma4 自己推出了它（「模型可以伪造 plan_approved 直接跳过审核」），
     * 那是对的 —— 但不能靠模型每次都想到。它是 check 这一层的根本限制：
     * `validateResult(raw, spec)` 里的 `raw` 就是模型自己写的那份结果。
     *
     * 所以「主语是模型自己的声明」的 check 一律等于零 —— 而这类 check
     * 恰好最容易写出来（加一个 `verified: true` 就有了「检查」），
     * 也最容易让人以为已经管住了。
     */
    '## check 的根本限制 —— 判之前必须知道',
    'check 校验的是**模型自己提交的那份结果**，没有别的信息源。',
    '所以主语是「模型自己声称」的检查等于零：`plan_approved: true`、`verified: true`、',
    '`reviewed_by_user: true` —— 都是同一个模型填的，它想跳过就跳过。',
    '有效的 check 要求的是**内容本身**（数据带来源、结论带引用、字段非空），',
    '而不是一句「我做过了」。',
    '',
    '**如果两者都不行，置 cannotEnforce: true 并说明原因。那是合法答案** ——',
    '不要编一个不相干的 check 来凑数。',
    '同时必须给 unenforceableKind：本质判不了（inherent），',
    '还是这条要求本可机械判定、只是运行时缺原语（missing_mechanism，',
    '比如需要用户审批、跨回合状态、或者要验运行时发生过什么）。',
    '这两者的后续处理完全不同，所以不能含糊。',
    '',
    '调用 propose_rule 提交。',
  ].join('\n')
}

export interface ProposalProblem {
  field: string
  message: string
  fatal: boolean
}

/**
 * 拿真注册表校验模型的产出。
 *
 * 这一步是「LLM 生成」与「黑盒」的分界线。能机械判的一律机械判：
 * 工具是否注册、字段名是否合法、requiredFields 是否引用了未声明的字段、
 * 最终是否只剩提醒。
 *
 * **判不了的是「这个 check 真的对应那句要求吗」** —— 模型可能编一个形式合法
 * 但不相干的检查。所以那一条要人确认，向导会把它显式问出来。
 */
export function validateRuleProposal(
  n: Nucleus,
  p: RuleProposal,
): ProposalProblem[] {
  const out: ProposalProblem[] = []
  const tools = new Set([...n.tools.all()].map((t) => t.name))
  const agents = new Set(n.config.agents.map((a) => a.id))

  for (const t of p.denyTools ?? []) {
    if (t.includes('*')) continue
    if (!tools.has(t)) {
      out.push({
        field: 'denyTools',
        message: `「${t}」不是已注册的工具 —— 拼错不会报错，只会让这条边界形同虚设`,
        fatal: true,
      })
    }
  }
  for (const a of p.appliesTo ?? []) {
    if (a === '*') continue
    if (!agents.has(a)) {
      out.push({
        field: 'appliesTo',
        message: `「${a}」不是已有 agent（现有：${[...agents].join(', ')}）`,
        fatal: true,
      })
    }
  }

  const declared = new Set([...RESERVED_FIELDS, ...Object.keys(p.resultFields ?? {})])
  for (const [name, decl] of Object.entries(p.resultFields ?? {})) {
    if (!FIELD_NAME.test(name)) {
      out.push({ field: `resultFields.${name}`, message: FIELD_NAME_HINT, fatal: true })
    }
    if (RESERVED_FIELDS.includes(name)) {
      out.push({
        field: `resultFields.${name}`,
        message: `${name} 是核心字段，不能覆盖`,
        fatal: true,
      })
    }
    for (const f of Object.keys(decl.fields ?? {})) {
      if (!FIELD_NAME.test(f)) {
        out.push({ field: `resultFields.${name}.${f}`, message: FIELD_NAME_HINT, fatal: true })
      }
    }
  }
  for (const f of p.requiredFields ?? []) {
    const top = f.split(/[.[]/)[0]!
    if (!declared.has(top)) {
      out.push({
        field: 'requiredFields',
        message: `${f} 引用了未声明的字段「${top}」—— 要么用核心字段，要么在 resultFields 里声明`,
        fatal: true,
      })
    }
  }

  const hasCheck = Boolean(p.requiredFields?.length || Object.keys(p.resultFields ?? {}).length)
  const hasBoundary = Boolean(p.denyTools?.length)
  const hasReminder = Boolean(p.constraint?.trim())

  // 只剩提醒 → 阻断。这是整套设计的核心约束，模型也不能例外
  if (hasReminder && !hasCheck && !hasBoundary && !p.cannotEnforce) {
    out.push({
      field: 'tier',
      message:
        '只有 reminder，没有任何机械强制 —— 那等于一句没人强制的 prompt 文本。' +
        '要么找出 check / boundary，要么置 cannotEnforce',
      fatal: true,
    })
  }
  if (!hasReminder && !hasCheck && !hasBoundary && !p.cannotEnforce) {
    out.push({ field: 'tier', message: '什么都没提议', fatal: true })
  }

  // 边界够了还写提醒 —— 提示而非阻断（那句话可能讲的是别的事）
  if (hasBoundary && hasReminder && !hasCheck) {
    out.push({
      field: 'constraint',
      message: '边界已经让那些工具不出现在模型看到的定义里，再写一句提醒是白花每轮的预算',
      fatal: false,
    })
  }

  // 长正文必须有索引行
  if (p.constraint && roughTokens(p.constraint) > INLINE_MAX_TOKENS && !p.gist) {
    out.push({
      field: 'gist',
      message: `正文约 ${roughTokens(p.constraint)} token，超过内联上限，必须给索引行`,
      fatal: true,
    })
  }

  return out
}

/** 提案 → 规则（写文件前的预览与校验用） */
export function toRule(id: string, p: RuleProposal, path: string): UserRule {
  const resultFields = Object.keys(p.resultFields ?? {}).length ? p.resultFields : undefined
  const requiredFields = p.requiredFields?.length ? p.requiredFields : undefined
  return {
    id,
    gist: p.gist?.trim() || null,
    constraint: p.constraint?.trim() || null,
    check:
      resultFields || requiredFields
        ? {
            ...(requiredFields ? { requiredFields } : {}),
            ...(resultFields ? { resultFields: resultFields as never } : {}),
          }
        : null,
    denyTools: p.denyTools ?? [],
    appliesTo: p.appliesTo?.length ? p.appliesTo : ['*'],
    path,
  }
}

/** 渲染成 md 文件内容 */
export function renderRuleMd(r: UserRule): string {
  const fm: string[] = []
  if (r.gist) fm.push(`gist: ${r.gist}`)
  fm.push(`appliesTo: [${r.appliesTo.map((x) => `'${x}'`).join(', ')}]`)
  if (r.denyTools.length) fm.push(`denyTools: [${r.denyTools.join(', ')}]`)
  const rf = r.check?.requiredFields
  if (rf?.length) fm.push(`requiredFields: [${rf.join(', ')}]`)
  const decls = r.check?.resultFields
  if (decls && Object.keys(decls).length) {
    fm.push('resultFields:')
    for (const [name, decl] of Object.entries(decls)) {
      fm.push(`  ${name}:`)
      const o = decl as { type: string; description?: string; fields?: Record<string, unknown> }
      fm.push(`    type: ${o.type}`)
      if (o.description) fm.push(`    description: ${o.description}`)
      if (o.fields) {
        fm.push(`    fields:`)
        for (const [k, v] of Object.entries(o.fields)) {
          fm.push(`      ${k}: ${typeof v === 'string' ? v : (v as { type: string }).type}`)
        }
      }
    }
  }
  return `---\n${fm.join('\n')}\n---\n${r.constraint ? `\n${r.constraint}\n` : ''}`
}
