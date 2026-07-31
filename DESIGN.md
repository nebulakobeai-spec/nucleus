# Nucleus — 设计文档 v2

> 状态：设计收敛，未开始实现
> 一句话：**为 Niche 定制的、可靠的多 agent 编排运行时。**
> 定位：不追求通用框架，不追求与现有工具的差异化。成熟做法直接沿用，只重做对自己不够用的部分。

**v1 版本记录**：v1 把论证结构写成了"为什么比 OpenClaw 好"，那是错的框架——重叠不是问题，重叠是省事。v2 删掉全部竞品论证，只描述"我要什么、怎么做"。v1 中五处技术错误已在本版修正（见附 A）。

---

## 1. 目标与非目标

### 出发点：现有系统（OpenClaw 上的 Nebula）的几个具体不够用之处

均来自 2026-04 的实测记录（`Nebula/workspace-keystone/subagent-delivery-analysis.md`、`workspace-ant/diagnosis-report-2026-04-25.md`）：

| 现象 | 我要的性质 |
|---|---|
| 专家结果直发用户 DM，绕过编排者 | 子 run 在结构上没有对外身份 |
| 任务做完编排者没拿到结果 | 结果所有权明确 + 可靠的 join/wake |
| 需要不断 ping 查询进度 | 状态可拉取 + 进度结构化上报 |
| worker 死后任务永久悬空（`lost: 11`） | lease + heartbeat + reconciler |
| 429 打挂整条 fallback 链 | 熔断 + 可见的等待状态 |
| 同一 agent 的多件事互相排队 | run 隔离，限流限在 provider 而非 agent |
| 不知道任务是活着还是死了 | 「会不会自己恢复」是一等信息 |
| 模型重复输出一段话，不知是谁的问题 | 退化/循环检测 + 可观测 |

> OpenClaw 在 2026 年内已补上其中若干能力（durable task record、lost reconciliation、restart recovery、task flow 等）。**这不影响本项目的必要性——我不使用它，所以这些能力无论如何都要自己有。** 但它现在的 `automation/tasks`、`automation/taskflow`、`tools/subagents`、`gateway/restart-recovery 文档值得读，它的解法可以直接借鉴。**踩过的坑比失败率更有信息量。**

### 三条设计原则

1. **可靠性由结构保证，不由 prompt 文本保证。** 每一条写在 prompt 里补基础设施缺口的规则，都是一笔待偿的技术债。
2. **任何单点失败都有一个不依赖该单点的东西负责收尾。**
3. **过程必须结构化上报。** 可视化的上限由事件粒度决定，不由前端决定。

### 非目标（明确不做）

- 不做通用框架：规则、事实、记忆的形态**直接写死成自己需要的样子**，不做可插拔 pack、不做声明式注册表、不做治理 UI
- 不做多租户：无 `owner_id`，个人部署
- 不做 channel 生态：唯一前端是 Niche。移动端推送若要，只做单向出站，不参与编排
- 不追求覆盖率数字：要的是关键路径的强断言 + 可注入接缝
- 不做通用 provider gateway：四家目标模型全是 OpenAI 兼容形态，一个 client + 一张配置表

---

## 2. 概念模型

| 对象 | 是什么 | 生命周期 |
|---|---|---|
| **conversation** | 用户可见的线程（等同 ChatGPT 左侧列表项） | 永久；不过期、不重置、不按 sender 分片 |
| **run** | 一次**逻辑**执行（"让 Albert 做这件事"） | 可跨多次尝试 |
| **run_attempt** | 一次**物理**尝试 | 终态**不可变** |
| **task** | 看板上的一张卡，可跨多个 run | 天/周级 |

**agent 是无状态的角色定义**（prompt + 工具集 + 模型链），不是进程。所以"三个会话都用同一个编排者但做不同的事"不需要任何特殊处理——三份独立 context 装配，共用一份定义。

### 三条不变量

- **专家 run 的 transcript 永不进入 conversation 的消息流。** 专家跑完只往会话追加一条消息：`summary` + artifact 引用；全文留在 `runs/<id>/`。会话历史因此可无限增长。
- **子 run 没有任何对外身份。** 只有 root run 关联 conversation。结构上不可能"直发用户"。
- **conversation 是日志，不是 context。** 每回合从 DB **装配** context。

### 并发粒度

| 层 | 策略 |
|---|---|
| conversation | 串行（`active_run_id` 乐观锁） |
| **provider / 账号** | 令牌桶 + 熔断 —— 限流限在真正的瓶颈上，**不限在 agent 上** |
| 全局 | worker pool |

---

## 3. 可靠性契约（核心）

### 3.1 三个必须分开的概念

v1 的错误是把它们混成"写一行数据库就不会丢"：

| 概念 | 谁保证 |
|---|---|
| **execution succeeded** | runner 完成了 agent loop |
| **result persisted** | 终态与结果在一个事务内落库 → **调用者一定查得到** |
| **external effect confirmed** | **无法由 runtime 单方面保证。** 需要下游工具配合，或升级给人 |

数据库写入只保证第二条。**"不存在没收到"是产品目标，不是架构不变量。**

### 3.2 副作用分级与 write-ahead 意图日志

外部副作用的 exactly-once 不可能白拿。做法是**先记意图，再调用**，恢复时按副作用等级分流：

```
tool_invocations(
  id, run_attempt_id, seq,
  tool_name, args_hash, args_ref,
  side_effect_class,     -- pure | idempotent | non_idempotent
  idempotency_key,       -- 传给下游的那一个（仅当下游支持才有意义）
  intent_at,             -- ← 调用之前写
  outcome,               -- NULL = UNKNOWN（崩在中间）
  outcome_at, result_ref, error_code)
