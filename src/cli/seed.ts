import type { ConversationStore } from '../store/conversations.js'

/**
 * 造一段用来测 compact 的会话历史。
 *
 * ── 为什么直接写库、不调模型 ────────────────────────────
 *
 * compact 只读消息日志。所以「助手那边答得像不像真的」对它毫无影响，
 * 而调 15 次 gemma4:31b 要十分钟。秒级、零 token 才能反复试。
 *
 * ── 第一版只埋三句固定的话，那测不出什么 ────────────────────
 *
 * 三句都以明确标记开头（「有一条你要一直记着」），都用「不要 / 必须」，
 * 都是自足单句 —— 最好认的形状。**对着 n=3 的固定集调 prompt 就是过拟合。**
 *
 * 所以现在每个场景同时埋四类，分别对应一种会真出问题的形状：
 *
 *  | 类型       | 摘要该怎么处理             | 处理错了会怎样 |
 *  |-----------|--------------------------|---------------|
 *  | constraint | 保留                     | 重犯已被否掉的建议 |
 *  | implicit   | 保留（没有「不要/必须」） | 靠关键词筛不出来，会静默丢 |
 *  | decoy      | **不要**放进 constraints  | 摘要逐代变脏，约束段塞满技术陈述 |
 *  | revision   | 覆盖掉它修的那条         | **留着已撤销的约束比丢掉更糟** —— 会拒绝你现在想要的 |
 *
 * `revision` 是最要紧的一类，也是我第一版完全没想到的：摘要里留着一条你已经
 * 撤销的要求，模型会照它办事，而你根本不知道它为什么在拒绝。
 *
 * 每条消息都带 `meta.synthetic = true`。合成历史被当成真对话是很糟的事
 * （比如你事后翻会话，会以为自己真说过这些话），必须能区分。
 */

export type SeedKind = 'constraint' | 'implicit' | 'decoy' | 'revision' | 'filler'

export interface SeedTurn {
  kind: SeedKind
  text: string
  /** 判断它有没有活下来的关键词 —— 摘要会改写措辞，所以查词不查整句 */
  keywords?: string[]
  /** revision 专用：它撤销/修改的是哪一条（按 id 引用） */
  revises?: string
  /**
   * 判「**旧状态**还被当成有效约束」用的词。只有会被撤销的约束需要它。
   *
   * 为什么不能复用 `keywords`：撤销之后摘要**应该**还提这个话题，
   * 只是换了结论。「暂时不要用真 Postgres」与「部署机上就用真 Postgres」
   * 都含 postgres —— 靠话题词分不开，得靠「不要」这种表达旧结论的词。
   */
  staleKeywords?: string[]
  /** constraint / implicit / decoy 的标识，供 revision 引用与结果对照 */
  id?: string
}

export interface Scenario {
  name: string
  description: string
  turns: SeedTurn[]
}

const FILLER_POOL = [
  '先说说 provider 层现在是怎么选路的。',
  '熔断的窗口和阈值分别是多少，为什么这么定？',
  'MCP 那块的工具名是怎么避免和内置工具撞车的？',
  '任务信封的三段各自解决什么问题？',
  'wake/join 为什么要放在同一个事务里？',
  '心跳是怎么做到不经过模型的？',
  '幂等键在工具调用和定时任务里是同一套语义吗？',
  '上下文装配的降级顺序是怎么排的？',
  'artifact 的 trust_level 有几档？',
  'run 级重试和就地重试的区别在哪？',
  '诊断包里为什么要带 transcript？',
  '会话锁是在哪一层实现的？',
  '委派深度的上限是多少？',
  'requiredFields 是怎么校验嵌套字段的？',
  'provider_events 记了哪几种 kind？',
]

const filler = (i: number): SeedTurn => ({
  kind: 'filler',
  text: FILLER_POOL[i % FILLER_POOL.length]!,
})

/**
 * 场景。
 *
 * 内容用这个项目自己的真实决定 —— 读摘要时你能判断对不对，
 * 而且它们本来就是「不该被忘掉」的那类话。
 */
