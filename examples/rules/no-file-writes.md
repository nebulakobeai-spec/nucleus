---
# 纯「边界」的规则：**不需要正文**。
#
# 「不给工具」比任何一句「请不要写文件」都可靠 —— 工具根本不出现在模型看到的
# 定义里，所以无从违反，而且零成本（不占约束块预算）。
#
# denyTools 里的工具名必须真的注册过：拼错不会报错，只会让这条边界形同虚设。
# 内置的有 read_file / write_file / write_report / delegate；
# MCP 工具形如 server__tool，用 server__* 可以整组禁掉。
appliesTo: ['*']
denyTools: [write_file]
---
