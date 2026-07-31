# Nucleus 部署指南

> **本文档面向部署机上的操作者（人或 agent）。**
> 按顺序执行，每一步都有明确的成功判据。任何一步失败 → 跑 `bundle` → 提交诊断文件 → 停止。

---

## ⛔ 开始之前：三条硬规矩

### 1. 远端不改代码

**所有代码修改只从 git 来。** 部署机上只允许改两个文件：

- `.env`
- `nucleus.config.json`

发现 bug → 导出诊断包 → 提交 → **停止，等新的 commit**。不要在部署机上试着修。

> 理由：两份代码一旦漂移，之后任何调试都不可信 —— 你在修的和开发方在看的不是同一个东西。诊断包里带 git sha 就是为了保证这一点。

### 2. 密钥不进任何被 git 跟踪的文件

配置文件里只写 `apiKeyRef` / `envRefs`（引用名），值通过 `nucleus auth login` 或环境变量提供。

### 3. 每一步都要看成功判据

本文档每步都写了"成功的样子"。不符合就停下来，不要继续往下走 —— 后面的失败会指向完全无关的地方。

---

## 阶段 0：环境检查

```bash
node -v          # 需要 ≥ 20，推荐 22+
git --version
```

**判据**：node 版本 ≥ 20。低于 20 请先升级，不要继续。

---

## 阶段 1：数据库

Nucleus 需要 **PostgreSQL ≥ 14**。

### 方式 A：Docker（推荐）

```bash
docker run -d --name nucleus-pg \
  -e POSTGRES_PASSWORD=nucleus \
  -e POSTGRES_USER=nucleus \
  -e POSTGRES_DB=nucleus \
  -p 5432:5432 \
  --restart unless-stopped \
  postgres:16

# 等它起来
sleep 5
docker exec nucleus-pg pg_isready -U nucleus
```

**判据**：输出包含 `accepting connections`。

### 方式 B：系统安装

```bash
# Debian/Ubuntu
sudo apt install -y postgresql
sudo -u postgres createuser -P nucleus     # 设个密码
sudo -u postgres createdb -O nucleus nucleus

# macOS
brew install postgresql@16 && brew services start postgresql@16
createuser -P nucleus && createdb -O nucleus nucleus
```

**判据**：

```bash
psql "postgresql://nucleus:<密码>@localhost:5432/nucleus" -c 'select version();'
```

能打印出版本号，且主版本 ≥ 14。

> ⚠️ **这是当前最大的未知数。** Nucleus 的所有自动化测试都跑在 PGlite（进程内
> WASM Postgres）上，**真 Postgres 连接路径尚未在真实环境验证过** ——
> 开发机的网络策略连不上数据库。如果阶段 4 的 `migrate` 或 `doctor` 在这里失败，
> 那是预期内的风险，请直接导出诊断包。

---

## 阶段 2：获取代码并构建

```bash
git clone <仓库地址> nucleus
cd nucleus
npm ci
npm run build
```

**判据**：`npm run build` 无输出（tsc 成功时静默），且 `dist/cli/index.js` 存在。

```bash
ls dist/cli/index.js && node dist/cli/index.js --help | head -3
```

应该打印命令帮助。

### 先跑一遍离线测试

```bash
npm test
```

**判据**：`Tests  213 passed (213)`。

这一步不需要数据库、网络、API key。**如果这里就失败了，说明是环境问题（node 版本、依赖安装），不要继续。**

---

## 阶段 3：配置

### 3.1 环境变量

```bash
cp .env.example .env
```

编辑 `.env`，**至少填这一项**：

```bash
NUCLEUS_DATABASE_URL=postgresql://nucleus:<密码>@localhost:5432/nucleus
```

其余按需：

| 变量 | 说明 |
|---|---|
| `NUCLEUS_DATABASE_URL` | **必填**。留空会退回本地 PGlite，那不是生产配置 |
| `NUCLEUS_WORKDIR` | agent 的工作目录根，默认 `/tmp/nucleus`。生产建议改成持久路径 |
| `OLLAMA_BASE_URL` | 有本地 ollama 才需要 |

