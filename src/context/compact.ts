import type { ChatMessage } from '../providers/types.js'
import { heuristicTokenizer, type Tokenizer } from './tokenizer.js'

/**
 * Compact —— 把退役的会话历史压成结构化摘要。
 *
 * ── 为什么摘要必须是结构化的，不是散文 ──────────────────────
 *
 * 「请总结上面的对话」会产出「用户与助手讨论了若干话题，包括……」这种东西。
 * 它读起来像摘要，但**恰好丢掉了唯一要紧的部分**：
 *
 *  - 用户明确提过的要求（「不要有任何 default 模型」）
 *  - 已经定下来的事（重新讨论就是浪费一整轮）
 *  - 悬而未决的问题
 *
 * 真实的故障形状是「模型忘了我三轮前说过什么，又开始建议我加 default 模型」。
 * 散文摘要挡不住这个，因为它没有任何地方**必须**写下约束。
 *
 * 所以用小词表 + function calling，和结果契约同一套思路：
 * 模型只负责它擅长的（把长对话浓缩），什么必须留下由 schema 强制。
 *
 * ── 摘要是有损且不可逆的，所以必须留账 ──────────────────────
 *
 * `compactions` 表一次一行，存「退役了哪些消息」与「摘出来的是什么」。
 * 没有它的话，「模型为什么忘了」根本无从定位 —— 而这类问题不会当场暴露，
 * 是在三轮之后以「它怎么又说这个」的形式出现的。
 *
 * 这个文件里全是纯函数：判定、渲染、校验都能不调模型就测。
 */

/** 摘要的结构。词表刻意小 —— 每一项都要能回答「丢了它会怎样」 */
export interface ConversationSummary {
  /**
   * 用户明确提出的要求与禁止，**尽量保留原话**。
   *
   * 这一项是整个结构存在的理由。它必须最先出现在渲染结果里，
   * 因为 context 靠前的位置注意力更高。
   */
  constraints: string[]
  /** 已经定下来的事 —— 重新讨论就是浪费一整轮 */
  decisions: string[]
  /** 悬而未决 —— 丢了会让下一轮假装一切都清楚 */
  open: string[]
  /** 产出过什么（artifact 路径或 ref）。只留引用，正文在 artifacts 表 */
  artifacts: string[]
  /** 其余背景，散文即可 */
  context: string
}

export const EMPTY_SUMMARY: ConversationSummary = {
  constraints: [],
  decisions: [],
  open: [],
  artifacts: [],
  context: '',
}

/** 给模型的产出 schema。用 function calling 而不是让它吐 markdown —— 好校验。 */
export function summarySchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description:
          '用户明确提出的要求与禁止，**尽量保留原话**。' +
          '这一项最重要：它决定下一轮会不会重犯已经被否掉的建议。' +
          '例：「不要有任何 default 模型，都要用户自己设置」。' +
          '只写用户说过的，不要写你推断出来的。没有就给空数组。',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description:
          '已经定下来的事，连同**为什么** —— 少了理由，下一轮会把它当成可以推翻的默认值。' +
          '例：「幂等键用计划时刻而非实际时刻，因为补跑要与原定触发视为同一件事」。',
      },
      open: {
        type: 'array',
        items: { type: 'string' },
        description:
          '**真正还悬着**的问题：你或用户明确说了「还没定」「待确认」的事。' +
          '不要为了填满这个字段去翻一条已经回答过的提问 —— ' +
          '实测中模型每次都会挑一条已答的技术问题塞进来，那是噪音，而且会逐代累积。' +
          '没有就给空数组，空着完全正常。',
      },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        description:
          '**本系统登记过的产出**的 ref 或路径（由 write_report / write_file 这类工具产生的）。' +
          '不要写对话里顺口提到的普通文件名 —— 比如 README.md、DESIGN.md、某个源码路径' +
          '都不是产出，写进来会让后续回合以为存在一个可读取的 artifact。' +
          '**不确定它是不是登记过的产出，就不要写。** 没有就给空数组。',
      },
      context: {
        type: 'string',
        description:
          '其余背景，散文即可。写下一轮真正需要知道的，不要写「双方进行了讨论」这类空话。',
      },
    },
    required: ['constraints', 'decisions', 'open', 'artifacts', 'context'],
  }
}

const HEADER = '## 此前对话摘要'