```

恢复规则：

| `side_effect_class` | `outcome IS NULL` 时 |
|---|---|
| `pure` | 直接重跑 |
| `idempotent` | 带同一 `idempotency_key` 重跑 |
| `non_idempotent` | **绝不自动重跑** → run 转 `needs_human_confirmation`，UI 显示"可能已执行：<描述>，请确认" |

每个工具在注册时必须声明 `side_effect_class`。**没有默认值**——不声明则拒绝注册。

### 3.3 终态不可变 + 状态分层

v1 的另一个错误：把三个层级的状态塞进 `run.status`，并且回头修改已完成 run 的状态（"子 run succeeded 但 gate 不过 → 转 waiting_approval"）。修正为：

| 层 | 状态 | 可变性 |
|---|---|---|
| **run_attempt** | `queued` `running` `succeeded` `failed` `timed_out` `lost` `cancelled` | **终态不可变，永不回改** |
| **run**（逻辑） | `pending` `running` `waiting_children` `waiting_retry` `succeeded` `failed` `needs_human_confirmation` `cancelled` | 可推进 |
| **task**（v1 简化） | `waiting` `todo` `progress` `verify` `done` `cancel` | 可推进 |

`idempotency_key` 的唯一约束在 **run**（逻辑层），`attempt_no` 在 run 内唯一。重试 = 新建一个 attempt，不是改旧的。

### 3.4 Worker lease + fencing

```
run_attempts.worker_id, lease_expires_at, fence_token
```

- worker 领取 attempt 时写 `worker_id` + `lease_expires_at`（比如 now + 60s），持续续租
- 所有对该 attempt 的写入都带 `fence_token`，旧 token 的写入被拒绝 → 防止"被判死的 worker 复活后继续写"
- lease 过期 → reconciler 判 `lost`，可重新入队为新 attempt

### 3.5 Wake / Join —— v1 最大的空白，现补上

**核心：parent 不保持活着。** 委派之后 parent 的当前 attempt **直接终结**（`succeeded`），逻辑 run 转 `waiting_children`。没有轮询、没有挂起的进程、没有占用的 context。

> 这个设计之所以干净，正是因为 3.3 把 attempt 与逻辑 run 分开了：attempt 已经结束，逻辑 run 在等待。两者不冲突。

```
wake_records(
  id, kind,                    -- children_done | approval | retry_timer
  parent_run_id, parent_conversation_id, parent_agent_id,
  wait_on_run_ids uuid[], pending_count int,
  resume_payload jsonb,        -- 恢复信封：目标 / 已完成步骤摘要 / 未决项
  status,                      -- waiting | fired | superseded
  fired_attempt_id, created_at, fired_at)
```

**子 run 写终态与唤醒 parent 在同一个事务内**，所以不存在丢唤醒：

```sql
BEGIN;
  UPDATE run_attempts SET status='succeeded', … WHERE id = $attempt AND fence_token = $fence;
  UPDATE runs         SET status='succeeded', result = $r WHERE id = $child;
  UPDATE wake_records SET pending_count = pending_count - 1
   WHERE status = 'waiting' AND $child = ANY(wait_on_run_ids)
  RETURNING id, pending_count;
  -- pending_count 归零者 → 同事务插入 run_queue（parent 的新 attempt）
