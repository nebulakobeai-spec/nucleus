---
# **提醒 + 检查**：正文是给模型的提示，requiredFields 才是强制手段。
#
# appliesTo 里的 agent 必须真的存在 —— 拼错会在加载时报错，不会静默失效。
# 想只对某几个专家生效就把 '*' 换成它们的 id。
appliesTo: ['*']
requiredFields: [findings[].sources]
---

每条 finding 至少给一个可验证的来源。查不到来源的结论宁可不写，
或者写进 open_questions 说明「没找到可验证的依据」。
