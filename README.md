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

# 端到端冒烟，全离线、不需要数据库、不烧 token
node dist/cli/index.js verify

# 交互式对话（内置 mock 模型，离线可跑）
node dist/cli/index.js chat --mock
```

输出：

```
会话 39774043
───────────────────────────────
你  帮我调研一下向量数据库选型

▸ orchestrator attempt 1 · run dc1996e0
  · waiting_children（挂起，等待专家）
▸ researcher attempt 1 · run 26a1e0d5
  ✓ succeeded
▸ orchestrator attempt 2 · run dc1996e0
  ✓ succeeded

助手 调研完成：专家确认方向可行，关键依据已整理成报告。

2 个 run · 1400 tokens · $0 · 43ms
详情：nucleus runs dc1996e0
```

注意第一行的 `waiting_children` —— 编排者委派后**当轮就结束了**，没有空转等待。子任务完成时它会被唤醒，起第二次 attempt 来整合。

`chat` 是连续对话的 REPL —— 会话 id 自动记住，`/model` 可随时换模型链，
`/runs` 可以不退出就查执行详情。脚本场景用 `ask`（一次性，两者走同一条管线）。

接真模型 —— **两种凭据形态**：

```bash
# GLM / Kimi 的订阅发 API key
node dist/cli/index.js auth login ZAI_API_KEY      # 输入不回显

# OpenAI / Grok 的订阅不发 API key，只能走 OAuth
node dist/cli/index.js auth login OPENAI_OAUTH --oauth --provider openai

node dist/cli/index.js chat --model zai:glm-5.2
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

规则不靠 prompt 文本约束，靠**不给工具**：

```json
{
  "id": "orchestrator",
  "toolsAllow": ["delegate"]
}
```

编排者的工具集里只有 `delegate` —— 没有 `write_file`、没有 `exec`。这些工具**根本不会出现在给模型的定义里**，模型看不到就无从调用。这比任何"禁止自己动手"的 prompt 都可靠，且成本为零。

需要机械检查的约束走工具前置条件，被拒时**规则原文原样回给模型**（同一份文本，不是搬运）：

```json
{ "ok": false, "rule": "fs.workdir-boundary",
  "message": "路径必须是工作目录内的相对路径，不允许绝对路径或 .. 穿越。" }
```

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

**已完成**：会话与消息 · run/attempt/工具调用三层模型 · wake/join · 心跳与 reconciler · 事件流 · provider 熔断与预检 · MCP client · 凭据管理 · context 装配 · CLI

**未完成**：HTTP API + SSE（所以前端还接不上）· 计划式编排（目前是 ad-hoc 委派）· 长期记忆 · 定时任务 · LLM 压缩

**已知风险**：
- 前沿模型对输出 schema 的实际遵守率未知（本地只有小模型的真实响应）
- 四个订阅模型的 `baseUrl` / `contextWindow` / `maxTokens` **需要部署方自行确认**（它们比开发方的知识截止更新）—— 见 [部署指南 阶段 0.5](./docs/DEPLOYMENT.md#-阶段-05你需要自己搞清楚的事)

---

## 文档

| | |
|---|---|
| [`DESIGN.md`](./DESIGN.md) | 设计决策与取舍，含修正记录 |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | 部署到另一台机器的完整步骤 |
| [`docs/USAGE.md`](./docs/USAGE.md) | 命令参考与日常操作 |
| [`nucleus.config.example.json`](./nucleus.config.example.json) | 配置示例（带注释） |
