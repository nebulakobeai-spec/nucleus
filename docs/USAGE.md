# Nucleus 使用指南

命令参考与日常操作。部署见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)，设计见 [`../DESIGN.md`](../DESIGN.md)。

下文用 `nucleus` 指代 `node dist/cli/index.js`。想直接用短命令：

```bash
npm link          # 之后可以直接敲 nucleus
```

---

## 命令速查

```
对话与诊断
  chat                          交互式 REPL，连续对话（推荐）
  ask <文本>                    一次性对话，脚本友好
  runs [id 前缀]                列出 run / 查看 run 树
  events <id 前缀>              查看时间轴

凭据
  auth login <REF>              录入 API key（静默输入）
  auth login <REF> --oauth      浏览器授权（device flow + PKCE）
  auth list                     列出来源与状态
  auth test [REF]               用真实请求验证
  auth refresh <REF>            刷新 OAuth token
  auth logout <REF>             删除凭据

MCP
  mcp list                      server 状态与工具数
  mcp tools [server]            工具清单 + 副作用等级
  mcp enable <id>               解除自动禁用
  mcp call <tool> --args '{}'   直接调用（调试）

运维
  doctor                        环境与配置自检
  verify                        端到端冒烟（离线）
  migrate                       应用数据库迁移
  bundle [--run <id>]           导出诊断包
  replay <文件>                 读取诊断包，还原现场

通用参数
  --mock                        用内置 mock provider（离线）
  --model a,b                   覆盖模型链
  --config <file>               指定配置文件
  --conv <id>                   复用已有会话
  --db <url>                    覆盖数据库连接
  --no-keychain                 不用 macOS keychain
```

---

## 对话

### 交互式（推荐）

```bash
nucleus chat
nucleus chat --model zai:glm-5.2          # 指定模型链
nucleus chat --conv <id>                  # 接着已有会话聊
```

```
╭─ nucleus ──────────────────────────────╮
│ 会话 （下一轮创建）                     │
│ 模型 zai:glm-5.2, kimi:k3              │
╰────────────────────────────────────────╯
/help 查看命令 · /exit 退出

> 帮我调研一下向量数据库选型
新会话 8f29f2f3
▸ orchestrator attempt 1 · run 04c8a001
  · waiting_children（挂起，等待专家）
▸ researcher attempt 1 · run ea38c03e
  ✓ succeeded
▸ orchestrator attempt 2 · run 04c8a001
  ✓ succeeded

助手 调研完成：专家确认方向可行……

2 个 run · 1400 tokens · 订阅 · 2.3s

> 接着说
```

**会话 id 自动记住**，不用手抄。

#### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/new` | 开新会话（下一轮生成新 id） |
| `/model a,b,c` | 换模型链，对后续轮次生效；写错模型名会当场拒绝 |
| `/model` | 显示当前模型链与可用模型 |
| `/runs [id 前缀]` | 查看最近的 run 或某个 run 树，不退出 REPL |
| `/help` | 列命令 |
| `/exit` | 退出（Ctrl-D 同效） |

#### 出错时不会退出

模型报错（429 / 熔断 / 超时）只打印信息，REPL 继续等下一次输入。
`contract.rejected` 反复出现时会提示导出诊断包的命令。

Ctrl-C 的行为分两种：**有请求在跑时取消该请求**，空闲时才退出 ——
避免误触丢掉整个会话。

### 一次性（脚本用）

```bash
nucleus ask "帮我调研一下向量数据库选型"
nucleus ask "接着刚才的说" --conv 39774043-...   # 需要完整 id
```

`ask` 与 `chat` 走同一条管线、同一套渲染，输出格式一致。

### 读懂输出

```
▸ orchestrator attempt 1 · run dc1996e0
  · waiting_children（挂起，等待专家）
▸ researcher attempt 1 · run 26a1e0d5
  ✓ succeeded
▸ orchestrator attempt 2 · run dc1996e0
  ✓ succeeded

助手 调研完成：专家确认方向可行，关键依据已整理成报告。

2 个 run · 1400 tokens · $0.0021 · 2.3s
```

`waiting_children` **不是错误**。编排者委派后当轮就结束了 —— 它不保持活着、不占进程、不占 context。子任务完成时会被唤醒，起第二次 attempt 来整合。

这也解释了为什么 attempt 编号会跳：一个逻辑 run 可以有多次物理尝试（被唤醒、重试、恢复）。

### 换模型

```bash
nucleus ask "..." --model zai:glm-5.2
nucleus ask "..." --model zai:glm-5.2,kimi:k3         # fallback 链
nucleus ask "..." --mock                              # 离线，不烧 token
```