export const SCENARIOS: Scenario[] = [
  {
    name: 'basic',
    description: '三条明确约束 + 填充。最容易的形状，用来看基本功能。',
    turns: [
      filler(0),
      {
        kind: 'constraint',
        id: 'no-default',
        text: '有一条你要一直记着：不要有任何 default 模型，所有模型都必须我自己在配置里声明。',
        keywords: ['default', '模型'],
      },
      filler(1),
      filler(2),
      {
        kind: 'constraint',
        id: 'runtime-rules',
        text: '再补一条：规则必须能被运行时强制，不能只写在 prompt 里。',
        keywords: ['运行时', 'prompt'],
      },
      filler(3),
      filler(4),
      filler(5),
      {
        kind: 'constraint',
        id: 'agents-md',
        text: '还有，专家 agent 只能来源于 agents/*.md 一个地方，不要再允许第二种来源。',
        keywords: ['agents', '来源'],
      },
      filler(6),
      filler(7),
      filler(8),
      filler(9),
      filler(10),
      filler(11),
    ],
  },
  {
    name: 'decoys',
    description:
      '**关键场景**：填充里混入「长得像约束的技术陈述」。它们用了「必须/不能」' +
      '但不是用户的要求 —— 被塞进 constraints 就是真缺陷。',
    turns: [
      {
        kind: 'constraint',
        id: 'no-cloud',
        text: '先说清楚：不要接任何云端模型，这台机器只用本地 ollama。',
        keywords: ['云端', '本地'],
      },
      // ↓ 以下三条都用了「必须 / 不能」，但都是在陈述系统事实，不是用户的要求
      {
        kind: 'decoy',
        id: 'decoy-tx',
        text: 'wake 和子 run 的终态必须在同一个事务里，这一点我理解得对吗？',
        keywords: ['事务'],
      },
      filler(0),
      {
        kind: 'decoy',
        id: 'decoy-heartbeat',
        text: '心跳不能经过模型 —— 因为经过 LLM 的心跳等于没有监控，对吧？',
        keywords: ['心跳'],
      },
      filler(1),
      {
        kind: 'constraint',
        id: 'no-guess',
        text: '另外要求一条：不确定的数字不要编，宁可留空并说明不知道。',
        keywords: ['不要编', '留空'],
      },
      {
        kind: 'decoy',
        id: 'decoy-nonidem',
        text: 'non_idempotent 的工具绝不能自动重跑，这条是写死在 domain 里的吧？',
        keywords: ['non_idempotent'],
      },
      filler(2),
      filler(3),
      filler(4),
      filler(5),
      filler(6),
      filler(7),
      filler(8),
    ],
  },
  {
    name: 'revision',
    description:
      '**最要紧的场景**：一条约束后来被撤销。摘要留着已撤销的约束' +
      '比丢掉一条更糟 —— 模型会照它拒绝你现在想要的东西。',
    turns: [
      {
        kind: 'constraint',
        id: 'no-pg',
        text: '暂时不要用真 Postgres，本地一律走 PGlite。',
        keywords: ['postgres'],
        // 旧结论的标志是「不要 + postgres 出现在同一行」
        staleKeywords: ['不要', 'postgres'],
      },
      filler(0),
      filler(1),
      {
        kind: 'constraint',
        id: 'zh-comments',
        text: '还有一条：注释一律写中文。',
        keywords: ['注释', '中文'],
      },
      filler(2),
      filler(3),
      {
        kind: 'revision',
        revises: 'no-pg',
        text: '刚才说的「不要用真 Postgres」那条取消了 —— 部署机上就用真 Postgres，本地才用 PGlite。',
        keywords: ['postgres'],
      },
      filler(4),
      filler(5),
      filler(6),
      filler(7),
      filler(8),
      filler(9),
      filler(10),
    ],
  },
  {
    name: 'implicit',
    description:
      '约束说得很委婉，没有「不要 / 必须」。关键词筛查会漏，' +
      '所以这个场景要人读一遍才能判。',
    turns: [
      {
        kind: 'implicit',
        id: 'dislike-default',
        text: '我觉得那些 default 模型挺碍事的，还是我自己声明比较放心。',
        keywords: ['default'],
      },
      filler(0),
      filler(1),
      {
        kind: 'implicit',
        id: 'prefer-short',
        text: '回答别铺开太长，我更愿意看结论加一句理由。',
        keywords: ['结论'],
      },
      filler(2),
      filler(3),
      filler(4),
      filler(5),
      filler(6),
      filler(7),
      filler(8),
      filler(9),
    ],
  },
]

/** 助手回复。刻意写得有信息量 —— 全是「好的」的话摘要就没东西可摘 */
function reply(turn: SeedTurn, i: number): string {
  if (turn.kind === 'constraint' || turn.kind === 'implicit') {
    return `明白，这条我记下了，后面都按它来。（第 ${i + 1} 轮）`
  }
  if (turn.kind === 'revision') {
    return `好，那条我撤掉了，按你新说的执行。（第 ${i + 1} 轮）`
  }
  return (
    `关于「${turn.text.slice(0, 16)}…」：这一块的做法是把判定和执行分开，` +
    `判定写成纯函数以便单测，执行侧只负责接线与落库。相关的不变量由测试钉住，` +
    `其中最要紧的是终态不可回改。细节见 DESIGN.md 第 ${i + 1} 节。` +
    `另外有个容易踩的点：同一毫秒内的多条记录用时间戳排序不稳定，` +
    `所以序号一律用数据库侧生成的单调值。`
  )
}