COMMIT;
```

**Reconciler 兜底**：扫 `status='waiting'` 但 `wait_on_run_ids` 全部已终态的 wake_record → 说明递减漏了 → 补触发。

三种情形：

| 情形 | 处理 |
|---|---|
| 有依赖图（v2 的 plan） | runtime 按图驱动；「唤醒 parent」与「执行一步」是同一件事，无特例 |
| **ad-hoc 委派（v1 唯一形态）** | 建 `children_done` wake record，机制同上 |
| 既无依赖图也无 wake record | **显式禁止**。结果只落看板，永不恢复会话，且必须是有意声明的 |

### 3.6 Reconciler（纯 SQL + 时钟，零 LLM）

- `running` 且 lease 过期 → `lost`
- 过 `deadline_at` → `timed_out`
- `waiting_retry` 且熔断已恢复 → 新 attempt 入队
- 进程重启后无人认领的 `queued` → 重新入队
- wake_record 漏触发 → 补触发
- `tool_invocations.outcome IS NULL` 且 attempt 已死 → 按副作用等级分流（见 3.2）

**heartbeat 是进程写库，不是模型自述。** runner 每 15s 一条 `UPDATE`。零 token、零判断。用一个经过 LLM 的 heartbeat 去监控可靠性等于没有监控。

### 3.7 取消

- abort root run → 级联取消所有后代（`root_run_id` 一把查出）
- **两段式**：先写 `cancel_requested_at`；runner 在每个 step 边界优雅退出（保留已有产出）；超过 grace period（10s）→ 强制杀（SIGTERM → SIGKILL），落 `cancelled` 并标 `forced`
- 每个工具调用带 `AbortSignal`；exec 类必须支持 kill
- **跨进程靠 DB 字段 + `LISTEN/NOTIFY`，不依赖内存状态**
- 已完成的子 run 不回滚，artifact 保留并标注"来自已取消的任务"

### 3.8 错误分类学 + 恢复分类

每个 `error_code` 必须声明 `recovery: automatic | needs_user | terminal`。**UI 直接渲染这个字段**——让用户在异常时立刻知道系统会不会自己恢复，而不是自己从 status 和事件流里推断。

```
provider.*   rate_limited(auto) | quota_exhausted(auto) | all_exhausted(needs_user)
             | auth_failed(needs_user) | server_error(auto) | timeout(auto)
             | degenerate_output(auto)
tool.*       not_found(terminal) | denied(needs_user) | timeout(auto)
             | crashed(auto) | output_too_large(auto)
             | side_effect_unknown(needs_user)          ← 见 3.2
mcp.*        server_unavailable(auto) | server_crashed(auto)
             | tool_missing(needs_user) | schema_invalid(terminal)
contract.*   schema_invalid(auto, ≤2 次) | postcondition_failed(auto, ≤2 次)
budget.*     steps_exceeded(needs_user) | cost_exceeded(needs_user)
             | no_progress(needs_user) | loop_detected(needs_user)
runtime.*    lease_expired(auto) | deadline_exceeded(needs_user)
             | cancelled(terminal) | worker_died(auto)
```

---

## 4. 数据模型

Postgres 单库，Nucleus 独占。前端不直连数据库。无 `owner_id`。

```sql
-- 会话
conversations(id, title, agent_id, parent_conversation_id, forked_at_seq,
              active_run_id, last_seq, pinned, archived_at, created_at, updated_at)

messages(id, conversation_id, seq, role,      -- user | assistant | system_note
         content, run_id, artifacts jsonb, tokens, meta jsonb, created_at,
         unique(conversation_id, seq))

-- 执行
runs(id, parent_run_id, root_run_id, conversation_id, task_id, agent_id,
     status, error_code, error_detail,
     idempotency_key unique,                  -- ← 唯一约束在逻辑层
     input jsonb,                             -- task envelope
     result jsonb, result_ref,                -- submit_result payload
     result_schema_version,
     deadline_at, created_at, ended_at)

run_attempts(id, run_id, attempt_no,          -- unique(run_id, attempt_no)
             status,                          -- 终态不可变
             worker_id, lease_expires_at, fence_token,
             prompt_version_id, config_hash, tool_snapshot_id,
             model, provider,
             heartbeat_at, cancel_requested_at, started_at, ended_at,
             error_code, error_detail,
             steps_used, tokens_in, tokens_out, cache_read, cost_usd,
             context_breakdown jsonb)

tool_invocations(…)                           -- 见 3.2

run_events(id bigserial, run_attempt_id, seq, kind, payload jsonb, created_at)
                                              -- 按月分区

wake_records(…)                               -- 见 3.5

-- 看板
tasks(id, title, description, status, priority, sort_order,
      agent_id, conversation_id, parent_task_id, source,
      result_summary, error_message, tags[], metadata,
      created_at, updated_at, started_at, completed_at, deleted_at)

activity_logs(id bigserial, task_id, action, old_value, new_value, actor, created_at)

-- 产出
artifacts(ref pk, run_id, path, kind, bytes, sha256, summary,
          trust_level,                        -- user | agent | untrusted_tool_output
          created_at)

-- 归因（便宜且高价值，v1 保留）
prompt_versions(id, agent_id, version, layers jsonb, checksum, note, created_at)
tool_snapshots(id, taken_at, doc jsonb)

-- 基础设施
mcp_servers(id pk, transport, command, args[], url, env_refs jsonb,
            enabled, auto_disabled_at, failure_count, last_error, updated_at)