内置模型：`zai:glm-5.2` · `kimi:k3` · `openai:gpt-5.6-sol` · `xai:grok-4.5`
（均为订阅制）· `zai:glm-4.7`（按量）· `mock:local` / `ollama:llama`（本地）

链上前面的不可用（限流 / 熔断 / 额度耗尽）就自动切后面的。切换会记进时间轴的 `llm.retry`。

---

## 查看执行情况

### run 列表

```bash
nucleus runs
```

```
ID        AGENT         状态       错误  时间
────────  ────────────  ─────────  ────  ─────────────────────
dc1996e0  orchestrator  succeeded        7/30/2026, 8:09:03 PM
a3f21b90  orchestrator  failed     budget.steps_exceeded 需要你处理
```

错误列会带**恢复性**（`系统会自动重试` / `需要你处理` / `不会再变`）—— 直接看这个，不用自己从 status 推断。

### run 树

```bash
nucleus runs dc1996e0
```

```
● orchestrator succeeded dc1996e0 · 2 attempt · $0.0018
   调研完成：专家确认方向可行，关键依据已整理成报告。
  └─ researcher succeeded 26a1e0d5 · 1 attempt · $0.0003
     主题可行，关键依据已整理成报告。
```

多 agent 系统最需要的视图：谁委派了谁、各自花了多少、每层的结论是什么。

### 时间轴

```bash
nucleus events dc1996e0
```

```
     0ms dc1996 attempt.started      orchestrator #1
     2ms dc1996 llm.call.started     {"step":1,...}
    11ms dc1996 llm.call.finished    zai:glm-5.2 200+40 tok $0.0002
    11ms dc1996 tool.intent          delegate idempotent
    14ms dc1996 tool.outcome         delegate ✓ 2ms
    17ms dc1996 wake.armed           {"waitOn":1}
    18ms dc1996 attempt.finished     waiting_children $0.0002
    19ms 26a1e0 attempt.started      researcher #1
    ...
```

关键事件：

| 事件 | 含义 |
|---|---|
| `wake.armed` | 编排者挂起等待，**正常** |
| `llm.retry` | 切换 provider 中（429 / 超时 / 输出退化） |
| `tool.intent` | 工具调用**意图已记录**，尚未执行完 |
| `tool.outcome` | 工具执行完毕 |
| `rule.violation` | 被前置检查拦下，模型收到说明后会重试 |
| `contract.rejected` | 输出不合 schema，已退回重写 |
| `artifact.written` | 产出已登记 |

**判断死活最有用的信号是「最后一个事件距今多久」**，比 status 本身有用。`tool.intent` 后长时间没有 `tool.outcome` = 工具卡住；完全没有新事件 = 真卡住。

---

## 凭据

### 录入

```bash
nucleus auth login ZAI_API_KEY                          # 交互式，不回显
echo "$KEY" | nucleus auth login ZAI_API_KEY --stdin    # 管道
nucleus auth login ZAI_API_KEY --value "$KEY"           # 直接给值
```

### 查看

```bash
nucleus auth list
```

```
REF               类型     来源      值                过期  用于
────────────────  ───────  ────────  ────────────────  ────  ────────────
OPENAI_API_KEY    api_key  env       ************DOkA        openai:gpt-5.6-sol
ZAI_API_KEY       api_key  keychain  ************1234        zai:glm-5.2

解析优先级：环境变量 > keychain > ~/.nucleus/credentials.json
```

**明文永不显示。** 存储优先级：环境变量 > macOS keychain > `~/.nucleus/credentials.json`（0600）。

如果某个 ref 已有环境变量，`auth login` 会警告"环境变量优先级更高" —— 否则你会以为改生效了，实际没有。

### 验证

```bash
nucleus auth test              # 全部
nucleus auth test ZAI_API_KEY  # 单个
```

发真实请求，区分三种情况：

| | 含义 |
|---|---|
| `[ok]` | 有效 |
| `[fail] 凭据被拒绝` | key 错了或过期 |
| `[warn] 无法连接` | **网络问题，无法判断凭据** |

第三种很重要 —— 光检查"有没有设置"没意义，key 可能是错的、过期的、或复制时漏了字符。

### OAuth

**OpenAI 与 Grok 的订阅不发 API key，只能走 OAuth。** GLM 与 Kimi 有 key，不需要这一节。

```bash
nucleus auth login OPENAI_OAUTH --oauth --provider openai
nucleus auth login XAI_OAUTH --oauth --provider xai
nucleus auth login XAI_OAUTH --oauth --provider xai --method device   # 无回调端口时
```

#### 先配置 clientId

**Nucleus 不内置任何第三方产品的 client_id。** 端点模板是内置的（公开的协议事实），
但应用标识必须自己提供：