export interface SeedResult {
  scenario: string
  description: string
  turns: number
  messages: number
  /** 实际埋进去的（不含 filler） */
  planted: Array<SeedTurn & { turn: number }>
}

export function scenarioByName(name: string): Scenario | null {
  return SCENARIOS.find((s) => s.name === name) ?? null
}

/**
 * 往会话里写一个场景（每轮一条 user + 一条 assistant）。
 *
 * `turns` 截断或循环填充到指定长度 —— 但**埋点永远全部写入**，
 * 否则检查会去找根本不存在的约束。
 */
export async function seedConversation(
  conversations: ConversationStore,
  conversationId: string,
  opts: { scenario?: string; turns?: number } = {},
): Promise<SeedResult> {
  const sc = scenarioByName(opts.scenario ?? 'basic')
  if (!sc) throw new Error(`没有场景「${opts.scenario}」（可用：${SCENARIOS.map((s) => s.name).join(', ')}）`)

  const want = opts.turns ?? sc.turns.length
  const seq: SeedTurn[] = [...sc.turns]
  // 要求的轮数更多 → 补 filler；更少 → 只砍 filler，埋点一个不少
  if (want > seq.length) {
    for (let i = seq.length; i < want; i++) seq.push(filler(i))
  } else if (want < seq.length) {
    const marked = seq.filter((t) => t.kind !== 'filler')
    const fillers = seq.filter((t) => t.kind === 'filler')
    const keepFiller = Math.max(0, want - marked.length)
    // 保持原有顺序：按原数组走，filler 超额就跳过
    let used = 0
    const trimmed: SeedTurn[] = []
    for (const t of seq) {
      if (t.kind === 'filler') {
        if (used >= keepFiller) continue
        used++
      }
      trimmed.push(t)
    }
    seq.length = 0
    seq.push(...trimmed)
    void fillers
  }

  const planted: Array<SeedTurn & { turn: number }> = []
  let messages = 0

  for (let i = 0; i < seq.length; i++) {
    const t = seq[i]!
    const turnNo = i + 1
    await conversations.append({
      conversationId,
      role: 'user',
      content: t.text,
      // 合成历史必须可区分 —— 事后翻会话时不该以为自己真说过这些
      meta: {
        synthetic: true,
        seedTurn: turnNo,
        seedKind: t.kind,
        ...(t.id ? { seedId: t.id } : {}),
        ...(t.revises ? { seedRevises: t.revises } : {}),
        ...(t.keywords ? { seedKeywords: t.keywords } : {}),
      },
    })
    await conversations.append({
      conversationId,
      role: 'assistant',
      content: reply(t, i),
      meta: { synthetic: true, seedTurn: turnNo },
    })
    messages += 2
    if (t.kind !== 'filler') planted.push({ ...t, turn: turnNo })
  }

  return {
    scenario: sc.name,
    description: sc.description,
    turns: seq.length,
    messages,
    planted,
  }
}

// ── 检查 ──────────────────────────────────────────────

export type CheckVerdict = 'ok' | 'lost' | 'leaked' | 'stale'

export interface SeedCheck {
  kind: SeedKind
  turn: number
  text: string
  verdict: CheckVerdict
  /** 说清「为什么判成这样」，以及机器判不了的部分 */
  note: string
}

/**
 * 摘要处理得对不对。
 *
 * 四种判定，而不是一个「活下来了吗」：
 *
 *  - `ok`     —— 该留的留了 / 该拦的拦住了
 *  - `lost`   —— 约束丢了
 *  - `leaked` —— **诱饵混进了 constraints**。第一版完全测不到这一项
 *  - `stale`  —— **已撤销的约束还在**。比丢掉一条更糟：模型会照它拒绝你
 *                现在想要的东西，而你不知道它为什么在拒绝
 *
 * **这仍然是筛查，不是判定。** 查关键词不查意思：改写措辞会骗过它，
 * 而 `implicit` 那类本来就筛不出来。输出必须说清这一点。
 */
