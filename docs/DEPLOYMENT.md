# Nucleus 部署指南

> **本文档面向部署机上的操作者（人或 agent）。**
> 按顺序执行，每一步都有明确的成功判据。

---

## 开始之前：三条规矩

### 1. 可以改代码，但改动必须可见

部署机上**允许直接修改代码**修 bug、加功能。唯一的要求是**别让两份代码悄悄分叉**：

```bash
# 改之前先开分支，不要直接在 main 上改
git switch -c fix/<简短描述>

# 改完提交并推回
git add -A && git commit -m "fix: ..." && git push -u origin HEAD
```

**为什么要分支和提交**：诊断包里记录 git sha。如果部署机有未提交的改动，
那个 sha 对应的代码和实际跑的不是一回事 —— 之后任何基于诊断包的分析都会指向错误的地方。
`bundle` 会检测工作区是否干净并在包里标注，但它无法还原你改了什么。

改完记得跑一遍：

```bash
npm test && npm run build
```

**如果不方便提交**（比如只是临时试一下），至少在导出诊断包时把 diff 一起带上：

```bash
git diff > diagnostics/local-changes.patch
node dist/cli/index.js bundle --run <id>
```

### 2. 密钥不进任何被 git 跟踪的文件

配置文件里只写 `apiKeyRef` / `envRefs`（引用名），值通过 `nucleus auth login` 或环境变量提供。

改代码时也一样：**不要为了方便把 key 硬编码进源文件**，那会跟着 commit 推到远端。

### 3. 每一步都要看成功判据

本文档每步都写了"成功的样子"。不符合就停下来排查，不要继续往下走 ——
后面的失败会指向完全无关的地方。

---

## 阶段 0：环境检查

```bash
node -v          # 需要 ≥ 20，推荐 22+
git --version
```

**判据**：node 版本 ≥ 20。低于 20 请先升级，不要继续。

---

## ⚠️ 阶段 0.5：你需要自己搞清楚的事

**开发方不知道这些，必须由你在部署机上确认。** 有些会导致明确的报错，有些会**静默地降低效果** —— 后者更危险，所以逐项确认。

### A. 模型的真实参数（必须确认）

以下字段在 `src/config.ts` 里是**空的或猜的**，因为开发方无法访问网络、且这些模型比其知识截止更新：

| 模型 | `baseUrl` | `contextWindow` | `maxTokens` |
|---|---|---|---|
| `zai:glm-5.2` | `https://api.z.ai/api/coding/paas/v4` ⚠️沿用旧版路径 | **缺失** | **缺失** |
| `kimi:k3` | `https://api.kimi.com/coding` ⚠️沿用旧版路径 | **缺失** | `32768`（猜的） |
| `openai:gpt-5.6-sol` | `https://api.openai.com/v1` | **缺失** | **缺失** |
| `xai:grok-4.5` | `https://api.x.ai/v1` ⚠️未验证 | **缺失** | **缺失** |

**`contextWindow` 缺失的后果是静默的**：context 装配会用默认预算（128k 窗口，16k 留给输出）。

- 实际窗口更大 → 白白浪费容量，长会话被过早裁剪
- 实际窗口更小 → 装配出超窗的请求，被 provider 拒绝

**你要做的**：查各家文档拿到准确值，写进 `nucleus.config.json`：

```json
{
  "models": [
    {
      "key": "zai:glm-5.2", "provider": "zai", "model": "glm-5.2",
      "baseUrl": "<确认后的地址>",
      "api": "openai-completions",
      "apiKeyRef": "ZAI_API_KEY",
      "billing": "subscription",
      "contextWindow": 200000,
      "maxTokens": 131072
    }
    // …其余三个同理。models 是整体替换，要写全
  ]
}
```

**验证 baseUrl 是否正确**（在配置之前就能查）：

```bash
# OpenAI 兼容的三家：列模型
curl -s -H "Authorization: Bearer $ZAI_API_KEY" \
  https://api.z.ai/api/coding/paas/v4/models | head -c 300

curl -s -H "Authorization: Bearer $XAI_API_KEY" \
  https://api.x.ai/v1/models | head -c 300

curl -s -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models | head -c 300
```

返回 JSON 模型列表 = baseUrl 对。返回 404 / HTML = 路径错了。
**同时确认返回的列表里真的有你配置的那个 model id**（比如 `glm-5.2`、`grok-4.5`）——
model id 写错的报错通常很含糊。

