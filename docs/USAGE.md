# Nucleus 使用指南

命令参考与日常操作。部署见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)，设计见 [`../DESIGN.md`](../DESIGN.md)。

下文用 `nucleus` 指代 `nucleus`。想直接用短命令：

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

agent 与规则
  agent list                    谁负责什么：领域、模型链、必填字段
  agent show <id>               看模型实际收到的 system prompt 与结果契约
  agent map                     能力边界矩阵：谁能用哪些工具
  agent new <id>                生成专家定义骨架（或 --describe 让模型起草）
  agent try <id> [任务]         只跑这一个专家
  rules                         规则清单 + 遵守率
  rules stats                   只看遵守率
  rules --agent <id>            单个 agent 的规则全貌
  rule add <id> "<要求>"        加一条规则 —— 说一句话，模型判它属于哪一层
  rule edit <id> "<改什么>"     改一条 —— 没提到的原样保留，写之前给差异
  rule rm <id>                  删一条 —— 先说清它在管什么、谁依赖它

模型
  model list                    模型清单：窗口、单价、计费方式
  model config                  配置向导：先选 provider，再选它下面的模型
  model add <key>               直接加一个（脚本用）
  providers probe [provider]    探测可用模型与上下文窗口

会话与压缩
  conv list                     会话列表：消息数与压缩代数
  conv show <id>                摘要内容 + 压缩历史
  conv compact <id>             现在就压一次（--dry-run 只判定）
  conv seed --turns 15          造一段合成历史用来测 compact

常驻与定时
  serve                         常驻进程 —— 定时任务到点执行、重试自己推进
  serve --install               生成 launchd 配置（开机自启）；不自动 load
  schedule list                 定时任务：下次什么时候跑
  schedule add <名称>           加一个：--cron "30 8 * * *" --agent <id>
  schedule history <名称>       上次跑了吗、为什么没跑
  artifacts [run]               产出清单

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
⏺ orchestrator #1
  ⎿ zai:glm-5.2 · 240 tok
  ⎿ delegate ✓ 1ms
  ⎿ 挂起，等 1 个专家 —— 本轮 attempt 到此结束
  ⏺ researcher #1
    ⎿ zai:glm-5.2 · 1.2k tok
    ⎿ 想了 2.4k 字
    ⎿ 产出 reports/主题调研.md 3.1 KB
    ⎿ write_report ✓ 12ms
⏺ orchestrator #2
  ⎿ zai:glm-5.2 · 290 tok

⏺ 助手
  调研完成：专家确认方向可行，关键依据已整理成报告。

(=^ω^=)/ 2 个 run · 1.7k tok · 订阅 · 2.3s
```

| 符号 | 含义 |
|---|---|
| `⏺ agent #N` | 第 N 次 **attempt**（物理尝试）。缩进代表 run 树的层级 |
| `⎿` | 这一层的实际动作 |
| `⎿ <模型> · N tok` | 一次模型调用，报出**真正服务的模型** |
| `⎿ 想了 N 字` | 推理模型的思考量。内容只进事件流，**不进对话历史** |
| `⎿ 结果被退回（第 N 次）` | 模型输出不合契约，缺项已回喂给它重试 |
| `⎿ 挂起，等 N 个专家` | 本轮 attempt 正常结束，不是卡住 |

几件事这里说清楚了：

**`挂起，等 N 个专家` 不是错误。** 编排者委派后当轮就结束了 —— 它不保持
活着、不占进程、不占 context。子任务完成时会被唤醒，起第二次 attempt 来整合。
这也解释了为什么 attempt 编号会跳：一个逻辑 run 可以有多次物理尝试
（被唤醒、重试、恢复）。

**「订阅」不等于 `$0`。** 订阅制模型不产生边际成本，但把它显示成 `$0` 会和
「按量计费但恰好没花钱」混为一谈。没有单价数据时显示 `N/A`，也不写成 `$0`。

**`结果被退回` 是规则遵守情况的直接读数。** 0 次表示模型一次就写对了；
反复出现说明这个模型对当前 schema 的遵守率不行，换模型或简化 schema
比继续加 prompt 有用。想统计的话：

```bash
nucleus events <run-id> | grep contract.rejected | wc -l
```

### 状态行与那只猫

跑的过程中最后一行是活的：

