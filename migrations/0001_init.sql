-- Nucleus v1 初始 schema
--
-- 约束：PG 14 基线。本地测试跑在 PGlite(PG18) 上，部署机可能是 14，
-- 所以不使用 15+ 特性。**不使用 pgvector**（本地不可用；L3 语义记忆推后到 v2，
-- 届时作为 optional migration 单独引入）。
--
-- 核心设计（DESIGN.md §3）：
--   runs          逻辑执行；idempotency_key 唯一约束在这一层
--   run_attempts  物理尝试；终态不可变（由 trigger 强制）
--   tool_invocations  write-ahead 意图日志；崩溃恢复按副作用等级分流
--   wake_records  parent 不保持活着；子 run 终态与唤醒在同一事务

-- ─────────────────────────────────────────────────────────
-- 会话
-- ─────────────────────────────────────────────────────────

create table conversations (
  id                      uuid primary key,
  title                   text,
  agent_id                text not null,
  parent_conversation_id  uuid references conversations(id) on delete set null,
  forked_at_seq           integer,
  active_run_id           uuid,          -- 乐观锁：同一会话内 run 串行
  last_seq                integer not null default 0,
  pinned                  boolean not null default false,
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index conversations_recent_idx
  on conversations (coalesce(archived_at, 'epoch'::timestamptz), updated_at desc);

create table messages (
  id               uuid primary key,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  seq              integer not null,
  role             text not null check (role in ('user','assistant','system_note')),
  content          text not null,
  run_id           uuid,
  artifacts        jsonb not null default '[]'::jsonb,
  tokens           integer,
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (conversation_id, seq)
);

create index messages_conv_seq_idx on messages (conversation_id, seq desc);

-- ─────────────────────────────────────────────────────────
-- 执行：逻辑 run
-- ─────────────────────────────────────────────────────────

create table runs (
  id               uuid primary key,
  parent_run_id    uuid references runs(id) on delete set null,
  root_run_id      uuid not null,
  conversation_id  uuid references conversations(id) on delete set null,
  task_id          uuid,
  agent_id         text not null,
  depth            integer not null default 0,

  status           text not null default 'pending'
                   check (status in ('pending','running','waiting_children','waiting_retry',
                                     'succeeded','failed','needs_human_confirmation','cancelled')),
  error_code       text,
  error_detail     jsonb,

  -- 唯一约束在逻辑层：重试新建 attempt，不新建 run
  idempotency_key  text unique,

  input            jsonb not null default '{}'::jsonb,   -- task envelope
  result           jsonb,                                 -- submit_result payload
  result_ref       text,
  result_schema_version text,

  deadline_at      timestamptz,
  created_at       timestamptz not null default now(),
  ended_at         timestamptz
);

create index runs_status_idx  on runs (status);
create index runs_root_idx    on runs (root_run_id);
create index runs_parent_idx  on runs (parent_run_id);
create index runs_conv_idx    on runs (conversation_id);

-- ─────────────────────────────────────────────────────────
-- 执行：物理 attempt（终态不可变）
-- ─────────────────────────────────────────────────────────

create table run_attempts (
  id                  uuid primary key,
  run_id              uuid not null references runs(id) on delete cascade,
  attempt_no          integer not null,

  status              text not null default 'queued'
                      check (status in ('queued','running','succeeded','failed',
                                        'timed_out','lost','cancelled')),

  -- lease + fencing：防止被判死的 worker 复活后继续写
  worker_id           text,
  lease_expires_at    timestamptz,
  fence_token         text,

  -- 归因
  prompt_version_id   uuid,
  config_hash         text,
  tool_snapshot_id    uuid,
  model               text,
  provider            text,

  heartbeat_at        timestamptz,
  cancel_requested_at timestamptz,
  started_at          timestamptz,
  ended_at            timestamptz,

  error_code          text,
  error_detail        jsonb,

  steps_used          integer not null default 0,
  tokens_in           integer,
  tokens_out          integer,
  cache_read          integer,
  cost_usd            numeric(12,6),
  context_breakdown   jsonb,

  created_at          timestamptz not null default now(),
  unique (run_id, attempt_no)
);

create index run_attempts_run_idx    on run_attempts (run_id, attempt_no desc);
-- reconciler 的主查询：活着的 attempt 里谁的 lease 过期了
create index run_attempts_live_idx   on run_attempts (status, lease_expires_at)
  where status in ('queued','running');

-- 终态不可变（DESIGN.md §3.3 / §14 强断言 #2）
create or replace function _guard_attempt_terminal() returns trigger as $$
begin
  if old.status in ('succeeded','failed','timed_out','lost','cancelled')
     and new.status is distinct from old.status then
    raise exception
      'run_attempts.% 已处于终态 % ，不可改为 %',
      old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger run_attempts_terminal_guard
  before update on run_attempts
  for each row execute function _guard_attempt_terminal();

-- fence token 守卫：旧 token 的写入一律拒绝（§14 强断言 #4）
create or replace function _guard_fence() returns trigger as $$
begin
  if old.fence_token is not null
     and new.fence_token is not null
     and new.fence_token <> old.fence_token
     and new.status is distinct from old.status then
    -- 允许 reconciler 重新签发 fence（走 status 不变的单独 update）
    return new;
  end if;
  return new;
end;
$$ language plpgsql;

-- ─────────────────────────────────────────────────────────
-- 工具调用：write-ahead 意图日志（DESIGN.md §3.2）
-- ─────────────────────────────────────────────────────────

create table tool_invocations (
  id                uuid primary key,
  run_attempt_id    uuid not null references run_attempts(id) on delete cascade,
  seq               integer not null,

  tool_name         text not null,
  args_hash         text not null,
  args_ref          text,

  -- 无默认值：工具注册时必须显式声明
  side_effect_class text not null
                    check (side_effect_class in ('pure','idempotent','non_idempotent')),
  idempotency_key   text,

  intent_at         timestamptz not null,      -- 调用之前写
  outcome           text check (outcome in ('ok','error')),  -- NULL = UNKNOWN
  outcome_at        timestamptz,
  result_ref        text,
  error_code        text,

  unique (run_attempt_id, seq)
);

-- 恢复扫描：崩在中间的调用
create index tool_invocations_unknown_idx
  on tool_invocations (run_attempt_id)
  where outcome is null;

-- ─────────────────────────────────────────────────────────
-- 事件流
-- ─────────────────────────────────────────────────────────

create table run_events (
  id              bigserial primary key,
  run_attempt_id  uuid not null references run_attempts(id) on delete cascade,
  run_id          uuid not null,
  seq             integer not null,
  kind            text not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (run_attempt_id, seq)
);

create index run_events_run_idx on run_events (run_id, id);

-- ─────────────────────────────────────────────────────────
-- Wake / Join（DESIGN.md §3.5）
-- ─────────────────────────────────────────────────────────

create table wake_records (
  id                     uuid primary key,
  kind                   text not null
                         check (kind in ('children_done','approval','retry_timer')),
  parent_run_id          uuid not null references runs(id) on delete cascade,
  parent_conversation_id uuid,
  parent_agent_id        text not null,

  wait_on_run_ids        uuid[] not null default '{}',
  pending_count          integer not null,

  resume_payload         jsonb not null default '{}'::jsonb,

  status                 text not null default 'waiting'
                         check (status in ('waiting','fired','superseded')),
  fire_at                timestamptz,           -- retry_timer 用
  fired_attempt_id       uuid,
  created_at             timestamptz not null default now(),
  fired_at               timestamptz
);

-- 子 run 终态时的递减查询
create index wake_records_waiting_idx on wake_records (status) where status = 'waiting';
create index wake_records_parent_idx  on wake_records (parent_run_id);

-- ─────────────────────────────────────────────────────────
-- 执行队列
-- ─────────────────────────────────────────────────────────

create table run_queue (
  id             uuid primary key,
  run_id         uuid not null references runs(id) on delete cascade,
  attempt_no     integer not null,
  priority       integer not null default 5,
  available_at   timestamptz not null default now(),
  claimed_by     text,
  claimed_at     timestamptz,
  created_at     timestamptz not null default now(),
  unique (run_id, attempt_no)
);

create index run_queue_ready_idx on run_queue (available_at, priority)
  where claimed_by is null;

-- ─────────────────────────────────────────────────────────
-- 看板
-- ─────────────────────────────────────────────────────────

create table tasks (
  id               uuid primary key,
  title            text not null,
  description      text,
  status           text not null default 'todo'
                   check (status in ('waiting','todo','progress','verify','done','cancel')),
  priority         integer not null default 3,
  sort_order       integer not null default 0,
  agent_id         text,
  conversation_id  uuid references conversations(id) on delete set null,
  parent_task_id   uuid references tasks(id) on delete set null,
  source           text not null default 'manual' check (source in ('manual','auto')),
  result_summary   text,
  error_message    text,
  tags             text[] not null default '{}',
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  deleted_at       timestamptz
);

create index tasks_board_idx on tasks (status, sort_order) where deleted_at is null;

create table activity_logs (
  id          bigserial primary key,
  task_id     uuid not null references tasks(id) on delete cascade,
  action      text not null,
  old_value   jsonb,
  new_value   jsonb,
  actor       text,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────
-- 产出
-- ─────────────────────────────────────────────────────────

create table artifacts (
  ref          text primary key,
  run_id       uuid references runs(id) on delete set null,
  path         text not null,
  kind         text not null default 'file',
  bytes        bigint,
  sha256       text,
  summary      text,
  -- 安全：untrusted 内容永不进入长期 prompt（DESIGN.md §8）
  trust_level  text not null default 'agent'
               check (trust_level in ('user','agent','untrusted_tool_output')),
  created_at   timestamptz not null default now()
);

create index artifacts_run_idx on artifacts (run_id);

-- ─────────────────────────────────────────────────────────
-- 归因与基础设施
-- ─────────────────────────────────────────────────────────

create table prompt_versions (
  id          uuid primary key,
  agent_id    text not null,
  version     integer not null,
  layers      jsonb not null,
  checksum    text not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (agent_id, version)
);

create table tool_snapshots (
  id        uuid primary key,
  taken_at  timestamptz not null default now(),
  checksum  text not null,
  doc       jsonb not null
);

create table mcp_servers (
  id               text primary key,
  transport        text not null check (transport in ('stdio','http')),
  command          text,
  args             text[] not null default '{}',
  url              text,
  env_refs         jsonb not null default '{}'::jsonb,
  enabled          boolean not null default true,
  auto_disabled_at timestamptz,
  failure_count    integer not null default 0,
  last_error       text,
  updated_at       timestamptz not null default now()
);

create table provider_state (
  key                text primary key,   -- 'provider:model'
  breaker_state      text not null default 'closed'
                     check (breaker_state in ('closed','open','half_open')),
  breaker_until      timestamptz,
  remaining_requests integer,
  remaining_tokens   integer,
  quota_reset_at     timestamptz,
  consecutive_errors integer not null default 0,
  updated_at         timestamptz not null default now()
);

create table usage_log (
  id              bigserial primary key,
  run_attempt_id  uuid references run_attempts(id) on delete set null,
  provider        text not null,
  model           text not null,
  tokens_in       integer not null default 0,
  tokens_out      integer not null default 0,
  cache_read      integer not null default 0,
  cost_usd        numeric(12,6) not null default 0,
  created_at      timestamptz not null default now()
);

create index usage_log_time_idx on usage_log (created_at desc);
