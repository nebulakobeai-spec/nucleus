---
gist: 金融数据需包含 source 和 timestamp
appliesTo: ['*']
requiredFields: [financial_metrics[].source, financial_metrics[].timestamp]
resultFields:
  financial_metrics:
    type: object[]
    fields:
      source: string
      timestamp: string
      value: string
---

凡是涉及金融数据的输出，必须明确标注其具体来源以及数据抓取或获取的确切时间。请将这类数据放入 `financial_metrics` 字段中。
