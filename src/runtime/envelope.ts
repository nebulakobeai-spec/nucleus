import type { ChatMessage } from '../providers/types.js'

/**
 * 任务信封 —— 编排者派活时唯一的通道。
 *
 * 为什么要结构化，而不是一个自由字符串：
 *
 * 专家**看不到会话历史**（刻意设计：子 run 没有 conversationId，
 * 所以它在结构上无法把结果直发用户）。这意味着信封必须**自足** ——
 * 编排者写漏了背景，专家就只能抓瞎，而且没有任何机制能发现这件事。
 *
 * 以前的做法是在工具描述里写一句「包含必要上下文与验收标准」。那是劝导，
 * 没有任何东西保证它真的包含 —— 和「prompt 里写满禁止但模型照犯」是同一类
 * 问题。改成 schema 字段之后：漏了模型就调不成功，缺失率也能统计。
 *
 * `why`（为什么选这个专家）刻意**不进信封**：它是编排者关于「派给谁」的
 * 推理，对干活的专家无关，写进去还可能带偏它。它只进事件流，作为派错时的
 * 诊断材料。
 */

export interface TaskEnvelope {
  /** 要达成什么 */
  goal: string
  /** 专家需要知道的背景 —— 它看不到会话历史，这里不写就没有 */
  context: string
  /** 怎么算做完了。专家可以直接拿它自检 */
  acceptance: string
}

/** 老的信封形状。历史 run 的 input 里存的是这个，读的时候要兼容。 */
interface LegacyEnvelope {
  task?: string
}

const FIELDS: Array<{ key: keyof TaskEnvelope; heading: string; why: string }> = [
  { key: 'goal', heading: '任务', why: '要达成什么' },
  { key: 'context', heading: '背景', why: '你看不到之前的对话，需要的背景都在这里' },
  { key: 'acceptance', heading: '验收标准', why: '满足这些才算做完；提交前照着自检' },
]

/** 给模型看的参数 schema —— 描述里直说「专家看不到对话历史」 */
export function envelopeJsonSchema(): Record<string, unknown> {
  return {
    goal: {
      type: 'string',
      description: '要达成什么。一句话说清目标，不要复述用户原话。',
    },
    context: {
      type: 'string',
      description:
        '专家需要的背景。**专家看不到这段对话**，所以相关的前提、约束、' +
        '已知结论都要写在这里，否则它无从得知。',
    },
    acceptance: {
      type: 'string',
      description: '怎么算做完了。写成可检查的条件，专家会照着自检。',
    },
  }
}

/**
 * 渲染成专家收到的那条 user 消息。
 *
 * 分段带小标题而不是拼成一段散文：专家要按 acceptance 自检，
 * 拼成散文它得先把三件事拆回来。
 */
export function renderEnvelope(input: unknown): ChatMessage {
  const env = parseEnvelope(input)
  if (!env) {
    // 兜底：连老形状都对不上（比如手工塞进去的 input），如实转成文本，
    // 不要静默丢掉 —— 丢掉的话专家会收到一条空消息然后胡编
    return { role: 'user', content: JSON.stringify(input ?? {}) }
  }
  if ('task' in env) {
    return { role: 'user', content: env.task }
  }
  const blocks = FIELDS.filter((f) => env[f.key]?.trim()).map(
    (f, i) => `${i === 0 ? '# ' : '## '}${f.heading}\n${env[f.key].trim()}`,
  )
  return { role: 'user', content: blocks.join('\n\n') }
}

/** 解析出信封，认不出返回 null。返回 `{task}` 表示是老形状。 */
export function parseEnvelope(input: unknown): TaskEnvelope | { task: string } | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Partial<TaskEnvelope> & LegacyEnvelope
  if (typeof o.goal === 'string' && o.goal.trim()) {
    return {
      goal: o.goal,
      context: typeof o.context === 'string' ? o.context : '',
      acceptance: typeof o.acceptance === 'string' ? o.acceptance : '',
    }
  }
  // 历史 run：input 是 { task: '...' }
  if (typeof o.task === 'string' && o.task.trim()) return { task: o.task }
  return null
}

export interface EnvelopeProblem {
  field: keyof TaskEnvelope
  message: string
}

/**
 * 校验信封。
 *
 * 只挡「空」这一种，不设长度阈值 —— 阈值是拍脑袋的数字，而且「acceptance
 * 写得敷衍」和「acceptance 确实很短就够了」区分不了。所以硬规则只到非空，
 * 各字段长度记进事件流让它可度量。
 */
export function validateEnvelope(args: unknown): EnvelopeProblem[] {
  const o = (args ?? {}) as Partial<TaskEnvelope>
  const problems: EnvelopeProblem[] = []
  for (const f of FIELDS) {
    const v = o[f.key]
    if (typeof v !== 'string' || !v.trim()) {
      problems.push({ field: f.key, message: `${f.key} 不能为空 —— ${f.why}` })
    }
  }
  return problems
}

/** 各字段长度，进事件流用于统计「信封写得够不够」 */
export function envelopeSizes(args: unknown): Record<string, number> {
  const o = (args ?? {}) as Partial<TaskEnvelope>
  return Object.fromEntries(FIELDS.map((f) => [f.key, (o[f.key] ?? '').trim().length]))
}
