import type { Db, Queryable } from '../db/types.js'
import type { Deps } from '../seams.js'
import type { ChatMessage } from '../providers/types.js'
import type { ConversationSummary } from '../context/compact.js'

export interface Conversation {
  id: string
  title: string | null
  agentId: string
  parentConversationId: string | null
  forkedAtSeq: number | null
  activeRunId: string | null
  lastSeq: number
  pinned: boolean
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
  /** 结构化摘要的 JSON。null = 还没压缩过 */
  summary: ConversationSummary | null
  /** 摘要覆盖到哪条消息（含）。它之后的消息仍然逐条进 context */
  summaryThroughSeq: number
  /** 摘了几代。增量摘要会逐代失真，代数是判断可信度的依据 */
  summaryGeneration: number
}

export type MessageRole = 'user' | 'assistant' | 'system_note'

/** 一次压缩的账。摘要是有损且不可逆的，所以每次都留档 */
export interface CompactionRecord {
  generation: number
  fromSeq: number
  throughSeq: number
  messageCount: number
  tokensBefore: number
  tokensAfter: number
  /** 摘要正文（JSON 文本）或失败原因 */
  summary: string
  provider: string | null
  model: string | null
  outcome: 'ok' | 'failed'
  createdAt: Date
}

export interface Message {
  id: string
  conversationId: string
  seq: number
  role: MessageRole
  content: string
  runId: string | null
  artifacts: string[]
  tokens: number | null
  meta: Record<string, unknown>
  createdAt: Date
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const toConv = (r: any): Conversation => ({
  id: r.id,
  title: r.title,
  agentId: r.agent_id,
  parentConversationId: r.parent_conversation_id,
  forkedAtSeq: r.forked_at_seq,
  activeRunId: r.active_run_id,
  lastSeq: r.last_seq,
  pinned: r.pinned,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  summary: parseSummary(r.summary),
  summaryThroughSeq: r.summary_through_seq ?? 0,
  summaryGeneration: r.summary_generation ?? 0,
})

/**
 * 摘要存的是 JSON 文本。解析失败时**当作没有摘要**而不是抛 ——
 * 一个坏摘要不该让整个会话打不开；下一次压缩会覆盖它。
 */
function parseSummary(raw: unknown): ConversationSummary | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as ConversationSummary
  try {
    return JSON.parse(String(raw)) as ConversationSummary
  } catch {
    return null
  }
}

const toMsg = (r: any): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  seq: r.seq,
  role: r.role,
  content: r.content,
  runId: r.run_id,
  artifacts: r.artifacts ?? [],
  tokens: r.tokens,
  meta: r.meta ?? {},
  createdAt: r.created_at,
})
/* eslint-enable @typescript-eslint/no-explicit-any */

export class ConversationBusyError extends Error {
  constructor(public conversationId: string) {
    super(`会话 ${conversationId} 有正在执行的 run，请等待或中止后重试`)
    this.name = 'ConversationBusyError'
  }
}

/**
 * 会话存储。
 *
 * 关键性质（DESIGN.md §1-2）：
 *  - 会话是**日志**，不是 context。装配在 context 层做。
 *  - 会话内 run **串行**，由 `active_run_id` 乐观锁保证。
 *  - seq 在事务内递增，并发追加不会重号。
 *  - **只有 root run 关联 conversation**；子 run 没有对外身份。
 */
export class ConversationStore {
  constructor(
    private db: Db,
    private deps: Deps,
  ) {}

  async create(
    input: { agentId: string; title?: string | null; id?: string },
    q: Queryable = this.db,
  ): Promise<Conversation> {
    const id = input.id ?? this.deps.ids.uuid()
    const now = this.deps.clock.nowIso()
    const r = await q.query(
      `insert into conversations (id, title, agent_id, created_at, updated_at)
       values ($1,$2,$3,$4,$4) returning *`,
      [id, input.title ?? null, input.agentId, now],
    )
    return toConv(r.rows[0])
  }

  async get(id: string): Promise<Conversation | null> {
    const r = await this.db.query(`select * from conversations where id = $1`, [id])
    return r.rows[0] ? toConv(r.rows[0]) : null
  }

  async list(opts: { includeArchived?: boolean; limit?: number; q?: string } = {}): Promise<Conversation[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (!opts.includeArchived) where.push('archived_at is null')
    if (opts.q) {
      params.push(`%${opts.q}%`)
      where.push(`title ilike $${params.length}`)
    }
    params.push(opts.limit ?? 50)
    const r = await this.db.query(
      `select * from conversations
       ${where.length ? 'where ' + where.join(' and ') : ''}
       order by pinned desc, updated_at desc
       limit $${params.length}`,
      params,
    )
    return r.rows.map(toConv)
  }

