-- provider 层的可追溯性。
--
-- provider_state 只有**当前快照**（谁在熔断、还剩多少额度），所以
-- 「熔断什么时候打开的、因为什么、开了多久」「429 那次到底试了哪几个模型、
-- 各自返回什么」都答不出。而这几个问题正是「后端模型出问题」时要问的。
--
-- 另一个缺口更隐蔽：preflight 跳过某个模型的原因**只在全链失败时**才记进
-- 错误详情。如果它选中了链上第 3 个，你看不到前两个为什么被跳过 ——
-- 「为什么用了 grok 而不是 glm」是答不出的。
create table if not exists provider_events (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  -- 'provider:model'
  key             text not null,
  kind            text not null,
  error_code      text,
  -- 关联的 attempt；熔断状态变化可能发生在 reconciler 里，与 run 无关
  run_attempt_id  uuid references run_attempts(id) on delete set null,
  detail          jsonb not null default '{}'::jsonb
);

create index if not exists provider_events_at_idx on provider_events (at desc);
create index if not exists provider_events_key_idx on provider_events (key, at desc);
