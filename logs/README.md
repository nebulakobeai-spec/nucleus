# logs/

`nucleus serve` 的运行日志。**这个目录会进 git**（`.gitignore` 里显式放开），
因为它是「另一台机器上出了什么事」唯一的渠道。

## 里面是什么

`serve-YYYY-MM-DD.jsonl` —— 每行一个 JSON，按 UTC 日期切。

| 字段 | 说明 |
|---|---|
| `t` | ISO 时间戳 |
| `kind` | 事件类型（`attempt.started` / `llm.call.finished` / `tool.intent` / …） |
| `run` `attempt` | 对应的 run / attempt id |
| `payload` | 该事件的完整载荷 |

两条特别的：

- `serve.started` —— 启动时的配置快照（worker id、配置路径、模型链、启用的计划）
- `transcripts` —— **run 失败时**才写，包含那次的完整 prompt 与模型回复

为什么只在失败时写 transcript：事件流能回答「发生了什么」，回答不了「模型当时
看到了什么」，而后者往往才是失败的原因（历史被裁掉了、约束块被砍半了）。
但成功的 run 也写会让仓库无限膨胀，而 **git 历史是永久的**。

## 凭据

**写盘前**就过 `redactText`，不是提交前。理由：一旦落到磁盘上就可能被别的东西
带走（编辑器备份、一次手滑的 `git add -A`），而 git 一旦收下就永久留在历史里，
即使后来删掉。

认得出的形态：`sk-*`、`xai-*`、z.ai 的 `hex32.alnum16`、`Bearer *`，以及
「字段名 : 值」（`api_key` / `access_token` / `refresh_token` / `token` /
`secret` / `password` / `authorization`），**引号可以是转义的或单引号** ——
转义那一版是写这个功能时才发现原先漏掉的，而它恰恰是日志里最常见的形态
（一段 JSON 被当字符串写进外层）。

**认不出没见过的格式。** 所以这不是「安全了」，是「已知的那些不会漏」。

## 开源之前必须做的一件事

日志里有你的任务原文、模型输出、工具参数 —— 那些不是凭据，但是你的数据。
**把仓库转成公开之前先自己过一遍这个目录**，或者把它从历史里彻底移除
（`git filter-repo`），因为删文件不会删历史。

## 大小

默认按天切、保留 14 个文件、单日上限 32 MB（`--log-keep-days` / `--log-max-mb`
可调）。到上限时会写一行 `log.capped` 再停写 —— 静默停写会让人以为
「那段时间什么都没发生」，而日志爆掉往往意味着有东西在疯狂重试。

## 怎么看

```bash
# 今天发生了什么
jq -r '"\(.t[11:19])  \(.kind)"' logs/serve-$(date -u +%F).jsonl

# 某个 run 的全过程
jq 'select(.run | startswith("a8f0a251"))' logs/*.jsonl

# 只看失败
jq 'select(.kind == "attempt.failed")' logs/*.jsonl
```

正式的诊断渠道仍然是 `nucleus bundle --run <id>` —— 它多带 git sha、schema
版本、provider 健康、压缩历史，是为「一次往返拿到最多信息」设计的。
这里的日志补的是它的前提：**你得先知道出过事**。