  /**
   * 追加消息。seq 在事务内由 `last_seq + 1` 生成 ——
   * 并发追加时唯一约束会挡住重号，调用方重试即可。
   */
  async append(
    input: {
      conversationId: string
      role: MessageRole
      content: string
      runId?: string | null
      artifacts?: string[]
      tokens?: number | null
      meta?: Record<string, unknown>
    },
    q?: Queryable,
  ): Promise<Message> {
    const run = async (tx: Queryable): Promise<Message> => {
      const bumped = await tx.query<{ last_seq: number }>(
        `update conversations set last_seq = last_seq + 1, updated_at = $2
          where id = $1 returning last_seq`,
        [input.conversationId, this.deps.clock.nowIso()],
      )
      const seq = bumped.rows[0]?.last_seq
      if (seq === undefined) throw new Error(`会话 ${input.conversationId} 不存在`)

      const r = await tx.query(
        `insert into messages (id, conversation_id, seq, role, content, run_id, artifacts, tokens, meta, created_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10) returning *`,
        [
          this.deps.ids.uuid(),
          input.conversationId,
          seq,
          input.role,
          input.content,
          input.runId ?? null,
          JSON.stringify(input.artifacts ?? []),
          input.tokens ?? null,
          JSON.stringify(input.meta ?? {}),
          this.deps.clock.nowIso(),
        ],
      )
      return toMsg(r.rows[0])
    }
    return q ? run(q) : this.db.tx(run)
  }

  /** 按 seq 倒序取最近 N 条，返回时恢复正序 */
  async recent(conversationId: string, limit = 50, beforeSeq?: number): Promise<Message[]> {
    const params: unknown[] = [conversationId]
    let cond = ''
    if (beforeSeq !== undefined) {
      params.push(beforeSeq)
      cond = `and seq < $${params.length}`
    }
    params.push(limit)
    const r = await this.db.query(
      `select * from messages where conversation_id = $1 ${cond}
       order by seq desc limit $${params.length}`,
      params,
    )
    return r.rows.map(toMsg).reverse()
  }

  /**
   * 转成模型消息。
   *
   * `system_note`（例如「专家结果已回流」）转成 user 角色的标注文本 ——
   * 多数 provider 不接受对话中段出现 system。
   */
  toChatMessages(messages: Message[]): ChatMessage[] {
    return messages.map((m) => {
      if (m.role === 'system_note') return { role: 'user' as const, content: `[系统] ${m.content}` }
      return { role: m.role as 'user' | 'assistant', content: m.content }
    })
  }

  // ── Compact：摘要 ──────────────────────────────────────

  /**
   * 写入一次压缩的结果。
   *
   * **摘要与账本同事务，且都不动 messages。** 消息永不删除 ——
   * 摘要失败时退化成「装配器照常裁剪」，而不是数据丢失。
   * 代价是库会一直长，但那是磁盘问题；反过来是正确性问题。
   *
   * `generation` 用条件更新做 CAS：两个 run 同时压缩时只有一个能落地，
   * 另一个撞 unique(conversation_id, generation) 后重新读到新摘要即可。
   */
  async recordCompaction(input: {
    conversationId: string
    summary: ConversationSummary
    fromSeq: number
    throughSeq: number
    messageCount: number
    tokensBefore: number
    tokensAfter: number
    provider?: string | null
    model?: string | null
  }): Promise<{ generation: number } | null> {
    return this.db.tx(async (tx) => {
      const cur = await tx.query<{ summary_generation: number; summary_through_seq: number }>(
        `select summary_generation, summary_through_seq from conversations where id = $1`,
        [input.conversationId],
      )
      const row = cur.rows[0]
      if (!row) return null
      // 别人已经压到更远的位置了 —— 放弃这次，不要把摘要往回退
      if (row.summary_through_seq >= input.throughSeq) return null

      const generation = row.summary_generation + 1
      await tx.query(
        `insert into compactions
           (conversation_id, generation, from_seq, through_seq, message_count,
            tokens_before, tokens_after, summary, provider, model, outcome, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ok',$11)`,
        [
          input.conversationId,
          generation,
          input.fromSeq,
          input.throughSeq,
          input.messageCount,
          input.tokensBefore,
          input.tokensAfter,
          JSON.stringify(input.summary),
          input.provider ?? null,
          input.model ?? null,
          this.deps.clock.nowIso(),
        ],
      )
      await tx.query(
        `update conversations
            set summary = $2, summary_through_seq = $3, summary_generation = $4,
                summary_updated_at = $5, updated_at = $5
          where id = $1 and summary_generation = $6`,
        [
          input.conversationId,
          JSON.stringify(input.summary),
          input.throughSeq,
          generation,
          this.deps.clock.nowIso(),
          row.summary_generation,
        ],
      )
      return { generation }
    })
  }

