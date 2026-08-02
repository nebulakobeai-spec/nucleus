import type { ConversationStore } from '../store/conversations.js'

/**
 * 造一段用来测 compact 的会话历史。
 *
 * ── 为什么直接写库、不调模型 ────────────────────────────
 *
 * compact 只读消息日志。所以「助手那边答得像不像真的」对它毫无影响，
 * 而调 15 次 gemma4:31b 要十分钟。秒级、零 token 才能反复试。
 *
 * ── 为什么要有「埋了哪几条约束」这份清单 ─────────────────
 *
 * 评估 compact 要回答的是「第 2 轮说过的要求，到第 15 轮还在不在」。
 * 如果那 15 轮是模型现场编的，你就**没有对照物** —— 只能读一遍摘要凭感觉
 * 判断，而摘要读起来总是通顺的。所以约束必须是我们自己埋进去的、已知的。
 *
 * 每条消息都带 `meta.synthetic = true`。合成历史被当成真对话是很糟的事
 * （比如你事后翻会话，会以为自己真说过这些话），必须能区分。
 */

export interface PlantedConstraint {
  /** 第几轮说的（1-based，指用户消息的序号） */
  turn: number
  /** 原话 */
  text: string
  /** 判断它有没有活下来的关键词 —— 摘要可能改写措辞，所以查词不查整句 */
  keywords: string[]
}

/**
 * 埋进去的约束。
 *
 * 内容刻意用这个项目自己的真实决定 —— 一来读摘要时你能判断对不对，
 * 二来它们本来就是「不该被忘掉」的那类话。
 */
const CONSTRAINTS: PlantedConstraint[] = [
  {
    turn: 2,
    text: '有一条你要一直记着：不要有任何 default 模型，所有模型都必须我自己在配置里声明。',
    keywords: ['default', '模型'],
  },
  {
    turn: 5,
    text: '再补一条：规则必须能被运行时强制，不能只写在 prompt 里 —— 写在 prompt 里的规则模型会忽略。',
    keywords: ['运行时', '强制', 'prompt'],
  },
  {
    turn: 9,
    text: '还有，专家 agent 只能来源于 agents/*.md 一个地方，不要再允许第二种来源。',
    keywords: ['agents', 'md', '来源'],
  },
]

/** 填充轮次的话题。内容不重要，但要够长才能推高 token 数 */
const FILLER = [
  '先说说 provider 层现在是怎么选路的。',
  '熔断的窗口和阈值分别是多少，为什么这么定？',
  'MCP 那块的工具名是怎么避免和内置工具撞车的？',
  '任务信封的三段各自解决什么问题？',
  'wake/join 为什么要放在同一个事务里？',
  '心跳是怎么做到不经过模型的？',
  '幂等键在工具调用和定时任务里是同一套语义吗？',
  '上下文装配的降级顺序是怎么排的，为什么是这个顺序？',
  'artifact 的 trust_level 有几档，各自意味着什么？',
  'run 级重试和就地重试的区别在哪？',
  '诊断包里为什么要带 transcript？',
  '会话锁是在哪一层实现的？',
  '委派深度的上限是多少，为什么需要这个上限？',
  '结果契约里的 requiredFields 是怎么校验嵌套字段的？',
  'provider_events 记了哪几种 kind？',
]

/** 助手回复。刻意写得有信息量 —— 全是「好的」的话摘要就没东西可摘 */
function reply(topic: string, i: number): string {
  return (
    `关于「${topic}」：这一块的做法是把判定和执行分开，判定写成纯函数以便单测，` +
    `执行侧只负责接线与落库。相关的不变量有三条，都由测试钉住，` +
    `其中最要紧的是终态不可回改。具体数字与代码位置见 DESIGN.md 第 ${i + 1} 节。` +
    `另外这里有一个容易踩的点：同一毫秒内的多条记录用时间戳排序是不稳定的，` +
    `所以序号一律用数据库侧生成的单调值。`
  )
}

export interface SeedResult {
  turns: number
  messages: number
  planted: PlantedConstraint[]
}

/**
 * 往会话里写 `turns` 轮（每轮一条 user + 一条 assistant）。
 *
 * 约束按 CONSTRAINTS 里声明的轮次插入 —— 轮数不够时只插得下的那几条，
 * 返回值里只列**实际埋进去的**，否则检查会去找根本不存在的约束。
 */
export async function seedConversation(
  conversations: ConversationStore,
  conversationId: string,
  turns: number,
): Promise<SeedResult> {
  const planted: PlantedConstraint[] = []
  let messages = 0

  for (let i = 0; i < turns; i++) {
    const turnNo = i + 1
    const constraint = CONSTRAINTS.find((x) => x.turn === turnNo)
    const topic = FILLER[i % FILLER.length]!
    const content = constraint ? constraint.text : topic

    await conversations.append({
      conversationId,
      role: 'user',
      content,
      // 合成历史必须可区分 —— 事后翻会话时不该以为自己真说过这些
      meta: { synthetic: true, seedTurn: turnNo, ...(constraint ? { constraint: true } : {}) },
    })
    await conversations.append({
      conversationId,
      role: 'assistant',
      content: reply(constraint ? '你提的这条要求' : topic, i),
      meta: { synthetic: true, seedTurn: turnNo },
    })
    messages += 2
    if (constraint) planted.push(constraint)
  }

  return { turns, messages, planted }
}

export interface ConstraintCheck {
  constraint: PlantedConstraint
  /** 关键词全都出现在摘要里 */
  survived: boolean
  /** 没出现的那些词 */
  missing: string[]
}

/**
 * 摘要里还剩哪几条约束。
 *
 * **这是筛查，不是判定。** 查关键词而不是整句，因为摘要会改写措辞；
 * 但反过来关键词都在也不代表意思没变。所以输出要说清「机器只能查到这一步」，
 * 剩下的要人读一遍 —— 而人读一遍时手里有这份清单，比空手读有用得多。
 */
export function checkConstraints(
  planted: PlantedConstraint[],
  summaryText: string,
): ConstraintCheck[] {
  const hay = summaryText.toLowerCase()
  return planted.map((c) => {
    const missing = c.keywords.filter((k) => !hay.includes(k.toLowerCase()))
    return { constraint: c, survived: missing.length === 0, missing }
  })
}