```json
{
  "oauthProviders": {
    "openai": { "clientId": "<你申请到的>" },
    "xai": { "clientId": "<你申请到的>" }
  }
}
```

没配置时 `--oauth` 会打印可直接抄的配置片段，并说明为什么不给默认值 ——
借用别人的 client_id 等于把本程序声明成对方，配额与审计都记在人家头上。

#### 登录时会发生什么

1. 启动本地回调服务器（默认 `localhost:1455`，**只绑 loopback**）
2. 打开浏览器到 authorize URL（PKCE challenge + state）
3. **回调服务器与手动粘贴同时等待，先到的赢**
4. 换 token 并存入凭据库

第 3 步是为远程环境设计的：SSH 到 VPS 时浏览器在你本地、服务器收不到回调，
这时把重定向后的完整 URL 粘回终端即可。端口被占也会自动降级到这条路径。

#### 自动刷新

access token 通常 1 小时过期。运行时检测到快过期会**自动刷新**，无需手动干预。

并发去重：同一 ref 的刷新只跑一次，其余调用共享结果 ——
OpenAI 这类 rotation 型 provider 每次刷新会作废旧的 refresh token，
并发刷新会让先返回的那个失效。

手动刷新：

```bash
nucleus auth refresh OPENAI_OAUTH
```

凭据里记着用哪个 provider 登录的，刷新时自动用同一套 clientId 与端点。

#### 安全约束

| | |
|---|---|
| PKCE | verifier 256 位随机，challenge 为 S256，token 交换时校验 |
| state | 128 位随机，回调时**定长比较**（避免时序侧信道） |
| redirect_uri | **只允许 loopback**（`localhost` / `127.0.0.1` / `::1`） |
| OIDC discovery | 返回的端点必须落在信任域内，否则拒绝（防篡改劫持） |
| refresh token | 与 access token 同存，不进日志、不进诊断包 |

---

## MCP 工具

### 查看

```bash
nucleus mcp list
```

```
ID    状态   工具  失败  最近错误
────  ─────  ────  ────  ────────
demo  ready  3     0
```

```bash
nucleus mcp tools
```

```
工具              副作用          依据
────────────────  ──────────────  ──────────────────────────
demo__echo        non_idempotent  未声明，按不可幂等处理
demo__get_time    pure            名称匹配只读模式 *__get_*
demo__send_alert  non_idempotent  未声明，按不可幂等处理
```

工具名一律是 `<serverId>__<toolName>` —— 多个 server 必然撞名（两个 `search`）。

### 副作用等级为什么重要

它决定**崩溃后的行为**：

| 等级 | 结果未知时 |
|---|---|
| `pure` | 直接重跑 |
| `idempotent` | 带同一幂等键重跑 |
| `non_idempotent` | **绝不自动重跑**，转人工确认 |

MCP 协议不表达这个，所以未声明的一律按 `non_idempotent`（安全侧）。确实可安全重放的在配置里声明：

```json
"mcpPolicies": {
  "policies": [
    { "pattern": "searxng__*", "sideEffect": "pure" },
    { "pattern": "memory__*", "sideEffect": "idempotent" }
  ],
  "fallback": "non_idempotent"
}
```

### 调试

```bash
nucleus mcp call searxng__search --args '{"query":"test"}'
nucleus mcp enable searxng      # 解除自动禁用
```

`mcp call` 绕过 agent 直接调工具 —— 排查是 server 的问题还是 agent 的问题时用。

server 连续失败达阈值会被**自动禁用**，其工具从所有 agent 的工具集中移除（模型看不到就不会调）。修好后 `mcp enable` 恢复。

---

## 诊断

### 导出

```bash
nucleus bundle --run dc1996e0    # 单条完整链路
nucleus bundle                   # 最近 20 条失败
```

生成 `diagnostics/<时间>-<git sha>.json`，**已脱敏**，可直接提交。

包含：git sha / node 版本 / 平台 / 数据库类型 / schema hash / 配置来源 / 凭据是否存在（不含值）/ provider 健康 / MCP 状态 / 该 run 的全部 attempt、事件、工具调用、wake、artifact / 出现过的 error_code 及其恢复性。

### 还原

```bash
nucleus replay diagnostics/2026-07-30-19-30-00-a1b2c3d.json
```

在**另一台机器上**读取诊断包，打印环境摘要 + 完整时间轴 + 结果未知的工具调用 + 错误清单。

这就是「那边测、这边修」的回路：出问题的机器只需要跑一条 `bundle`，不用来回描述现象。

---

## 配置

### .env 自动加载