```
(=^･ω･^=)~~ 干活中… write_report · 12.4s · 3.2k tok · Ctrl-C 取消
```

表情跟着状态换 —— `?` 在等模型回话、`~` 在执行工具、`z` 挂起等子任务、
`x` 出错了。这不只是好看：本地模型一次调用可能几十秒，
**「在想」和「已经卡死」看起来必须不一样**，否则只能靠盯着秒表猜。

自动关闭动画的情况：输出不是 TTY（管道、重定向、CI）。手动关：

```bash
NUCLEUS_NO_ANIM=1 nucleus chat
NO_COLOR=1 nucleus chat          # 只去颜色，符号和结构保留
```

关掉动画不影响任何永久输出 —— 上面那棵树照样完整。

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

## agent 与规则

### 看一个 agent 到底是什么样

```bash
nucleus agent list
nucleus agent show researcher
nucleus agent show researcher --mcp    # 把 MCP 提供的工具也算进可见工具
```

`agent show` 打印的是**模型实际收到的东西**，不是配置的复述：

```
模型收到的 system prompt
──────────────────────────────────────────
199 字符 · 9 行 · 逐字节稳定（prompt cache 依赖这一点）
  # 运行时契约
  - 你在一个多 agent 编排系统中执行一次任务。
  - 完成任务必须调用 submit_result；不要用纯文本结束。
  ...
  # researcher
  你是研究专家，负责调研与信息收集。
  结论必须标注来源。
──────────────────────────────────────────

可见工具
  write_report             idempotent 写一份报告并登记为产出

结果契约
能力段   research
必填     findings[].sources
         a[].b 表示每一个元素的 b 都不能为空
```

这些都由**运行时同一条代码路径**算出（`agentSpec` / `buildPrefix` /
`resultJsonSchema`），不是另写一份展示用的拼装逻辑 —— 否则迟早和真实请求
不一致，而这个命令的全部价值就在于可信。

还会报出两件容易踩的事：`toolsAllow` 里有未注册的工具（拼错工具名或 MCP
没连上时，模型只是「看不见」它，不会报错），以及这个 agent 能不能委派、
能派给谁、深度与扇出上限是多少。

### 谁负责什么（编排者的选路依据）

```bash
nucleus agent list
```

```
ID              名称    什么时候派给它                                  模型链
▸ orchestrator  编排者  用户的入口，不作为委派目标                      ollama:gemma4:31b → …
  researcher    研究员  需要调研、查资料、核实事实、给出带来源的结论时  ollama:gemma4:31b → …
  operator      执行者  需要读写文件、整理数据、执行具体操作时          ollama:gemma4:31b → …
```

`whenToUse` 不只是给人看的 —— 它会写进 `delegate` 的**工具描述**：

```
把一件事委派给专家。可选专家：
  - researcher：需要调研、查资料、核实事实、给出带来源的结论时
  - operator：需要读写文件、整理数据、执行具体操作时
```

不写的话编排者只能看到 id 字符串去猜。`researcher` / `operator` 这种英文常用词
还能猜对，加一个 `reviewer` 或两个相近的（`web-researcher` / `data-analyst`）
就会派错。**这是编排质量问题，不只是可视化问题。** 没声明的专家，
`agent list` 会显式警告。

### 所有 agent 的能力边界

```bash
nucleus agent map
```

```
AGENT           delegate  read_file  write_file  write_report
▸ orchestrator  ●         ·          ·           ·
  researcher    ·         ·          ·           ●
  operator      ·         ●          ●           ·

● 可用   · 未授予   ✗ 显式拒绝   ? 声明了但未注册（模型看不到）
```

横过来看才发现得了的事：谁权限过大、哪个工具人人都能用、有没有第二个 agent
也能委派（多一个就多一条成环的路）。这张表就是 **「边界」层的全貌** ——
而边界是唯一不依赖模型配合的一层：工具不出现在模型看到的定义里，它无从违反。

底下会点出两类风险：多个 agent 能委派、以及**谁能执行不可重试的操作**
（按工具**声明的** `side_effect_class` 判断，不按工具名猜 ——
`write_report` 只写数据库，不该被算成改变外部状态）。

### 单个 agent 的规则全貌

```bash
nucleus rules --agent researcher
```