**API key 不要写进 `.env`**，用阶段 5 的 `auth login`。（写进去也能工作，环境变量优先级最高，但那样它就进了一个容易被误提交的文件。）

### 3.2 配置文件

```bash
cp nucleus.config.example.json nucleus.config.json
```

编辑 `nucleus.config.json`。最少要改的是模型链：

```json
{
  "defaults": {
    "modelChain": ["zai:glm-4.7", "openai:gpt-5"],
    "maxSteps": 12,
    "maxCostUsd": 1.0
  }
}
```

`modelChain` 是 fallback 顺序：前面的不可用（限流/熔断/额度耗尽）就自动切后面的。

**可用的模型 key** 在 `src/config.ts` 的 `defaultConfig.models` 里：`mock:local`、`ollama:llama`、`zai:glm-4.7`、`openai:gpt-5`。要加别的模型，在配置文件里写完整的 `models` 数组（会整体替换默认值）。

> 配置文件支持 `//` 和 `/* */` 注释。
> 数组是**整体替换**语义，不是合并 —— 你列了 3 个 MCP server 就是 3 个。

---

## 阶段 4：建表

```bash
node dist/cli/index.js migrate
```

**判据**：输出 `[ok] migration 已应用（postgres）`。

注意括号里必须是 **`postgres`**。如果显示 `pglite`，说明 `NUCLEUS_DATABASE_URL` 没读到 —— 检查 `.env` 是否在当前目录、变量名是否拼对。

> migration 是 forward-only，没有回滚。已应用的 migration 文件被修改会**拒绝启动**，这是有意的，防止 schema 与代码悄悄漂移。

---

## 阶段 5：凭据

```bash
# 交互式，输入不回显
node dist/cli/index.js auth login ZAI_API_KEY

# 或脚本化（适合自动部署）
echo "$ZAI_KEY" | node dist/cli/index.js auth login ZAI_API_KEY --stdin
```

**判据**：

```bash
node dist/cli/index.js auth list
```

对应的 ref 显示来源（`env` / `keychain` / `file`）和脱敏值（形如 `********1234`）。**明文永不显示。**

### 用真实请求验证

```bash
node dist/cli/index.js auth test
```

**判据**：目标凭据显示 `[ok]`。

这条命令会区分三种情况，**注意分辨**：

| 输出 | 含义 | 处理 |
|---|---|---|
| `[ok]` | 凭据有效 | 继续 |
| `[fail] 凭据被拒绝` | key 错了或过期 | 重新 `auth login` |
| `[warn] 无法连接` | **网络不通，无法判断凭据是否有效** | 先解决出网，不是凭据问题 |

### 关于 OAuth

`auth login <REF> --oauth` 的机制（device flow + PKCE）完整可用，但**目前没有任何 provider 配置它** —— Kimi / GLM / OpenAI / Grok 对 API 访问都只提供 API key。

除非你要接的服务确实支持 OAuth，否则**一律用 API key**。运行 `--oauth` 会得到明确提示而不是含糊的错误。

---

## 阶段 6：自检

```bash
node dist/cli/index.js doctor
```

**判据**：最后一行是 `全部通过`。

逐项确认：

| 检查项 | 期望 |
|---|---|
| node 版本 | ≥ 20 |
| 配置文件 | 显示 `nucleus.config.json` 的**绝对路径**和覆盖了哪些键 |
| 数据库连接 | **`postgres`**，不是 `pglite` |
| schema 已应用 | 17 张表 |
| Postgres 版本 ≥ 14 | 真实版本号 |
| 工具注册 | ≥ 5 个 |
| agent 配置 | 你配置的 agent id 列表 |
| 凭据 | 用得上的都 `[ok]` |
| MCP（若配置了） | `ready`，显示工具数 |
| provider | `正常` |

**「配置文件」那一行特别重要** —— 部署时最常见的问题是"改了配置但没生效"（改错文件、或路径不对）。这一行会告诉你实际用的是哪个文件。

---

## 阶段 7：验证

### 7.1 离线冒烟（不烧 token）