  /**
   * 压缩失败也记一行。
   *
   * 「模型忘了我说过什么」这类问题的成因可能是**压缩根本没成功** ——
   * 那时消息没退役、摘要没生成，症状却和「摘丢了」一模一样。
   * 不留账的话这两种情况分不开。
   */
  async recordCompactionFailure(input: {
    conversationId: string
    fromSeq: number
    throughSeq: number
    messageCount: number
    tokensBefore: number
    error: string
  }): Promise<void> {
    // generation 用负数避免与成功的那串冲突：失败不推进代数
    const n = await this.db.query<{ n: number }>(
      `select coalesce(min(generation), 0) - 1 as n from compactions where conversation_id = $1`,
      [input.conversationId],
    )
    await this.db.query(
      `insert into compactions
         (conversation_id, generation, from_seq, through_seq, message_count,
          tokens_before, tokens_after, summary, outcome, created_at)
       values ($1,$2,$3,$4,$5,$6,0,$7,'failed',$8)
       on conflict (conversation_id, generation) do nothing`,
      [
        input.conversationId,
        n.rows[0]?.n ?? -1,
        input.fromSeq,
        input.throughSeq,
        input.messageCount,
        input.tokensBefore,
        input.error,
        this.deps.clock.nowIso(),
      ],
    )
  }

  /** 压缩历史。给 `nucleus conv compactions` 与诊断包用 */
  async compactions(conversationId: string, limit = 20): Promise<CompactionRecord[]> {
    const r = await this.db.query<Record<string, unknown>>(
      // **按 id 排，不按 created_at。** bigserial 严格跟随插入顺序；
      // created_at 在同一毫秒内（或 FakeClock 下）完全相同，排序不稳定 ——
      // 而这张表的价值全在于「哪一代丢的」，顺序错了就指错代。
      // 也不按 generation 排：失败的记录用负数代，那样会把它们全排到一头
      `select * from compactions where conversation_id = $1
        order by id desc limit ${Number(limit) | 0}`,
      [conversationId],
    )
    return r.rows.map((x) => ({
      generation: x['generation'] as number,
      fromSeq: x['from_seq'] as number,
      throughSeq: x['through_seq'] as number,
      messageCount: x['message_count'] as number,
      tokensBefore: x['tokens_before'] as number,
      tokensAfter: x['tokens_after'] as number,
      summary: x['summary'] as string,
      provider: (x['provider'] as string) ?? null,
      model: (x['model'] as string) ?? null,
      outcome: x['outcome'] as 'ok' | 'failed',
      createdAt: new Date(x['created_at'] as string),
    }))
  }

  // ── 串行化：同一会话内只允许一个活跃 run ─────────────

  /**
   * 抢占会话。已有活跃 run 时抛 ConversationBusyError。
   *
   * 用条件更新实现 CAS，避免「先查后写」的竞态。
   */
  async acquire(conversationId: string, runId: string): Promise<void> {
    const r = await this.db.query(
      `update conversations set active_run_id = $2, updated_at = $3
        where id = $1 and active_run_id is null`,
      [conversationId, runId, this.deps.clock.nowIso()],
    )
    if (r.rowCount === 0) {
      const cur = await this.get(conversationId)
      if (!cur) throw new Error(`会话 ${conversationId} 不存在`)
      if (cur.activeRunId === runId) return // 幂等
      throw new ConversationBusyError(conversationId)
    }
  }

  async release(conversationId: string, runId: string): Promise<void> {
    await this.db.query(
      `update conversations set active_run_id = null, updated_at = $3
        where id = $1 and active_run_id = $2`,
      [conversationId, runId, this.deps.clock.nowIso()],
    )
  }

  // ── 分支：编辑重发 ───────────────────────────────────

  /**
   * 从某个 seq 分叉出新会话，复制该点之前的消息。
   *
   * 等同 ChatGPT 的「编辑并重新发送」。原会话不受影响。
   */
  async fork(conversationId: string, atSeq: number, title?: string): Promise<Conversation> {
    return this.db.tx(async (tx) => {
      const src = await tx.query(`select * from conversations where id = $1`, [conversationId])
      const parent = src.rows[0]
      if (!parent) throw new Error(`会话 ${conversationId} 不存在`)

      const id = this.deps.ids.uuid()
      const now = this.deps.clock.nowIso()
      const created = await tx.query(
        `insert into conversations
           (id, title, agent_id, parent_conversation_id, forked_at_seq, last_seq, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$5,$6,$6) returning *`,
        [
          id,
          title ?? `${(parent as { title: string | null }).title ?? '会话'}（分支）`,
          (parent as { agent_id: string }).agent_id,
          conversationId,
          atSeq,
          now,
        ],
      )

      await tx.query(
        `insert into messages (id, conversation_id, seq, role, content, run_id, artifacts, tokens, meta, created_at)
         select uuid_generate_v4(), $1, seq, role, content, run_id, artifacts, tokens, meta, created_at
           from messages where conversation_id = $2 and seq <= $3`,
        [id, conversationId, atSeq],
      )

      return toConv(created.rows[0])
    })
  }

  async archive(id: string): Promise<void> {
    await this.db.query(`update conversations set archived_at = $2, updated_at = $2 where id = $1`, [
      id,
      this.deps.clock.nowIso(),
    ])
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db.query(`update conversations set title = $2, updated_at = $3 where id = $1`, [
      id,
      title,
      this.deps.clock.nowIso(),
    ])
  }
}