按三层分开列，并且**只列它实际会碰到的**运行时规则：

```
researcher 的规则
负责领域 需要调研、查资料、核实事实、给出带来源的结论时

内置的能力边界
  可用工具 write_report

内置的结果契约（检查）
  findings[].sources

会碰到的运行时规则
  （无 —— 它的工具集触发不到任何一条）
触发不到（缺相应工具）：fs.workdir-boundary, delegate.max-depth, …
```

「触发不到」这一行是有意留的：把全部规则一股脑列出来会让人分不清哪条真的
约束着它。可达性按规则**声明的强制工具**算，不按名字猜。

### 加一个专家 agent

在 `nucleus.config.json` 里加一项。**注意 `agents` 是整体替换而非合并** ——
写了这个数组就得把要用的都列上，漏了入口 agent 会在启动时报错：

```jsonc
{
  "agents": [
    { "id": "orchestrator", "name": "编排者",
      "identity": "你是编排者，用户的唯一入口。\n理解需求 → 拆解 → 委派 → 整合。",
      "toolsAllow": ["delegate"] },
    { "id": "reviewer", "name": "审核员",
      "identity": "你是审核员，检查结论是否有依据。\n没有来源的断言一律标出。",
      "toolsAllow": ["read_file"],
      "capabilities": ["research"],
      "requiredFields": ["findings[].sources"],
      "modelChain": ["kimi:k3"],
      "maxSteps": 8 }
  ]
}
```

改完先看一眼再跑：`nucleus agent show reviewer`。

### 规则有哪几层

```bash
nucleus rules
```

三层有**名字**而不是编号，而且**强的排前面**：

| | 怎么生效 | 代价 |
|---|---|---|
| **边界** | 工具不出现在模型看到的定义里 —— 它无从违反 | **零**。不占任何 token |
| **检查** | 提交的结果不合就退回，规则原文回给它重做 | 一次重写；字段声明进工具 schema，约 55 tok/字段 |
| **提醒** | 只是说一声，模型可能照做也可能不 | **每一轮**都占约束块预算 |

用名字是因为编号记不住哪个是哪个 —— 而且「T1」听起来像「第一层、最基本的」，
而它恰恰是最弱的一层。那个误导正好助长了要修的毛病：人的默认冲动是写一句
prompt 文本。

**两条由校验强制的原则**（不是靠自觉）：

1. **提醒必须配检查或边界。** 只有提醒的规则会被加载器**拒绝** ——
   它会出现在规则清单里、看起来系统在管，实际什么都没管。
   *看起来有约束比没有约束更糟。*
2. **能用边界表达的绝不写成提醒。** 前者零成本且不可违反。

写在 `identity` / `policy` 正文里的软规则不属于这三层 ——
它们无法被运行时验证，也就统计不出遵守率。

### 加一条规则

```bash
nucleus rule add cite-sources "结论必须标明来源"
```

**说一句话就行，模型判它属于哪一层。** 你不需要先想清楚「这是边界还是检查」——
那恰好是模型擅长判的，而你心里想的是一句具体的要求。

它会给你完整的规则内容、分层理由、**每轮的成本**，以及一句机器判不了的话：
「这个检查真的对应你那句要求吗？」—— 形式合法但不相干的检查比没有检查更糟。

不满意就说一句，它照着改（「plan 要是步骤列表，不是一个字符串」），
不用重新想一遍描述。

**复合要求会被拆开。** 一条要求里有一句管不住时，它管住能管的，
把管不住的写进文件的 `uncovered` 并在清单里标成「半」：

```
ID          强制方式     必填字段（检查）
cite        检查         confidence
plan-first  检查 半 (1)  plan[].step

! 1 条只管住了一部分 —— 下面这些分句**没有任何机械强制**，靠模型自觉：
  plan-first
    · 计划写完必须由用户审核后同意后再执行
```

不这样标的话，「管住一半」在清单里和「全管住」长得一模一样。

### 改与删

```bash
nucleus rule edit plan-first "plan 要是步骤列表"
nucleus rule rm plan-first
```

`edit` 会读现有内容、**你没提到的部分原样保留**（手改过的地方不会被冲掉）、
写之前给你看差异。**没有 `--force`** —— 规则只有增加、更新、删除三种操作，
「覆盖」不是其中一种，它只是「更新但先把现有的扔了」。