Kimi 走 anthropic-messages 协议，端点不同：

```bash
curl -s -X POST https://api.kimi.com/coding/v1/messages \
  -H "Authorization: Bearer $KIMI_API_KEY" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"k3","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

期望返回带 `content` 数组的 JSON。如果报错，**先确认 Kimi 的订阅端点到底是不是这个路径以及是不是 anthropic 协议** —— 开发方是从你 4 月的旧配置里读到的，可能已经变了。若实际是 OpenAI 兼容，把配置改成 `"api": "openai-completions"` 并换 baseUrl 即可，两个适配器都在。

### B. 订阅制的配额边界（强烈建议摸清）

四个模型都是订阅制。**订阅制下真正会卡住你的不是钱，是配额和限流。** 但每家的配额口径不同（按请求数？按 token？按小时还是按天？），开发方无从得知。

**你要做的**：

1. 查各家订阅页面的速率限制说明，记下来
2. 如果某家**没有** rate-limit 响应头（z.ai 和 Kimi 大概率没有），在配置里设本地令牌桶兜底：

```json
{ "key": "zai:glm-5.2", "rpm": 60, "...": "..." }
```

不设的话，撞限流只能靠 429 被动发现 —— 能工作，但会浪费调用、拖慢响应。

3. 跑几轮真实任务后看：

```bash
node dist/cli/index.js doctor      # provider 健康：谁在熔断、何时恢复
```

### C. 数据库连接细节

| 要确认的 | 怎么确认 |
|---|---|
| 连接串格式（是否需要 `?sslmode=require`） | 托管数据库通常需要；本地 docker 不需要 |
| 数据库用户是否有建表权限 | `migrate` 会直接报错，很明确 |
| Postgres 主版本 | `psql -c 'select version()'`，必须 ≥ 14 |

> ⚠️ **真 Postgres 路径尚未在真实环境验证过** —— 开发方的机器连不上数据库，
> 所有测试跑在 PGlite 上。这是整个部署中最大的未知数。
> 如果 `migrate` 或 `doctor` 在这里失败，**这是预期内的风险**，直接导出诊断包。

### D. 工作目录

`NUCLEUS_WORKDIR` 默认 `/tmp/nucleus` —— **重启会丢**。生产要改成持久路径，并确认：

```bash
mkdir -p /var/lib/nucleus/work && touch /var/lib/nucleus/work/.probe && rm $_
```

能写入即可。agent 产出的文件都落在这里。

### E. MCP server 的可用性（若要用）

每个 MCP server 都是**独立的第三方进程**，开发方不知道你的机器上能不能跑起来。逐个确认：

```bash
# 命令本身存在吗
npx -y mcp-searxng --help 2>&1 | head -3

# 它依赖的服务在吗（比如 searxng 需要一个本地实例）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888
```

**尤其注意**：有些 MCP server 需要额外的后端服务（searxng 要 searxng 实例、postgres MCP 要数据库、browserless 要浏览器容器）。这些**不在 Nucleus 的职责范围内**，要你自己部署。

配好之后必看这一项：

```bash
node dist/cli/index.js mcp tools
```

**逐个确认副作用等级**（见阶段 8）。分级错了的后果：把「发邮件」标成 `pure` → 崩溃后会自动重发。

### F. 网络出站

```bash
# 确认能连到各家 API（如果在受限网络里，这一步会暴露问题）
curl -s -o /dev/null -w 'z.ai %{http_code}\n'   https://api.z.ai
curl -s -o /dev/null -w 'openai %{http_code}\n' https://api.openai.com
curl -s -o /dev/null -w 'xai %{http_code}\n'    https://api.x.ai
curl -s -o /dev/null -w 'kimi %{http_code}\n'   https://api.kimi.com
```

任何一家连不通，对应的模型就不可用 —— 在 `modelChain` 里把它移到后面或去掉，
否则每次都会先浪费一次超时。

> 如果需要代理，Node 的 `fetch` **不会自动读 `HTTP_PROXY`**。目前 Nucleus
> 没有代理配置项 —— 如果你的环境必须走代理，导出诊断包告知，这需要开发方加支持。

### G. 前沿模型的 schema 遵守率（跑起来才知道）

Nucleus 要求模型用 `submit_result` 工具提交结构化结果。本地只用小模型（llama3.2）验证过协议管道，**前沿模型的实际遵守率是未知的**。

跑几轮真实任务后：

```bash
node dist/cli/index.js events <run-id> | grep contract.rejected
```

- 偶尔出现 = 正常，系统会让它重写
- **每次都出现** = prompt 或 schema 需要调整，**导出诊断包，需要开发方介入**

### H. OAuth clientId（必须自己解决）

**OpenAI 和 Grok 的订阅不发 API key，只能走 OAuth，而 OAuth 需要 client_id。**
Nucleus 不内置任何第三方的 client_id，所以这一项不解决，这两个模型就用不了。

需要查清三件事：

1. **各家是否开放个人注册 OAuth 客户端？**
   - OpenAI：platform.openai.com → Settings → 找 OAuth / Applications
   - xAI：console.x.ai → 开发者设置
   - 关注 redirect URI 能否填 `http://localhost:1455/auth/callback`（loopback）

