-- 可追溯性：把「模型被问了什么、答了什么」存下来。
--
-- 此前事件流只记 { step, chain } 与 { model, tokens, latency, finishReason }，
-- 工具实参只有 args_hash（args_ref / result_ref 从来没人写）。于是
-- 「发生了什么」可以完整重建，而「模型为什么那么做」完全看不到 ——
-- 而后者正是 agent 定义调优阶段最常要回答的问题：
-- 编排者为什么派给了这个专家？专家为什么忽略了验收标准？
--
-- 为什么必须存而不是「事后重建」：重建需要当时的 config + agent 定义 +
-- 当时的历史，而这三样都会变。出问题之后再想开启也来不及。
create table if not exists transcripts (
  id              uuid primary key,
  run_attempt_id  uuid not null references run_attempts(id) on delete cascade,
  step            integer not null,
  -- 发给模型的完整消息数组（含 system prompt）
  request         jsonb not null,
  -- 模型返回：content / reasoning 摘要 / tool_calls 的实参
  response        jsonb not null,
  -- 被截断时为 true，配合 runtime.transcriptMaxChars
  truncated       boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (run_attempt_id, step)
);

create index if not exists transcripts_attempt_idx on transcripts (run_attempt_id, step);

-- 工具的实参与返回。只有 hash 时无法判断「模型到底填了什么」——
-- 而委派信封写得好不好、路径为什么被规则拦下，都要看实参。
alter table tool_invocations add column if not exists args_json jsonb;
alter table tool_invocations add column if not exists result_text text;