export function checkSummary(
  planted: Array<SeetTurnWithNo>,
  summary: { constraints: string[]; decisions: string[]; open: string[]; context: string },
): SeedCheck[] {
  /**
   * **逐行匹配，不是把 constraints 拼成一整块。**
   *
   * 实测踩到的：`revision` 场景里模型答对了 —— 摘要写的是
   * 「部署机上就用真 Postgres，本地才用 PGlite」，旧结论一点痕迹都没留。
   * 但我把所有 constraints 拼起来再查 `['postgres','pglite']`，两个词当然都
   * 命中 —— 命中的是**新状态那一行**。于是判成 stale，误报。
   *
   * 「某一条约束是否存在」本来就是**单行**的性质。拼成一块之后，
   * A 行的词 + B 行的词能凑出一个根本不存在的匹配。
   */
  const lines = summary.constraints.map((x) => x.toLowerCase())
  const elsewhere = [...summary.decisions, ...summary.open, summary.context]
    .join('\n')
    .toLowerCase()

  /** 有没有**某一行**同时含全部关键词 */
  const anyLine = (kw?: string[]) =>
    (kw ?? []).length > 0 && lines.some((l) => kw!.every((k) => l.includes(k.toLowerCase())))
  const inElsewhere = (kw?: string[]) =>
    (kw ?? []).length > 0 && kw!.every((k) => elsewhere.includes(k.toLowerCase()))

  const revisedIds = new Set(planted.filter((p) => p.revises).map((p) => p.revises!))
  const byId = new Map(planted.filter((p) => p.id).map((p) => [p.id!, p]))

  const out: SeedCheck[] = []
  for (const p of planted) {
    if (p.kind === 'decoy') {
      const leaked = anyLine(p.keywords)
      out.push({
        kind: p.kind,
        turn: p.turn,
        text: p.text,
        verdict: leaked ? 'leaked' : 'ok',
        note: leaked
          ? '这是技术陈述，不是你的要求 —— 混进 constraints 会让约束段逐代变脏'
          : '正确地没有当成约束'
          + (inElsewhere(p.keywords) ? '（出现在 decisions/背景 里，那是对的位置）' : ''),
      })
      continue
    }

    if (p.kind === 'revision') {
      // 撤销做对了 = 旧结论不再作为有效约束，而话题本身可以（也应该）还在
      const target = p.revises ? byId.get(p.revises) : undefined
      const oldStillThere = anyLine(target?.staleKeywords ?? p.staleKeywords)
      const topicGone = !anyLine(p.keywords) && !inElsewhere(p.keywords)
      out.push({
        kind: p.kind,
        turn: p.turn,
        text: p.text,
        verdict: oldStillThere ? 'stale' : topicGone ? 'lost' : 'ok',
        note: oldStillThere
          ? '旧结论仍然作为有效约束存在 —— 模型会照它拒绝你现在想要的'
          : topicGone
            ? '整个话题都没了 —— 撤销与新结论一起丢了'
            : '撤销被正确吸收：旧结论没了，新结论在',
      })
      continue
    }

    // constraint / implicit
    if (p.id && revisedIds.has(p.id)) {
      // 这条后来被撤了 → 只要旧结论不再是有效约束就算对
      const oldStillThere = anyLine(p.staleKeywords)
      out.push({
        kind: p.kind,
        turn: p.turn,
        text: p.text,
        verdict: oldStillThere ? 'stale' : 'ok',
        note: oldStillThere
          ? '这条后来被撤销了，却还作为有效约束留在 constraints 里'
          : '后来被撤销，正确地不再是有效约束',
      })
      continue
    }

    const kept = anyLine(p.keywords) || inElsewhere(p.keywords)
    out.push({
      kind: p.kind,
      turn: p.turn,
      text: p.text,
      verdict: kept ? 'ok' : 'lost',
      note:
        p.kind === 'implicit'
          ? kept
            ? '委婉表达也被识别成了要求'
            : '委婉表达丢了 —— 也可能只是关键词没命中，**这条必须人读一遍**'
          : kept
            ? anyLine(p.keywords)
              ? '保留在 constraints 里'
              : '保留了，但不在 constraints 段 —— 位置不理想，不算丢'
            : '丢了',
    })
  }
  return out
}

type SeetTurnWithNo = SeedTurn & { turn: number }

/** 从消息 meta 还原埋点 —— 只有 seed 出来的会话有 */
export function plantedFromMessages(
  msgs: Array<{ content: string; meta: Record<string, unknown> }>,
): Array<SeedTurn & { turn: number }> {
  const out: Array<SeedTurn & { turn: number }> = []
  for (const m of msgs) {
    const kind = m.meta['seedKind'] as SeedKind | undefined
    if (!kind || kind === 'filler') continue
    out.push({
      kind,
      turn: Number(m.meta['seedTurn'] ?? 0),
      text: m.content,
      ...(m.meta['seedId'] ? { id: String(m.meta['seedId']) } : {}),
      ...(m.meta['seedRevises'] ? { revises: String(m.meta['seedRevises']) } : {}),
      ...(Array.isArray(m.meta['seedKeywords'])
        ? { keywords: m.meta['seedKeywords'] as string[] }
        : {}),
    })
  }
  return out
}