/**
 * 渲染成注入 context 的文本。
 *
 * 顺序不是随意的：**约束在最前面**。context 靠前的位置注意力更高，
 * 而「用户说过不要 X」正是最不能被忽略的一条。散文背景放最后。
 */
export function renderSummary(s: ConversationSummary, generation = 1): string {
  const parts: string[] = [`${HEADER}（第 ${generation} 代压缩，内容有损）`]

  if (s.constraints.length) {
    parts.push(
      '### 用户明确提过的要求（**仍然有效**）\n' + s.constraints.map((x) => `- ${x}`).join('\n'),
    )
  }
  if (s.decisions.length) {
    parts.push('### 已定下的事（不要重新讨论）\n' + s.decisions.map((x) => `- ${x}`).join('\n'))
  }
  if (s.open.length) {
    parts.push('### 悬而未决\n' + s.open.map((x) => `- ${x}`).join('\n'))
  }
  if (s.artifacts.length) {
    parts.push(`### 已产出\n${s.artifacts.map((x) => `- ${x}`).join('\n')}`)
  }
  if (s.context.trim()) {
    parts.push(`### 背景\n${s.context.trim()}`)
  }
  return parts.join('\n\n')
}

/**
 * 只保留约束的最小形态。
 *
 * 装配器在极端缺预算时原本是**把摘要整个丢掉**（`drop_summary`），包括里面
 * 全部用户约束 —— 而 compact 存在的唯一理由就是保住那些约束。
 * 到了最缺预算的时候第一个丢它，是自相矛盾的。
 *
 * 而摘要是结构化的，**本来就能按段降级** —— 这正是结构化的好处。
 * 丢掉 `context` 那段散文、只留 constraints（外加 open，因为「还悬着的事」
 * 丢了会让下一轮假装一切都清楚），能省下大部分体积而保住要紧内容。
 */
export function renderSummaryMinimal(s: ConversationSummary, generation = 1): string {
  const parts: string[] = [`${HEADER}（第 ${generation} 代，**已进一步压缩，只剩要求与未决**）`]
  if (s.constraints.length) {
    parts.push(
      '### 用户明确提过的要求（**仍然有效**）\n' + s.constraints.map((x) => `- ${x}`).join('\n'),
    )
  }
  if (s.open.length) {
    parts.push('### 悬而未决\n' + s.open.map((x) => `- ${x}`).join('\n'))
  }
  // 连约束都没有时返回空串 —— 让上层知道「没什么可保的」，直接走 drop
  return parts.length > 1 ? parts.join('\n\n') : ''
}

/** 组装摘要请求的提示词。**旧摘要一并传入 —— 摘要是增量的。** */
export function buildCompactPrompt(
  previous: ConversationSummary | null,
  retiring: ChatMessage[],
): string {
  const lines: string[] = [
    '你在压缩一段会话历史，为的是让后续回合在有限的 context 里仍然知道要紧的事。',
    '',
  ]

  if (previous) {
    // 增量：旧摘要必须传进来，否则「三轮前的约束」在第二次压缩时就没了
    lines.push(
      '## 已有的摘要（覆盖更早的对话）',
      '**它里面的约束与决定必须继续保留** —— 除非下面的新对话明确推翻了它们。',
      renderSummary(previous),
      '',
    )
  }

  lines.push(
    '## 这次要退役的对话',
    '（退役后这些原文不再进入 context，只剩你写的摘要）',
    '',
    ...retiring.map((m) => `[${m.role}] ${textOf(m)}`),
    '',
    '## 要求',
    '- **宁可留多也不要漏掉用户提过的要求。** 判断不了要不要留时，就留。',
    '- 不要写「双方讨论了……」这类空话 —— 摘要要能替代原文被用来做事。',
    '- 产出只写引用（路径 / ref），不要抄内容。',
    '- 你自己的推断与用户的原话要分开：constraints 只放用户说过的。',
    '',
    '调用 submit_summary 提交。',
  )
  return lines.join('\n')
}

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content
  // tool_calls 之类的非文本内容：摘要看不懂也用不上，只留一个标记
  return JSON.stringify(m.content ?? '').slice(0, 500)
}

export interface CompactDecision {
  compact: boolean
  /** 摘要要覆盖到哪条消息（含）。0 表示不动 */
  throughSeq: number
  reason: string
}