provider_state(key pk,                        -- 'provider:model'
               breaker_state, breaker_until,
               remaining_requests, remaining_tokens, quota_reset_at, updated_at)

usage_log(id bigserial, run_attempt_id, provider, model,
          tokens_in, tokens_out, cache_read, cost_usd, created_at)
```

**v1 不建的表**：`plans` / `plan_versions` / `facts` / `fact_defs` / `memory_items` / `memory_subjects` / `memory_jobs` / `rule_defs` / `rule_violations` / `schedules` / `approvals` / `model_prices`（价格放 config）。

---

## 5. Context 装配

### 三段结构（v1 把事实快照放进"byte-identical 前缀"是自相矛盾的，已修正）

```
① 不可变前缀 ── byte-identical，永不变动 ────────┐
│  L0 运行时契约（工具协议 / submit_result 要求） │
│  L1 identity                                   │
│  L2 稳定 policy                                │
└────────────────────────────────────────────────┘
② 版本化半静态 ── 仅当内容变更时才变 ────────────┐
│  事实/长期偏好快照（带 snapshot_version）      │  ← v1 手写在文件里
└────────────────────────────────────────────────┘
③ 动态 ─────────────────────────────────────────┐
│  会话摘要 / 最近 k 条 message / 工具结果       │
│  末尾块：当前生效约束（≤300 token）            │
└────────────────────────────────────────────────┘
   本回合输入