```bash
node dist/cli/index.js verify
```

**判据**：8 项全 `[ok]`，最后 `verify 通过`。

它跑的是一条完整编排链路，并断言：

- 编排者完成 · 专家被委派并完成
- **专家无对外身份**（结构上无法直发用户）
- 结果回流到会话
- 产出已登记 · timeline 已记录
- 无悬挂的工具调用 · 无悬挂 attempt

### 7.2 真模型

```bash
node dist/cli/index.js ask "用一句话介绍你自己" --model zai:glm-4.7
```

**判据**：打印出助手回复，末尾显示 run 数 / token 数 / 成本。

### 7.3 真实编排

```bash
node dist/cli/index.js ask "帮我调研一下 X，要有来源" --model zai:glm-4.7
```

**这一步是真正的验收。** 期望看到：

```
▸ orchestrator attempt 1 · run xxxxxxxx
  · waiting_children（挂起，等待专家）      ← 委派后当轮结束
▸ researcher attempt 1 · run yyyyyyyy
  ✓ succeeded
▸ orchestrator attempt 2 · run xxxxxxxx    ← 被唤醒，起第二次 attempt
  ✓ succeeded
```

然后看细节：

```bash
node dist/cli/index.js runs                  # run 树
node dist/cli/index.js events <run-id 前缀>  # 完整时间轴
```

**如果真模型这一步失败，最可能的原因是 schema 遵守率** —— 在 timeline 里找 `contract.rejected` 事件，它表示模型的 `submit_result` 输出不合格被退回了。偶尔一两次是正常的（系统会让它重写）；每次都失败则需要调整 prompt，**这需要开发方介入，请导出诊断包**。

---

## 阶段 8（可选）：MCP server

如果要接 MCP 工具，在 `nucleus.config.json` 的 `mcp` 数组里加：

```json
{
  "mcp": [
    {
      "id": "searxng",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": { "SEARXNG_URL": "http://localhost:8888" }
    },
    {
      "id": "finnhub",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "finnhub-mcp"],
      "envRefs": { "FINNHUB_API_KEY": "FINNHUB_API_KEY" }
    }
  ]
}
```

**密钥用 `envRefs`（引用名）而不是 `env`（明文）** —— 配置校验会拦住看起来像明文密钥的 `env` 项。对应的凭据用 `nucleus auth login FINNHUB_API_KEY` 配置。

验证：

```bash
node dist/cli/index.js mcp list      # 状态应为 ready
node dist/cli/index.js mcp tools     # 工具清单 + 副作用等级
```

### ⚠️ 副作用等级必须确认

MCP 协议**不表达副作用等级**，但崩溃恢复完全依赖它。未声明的工具一律按
`non_idempotent` 处理 —— 崩溃后不自动重跑，转人工确认。

`mcp tools` 会列出每个工具的分级和判定依据。**逐个看一遍**，确实可安全重放的在
`mcpPolicies.policies` 里显式声明：

```json
"mcpPolicies": {
  "policies": [
    { "pattern": "searxng__*", "sideEffect": "pure" },
    { "pattern": "memory__*", "sideEffect": "idempotent" }
  ],
  "fallback": "non_idempotent"
}
```

分级错了的后果：把「发邮件」标成 `pure` → 崩溃后会自动重发。**宁可保守。**

最后 agent 要能用上这些工具，在 agent 的 `toolsAllow` 里加（支持 glob）：

```json
{ "id": "researcher", "toolsAllow": ["write_report", "searxng__*"] }
```

---

## 出问题时：导出诊断包

**一条命令，一个文件：**

```bash
# 针对某个具体的 run
node dist/cli/index.js bundle --run <run-id 前缀>

# 或最近 20 条失败
node dist/cli/index.js bundle
```

生成 `diagnostics/<时间>-<git sha>.json`，包含：

- git sha · node 版本 · 平台 · 数据库类型 · schema hash
- 配置文件路径与覆盖项
- 凭据**是否存在**（不含值）· provider 健康 · MCP 状态
- 该 run 的全部 attempt / 事件 / 工具调用 / wake / artifact
- 出现过的 error_code 及其恢复性