export interface CompactPolicy {
  /**
   * 历史占「可用于历史的预算」的比例超过这个数就压缩。
   *
   * 不等到装配器报 trim_history 才动手 —— 那时消息**已经被丢了**，
   * 这一轮的摘要救不回这一轮。压缩必须发生在装配之前。
   */
  triggerRatio: number
  /** 压缩后保留最近多少条原文。摘要替代不了「上一句刚说了什么」 */
  keepRecent: number
  /**
   * **要退役的条数**少于这个值就不压 —— 不值得为此调一次模型。
   *
   * 原来这个参数叫 `minMessages`，作用在「未摘要的总条数」上。那是错的对象，
   * 而且**它从来不改变结果**：`fresh < minMessages(8)` 被拒的情况，
   * 一定也会被「`fresh <= keepRecent(10)` 没有可退役的」拒掉 ——
   * 后者严格更强。所以它唯一的作用是换一句措辞，而且那句还不如后者准确。
   *
   * 真正没被挡住的是另一头：`fresh = 11, keepRecent = 10` → 退役 **1 条**。
   * 调一次模型给一条消息做摘要，纯浪费。盯 retireCount 才挡得住。
   */
  minRetire: number
}

export const DEFAULT_COMPACT_POLICY: CompactPolicy = {
  triggerRatio: 0.7,
  keepRecent: 10,
  // 退役少于 3 条不值得一次调用 —— 省下的 token 抵不上那次调用的成本与延迟
  minRetire: 3,
}

/**
 * 要不要压缩，压到哪。纯函数。
 *
 * `messages` 必须按 seq 升序（最旧的在前）。
 */
export function decideCompact(input: {
  messages: Array<{ seq: number; message: ChatMessage }>
  /** 已经被摘要覆盖到的 seq */
  summaryThroughSeq: number
  /** 留给历史的 token 预算 */
  historyBudget: number
  policy?: CompactPolicy
  tokenizer?: Tokenizer
}): CompactDecision {
  const policy = input.policy ?? DEFAULT_COMPACT_POLICY
  const t = input.tokenizer ?? heuristicTokenizer

  // 只考虑还没被摘要覆盖的部分
  const fresh = input.messages.filter((m) => m.seq > input.summaryThroughSeq)

  /**
   * 保留最近 keepRecent 条原文 —— 摘要替代不了「上一句刚说了什么」。
   *
   * 所以真正的问题从一开始就是「**能退役几条**」，而不是「总共有几条」。
   * 原来先判 `fresh.length < minMessages` 再判 `retireCount <= 0`，
   * 而前者被后者严格包含（keepRecent ≥ minMessages 时永远如此）——
   * 那一档从来不改变结果，只换一句措辞。合成一处。
   */
  const retireCount = fresh.length - policy.keepRecent
  if (retireCount <= 0) {
    return {
      compact: false,
      throughSeq: 0,
      reason:
        `只有 ${fresh.length} 条未摘要的消息，而要保留最近 ${policy.keepRecent} 条 ——` +
        ` 没有可退役的（--keep 可以调小，但这么短的对话压缩没有意义）`,
    }
  }
  if (retireCount < policy.minRetire) {
    // 这一档是原来漏掉的：11 条、保留 10 条 → 退役 1 条，
    // 调一次模型给一条消息做摘要，省下的 token 抵不上成本
    return {
      compact: false,
      throughSeq: 0,
      reason:
        `只能退役 ${retireCount} 条（共 ${fresh.length} 条，保留最近 ${policy.keepRecent} 条）` +
        `，少于 ${policy.minRetire} 条不值得调一次模型`,
    }
  }

  const tokens = fresh.reduce((n, m) => n + t.count(textOf(m.message)), 0)
  const threshold = Math.floor(input.historyBudget * policy.triggerRatio)
  if (tokens <= threshold) {
    return {
      compact: false,
      throughSeq: 0,
      // 数字要给出来 —— 「为什么没压缩」和「为什么压缩了」一样需要能回答
      reason: `历史 ${tokens} tok 未到阈值 ${threshold}（预算 ${input.historyBudget} × ${policy.triggerRatio}）`,
    }
  }

  /**
   * 真正的「压缩也救不了」是另一种形状：退役完之后，**留下的那几条本身**
   * 就超预算（比如贴了一大段日志）。这时压缩会成功，但装配器仍然要裁剪 ——
   * 所以要在理由里说出来，不能让人以为压缩过就够了。
   */
  const keptTokens = fresh.slice(retireCount).reduce((n, m) => n + t.count(textOf(m.message)), 0)
  const stillOver = keptTokens > input.historyBudget

  return {
    compact: true,
    throughSeq: fresh[retireCount - 1]!.seq,
    reason:
      `历史 ${tokens} tok 超过阈值 ${threshold}，退役最旧的 ${retireCount} 条` +
      (stillOver
        ? `（注意：保留的 ${policy.keepRecent} 条本身就占 ${keptTokens} tok，` +
          `超过预算 ${input.historyBudget} —— 压缩之后装配器仍会裁剪）`
        : ''),
  }
}