```

- ① 里禁止出现时间戳、随机 id、变动计数——**由强断言测试守护**（见 §9）
- ② 内容不常变，所以大多数回合 ①+② 一起命中缓存；变更时只失效 ② 之后
- **按层记录 cache 命中率**，否则这个设计对不对没人知道

### 预算与降级

装配前实测 token，超预算按固定顺序降级：

```
工具结果头尾截断 → 老 message 丢弃 → 触发 checkpoint
```

v1 不做 LLM 压缩：超预算就截断 + 落 artifact，或直接报 `budget.*` 错误。tokenizer 是可插拔接口，默认启发式（CJK≈1 token/字，拉丁≈4 字/token）。

### Checkpoint 续跑

编排者不必活很久。transcript 触到软上限时结束当前 attempt，用「目标 + 已完成摘要 + 未决项」作为 `resume_payload` 起新 attempt，context 回到地板。

**长任务的连续性由持久化的恢复信封提供，不由长 context 提供。**

---

## 6. 工具与 MCP

### 能力边界 = 唯一保留的规则机制

v1 只保留最强也最便宜的一层：**per-agent 工具白名单/黑名单**。不给工具，模型就无从违反——这比任何 prompt 文本都强，且成本为零。写在 config 里。

所有 T1/T2 规则机制（注入式约束、checker、遵守率度量）**推后**。但两条纪律现在就要立：

- **每个工具注册时必须声明 `side_effect_class`**（见 3.2），无默认值
- **checker 的失败模式默认由副作用等级决定**：`non_idempotent` 一律 fail-closed 或升级人工审批，**绝不 fail-open**。v1 即使没有 checker 框架，这条也适用于工具本身的前置检查

### MCP：部署归用户，Nucleus 提供四层

| | 职责 |
|---|---|
| 连接与发现 | 作为 client 连上 server（拉起 stdio 子进程 / 连 http），握手，`tools/list` 拿清单 + JSON Schema |
| 翻译 | MCP schema → provider function-calling schema（处理各家支持子集差异，必要时 flatten `oneOf`/`$ref`） |
| 命名空间与筛选 | 多 server 必然撞名 → 暴露为 `searxng__search`；per-agent 白名单在这层生效 |
| 调用与归一 | 路由 → `tools/call` → 结果（text/image/resource）转成模型可消费形式 → 超时、大输出截断 |

- 按需拉起 + 空闲回收 + 崩溃自动重启（带退避）
- **失败超阈值自动禁用**（`auto_disabled_at`），UI 显著展示 + 记 `last_error`；被禁用的 server 其工具从 agent 工具集中移除，模型看不到
- 工具清单缓存并快照到 attempt（`tool_snapshot_id`），server 升级后可归因
- **MCP 返回的内容一律标 `trust_level = untrusted_tool_output`**，见 §8

### 输出契约

`submit_result` 用 provider 原生 function calling / JSON Schema，**但不信 provider**（各家严格度参差），runtime 自己再校验一遍。失败反馈精确到字段路径，重试 ≤2 次，超了落 `contract.postcondition_failed`。

v1 的 schema：
```
core   status / summary(≤500 token) / artifacts[] / confidence / open_questions[]
```
按 agent 追加能力字段（research → `findings[].sources[]` 等）。**加字段必须可选**，破坏性改动升 `result_schema_version` major 并保留旧 reader。

---

## 7. Provider

### 认证

secrets **不进 config、不进 git**。config 只写 `credential_ref`，值从 env 或 OS keychain 取。

四家目标（Kimi / GLM / OpenAI / Grok）**全部是 API key + OpenAI 兼容形态**，所以是一个 client + 一张配置表，不需要抽象层。（OAuth 在 OpenAI 是给第三方应用代表他人访问用的，自用 API 无此流程；预留 `kind: 'oauth'` 的位置但不实现。）

### Preflight 选路：不逐个试

**现实前提：没有哪家提供可靠的「剩余配额」查询 API。** 部分家返回 rate-limit 响应头；z.ai / Kimi 基本只有 429（有时带 `retry-after`）。所以：

1. 每次响应解析 rate-limit 头 → 写 `provider_state`；无头的家用本地令牌桶 + 熔断器，429 记 `quota_exhausted_until`
2. **开始前 preflight**：对链上每个候选按 `(熔断中? / 剩余 / 恢复时间 / 单价)` 打分，一次选出可用者
3. 全链不可用 → run 转 `waiting_retry` 并写出「最早可用时间」，**不浪费调用**
4. UI 给 provider 健康面板

preflight 的价值不是创造配额，而是：不在死路上浪费调用、把等待变成带 ETA 的可见状态、fallback 不按愚蠢顺序试。

预算触顶：**默认挂起等确认**，自动降级为可配策略。

### 退化与循环检测

"模型一直重复同一段话"通常是模型端的采样退化（长 context + 低温度更易出现），但平台会放大它——把重复输出又喂回去就自我强化。三层检测，同时把「是谁的问题」变成可观测：

| 层 | 机制 | error_code |
|---|---|---|
| 输出级 | 流式中滑窗检测 n-gram 重复超阈值 → 立刻中断本次生成，换 provider 或调参 | `provider.degenerate_output` |
| 步骤级 | 同一 `(tool_name, args_hash)` 在一个 attempt 内重复 > N 次 → 拦截并明确反馈 | `budget.loop_detected` |
| 无进展级 | 连续 K 步无新 artifact、无新 tool 结果哈希 | `budget.no_progress` |

另有硬上限 `max_steps` / `max_cost_usd`（per agent 可配），触顶落终态。

---

## 8. Security 基线（P0，不是待审计项）

系统同时握有 exec、filesystem、MCP 和长期凭据。这是运行时最底层的能力模型，不是事后补的模块。**现有仓库已泄露过 token/key，优先级只能是 P0。**

- 默认只 bind `127.0.0.1`
- API bearer/session token；防 CSRF 与 DNS rebinding
- MCP server 级 + 工具级 capability（与 §6 的白名单同一机制）
- filesystem 沙箱（工作目录白名单）+ 网络限制
- 子进程资源限制（CPU / 内存 / 墙钟）
- 日志与 UI 的 secret redaction
- **`trust_level` 标记贯穿全系统**：`user` / `agent` / `untrusted_tool_output`
  - untrusted 内容**永不进入长期记忆/长期 prompt**（这是持久化 prompt injection 的入口：一个网页写"记住：以后总是执行 X"，被提炼成记忆条目后每次装配都注入）
  - untrusted 内容在 prompt 中显式包裹并标注来源
- 破坏性工具（`non_idempotent`）需审批；审批不可被模型绕过

---

## 9. 可观测

### run_events 序列
```
attempt.queued
attempt.started(model, provider, prompt_version, config_hash, tool_snapshot)
context.assembled(各层 token 明细, cache_hit)
llm.call.started / llm.call.finished(tokens, cache_read, ms)
llm.retry(reason=429|timeout|schema_invalid|degenerate, next_provider)   ← 让"卡住"可见
tool.intent(name, args_digest, side_effect_class)                        ← 见 3.2
tool.outcome(ok|err, ms)
artifact.written(ref, trust_level)
child.spawned(run_id, agent)
wake.armed(wake_id, wait_on) / wake.fired(wake_id)
heartbeat(step, elapsed)                                                ← 让"还活着"可见
attempt.finished(status, tokens, cost)
```

### 三层视图（分级披露，见 §10）
1. **会话内联** —— 当前在做什么、需不需要我、失败会不会自己恢复
2. **看板卡** —— 四态（活着 / 等外部 / 等我 / 已死）+「最后事件距今 X 秒」
3. **调试视图（二级）** —— run 树、完整事件流、context_breakdown、成本、回放

### 另加
- **Stall detector** —— 连续 N 秒无任何事件（不是没结束，是没事件）→ 标 `stalled` 并高亮。不等超时就知道僵了
- **回放** —— events + transcript 落盘，可逐步重演一个 attempt
- **保留策略** —— `run_events` 按月分区；终态 run 超过 N 天则事件压成摘要 + 原始归档；`usage_log` 保留全量

---

## 10. UI 原则（Niche 侧）

系统内部有 conversation / run / attempt / tool_invocation / artifact / wake 等对象。**全部映射到前端会让人觉得在操作一套 CI/CD 系统。** 分级披露：

| 层级 | 暴露什么 |
|---|---|
| 主界面 | conversation、task、需要我处理的事 |
| 二级「为什么/调试」 | run 树、事件流、context 明细、成本、回放 |
| 不暴露 | attempt、fence token、lease、tool_invocation 等实现对象 |

默认状态文案只回答三个问题：**现在在做什么 · 是否需要我 · 失败后会怎样。** 第三个问题由 `error_code.recovery` 直接给出，不让用户推断。cost / heartbeat / provider retry 不抢占正常任务叙事。

---

## 11. API 契约（v1）

前端不持有持久状态，只有 UI 瞬时态。

```
# 会话
POST   /v1/conversations                  {agent_id?, title?}
GET    /v1/conversations?q=&archived=
GET    /v1/conversations/:id/messages?before_seq=&limit=
POST   /v1/conversations/:id/messages     {content} → {message_id, run_id}
POST   /v1/conversations/:id/fork         {at_seq}