2. **走 OAuth 的用量算订阅额度还是 API 计价？**
   这条很重要 —— 如果算 API 计价，会产生**订阅之外的费用**。
   订阅制的前提是"月费已付、调用无边际成本"，这个假设不成立的话
   `billing: "subscription"` 的配置就该改回 `"usage"` 并填单价。

3. **注册本身是否收费？**
   OAuth 客户端注册通常免费（它只是应用标识），但要确认。

可能的三种情形：

| 情形 | 表现 | 处理 |
|---|---|---|
| 开放注册 | 门户里能直接创建拿到 client_id | 最干净，用自己的 |
| 需审核 / 仅企业 | 要提交申请说明用途 | 走流程，或暂时不用这两家 |
| 完全不开放 | 只有官方 CLI 内置的 id 能用 | 需要向仓库所有者确认怎么处理 |

**如果是第三种情形，不要自行决定填别人的 client_id** —— 导出诊断包或直接反馈，
这是产品定位问题，不是部署问题。

在此期间 GLM 和 Kimi 可以正常工作，把 `modelChain` 里的 OpenAI / Grok 去掉即可。

---

### 阶段 0.5 检查清单

```
[ ] 四个模型的 baseUrl 用 curl 验证过，且模型列表里有对应 model id
[ ] Kimi 的协议确认过（anthropic-messages 还是 OpenAI 兼容）
[ ] 四个模型的 contextWindow / maxTokens 已查到并写进配置
[ ] 各家订阅的速率限制已了解；无响应头的家已设 rpm
[ ] 数据库连接串格式确认（sslmode 等），用户有建表权限
[ ] NUCLEUS_WORKDIR 指向持久路径且可写
[ ] （若用 MCP）每个 server 的命令与依赖服务都能跑
[ ] 出站网络到四家 API 都通
[ ] OpenAI / Grok 的 OAuth clientId 已解决（或已确认暂时不用这两家）
[ ] 已确认走 OAuth 的用量算订阅额度而非 API 计价
```

**这些不做也能启动**，但 A 和 B 不做会让系统在长会话和高负载下表现明显变差，而且症状不明显。

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

