-- Compact：会话摘要。
--
-- 现在超预算是**丢**最旧的消息（装配器的 trim_history），而降级顺序里的
-- shrink_summary / drop_summary 两档永远不会触发 —— 因为没有任何代码产生摘要。
--
-- ── 为什么摘要必须落库 ──────────────────────────────────
--
-- 摘要是一次模型调用。每回合重算就是每回合多一次调用，而且内容会漂
-- （同一段历史，两次摘要出来的重点可能不同）。落库之后：
--  - 一段历史只被摘要一次
--  - 摘要是**增量**的：新摘要 = 摘(旧摘要 + 新退役的消息)
--  - 摘要本身可读、可审、可在诊断包里看到「模型记住的是什么」
--
-- ── 消息永不删除 ────────────────────────────────────────
--
-- compact 只写 summary 与 summary_through_seq，**不动 messages**。
-- 摘要失败时退化成现在的行为（丢最旧的），而不是数据丢失。
-- 代价是库会一直长，但那是磁盘问题，不是正确性问题 —— 反过来则不然。
alter table conversations
  add column if not exists summary text,
  -- 摘要覆盖到哪条消息（含）。它之后的消息仍然逐条进 context。
  -- 用 seq 而不是时间戳：seq 有 unique(conversation_id, seq)，是可靠的序
  add column if not exists summary_through_seq integer not null default 0,
  -- 摘了几次 —— 增量摘要会逐代失真，代数是判断可信度的依据
  add column if not exists summary_generation integer not null default 0,
  add column if not exists summary_updated_at timestamptz;

/**
 * 每次 compact 一行，append-only。
 *
 * 为什么要留档而不只是覆盖 conversations.summary：**摘要是有损的，而损失
 * 发生在哪里事后必须查得到**。「模型忘了我三轮前说过不要用 default 模型」
 * 这类问题，只有对比「当时退役了哪些消息」与「摘出来的是什么」才能定位。
 *
 * 这和 schedule_fires 是同一个理由：有损的、不可逆的、且没人在旁边看的操作，
 * 必须自己留账。
 */
create table if not exists compactions (
  id              bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  generation      integer not null,
  /** 这次退役的消息区间（含两端） */
  from_seq        integer not null,
  through_seq     integer not null,
  message_count   integer not null,
  /** 退役消息的 token 数 → 摘要的 token 数，压缩比一眼可见 */
  tokens_before   integer not null,
  tokens_after    integer not null,
  /** 摘要正文。留全文 —— 这是「模型记住了什么」唯一的证据 */
  summary         text not null,
  /** 哪个模型摘的。换模型后摘要质量变化要能归因 */
  provider        text,
  model           text,
  /** 摘要失败时也记一行：outcome='failed'，summary 存错误信息 */
  outcome         text not null default 'ok' check (outcome in ('ok', 'failed')),
  created_at      timestamptz not null default now(),
  unique (conversation_id, generation)
);

create index if not exists compactions_conv_idx on compactions (conversation_id, generation desc);