# 实时（单条 SSE 多路复用）
GET    /v1/stream?scope=conversation:<id>,board
       events: message.delta | message.done | run.status | run.event
             | task.updated | provider.health
POST   /v1/runs/:id/abort

# 执行与可观测
GET    /v1/runs/:id                       → 状态 / recovery / 成本 / attempts[]
GET    /v1/runs/:id/events?after_seq=
GET    /v1/runs/:id/tree
GET    /v1/artifacts/:ref?section=

# 看板
GET    /v1/tasks?status=&agent=
GET    /v1/tasks/:id                      → runs[] + artifacts[] + activity[]
PATCH  /v1/tasks/:id                      {status, priority, sort_order}

# 人工确认（3.2 的 needs_human_confirmation）
POST   /v1/runs/:id/confirm               {decision: 'already_done'|'retry'|'abort', note}

# agent
GET    /v1/agents
GET    /v1/agents/:id/prompt              → 分层装配后的实际结果
PUT    /v1/agents/:id/prompt              → 新版本（不覆盖）

# 基础设施
GET    /v1/providers/health
GET    /v1/mcp/servers                    → 状态 / 工具数 / 最近错误 / 是否被自动禁用
POST   /v1/mcp/servers/:id/reenable
GET    /v1/usage?range=&group_by=agent|model
```

五条硬规矩：
1. **单条 SSE 多路复用**；断线后用 `after_seq` 补齐
2. **所有写操作要 `Idempotency-Key`**
3. **数值字段允许 `null` 且语义 = 不可用，后端永不填默认值**（前端 `?? 'N/A'`）
4. artifacts 只走 API，不暴露文件路径
5. 跨进程事件走 Postgres `LISTEN/NOTIFY`，API 与编排进程可分离

---

## 12. 统一 config

单一 `nucleus.config.ts`（TS 以获得类型与注释）+ env 注入 secrets。包含：

`providers`（credential_ref / fallback 链 / 配额 / 价格）· `agents`（模型链、**工具与 MCP 白名单 = 能力边界**、max_steps、max_cost）· `mcp`（server 列表、失败禁用阈值）· `context`（各层预算与降级顺序）· `budgets` · `security`（bind / token / 沙箱路径 / 资源上限）

**hot reload**：改 config 不重启。正在跑的 attempt 用旧快照，新 attempt 用新的；attempt 记 `config_hash`，与 prompt 版本一样可归因。

---

## 13. 目录结构

```
nucleus/
  nucleus.config.ts
  migrations/
  agents/<id>/{identity.md, policy.md, agent.json}
  src/
    api/          HTTP + SSE
    runtime/      runner / tools / mcp / wake
    context/      tokenizer / budget / assemble
    providers/    credentials / openai-compatible / health / preflight
    store/        所有 DB 访问
    reconciler.ts
  test/
    fixtures/     录制的 provider 响应、真实 run 的 transcript