> ⚠️ 真 Postgres 路径尚未在真实环境验证过，见 [阶段 0.5 C](#c-数据库连接细节)。

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

**判据**：`Tests  299 passed | 7 skipped (306)`。

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

> CLI 启动时会自动加载当前目录的 `.env`，不需要手动 `source`。
> 已存在的环境变量优先，所以容器注入的值不会被文件覆盖。

### 3.2 配置文件

```bash
cp nucleus.config.example.json nucleus.config.json
```

编辑 `nucleus.config.json`。最少要改的是模型链：

```json
{
  "defaults": {
    "modelChain": ["zai:glm-5.2", "kimi:k3", "openai:gpt-5.6-sol", "xai:grok-4.5"],
    "maxSteps": 12,
    "maxCostUsd": 1.0
  }
}
```

`modelChain` 是 fallback 顺序：前面的不可用（限流/熔断/额度耗尽）就自动切后面的。

**内置的模型 key**：

| key | 协议 | 计费 | 凭据 |
|---|---|---|---|
| `zai:glm-5.2` | openai-completions | 订阅 $30/月 | `ZAI_API_KEY` |
| `kimi:k3` | **anthropic-messages** | 订阅 $39/月 | `KIMI_API_KEY` |
| `openai:gpt-5.6-sol` | openai-completions | 订阅 $20/月 | `OPENAI_API_KEY` |
| `xai:grok-4.5` | openai-completions | 订阅 $30/月 | `XAI_API_KEY` |
| `zai:glm-4.7` | openai-completions | 按量（有单价） | `ZAI_API_KEY` |
| `mock:local` / `ollama:llama` | — | 本地/测试 | — |

要加别的模型，在配置文件里写完整的 `models` 数组（**整体替换**默认值）。

> **Kimi 走的是 anthropic-messages 协议**，不是 OpenAI 兼容 —— 请求体、
> 流式事件、usage 字段都不同。配置里 `"api": "anthropic-messages"` 决定走哪个适配器，
> 写错会得到 400。

> **订阅制的成本显示**：这四个模型都是订阅，单次调用无边际成本，
> UI 显示「订阅」而不是 `$0`（后者容易被误读成数据缺失）。
> token 用量仍然照常记录 —— **配额和限流才是订阅制下真正的约束**。

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

### 两种凭据形态

| Provider | 订阅是否发 API key | 怎么配 |
|---|---|---|
| GLM（z.ai） | ✅ 有 | `auth login ZAI_API_KEY` |
| Kimi | ✅ 有 | `auth login KIMI_API_KEY` |
| **OpenAI** | ❌ **无** | **OAuth**，见下 |
| **Grok（xAI）** | ❌ **无** | **OAuth**，见下 |

### OAuth（OpenAI / Grok 必须）

**先决条件：你必须自己提供 `clientId`。** Nucleus 不内置任何第三方产品的
client_id —— 内置的只有端点模板（公开的协议事实），应用标识借用别人的
等于把本程序声明成对方，配额与审计都记在人家头上。

```json
{
  "oauthProviders": {
    "openai": { "clientId": "<你申请到的 client_id>" },
    "xai": { "clientId": "<你申请到的 client_id>" }
  }
}
```

⚠️ **这一项需要你先搞清楚**（见 [阶段 0.5 H](#h-oauth-clientid必须自己解决)）：
各家是否开放个人注册 OAuth 客户端、走 OAuth 的用量算订阅额度还是 API 计费。

配好后：

```bash
node dist/cli/index.js auth login OPENAI_OAUTH --oauth --provider openai
node dist/cli/index.js auth login XAI_OAUTH --oauth --provider xai
```

流程：启动本地回调服务器（`localhost:1455`，只绑 loopback）→ 打开浏览器授权
→ 回调服务器与手动粘贴**同时等待，先到的赢**。

**远程 SSH 部署时**：浏览器在你本地、服务器收不到回调，这时把重定向后的
完整 URL 粘回终端即可。端口被占也会自动降级到这条路径。

**判据**：`auth list` 里对应 ref 显示 `oauth` 类型和过期时间。

> access token 通常 1 小时过期，运行时会自动刷新。
> xAI 两种 flow 都支持，加 `--method device` 可切到不需要回调端口的那种。

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
node dist/cli/index.js ask "用一句话介绍你自己" --model zai:glm-5.2

# 或用交互式 REPL 连续测几轮
node dist/cli/index.js chat --model zai:glm-5.2
```

**判据**：打印出助手回复，末尾显示 run 数 / token 数 / 成本。

### 7.3 真实编排

```bash
node dist/cli/index.js ask "帮我调研一下 X，要有来源" --model zai:glm-5.2
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

**已脱敏，可直接提交。**

如果工作区有未提交的改动，诊断包会标注出来 —— 一并附上 `git diff` 才能让分析可信：

```bash
git diff > diagnostics/local-changes.patch
```

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
[ ] 阶段 0.5 的清单全部确认（模型参数 / 配额 / 数据库 / 工作目录 / MCP / 网络）
[ ] node -v ≥ 20
[ ] Postgres ≥ 14 可连接（psql 能 select version()）
[ ] npm ci && npm run build 成功
[ ] npm test → 299 passed
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
[ ] 跑几轮后 events | grep contract.rejected → 不是每次都出现
```

任何一项失败：先 `bundle` 导出诊断包保留现场，再决定是自己修还是反馈回来。
自己修的话记得开分支并推回（见[规矩 1](#1-可以改代码但改动必须可见)）。
