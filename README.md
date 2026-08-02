# Nucleus

**为多 agent 协作定制的可靠编排运行时。**

一个编排者 agent 接收任务、委派给专家 agent、整合结果返回给你。系统保证的是：**任务不会做完了却没人知道，也不会因为进程崩了就永远悬在那里。**

> 状态：v1 开发中。CLI 可用，HTTP API 尚未实现。
> 设计决策见 [`DESIGN.md`](./DESIGN.md) · 部署见 [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) · 日常使用见 [`docs/USAGE.md`](./docs/USAGE.md)

---

## 它解决什么问题

在既有的多 agent 系统上跑了几个月后，反复遇到这几类问题：

| 现象 | Nucleus 的做法 |
|---|---|
| 专家 agent 的结果直接发给了用户，绕过编排者 | 子 run **在结构上没有对外身份** —— 做不到直发 |
| 任务做完了，但编排者没拿到结果 | 完成 = 写一行数据库记录；唤醒与子任务终态在**同一个事务**内 |
| 不知道任务卡在哪，只能反复追问进度 | 状态可拉取 + 结构化事件流，每一步都可见 |
| 进程被杀后任务永久悬空 | lease + 心跳 + reconciler 兜底，进程死了会被接管 |
| 429 打挂整条 fallback 链 | 熔断 + 开始前预检选路，不逐个试到成功 |
| prompt 里写满"禁止…"但模型照犯 | 能力边界写进配置：**不给工具，模型就无从违反** |

一句话概括设计原则：**可靠性由结构保证，不由 prompt 文本保证。**

---

## 快速开始

```bash
npm ci
npm run build
npm link            # 把 nucleus 挂到 PATH（改代码后重新 build 即生效）

# 端到端冒烟，全离线、不需要数据库、不烧 token
nucleus verify

# 交互式对话（内置 mock 模型，离线可跑）
nucleus chat --mock
```

不想装全局命令就用 `npm run cli -- <子命令>`，与 `nucleus <子命令>` 等价。

输出：

```
❯ 帮我调研一下向量数据库选型
  会话 a73f3fd8

⏺ orchestrator #1
  ⎿ zai:glm-5.2 · 240 tok
  ⎿ delegate ✓ 1ms
  ⎿ 挂起，等 1 个专家 —— 本轮 attempt 到此结束
  ⏺ researcher #1
    ⎿ zai:glm-5.2 · 240 tok
    ⎿ 产出 reports/主题调研.md 1.2 KB
    ⎿ write_report ✓ 1ms
    ⎿ zai:glm-5.2 · 340 tok
⏺ orchestrator #2
  ⎿ zai:glm-5.2 · 290 tok

⏺ 助手
  调研完成：专家确认方向可行，关键依据已整理成报告。

(=^ω^=)/ 2 个 run · 1.4k tok · 订阅 · 39ms
详情：nucleus runs 02054ec7
```

几处值得注意：

- **`挂起，等 1 个专家`** —— 编排者委派后**当轮就结束了**，没有空转等待。
  子任务完成时它会被唤醒，起第二次 attempt 来整合（就是下面的 `#2`）。
- **缩进代表 run 树的层级**，`⎿` 挂着的是那一层的实际动作。
- **每次模型调用都报出真正服务的模型** —— 降级链上到底谁接了这一手，
  事后不用猜。
- **订阅制显示「订阅」而不是 `$0`** —— 两者含义不同，混在一起会让人误判成本。

跑起来时最后一行是活的：一只猫跟着状态换表情（琢磨 / 干活 / 等专家 / 出错），
带耗时与累计 token。**任务挂住和任务在想，一眼能分清** —— 这是原来最难受的地方。
不想要动画就设 `NUCLEUS_NO_ANIM=1`，管道与 CI 下自动关闭。

`chat` 是连续对话的 REPL —— 会话 id 自动记住，`/model` 可随时换模型链，
`/runs` 可以不退出就查执行详情。脚本场景用 `ask`（一次性，两者走同一条管线）。