`rm` 之前会说清三件事：它在管什么、有没有别的规则依赖它声明的字段、
能省多少每轮成本。删规则等于放开约束，而**放开约束不会有任何报错**。

### 模型到底听不听

```bash
nucleus rules stats
nucleus rules --since 7          # 只看最近 7 天
```

```
模型               有契约的 attempt  一次过  被退回  遵守率
────────────────  ────────────────  ──────  ──────  ──────
zai:glm-5.2                     12      11       1   91.7%
ollama:gemma4:31b                8       5       3   62.5%

最常缺的字段
  findings[].sources           4 次
```

几点读法：

- **分母是「有契约要满足的 attempt」，不是所有 attempt。** 委派用的 attempt
  从不提交结果，算进去只会把数字冲淡成无意义。这个判断来自显式的
  `contract.accepted` / `contract.rejected` 事件，不是推断。
- **被退回不等于失败。** 缺项会回喂给模型重写，多数情况下第二次就对了。
  所以「遵守率 62.5%」的含义是「37.5% 的情况需要纠正一轮」，不是「失败」。
- **同一个字段反复缺**，说明这条规则对当前模型太难。换模型或简化契约，
  比继续往 prompt 里加话有用 —— 这也是这个数字存在的意义。
- 报告末尾若提示「N 次装配发生了上下文降级」，要先排除这个：历史被裁掉时
  模型可能是**没看到**要求，而不是不听话。

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
npm test              # 全离线，不需要数据库、不需要网络、不烧 token
npm run test:watch
npm run typecheck
npm run build
```

用 mock provider 快速迭代：

```bash
nucleus ask "..." --mock
```

mock 脚本在 `src/cli/index.ts` 的 `DEMO_SCRIPT` 里，改它可以模拟任意模型行为（包括故意的失败、循环、格式错误）—— 用来验证护栏是否生效，比等真模型犯错快得多。`MockTurn.tools` 可以让一轮返回**多个** tool_call，用来测多专家并发委派。

### 对着真模型验一遍

```bash
npm run test:live                                  # 需要本机 ollama
NUCLEUS_LIVE_FAST_MODEL=llama3.2:latest npm run test:live
NUCLEUS_LIVE_MODEL=gemma4:31b npm run test:live
```

离线测试保证的是「我们解析得对」，保证不了「模型现在还这么答」—— 模型换版本、
ollama 换实现、我们改 prompt 都会让结论失效，而离线测试照样全绿。这一层就是
补这个缺口：真调用、真数据库、真校验器。

跑什么：

| 用例 | 验的是 |
|---|---|
| 思考进 `reasoning` 不混进 `content` | 推理模型的响应被正确拆开 |
| `submit_result` 过我们的校验器 | 真模型对结果契约的遵守情况（含 `findings[].sources`） |
| 预算不足被识别为截断 | `finishReason === 'length'`，而不是误判成「模型不肯调工具」 |
| 完整编排跑到静止 | 委派 → 专家 → wake → 整合，且**没有悬挂状态** |
| 上下文装配用的是配置里的窗口 | `contextWindow` 生效，没有回落到假设值 |

三条设计约束：

- **只断言结构，不断言内容。** 模型每次输出都不同，断言「summary 里要提到 X」
  会变成随机失败。断言的是：调了工具、参数是完整 JSON、校验器跑得完、
  thinking 没混进 content。
- **遵守率是报出来的，不是断言的。** 模型不遵守契约是模型的事实，不是我们的
  bug —— 用例会把结果打进日志（`[live] gemma4:31b 契约遵守：一次通过`），
  硬断言只到「我们能解析」。
- **环境不齐就红，不报绿。** ollama 连不上时输出是「1 failed（说清原因）+
  其余 skipped」。没有真模型却报全绿等于说谎 —— 这一层原本就是空的
  （目录里没有匹配 `*.test.ts` 的文件，命令直接 no test files 退出），
  假绿只是把同一个问题换层皮。

慢的部分刻意用小模型（默认 `deepseek-r1:1.5b`）：本机 31B 一次调用几十秒，
整条编排要几分钟。管线连通性用小模型验，模型能力用 `NUCLEUS_LIVE_MODEL` 单测。

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