export interface SummaryProblem {
  field: string
  message: string
}

/**
 * 校验模型交回来的摘要。
 *
 * 这一步是「LLM 生成」与「黑盒」的分界线。能机械判的就机械判：
 * 结构、非空、以及**压缩比**（没变短就不是压缩）。
 */
export function validateSummary(
  s: unknown,
  opts: { tokensBefore: number; tokenizer?: Tokenizer } = { tokensBefore: 0 },
): { summary?: ConversationSummary; problems: SummaryProblem[] } {
  const problems: SummaryProblem[] = []
  if (!s || typeof s !== 'object') {
    return { problems: [{ field: '(整体)', message: '不是一个对象' }] }
  }
  const o = s as Record<string, unknown>

  const arr = (k: keyof ConversationSummary): string[] => {
    const v = o[k]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) {
      problems.push({ field: String(k), message: '应该是字符串数组' })
      return []
    }
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  }

  const summary: ConversationSummary = {
    constraints: arr('constraints'),
    decisions: arr('decisions'),
    open: arr('open'),
    artifacts: arr('artifacts'),
    context: typeof o['context'] === 'string' ? o['context'] : '',
  }

  const empty =
    summary.constraints.length === 0 &&
    summary.decisions.length === 0 &&
    summary.open.length === 0 &&
    !summary.context.trim()
  if (empty) {
    // 全空的摘要比不压缩更糟：消息退役了，替代品什么都没说
    problems.push({ field: '(整体)', message: '摘要是空的 —— 那些消息会白白退役' })
  }

  if (opts.tokensBefore > 0) {
    const t = opts.tokenizer ?? heuristicTokenizer
    const after = t.count(renderSummary(summary))
    if (after >= opts.tokensBefore) {
      // 没变短就不是压缩。发生过就说明 prompt 或模型有问题，不该静默接受
      problems.push({
        field: '(整体)',
        message: `摘要 ${after} tok 不比原文 ${opts.tokensBefore} tok 短 —— 这不是压缩`,
      })
    }
  }

  return problems.length ? { problems } : { summary, problems }
}

/**
 * 摘要声称的产出里，哪些是真的。
 *
 * 实测：gemma4:31b 把 `DESIGN.md` 与 `agents/*.md` 写进了 `artifacts` ——
 * 那是对话里顺口提到的文件名，不是这个系统登记过的产出。
 * 我的字段描述原文是「提到过的产出路径或 ref」，它照「提到过的路径」理解，
 * **是描述含糊，不是模型的错**。
 *
 * 描述已经写清了，但光靠 prompt 不够 —— 这正是这个项目的一贯立场：
 * 机器能判的就机器判。产出登记在 `artifacts` 表里，是可以核对的事实。
 *
 * 不静默丢弃：丢了什么要报出来，否则「摘要为什么没提那份报告」又变成谜案。
 */
export function reconcileArtifacts(
  claimed: string[],
  known: string[],
): { kept: string[]; dropped: string[] } {
  if (claimed.length === 0) return { kept: [], dropped: [] }
  // 宽松匹配：模型可能写 ref、也可能写路径，还可能带前后空白
  const norm = (s: string) => s.trim().toLowerCase()
  const index = new Set(known.map(norm))
  const kept: string[] = []
  const dropped: string[] = []
  for (const c of claimed) {
    if (index.has(norm(c))) kept.push(c.trim())
    else dropped.push(c.trim())
  }
  return { kept, dropped }
}

/** 压缩比，给终端与诊断包看 */
export function compressionRatio(before: number, after: number): string {
  if (before <= 0) return '—'
  return `${((1 - after / before) * 100).toFixed(0)}%`
}