**已脱敏，可直接提交。** 提交后停止操作，等待新的 commit。

---

## 读懂状态

### 事件时间轴

```bash
node dist/cli/index.js events <run-id>
```

| 事件 | 含义 |
|---|---|
| `wake.armed` | 编排者已挂起等待专家 —— **这是正常的**，不是卡住 |
| `llm.retry` | 正在切换 provider（429 或超时） |
| `rule.violation` | 工具调用被前置检查拦下，模型会收到说明并重试 |
| `contract.rejected` | 输出不合 schema，已退回重写 |
| `tool.intent` 后长时间没有 `tool.outcome` | 工具卡住了 |
| **长时间完全没有事件** | 才是真卡住 |

### 恢复性

每个错误都带恢复性，**直接看这个**，不要从 status 推断：

| | 含义 | 你要做什么 |
|---|---|---|
| `automatic` | 系统会自己重试 | 等着 |
| `needs_user` | 卡住了 | 处理 |
| `terminal` | 不会再变 | 看结果 |

### `needs_human_confirmation`

某个不可幂等的工具（发邮件、转账之类）调用结果未知 —— **可能已经执行了**。系统不会自动重跑，等你确认。

```bash
node dist/cli/index.js runs <id>    # 看是哪个工具
```

---

## 常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| `migrate` 显示 `pglite` | `.env` 没读到 | 确认在项目根目录、变量名拼写 |
| `doctor` 报 schema 不匹配 | 忘了 migrate | `nucleus migrate` |
| 改了配置没生效 | 改错文件 / 环境变量优先级更高 | 看 `doctor` 的「配置文件」行 |
| `auth test` 报「无法连接」 | 网络不通 | **不代表凭据无效**，先查出网 |
| MCP 显示 `disabled` | 连续失败达阈值被自动禁用 | 修复后 `mcp enable <id>` |
| run 卡在 `waiting_children` | 子 run 还在跑 | `runs <id>` 看子 run |
| 所有模型都不可用 | 额度耗尽或全部熔断 | `doctor` 看恢复时间 |
| 每次都 `contract.rejected` | 模型不遵守输出 schema | **导出诊断包，需要开发方介入** |

---

## 长驻运行

目前只有 CLI，**HTTP 服务（`serve` 命令）尚未实现**，所以还不需要配 systemd。

将来可用：

```ini
[Unit]
Description=Nucleus
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/nucleus
EnvironmentFile=/opt/nucleus/.env
ExecStart=/usr/bin/node dist/cli/index.js serve
Restart=always
RestartSec=5
User=nucleus

[Install]
WantedBy=multi-user.target
```

**进程崩溃是安全的**：lease 过期后 reconciler 判定 `lost` 并重新调度；不可幂等的工具调用若结果未知，转 `needs_human_confirmation` 而不是重跑。

---

## 升级

```bash
git pull
npm ci
npm run build
node dist/cli/index.js migrate
node dist/cli/index.js doctor      # 必须全绿
node dist/cli/index.js verify      # 离线冒烟
```

---

## 部署检查清单

给自动化 agent 用的顺序清单，每项都有判据：

```
[ ] node -v ≥ 20
[ ] Postgres ≥ 14 可连接（psql 能 select version()）
[ ] npm ci && npm run build 成功
[ ] npm test → 213 passed
[ ] .env 已配置 NUCLEUS_DATABASE_URL
[ ] nucleus.config.json 已创建，modelChain 已设置
[ ] migrate → 显示 (postgres)，不是 (pglite)
[ ] auth login <REF> → auth list 显示来源与脱敏值
[ ] auth test → 目标凭据 [ok]
[ ] doctor → 全部通过
[ ] verify → 8 项全 ok
[ ] ask "..." --model <真模型> → 有回复
[ ] ask 一个需要委派的任务 → 看到 waiting_children → 专家 → attempt 2
[ ] （若配 MCP）mcp list → ready；mcp tools → 副作用等级已逐个确认
```

任何一项失败：`bundle` → 提交 → 停止。
