-- ask_user：编排者可以反问用户。
--
-- ── 为什么是新状态而不是复用 needs_human_confirmation ──────────
--
-- `needs_human_confirmation` 是**副作用未知时的死胡同**：某个工具可能已经
-- 改了外部世界，系统不敢自动重试，只能停下等人来看。那是个故障状态。
--
-- `waiting_user` 是**正常的对话回合**：编排者问了一句，等你回答，然后接着做。
-- 混成一个状态会让「系统坏了」和「系统在等你说话」长得一样 ——
-- 而这两件事该给的提示完全相反。
--
-- ── 为什么复用 wake 而不是让 run 一直活着 ────────────────
--
-- 与 delegate 完全同构：attempt 正常终结，逻辑 run 转 waiting_user，
-- **不占进程、不占 context**。用户下一条消息就是唤醒信号。
-- 等人回答可能要几小时，让一个进程挂在那里等是不可接受的。

alter table runs drop constraint if exists runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('pending','running','waiting_children','waiting_retry','waiting_user',
                    'succeeded','failed','needs_human_confirmation','cancelled'));

alter table wake_records drop constraint if exists wake_records_kind_check;
alter table wake_records add constraint wake_records_kind_check
  check (kind in ('children_done','approval','retry_timer','user'));

-- 一个 run 最多只能有一个待答的提问。
--
-- 没有这道约束时，一个 attempt 里连着调两次 ask_user 会留下两条 waiting 记录，
-- 而用户的下一条消息只能回答一个 —— 另一条永远等不到，run 卡死在 waiting_user。
-- 用部分唯一索引挡在数据库层：靠代码自觉的话，第二次调用只会静默多插一行。
create unique index if not exists wake_records_one_pending_question
  on wake_records (parent_run_id)
  where kind = 'user' and status = 'waiting';

-- 提问原文。用户答完之后要能回看「当时问的是什么」——
-- 会话里那条 assistant 消息是给人读的，这里是给运行时对齐用的。
alter table wake_records add column if not exists question text;