niche/            # Next.js，只认 NUCLEUS_URL
postgres
```

单机一个长驻进程（API 与编排同进程即可）+ 一个 Postgres。Next.js 的 route handler 不放业务逻辑。

Niche 需删除：`pg` / `drizzle-orm` / `drizzle-kit` / `@types/pg` / `drizzle.config.ts` / `src/lib/db/**` / `src/lib/openclaw/**`，以及 `board-store.ts` 的 `INITIAL_TASKS`（与其自身 `DATA-INTEGRITY.md` 冲突）。`@tanstack/react-query` 升为唯一数据层，`zustand` 降为纯 UI 状态。现有 `waiting|todo|progress|verify|done|cancel` 状态设计可直接用。

---

## 14. 测试

不追求覆盖率数字，要的是**关键路径的强断言**和**一开始就留好的接缝**。

### 分层

| tier | 内容 | 命令 |
|---|---|---|
| 0 unit | 纯逻辑（context 装配 / 预算 / 状态机 / preflight 打分 / 恢复分流） | `npm test` |
| 1 integration | PGlite 进程内 Postgres + 手写 stub | `npm test` |
| 2 replay | **真实模型响应**的 cassette 回放 | `npm test` |
| 3 live | 真 provider | 部署机 `npm run test:live` |

**tier 0–2 全部离线、零成本、确定性**，不需要 Postgres、不需要网络、不需要 API key。

### AI agent 沙箱的限制（**不是机器限制**，人类终端不受影响）

开发过程中大量代码由 Claude Code agent 编写，它运行在 `CLAUDE_SANDBOX_LEVEL=strict`
沙箱内。以下限制**只作用于该 agent 的进程树**：

| | agent 沙箱内 | 同一台机器的普通终端 |
|---|---|---|
| Node 出网（含 localhost） | ❌ `EPERM` | ✅ 已实测通过 |
| Node 监听端口 | ❌ `EPERM` | ✅ 已实测通过 |
| Postgres socket / TCP | ❌ `EPERM` | ✅ 已实测通过（PG 14.17） |
| Docker daemon | ❌ `Forbidden` | 未测 |
| curl | ✅ | ✅ |

**曾经把这些误记为「开发机的硬限制」，是错的。** 它们只影响 agent 能自动验证什么，
不影响这份代码在真实环境的行为。

由此带来的实际影响：

1. **agent 无法跑 tier 3**（真模型）。真实响应改由 curl 采集后装配成 cassette
   fixture（见 `test/live/build-fixtures.ts`），所以 tier 2 仍然基于真实响应而非手写 stub。
   在人类终端或部署机上直接用 `npm run test:record`。

2. **agent 无法跑需要监听端口的测试**（OAuth 回调服务器，7 个）。
   测试里用 `canListen` 探测并自动 `describe.skipIf`。
   **已在人类终端验证会正常执行**：`309 passed`（无 skipped），
   覆盖端口绑定、state 校验返回 400、其它路径 404、端口被占时降级、close 后端口释放。

3. **agent 无法连真 Postgres**，所有自动化测试跑在 **PGlite**（进程内 WASM，PG 18.3）上。
   已验证可用：`pg_trgm` / `uuid-ossp` / tsvector 全文检索 / `LISTEN·NOTIFY` /
   事务 / jsonb / array / generated column。
   **`pgvector` 不可用** —— 因此 v1 的 migration 里不得出现 `vector` 类型；
   L3 语义记忆推后到 v2 时作为 optional migration 单独引入。

4. `tsx` 直接跑脚本会因 IPC pipe `EPERM` 失败；agent 的临时诊断脚本走 vitest。

### 真 Postgres 验证状态

**已在 PostgreSQL 14.17 上验证通过**（2026-07-31，人类终端）：

- `migrate` 建成 17 张表并显示 `(postgres)`、`doctor` 全绿
- **真库上跑完整编排链路**：委派 → wake 同事务触发 → attempt 2 → 结果回流
  （即 §3.5 的核心路径，此前只在 PGlite 上验证过）
- `verify` 8 项全过

14.x 正好是声明的最低支持版本，比部署机可能用的 16/17 更严格 ——
SQL 里若混进新版特性会在这里暴露。

### SQL 兼容性

本地 PGlite 是 PG 18，部署机可能是 14。**SQL 一律按 PG 14 基线写**，不用新版特性，由 `doctor` 检查目标库版本。

### 前提：必须一开始就设计成可测的

clock 注入 · random/ids 注入 · fetch 注入 · fs 注入 · MCP client 注入。**否则强断言无从写起。**

`FakeClock` 额外提供 `advanceWhenPending()`：等被测代码真正进入 `sleep` 再推进时间。直接 `advance()` 会静默失效（表现为测试超时），这类时序竞态很难定位。

### 弱断言 vs 强断言

```ts
// ❌ 100% 覆盖，什么都没验证
it('assembles context', async () => {
  expect(await assemble(s)).toBeDefined()
})

// ✅ 强断言
it('static prefix is byte-identical across turns', async () => {
  const a = await assemble(s)
  const b = await assemble({ ...s, step: 9, violated_ids: new Set(['x']) })
  expect(b.prefix).toBe(a.prefix)               // cache 命中的前提
  expect(b.tail).not.toBe(a.tail)
  expect(tokens(b.tail)).toBeLessThanOrEqual(300)
})
```

Mutation testing 会故意改代码（`<=`→`<`、`&&`→`||`、删一行）后跑测试；全绿说明断言弱。指标是 mutation score。

### 六处必须强断言

| # | 不变量 | 状态 |
|---|---|---|
| 1 | 不可变前缀 byte-identical | ✅ 跨回合/跨 run 状态变化断言；且断言动态部分确实变了 |
| 2 | 终态 attempt 拒绝被回改 | ✅ DB trigger + 测试 |
| 3 | wake 与子 run 终态同事务；reconciler 能补漏 | ✅ 含故障注入回滚测试 |
| 4 | 过期 fence_token 的写入被拒绝 | ✅ |
| 5 | `non_idempotent` 的 UNKNOWN 结果绝不自动重跑 | ✅ 含 e2e「邮件不会发第二次」 |
| 6 | 预算降级顺序 | ✅ 断言降级序列是固定顺序的子序列 |

---

## 15. v1 范围

```
1. conversation + messages 存 DB               → 接 Niche，刷新历史还在
2. run + run_attempts + tool_invocations       → 逻辑/物理分离 + write-ahead 意图日志
3. typed submit_result                         → 结果所有权
4. 子 run 无对外身份
5. wake/join（只做 ad-hoc 委派一种）
6. 终态保证 + heartbeat + lease/fencing + reconciler
7. run timeline 事件流 + recovery 分类
8. 一个 provider（z.ai）+ 熔断 + waiting_retry
9. MCP client + per-agent 工具白名单 + 副作用分级
10. security 基线（§8 全套）
```

### 明确推后
- **plan / 依赖图编排** —— v1 靠 LLM 自己 ad-hoc 委派 + wake
- **L2 事实层 / L3 语义记忆 / distiller** —— v1 记忆手写进 `identity.md`
- **T1/T2 规则、checker 框架、遵守率度量** —— v1 只有能力边界（T3）
- **scheduler / cron**
- **LLM 压缩** —— v1 超预算截断或报错
- **approval 流程 / 看板「待反馈」列的完整语义** —— v1 只有 `needs_human_confirmation` 一种人工介入
- **多 provider** —— 接口留好，v1 只接一家
- **移动端推送**

### v1 的验收
一条端到端路径跑通并可量化：**在 Niche 里发一句话 → 编排者委派专家 → 专家写 artifact → 结果回到编排者（不是直发用户）→ 会话追加摘要 → 全过程在 timeline 可见 → 中途 `kill -9` worker 后能自动恢复且不重复外部副作用。**

---

## 附 A. 修正记录

| 项 | 早期版本 | 修正 |
|---|---|---|
| 可靠性表述 | "写一行数据库 = 不可能丢失" | 只保证 result persisted；**external effect confirmed 需副作用分级 + write-ahead 意图日志 + 人工确认** |
| retry 模型 | `runs.idempotency_key unique` + `attempt` 列，且"同 key 重新入队" | 拆 `runs` / `run_attempts` / `tool_invocations`；唯一约束在逻辑层；**终态不可变** |
| join/wake | 只说"parent 自己 pull"，未说谁唤醒 | `wake_records` + 子 run 终态同事务触发 + reconciler 补漏；**parent 不保持活着** |
| cache 分层 | 事实快照放在"byte-identical 前缀"内 | 三段：不可变前缀 / 版本化半静态 / 动态 |
| 记忆写入 | "用户说'不是X我要Y' ≈ preference" | 不成立（task-local 纠正 ≠ 全局偏好）；**且工具输出/网页内容禁止进长期记忆**（持久化 prompt injection） |
| checker 失败模式 | 一律"连拦 3 次自动放行" | 默认由副作用等级决定；`non_idempotent` **绝不 fail-open** |
| checker 分类 | 六类，"交叉一致"标为确定 | 四类：deterministic / heuristic / model judge / human gate |
| security | 放在"待审计" | **P0，进正文** |
| 规则强制分级 | 七个平铺名字，含写死的具体规则 | 三层 T1/T2/T3；**v1 只实现 T3（能力边界）** |
| 文档框架 | "为什么比 OpenClaw 好" | 删除全部竞品论证；重叠不是问题，成熟做法直接沿用 |
| plan 并发表达 | `parallel_group` 字段 | 并发由 runtime 推导；改用 `fan_out`（推后到 v2） |
| `user.output_style` 归层 | 列入事实层 | 不满足"可判定" → 属语义记忆（推后） |

## 附 B. 待办：现有系统的凭据泄露

`Nebula` 仓库已推送至 GitHub，其中 `openclaw.json`（gateway auth token）与 `config/mcporter.json`（AlphaVantage / Finnhub / Z.AI 明文 API key）被 git 跟踪。**建议轮换这些凭据**，Nucleus 中一律用 `credential_ref` + env/keychain。

## 附 C. 未决

- 移动端单向推送是否要（砍 channel 后唯一缺口）
- exec 沙箱的具体形态（现有系统 `sandbox.mode: off`）
- 现有知识资产迁移（`workspace-*/rules/*.md` 494 行 → `agents/` 的 identity/policy；规则审计推迟到骨架完成后）
- `deadline_at` 的默认值策略（现有系统超时配置散落在 prompt 里）