接真模型 —— **两种凭据形态**：

```bash
# GLM / Kimi 的订阅发 API key
nucleus auth login ZAI_API_KEY      # 输入不回显

# OpenAI / Grok 的订阅不发 API key，只能走 OAuth
nucleus auth login OPENAI_OAUTH --oauth --provider openai

nucleus chat --model zai:glm-5.2
```

OAuth 需要先在配置里给出 `clientId`，见[凭据与 OAuth](#凭据与-oauth)。

---

## 核心概念

四个对象，各管一件事：

| | 是什么 | 生命周期 |
|---|---|---|
| **conversation** | 用户可见的会话线程（等同 ChatGPT 左侧列表） | 永久，不过期、不重置 |
| **run** | 一次**逻辑**执行（"让研究员做这件事"） | 可跨多次尝试 |
| **run_attempt** | 一次**物理**尝试 | 终态不可变 |
| **task** | 看板上的一张卡 | 天/周级 |

**agent 是无状态的角色定义**（prompt + 工具集 + 模型链），不是进程。所以"三个会话都用同一个编排者但做不同的事"不需要任何特殊处理。

### 三条不变量

- **专家 run 的完整过程永不进入会话** —— 只往会话追加一条摘要 + artifact 引用，全文留在 run 里。会话历史因此可以无限增长。
- **只有 root run 关联 conversation** —— 子 run 没有对外身份，结构上不可能直发用户。
- **conversation 是日志，不是 context** —— 每回合从数据库按预算**装配** context。

---

## 可靠性是怎么做到的

### 完成 = 写库，不是投递消息

子任务写终态、递减唤醒计数、给编排者入队新 attempt —— **全部在一个事务里**。任何一步失败则整体回滚，reconciler 之后重新处理。所以不存在"做完了但没人知道"。

### 心跳是进程写库，不是模型自述

runner 每 15 秒一条 `UPDATE run_attempts SET heartbeat_at = now()`。零 token、零模型判断。用一个经过 LLM 的心跳去监控可靠性等于没有监控。

### 外部副作用不做承诺，做分级

数据库写入只能保证**结果可查**，保证不了"邮件没发两次"。所以每个工具必须声明副作用等级，工具调用**先写意图再执行**：

| 等级 | 崩溃后结果未知时 |
|---|---|
| `pure` | 直接重跑 |
| `idempotent` | 带同一幂等键重跑 |
| `non_idempotent` | **绝不自动重跑** → 转人工确认 |

### 每个错误都带恢复性

`automatic`（系统自己重试）/ `needs_user`（需要你处理）/ `terminal`（不会再变）。UI 直接渲染这个字段，不让人从 status 里猜。

---

## 能力边界即规则

规则不靠 prompt 文本约束，靠**不给能力**：

```yaml
---
name: analyst
whenToUse: 需要读现有材料做判断、且结论要能被复核时
permissions: [read, artifact]
---
```

**permission 是主闸门，工具名单只能再收窄。** 两者是不同的东西：

- **permission** = 「我可以做什么」——`read` / `write` / `artifact` /
  `execute` / `network` / `delegate` / `user`。这是稳定的、少量的词表。
- **工具** = 「用什么做」——`write_file`、MCP 的 `github__create_issue`……
  数量会一直涨，而且大多来自你没写的代码。

所以授权按 permission 授，不按工具名单授 —— 否则每接一个 MCP server 都要回去
改每个 agent 的白名单，而漏掉一条就是静默放行。工具声明自己需要哪些 permission
（`requires: Permission[]`），没被覆盖到的工具**根本不会出现在给模型的定义里**，
模型看不到就无从调用。比任何「禁止自己动手」的 prompt 都可靠，且成本为零。

MCP 工具没在 `mcpPolicies.permissions` 里映射时，它需要 `unclassified` 这个
哨兵权限 —— 而配置校验**拒绝把它授给任何 agent**。默认拒绝，不是默认放行。

`nucleus agent map` 打出这张矩阵：谁能用哪些工具、少了哪个权限。

需要机械检查的约束走工具前置条件，被拒时**规则原文原样回给模型**（同一份文本，不是搬运）：

```json
{ "ok": false, "rule": "fs.workdir-boundary",
  "message": "路径必须是工作目录内的相对路径，不允许绝对路径或 .. 穿越。" }
```

---

## 定时任务

```bash
nucleus schedule add 每日简报 --cron "30 8 * * *" --tz Asia/Shanghai \
  --agent analyst --goal "汇总昨天的进展"
```

```
✓ 已加计划 每日简报
  每天 8:30（Asia/Shanghai）
  下次触发 2026-08-03 08:30 Asia/Shanghai 21h 后
  交给 analyst
  停机期间错过的不补（--catch-up 可开）

要有 worker 在跑才会执行 —— 开一个 nucleus chat 放着即可。
接下来：2026-08-03 08:30 · 2026-08-04 08:30 · 2026-08-05 08:30
```

不需要额外进程：`worker.tick()` 里就地触发，和 reconciler 同一个位置 ——
「定时」的本质就是到点往队列塞一个 run。

几个语义是刻意选的：

- **每次新建会话，不注入上次结果。** 每次运行是一件独立的工作，只知道目标。
  灌上次摘要会让第二次之后的运行都在继承上次的偏差，十次之后 context 里全是
  自己的历史。跨次积累是产物（artifacts）的事，不是会话历史的事。
- **信封里写明「没有人在线」** —— 否则它会留一句「需要你确认」然后没人看见。
- **停机不补**（默认）。笔记本合盖一晚上，醒来不该突然跑 8 次。
  `--catch-up` 可开，且只补**最近** N 次 —— 补日报你要昨天那份。
- **上次没跑完就跳过这次**，不排队。每小时一次的任务如果单次要跑两小时，
  排队会越积越多。
- **幂等键用「计划」时刻**，靠唯一索引挡重复 —— 两个 worker 同时到点是
  TOCTOU，先查后写挡不住。

**「该跑的没跑」是最难发现的故障**（没有人在旁边等结果，症状只是产出不再出现），
所以每个计划点都记一行账：

```
❯ nucleus schedule history 每日简报

   计划时刻          实际   结果                          run
─  ────────────────  ─────  ────────────────────────────  ────────
✓  2026-08-03 08:30  准时   完成                          a1b2c3d4
!  2026-08-02 08:30  —      跳过（上次还在跑）             —
✗  2026-08-01 08:30  迟 1m  失败：config.agent_not_found  7047433d
```

注意第三行：**触发成功 ≠ 跑成功**。所以 `history`、`doctor` 与诊断包三处都按
run 的最终状态判定 —— 对着一个 failed run 打绿勾，和「系统会自动重试」那句假话
是同一类错误。

---

## 长会话怎么办（compact）

会话历史超预算时，**不是丢掉最旧的消息，而是压成结构化摘要**。

```
⏺ orchestrator #7
  ⎿ 压缩历史：退役 12 条（8.4k）…
  ⎿ 历史已压缩 8.4k → 1.1k（省 87%） · 留住 3 条约束 / 5 条决定
```

**判据是 token 压力，不是消息条数。** 现代模型动辄 500k–1M 窗口，
成百上千条消息是常态 —— 按条数判等于没判。

```
① 未摘要历史 > 历史预算 × 0.7        ← 主判据
② 从最新往旧留满「保留预算」，剩下的退役
③ 退役量 ≥ minRetireTokens          否则一次调用省不回来
```

**预算按模型算，没有硬上限：**

```
输出余量 = 模型声明的 maxTokens × 1.25   ← 不是写死的数
历史预算 = (窗口 − 输出余量) × 0.7
```

| 模型 | 窗口 | 历史预算 | 触发压缩 |
|---|---|---|---|
| gemma4:31b | 131k | 84.6k | 59.2k |
| GLM-5.2 | 205k | 129k | 90.3k |
| 1M 窗口 | 1049k | 705k | 494k |

早先这里是一组常量（`maxHistoryTokens: 40_000`），与窗口无关 ——
**1M 窗口的模型会在用掉 3% 的时候开始压缩**，而每次压缩是一次模型调用加
一次不可逆的信息损失。

**只看「还没被摘要覆盖」的部分** —— 否则每轮都会把同一段重压一遍。

**摘要是结构化的，不是散文。** 这是这块唯一要紧的决定。
「请总结上面的对话」会产出「用户与助手讨论了若干话题」——
读起来像摘要，但恰好丢掉了唯一要紧的部分。真实的故障形状是：

> 模型忘了我三轮前说过「不要有任何 default 模型」，又开始建议我加。

散文摘要挡不住它，因为它没有任何地方**必须**写下约束。所以摘要有固定的段，
和结果契约同一套思路 —— 模型只负责浓缩，什么必须留下由 schema 强制：

| 段 | 丢了会怎样 |
|---|---|
| `constraints` 用户原话 | 下一轮重犯已经被否掉的建议。**渲染时排最前** |
| `decisions` 连同为什么 | 少了理由就会被当成可以推翻的默认值 |
| `open` 悬而未决 | 下一轮假装一切都清楚 |
| `artifacts` 只写引用 | 已有的产出被重做一遍 |

摘要是**增量**的：新摘要 = 摘(旧摘要 + 新退役的消息)。所以第二代必须继承第一代的
约束 —— 这正是「三轮前说过的话」蒸发的那一步，有测试钉住。

三条不变量：

- **消息永不删除。** 压缩只写摘要与「覆盖到哪条」。摘要失败就退回按预算裁剪，
  而不是数据丢失。库会一直长，但那是磁盘问题;反过来是正确性问题。
- **压缩失败不让任务失败。** 它是锦上添花的一次调用。
- **压缩发生在装配之前。** 等到装配器报「裁掉 N 条历史」才动手是没用的 ——
  那时消息这一轮已经被丢了。

**结构化还有一个用处：摘要能按段降级。** 极端缺预算时降级顺序是

```
裁历史 → 摘要降到只剩「要求 + 未决」 → 整个丢掉摘要 → 砍约束块 → 失败
```

中间那一档不能少。原来只有「整个丢掉」，于是最缺预算的时候第一个丢的就是
用户约束 —— 而这功能存在的唯一理由就是保住它们。自相矛盾。

压缩有损、不可逆、而且**症状要几轮之后才出现**，所以每一代都留账：

```
❯ nucleus replay bundle.json
历史压缩（3 代 · 1 次失败）
· 第 1 代：退役 seq 1-14 （14 条 · 8412→1103 tok 省 87% · glm-5.2）
    约束：不要有任何 default 模型，都要用户自己设置
· 第 2 代：退役 seq 15-28 （14 条 · 7980→1250 tok 省 84%）
    ! 这一代没留下任何约束
✗ 压缩失败（seq 29-40）—— 模型没有调用 submit_summary
  压缩失败时历史改按预算裁剪（丢最旧的）—— 与「摘丢了」症状相同，成因不同
```

最后那句是重点：**「压缩没成功」与「摘要丢了东西」症状一模一样**，
不分开记账就分不开。

> 这是三层记忆里的第一层（会话历史）。第二层（事实）与第三层（向量检索）
> 还没做 —— 装配器留了 `facts` 入口但没人喂。

---

## 凭据与 OAuth

四个订阅模型分成两类：

| Provider | 订阅是否发 API key | 接入方式 |
|---|---|---|
| GLM（z.ai） | ✅ 有 | `auth login ZAI_API_KEY` |
| Kimi | ✅ 有 | `auth login KIMI_API_KEY` |
| **OpenAI** | ❌ 无 | **OAuth**（authorization code + PKCE） |
| **Grok（xAI）** | ❌ 无 | **OAuth**（authorization code 或 device flow） |

凭据统一存储，解析优先级 **环境变量 > macOS keychain > `~/.nucleus/credentials.json`（0600）**。
API key 与 OAuth access token 在 HTTP 层都作为 `Bearer` 发送，运行时不区分。

### OAuth 需要你自己的 clientId

**Nucleus 不内置任何第三方产品的 `client_id`。** 内置的只有端点模板
（authorize/token URL、scope、回调端口）—— 那些是公开的协议事实；
而 `client_id` 是各家颁发给**具体应用**的标识，借用别人的等于把本程序声明成对方，
配额与审计都记在人家头上。

```json
{
  "oauthProviders": {
    "openai": { "clientId": "<你申请到的 client_id>" },
    "xai": { "clientId": "<你申请到的 client_id>" }
  }
}
```

不配置就用不了 —— `auth login ... --oauth` 会给出可直接抄的配置片段和这条理由。
把别人的 id 填进去技术上能跑，代码没有封死这条路，但那是你的决定。

### 登录流程

```bash
nucleus auth login OPENAI_OAUTH --oauth --provider openai
```

1. 启动本地回调服务器（默认 `localhost:1455`，只绑 loopback）
2. 打开浏览器到 authorize URL（带 PKCE challenge + state）
3. **回调服务器与手动粘贴同时等待，先到的赢**
   - 本机有浏览器 → 授权后自动完成
   - 远程 SSH / 端口被占 → 把重定向后的 URL 粘回终端
4. 用 code + verifier 换 token，存入凭据库

access token 通常 1 小时过期，运行时**自动刷新**（同一 ref 的刷新并发去重 ——
rotation 型 provider 只认最后一个 refresh token）。

xAI 两种 flow 都支持，`--method device` 可切到不需要回调端口的那种。

---

## 项目结构

```
src/
  boot.ts              系统组装（CLI / 测试共用一套接线）
  config.ts            配置类型 + 默认值 + prompt 拼装
  config-file.ts       nucleus.config.json 加载与校验
  domain.ts            状态机与副作用分级
  errors.ts            error_code 枚举 + 恢复性分类
  seams.ts             注入接缝（clock / ids）
  db/                  PGlite（本地）+ Postgres（生产）+ migration
  store/               runs / attempts / wake / conversations
  providers/           OpenAI 兼容 + anthropic-messages 双协议 + 熔断 + 预检选路
  runtime/             runner / worker / reconciler / 工具层
  context/             三段装配 + 预算降级
  mcp/                 MCP client（stdio + http）
  auth/                凭据存储 + OAuth（device flow / authorization code + PKCE）
  env.ts               .env 加载（无第三方依赖）
  cli/                 终端界面（chat REPL / ask / 运维命令）
migrations/            forward-only SQL
test/                  299 个测试，全离线
```

---

## 开发

```bash
npm test          # 299 个测试，全离线：不需要数据库、网络、API key
npm run typecheck
npm run build
```

**部署机上也可以直接改代码。** 唯一的要求是开分支并推回 ——
诊断包记录 git sha，工作区不干净时 sha 与实际运行的代码对不上，
基于它的分析会指向错误的地方。`bundle` 会检测并在包里标注这一点。

自动化测试用 **PGlite**（进程内 WASM Postgres），所以 `npm test` 不需要装任何东西。
SQL 按 **PG 14 基线**写，已在真实的 PostgreSQL 14.17 上验证通过。

**测试分层**：

| tier | 内容 | 需要什么 |
|---|---|---|
| 0 unit | 纯逻辑（装配 / 预算 / 状态机 / 选路打分） | — |
| 1 integration | PGlite + 手写 stub | — |
| 2 replay | **真实模型响应**的 cassette 回放 | — |
| 3 live | 真 provider | 部署机 |

tier 2 的 fixture 由真实模型产生，不是手写的 —— 手写 stub 只能测出"我以为的样子"。

### 六条强断言

不追覆盖率数字，但这六处必须锁死：

1. 缓存前缀跨回合逐字节相同（prompt cache 命中的前提）
2. 终态 attempt 拒绝被回改
3. wake 与子 run 终态同事务；reconciler 能补漏
4. 过期 fence token 的写入被拒绝
5. `non_idempotent` 的未知结果绝不自动重跑
6. 预算降级按固定顺序

---

## 现状与限制

**已完成**

- **执行模型**：会话与消息 · run/attempt/工具调用三层 · wake/join · 心跳与
  reconciler · 事件流 · fence token · **run 级重试**（等到 provider 说的时刻，
  不受退避上限约束）
- **provider 层**：熔断与预检 · 模型链降级 · `provider_events` 追溯
  （`picked`/`ok`/`failed`/`breaker.*`/`exhausted`）· 网络错误分类
- **能力与边界**：**permission 与工具分离**（`read`/`write`/`artifact`/
  `execute`/`network`/`delegate`/`user`，未分类的 MCP 工具走 `unclassified`
  哨兵，配置校验拒绝授予）· 委派深度与 run 数上限
- **专家 agent**：`agents/*.md` 单一来源 · `agent new [--describe]` ·
  `agent try [--n] [--compare]` · 可声明的结果字段与必填校验 · 任务信封三段
- **定时任务**：cron 表达式（时区靠 `Intl`，夏令时不漂）· per-schedule 停机
  补偿 · 重入跳过 · 幂等键用**计划**时刻 · `schedule_fires` 触发账本
- **compact**：结构化摘要（约束 / 决定 / 未决 / 产出）· 增量继承 ·
  消息永不删除 · `compactions` 账本
- **可追溯性**：transcripts（prompt + 回复）· 诊断包 + `replay` 还原现场 ·
  产出内容入库 · 上下文装配与 token 预算

**未完成**

- **HTTP API + SSE** —— 所以前端还接不上
- **规则的三层**：注册表与遵守率统计有了，但 T1（注入约束）、T2（检查器）、
  T3（能力边界）还不是一个可编写的单元
- **`ask_user`** —— `waiting_user` 状态与会话锁已声明，没接线
- **长期记忆** —— L2 事实层 / L3 向量层都没有（pgvector 在本地不可用）
- **计划式编排** —— 目前是 ad-hoc 委派，没有先出计划再执行

**已知风险**

- 前沿模型对输出 schema 的遵守率**只有一个真实样本**：GLM-5.2 端到端一次，
  0 次 `contract.rejected`。一个样本不足以下结论，但至少不是全靠小模型推测。
- compact 的摘要质量有**一份**真实样本（gemma4:31b，15 轮 → 省 85%，
  3 条约束全留、12 条普通提问零误报）。多代累积之后会不会漂，还没有数据。
- 本地小模型（ollama）会忽略 prompt 层的规则 —— 这正是「规则要能被运行时强制，
  不能只写在 prompt 里」的由来。
- 四个订阅模型的 `baseUrl` / `contextWindow` / `maxTokens` **需要部署方自行确认**
  （它们比开发方的知识截止更新）—— 见 [部署指南 阶段 0.5](./docs/DEPLOYMENT.md#-阶段-05你需要自己搞清楚的事)

---

## 文档

| | |
|---|---|
| [`DESIGN.md`](./DESIGN.md) | 设计决策与取舍，含修正记录 |
| [`docs/BACKLOG.md`](./docs/BACKLOG.md) | 待办：要做什么、为什么、哪些还没定 |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | 部署到另一台机器的完整步骤 |
| [`docs/USAGE.md`](./docs/USAGE.md) | 命令参考与日常操作 |
| [`nucleus.config.example.json`](./nucleus.config.example.json) | 配置示例（带注释） |
