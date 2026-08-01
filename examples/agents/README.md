# 示例专家

**这些不会被自动加载** —— 默认目录是 `agents/`，产品不预设你需要什么专家。

拿一个来用：

```bash
cp examples/agents/analyst.md examples/agents/analyst.cases.md agents/
nucleus agent show analyst      # 看模型实际收到什么
nucleus agent try analyst --n 3 # 跑试题集
```

或整套试一遍：

```bash
NUCLEUS_AGENTS_DIR=examples/agents nucleus agent map
```

四个例子各自压到不同的地方：

| | 压的是什么 |
|---|---|
| `analyst` | 自定义结果段（`metrics[{name,value,asOf,source}]`）+ 元素级必填 |
| `reviewer` | 最小权限 + 内置 research 预设 |
| `librarian` | `write` 权限 → `fs.workdir-boundary` 规则对它生效 |
| `scout` | 声明了 `network` 但本机没有对应工具 —— `agent map` 会如实显示这个权限是空的 |

`whenToUse` 都写成**可判别的条件**，并写清做不到什么。这是编排者选人的唯一依据，
写成名词（「调研」）它就只能猜。