CLI 启动时自动读取当前目录的 `.env`，不必每次 `source`：

```bash
NUCLEUS_DATABASE_URL=postgresql://...
```

**已存在的环境变量优先** —— 容器/CI 注入的值不会被文件覆盖，
这与凭据存储的优先级一致（env > keychain > 文件）。

用 `NUCLEUS_ENV_FILE` 可以指定别的路径。

### 配置文件

配置文件是 `nucleus.config.json`（支持注释），与代码内的 `defaultConfig` 合并。

```bash
nucleus doctor      # 「配置文件」那行显示实际用的路径和覆盖了哪些键
```

**数组是整体替换，不是合并** —— 列了 3 个 MCP server 就是 3 个。

### 加一个 agent

```json
{
  "agents": [
    {
      "id": "reviewer",
      "name": "评审员",
      "identity": "你是评审专家，负责检查方案的可行性与风险。",
      "toolsAllow": ["read_file"],
      "maxSteps": 8
    }
  ]
}
```

注意 `agents` 是整体替换 —— 加一个的时候要把原有的也写上。

### 能力边界

`toolsAllow` 是**唯一保留的规则机制**，也是最强的：不在白名单里的工具**根本不会出现在给模型的定义中**，模型看不到就无从调用。

```json
{ "id": "orchestrator", "toolsAllow": ["delegate"] }
```

编排者只有 `delegate` —— 没有 `write_file`、没有 `exec`。这比任何"禁止自己动手"的 prompt 都可靠，且成本为零。

支持 glob：`"toolsAllow": ["write_report", "searxng__*"]`。

### 输出契约

```json
{
  "id": "researcher",
  "capabilities": ["research"],
  "requiredFields": ["findings[].sources"]
}
```

启用 `requiredFields` 会让对应字段变必填 —— `findings[].sources` 的语义是「**每一条** finding 都必须有来源」。不合格的输出会被退回重写（最多 2 次），带精确到字段路径的反馈。

---

## 内建工具

| 工具 | 副作用 | 说明 |
|---|---|---|
| `delegate` | idempotent | 委派给专家；创建子 run，本轮结束 |
| `read_file` | pure | 读工作目录内的文件 |
| `write_file` | idempotent | 写文件并登记 artifact |
| `write_report` | idempotent | 写 Markdown 报告 |
| `web_search` | pure | 需要 MCP 提供实现，否则返回不可用 |

文件工具限制在 run 的工作目录内，**禁止绝对路径与 `..` 穿越** —— 违反时返回规则原文让模型改。

---

## 成本控制

```json
{
  "defaults": {
    "maxSteps": 12,
    "maxCostUsd": 1.0
  }
}
```

per-agent 可覆盖。触顶落终态（`budget.steps_exceeded` / `budget.cost_exceeded`），不会无限跑。

另外三层自动护栏：

| | 触发条件 |
|---|---|
| 循环检测 | 同一工具同一参数重复调用 → 第 2 次警告并跳过执行，第 4 次落 `budget.loop_detected` |
| 无进展检测 | 连续 6 步没有新产出 → `budget.no_progress` |
| 输出退化 | 模型重复输出同一段话 → 中断并换 provider |

查成本：

```bash
nucleus runs <id>      # run 树里每个节点都带成本
```

**订阅制模型显示「订阅」而不是 `$0`** —— 月费已付，单次调用没有边际成本，
但 `$0` 看起来像数据缺失。token 用量照常记录：**订阅制下真正的约束是配额和限流**，
不是钱。撞到限流时看 `doctor` 的 provider 健康面板与恢复时间。

---

## 开发时

```bash
npm test              # 275 个测试，全离线
npm run test:watch
npm run typecheck
npm run build
```

用 mock provider 快速迭代：

```bash
nucleus ask "..." --mock
```

mock 脚本在 `src/cli/index.ts` 的 `DEMO_SCRIPT` 里，改它可以模拟任意模型行为（包括故意的失败、循环、格式错误）—— 用来验证护栏是否生效，比等真模型犯错快得多。

---

## 疑难

| 症状 | 处理 |
|---|---|
| run 卡在 `waiting_children` | 正常，`runs <id>` 看子 run |
| `needs_human_confirmation` | 不可幂等的工具结果未知，**可能已执行**，`runs <id>` 看是哪个 |
| 每次都 `contract.rejected` | 模型不遵守 schema，需要调 prompt，导出诊断包 |
| 所有模型不可用 | `doctor` 看 provider 健康与恢复时间 |
| MCP `disabled` | `mcp enable <id>` |
| 改配置没生效 | `doctor` 看「配置文件」行 |
| 完全没有新事件 | 真卡住，`bundle` 导出 |
