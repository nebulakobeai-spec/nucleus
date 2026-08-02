-- 定时任务。
--
-- 不需要新进程：`run_queue.available_at` 已经支撑了 run 级重试的延迟执行，
-- 定时的本质就是「到点往队列塞一个 run」，和 reconciler 同一个位置。
--
-- 会话语义已定：**每次新建会话，不注入上次结果**。每次运行是一件独立的新
-- 工作，只知道任务目标。附带好处是会话不会无限增长，所以 cron 不依赖 compact。
-- 以后若想要「别重复昨天报过的内容」，那属于 L2 事实层，不是会话连续性。
create table if not exists schedules (
  id            uuid primary key,
  name          text not null,
  -- 五段 cron 表达式（分 时 日 月 周）
  cron          text not null,
  -- IANA 时区名。夏令时会让「每天早上 8 点」在 UTC 里漂移，所以必须存
  timezone      text not null default 'UTC',
  agent_id      text not null,
  -- 任务信封的三段。专家看不到会话历史，定时任务同样要自足
  goal          text not null,
  context       text not null default '',
  acceptance    text not null default '',
  enabled       boolean not null default true,

  /**
   * 停机补偿。
   *
   * 关机三天后开机：补跑三次还是只跑最近一次？「每日简报」补跑是噪音，
   * 「对账」类必须补 —— 所以是 per-schedule 开关，不是全局默认。
   */
  catch_up      boolean not null default false,
  /** 补偿时最多补几次，防止关机一个月后炸出 720 个 run */
  catch_up_max  integer not null default 3,

  last_fired_at timestamptz,
  /** 上一次**计划**触发的时刻（不是实际触发时刻）—— 幂等键用它 */
  last_planned_at timestamptz,
  next_fire_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (name)
);

create index if not exists schedules_due_idx on schedules (enabled, next_fire_at);

-- 定时产生的 run 指回来源，便于「这个 run 是哪条定时任务跑的」
alter table runs add column if not exists schedule_id uuid references schedules(id) on delete set null;
create index if not exists runs_schedule_idx on runs (schedule_id, created_at desc);

/**
 * 每个**计划点**一行，append-only。
 *
 * 为什么单独一张表而不复用 run_events：`run_events.run_attempt_id` 是 not null，
 * 而被跳过的触发根本没有 run。而「今天早上 8 点那次到底跑没跑」恰恰是最需要
 * 事后能查的事 —— 只有它跑了才有 run，没跑就什么痕迹都没有，
 * 那就只能靠「没看到产出」来发现，太晚。
 *
 * `unique (schedule_id, planned_at)` 与 runs.idempotency_key 双保险：
 * 后者挡重复建 run，前者挡重复记账。
 */
create table if not exists schedule_fires (
  id           bigserial primary key,
  schedule_id  uuid not null references schedules(id) on delete cascade,
  /** 计划时刻（幂等键的来源），截到分钟 */
  planned_at   timestamptz not null,
  /** 实际触发时刻 —— 与 planned_at 的差就是延迟/补偿的证据 */
  fired_at     timestamptz not null default now(),
  outcome      text not null check (outcome in ('fired','reentrant','duplicate','error')),
  run_id       uuid,
  conversation_id uuid,
  reason       text,
  unique (schedule_id, planned_at)
);

create index if not exists schedule_fires_sched_idx on schedule_fires (schedule_id, planned_at desc);
