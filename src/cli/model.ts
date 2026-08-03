import { loadConfig } from '../config-file.js'
import { PROVIDER_TEMPLATES, type ProviderConfig } from '../providers/registry.js'
import { probeModel } from '../providers/discover.js'
import { CredentialStore } from '../auth/credentials.js'
import { contextBudgetFor, describeBudget } from '../context/budget.js'
import { c, heading, ICON, line, strFlag, table } from './ui.js'

/**
 * `nucleus model` —— 加模型、看模型、改窗口。
 *
 * ── 为什么 provider 与 model 要分开问 ────────────────────
 *
 * 「加 anthropic 的 opus 5」「加 openrouter 的 kimi K3」「加 ollama 的 kimi K3」
 * —— 后两个是**同一个模型、不同 provider**。混在一起的话每次都要重填
 * baseUrl / api / apiKeyRef，而抄漏一处**不会报错**，只会在调用时 401；
 * 那时你会去查凭据，不会想到是配置抄漏了。
 *
 * 所以流程是两段：先确认 provider（多数情况有内置模板，一句话搞定），
 * 再问模型自己的东西（id、窗口、输出上限、单价）。
 *
 * ── 为什么问窗口而不是猜 ────────────────────────────────
 *
 * 窗口决定压缩何时触发、context 怎么装配，而填错**不会报错**：填小了
 * 1M 窗口的模型在 3% 就开始压缩，填大了请求被拒或者被静默截断。
 * 我这边不可能知道你用的版本 —— 模型更新比任何一份代码的知识都快。
 *
 * 所以：**能问服务就问服务**（ollama 的 `/api/show` 是权威的，
 * openrouter 的 `/models` 会给 context_length），问不出来就**问你**，
 * 绝不填一个猜的数字。
 *
 * ── 为什么不自动写回配置 ────────────────────────────────
 *
 * 配置文件里有大量注释（每个数字为什么是这个值），而 JSON 序列化会把它们
 * 全部丢掉。所以打印一段可以直接粘的片段 —— 这和 `agent new` 不同：
 * 后者是**新建**一个文件，没有既有注释可毁。
 */

interface Draft {
  providerId: string
  provider: ProviderConfig
  /** provider 是内置模板/已存在，还是这次新加的 */
  providerSource: 'existing' | 'template' | 'custom'
  key: string
  model: string
  contextWindow?: number
  maxTokens?: number
  windowSource?: string
}

export async function modelList(
  _argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const { config } = await loadConfig(strFlag(flags, 'config'))

  heading(`模型（${config.models.length}）`)
  table(
    config.models.map((m) => [
      m.key,
      m.provider,
      m.model,
      m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : c.yellow('未填'),
      m.maxTokens ? `${(m.maxTokens / 1000).toFixed(0)}k` : c.gray('—'),
      m.billing === 'subscription' ? '订阅' : m.costPerMTokIn ? `$${m.costPerMTokIn}/M` : c.gray('—'),
    ]),
    ['key', 'provider', '真实 id', '窗口', '输出', '计费'],
  )

  // 窗口没填的会回落到 assumedContextWindow —— 那也是猜的，值得点出来
  const noWindow = config.models.filter((m) => !m.contextWindow && m.provider !== 'mock')
  if (noWindow.length) {
    line()
    line(
      `${ICON.warn} ${noWindow.length} 个模型没填 contextWindow，会回落到 ` +
        `assumedContextWindow=${config.defaults.assumedContextWindow}（那也是猜的）`,
    )
    line(c.gray(`  问出来：nucleus providers probe`))
    line(c.gray(`  或直接填：nucleus model set <key> --context-window <n>`))
  }

  // providers 段的存在感很低但很有用 —— 列一下，顺便说明它能省掉什么
  const providers = config.providers ?? {}
  if (Object.keys(providers).length) {
    line()
    heading('provider')
    table(
      Object.entries(providers).map(([id, p]) => [
        id,
        p.api ?? 'openai-completions',
        p.baseUrl,
        p.apiKeyRef ?? c.gray('（不需要）'),
        p.rpm ? `${p.rpm}/min` : c.gray('—'),
      ]),
      ['id', '协议', 'baseUrl', '凭据 ref', '限流'],
    )
    line(c.gray('模型上省略 baseUrl / api / apiKeyRef 时从这里取；写了就覆盖。'))
    line(c.gray('rpm/tpm 是**账号级**的，所以住在 provider 上 —— 同 provider 的模型共用一个桶。'))
  } else {
    line()
    line(c.gray('还没有 providers 段。模型上各写一份 baseUrl 也能跑，'))
    line(c.gray('但同一个 provider 加第二个模型时就要抄一遍 —— 抄漏不会报错，只会 401。'))
  }
  return 0
}

export async function modelAdd(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const providerId = argv[0]
  const modelId = argv[1] ?? strFlag(flags, 'model')

  if (!providerId || !modelId) {
    printAddUsage()
    return 1
  }

  const { config } = await loadConfig(strFlag(flags, 'config'))
  const existing = config.providers?.[providerId]
  const template = PROVIDER_TEMPLATES[providerId]

  // provider 三种来源，可信度递减：已配置 > 内置模板 > 你自己给
  let provider: ProviderConfig
  let providerSource: Draft['providerSource']
  if (existing) {
    provider = existing
    providerSource = 'existing'
  } else if (template) {
    const { note: _n, modelIdHint: _h, ...rest } = template
    provider = rest
    providerSource = 'template'
  } else {
    const baseUrl = strFlag(flags, 'base-url')
    if (!baseUrl) {
      line(c.red(`不认识 provider「${providerId}」，也没给 --base-url`))
      line()
      line('内置模板：' + Object.keys(PROVIDER_TEMPLATES).join(', '))
      line(c.gray('不在里面的话给出端点即可：'))
      line(c.gray(`  nucleus model add ${providerId} ${modelId} \\`))
      line(c.gray(`    --base-url https://… --key-ref MY_API_KEY --context-window 200000`))
      return 1
    }
    provider = { baseUrl }
    providerSource = 'custom'
  }

  // 命令行给的覆盖一切
  const keyRef = strFlag(flags, 'key-ref')
  if (keyRef) provider = { ...provider, apiKeyRef: keyRef }
  const baseUrlFlag = strFlag(flags, 'base-url')
  if (baseUrlFlag) provider = { ...provider, baseUrl: baseUrlFlag }

  const draft: Draft = {
    providerId,
    provider,
    providerSource,
    // key 是**别名**，可以短；model 才是发上线的真实 id。
    // openrouter 的 moonshotai/kimi-k3 写进 key 会很难看，也不好在链里引用
    key: strFlag(flags, 'as') ?? `${providerId}:${shortName(modelId)}`,
    model: modelId,
  }

  const cw = strFlag(flags, 'context-window')
  if (cw) {
    draft.contextWindow = Number(cw)
    draft.windowSource = '你给的 --context-window'
  }
  const mt = strFlag(flags, 'max-tokens')
  if (mt) draft.maxTokens = Number(mt)

  heading(`加模型 ${c.bold(draft.key)}`)
  line(`  provider  ${providerId} ${c.gray(`（${SOURCE[providerSource]}）`)}`)
  line(`  端点      ${provider.baseUrl}`)
  line(`  协议      ${provider.api ?? 'openai-completions'}`)
  line(`  凭据 ref  ${provider.apiKeyRef ?? c.gray('（不需要）')}`)
  line(`  真实 id   ${draft.model}`)
  if (template?.modelIdHint && !existing) line(c.gray(`            ${template.modelIdHint}`))
  if (template?.note) line(c.gray(`  注意      ${template.note}`))
  line()

  // 窗口还不知道 → 先问服务。问不出来就明说要你填，不猜
  if (!draft.contextWindow && flags['no-probe'] !== true) {
    line(c.gray('正在问服务要窗口大小…'))
    const creds = new CredentialStore()
    const apiKey = provider.apiKeyRef
      ? ((await creds.resolve(provider.apiKeyRef).catch(() => null))?.secret ?? null)
      : null
    const probe = await probeModel(
      { key: draft.key, provider: providerId, model: draft.model, baseUrl: provider.baseUrl, ...(provider.api ? { api: provider.api } : {}) },
      apiKey,
      fetch as never,
    )
    if (probe.contextWindow) {
      draft.contextWindow = probe.contextWindow
      draft.windowSource = probe.source ?? '探测'
      line(`${ICON.ok} 窗口 ${c.bold(String(probe.contextWindow))} ${c.gray(`（${probe.source}）`)}`)
    } else {
      line(`${ICON.warn} 问不出来`)
    }
    for (const note of probe.notes) line(c.gray(`    ${note}`))
    if (probe.error) line(c.gray(`    ${probe.error}`))
    if (probe.maxOutputTokens && !draft.maxTokens) draft.maxTokens = probe.maxOutputTokens
    line()
  }

  if (!draft.contextWindow) {
    // 这里刻意**不给默认值**。给了就等于替你猜，而猜错不会报错
    line(`${ICON.fail} ${c.red('还不知道 contextWindow —— 这一项没法猜')}`)
    line(c.gray('  它决定压缩何时触发、context 怎么装配。填错不会报错：'))
    line(c.gray('  填小了压缩过早触发（1M 窗口的模型在 3% 就开始压），'))
    line(c.gray('  填大了请求被拒，或者更糟 —— 被 provider 静默截断。'))
    line()
    line(`  去 ${providerId} 的文档查一下，然后：`)
    line(c.gray(`    nucleus model add ${providerId} ${modelId} --context-window <数字>`))
    line(c.gray(`  留空也能跑，但会回落到 assumedContextWindow=${config.defaults.assumedContextWindow}（那也是猜的）`))
    return 1
  }

  printSnippet(draft, config.providers ?? {})
  return 0
}

const SOURCE: Record<Draft['providerSource'], string> = {
  existing: '你配置里已有',
  template: '内置模板：只有端点与协议，没有凭据',
  custom: '你给的 --base-url',
}

/** `moonshotai/kimi-k3` → `kimi-k3`；`gemma4:31b` 原样保留 */
function shortName(modelId: string): string {
  const last = modelId.split('/').pop() ?? modelId
  return last
}

function printSnippet(d: Draft, existingProviders: Record<string, ProviderConfig>): void {
  const budget = contextBudgetFor(d.contextWindow!, d.maxTokens ?? 4096)
  line(`${ICON.ok} 这个模型的预算会是：`)
  line(`  ${c.gray(describeBudget(budget))}`)
  line(c.gray(`  压缩会在历史超过 ${Math.floor(budget.maxHistoryTokens * 0.7)} tok 时触发`))
  line()

  heading('粘进 nucleus.config.json')
  // 不自动写：配置里那些注释（每个数字为什么是这个值）会被 JSON 序列化毁掉
  line(c.gray('刻意不自动写 —— 你配置里的注释会被 JSON 序列化全部丢掉。'))
  line()

  if (!existingProviders[d.providerId]) {
    line(c.gray('  // ── providers 段（没有就加上）──'))
    line(`  "providers": {`)
    line(`    ${JSON.stringify(d.providerId)}: ${JSON.stringify(d.provider, null, 6).replace(/\n/g, '\n    ')}`)
    line(`  },`)
    line()
  }

  const entry: Record<string, unknown> = { key: d.key, model: d.model }
  if (d.contextWindow) entry['contextWindow'] = d.contextWindow
  if (d.maxTokens) entry['maxTokens'] = d.maxTokens
  line(c.gray('  // ── models 数组里加一项 ──'))
  if (d.windowSource) line(c.gray(`  // contextWindow 来源：${d.windowSource}`))
  for (const l of JSON.stringify(entry, null, 2).split('\n')) line(`  ${l}`)
  line()
  line(c.gray('provider 从 key 的冒号前段自动取，所以不用再写 baseUrl / api / apiKeyRef。'))
  line(c.gray(`要用它：nucleus ask --model ${d.key} "…"，或写进 defaults.modelChain`))
}

function printAddUsage(): void {
  line(c.red('用法：nucleus model add <provider> <模型 id> [--context-window <n>]'))
  line()
  line('**provider 与模型分开** —— 同一个模型跑在不同 provider 上是常态：')
  line(c.gray('  nucleus model add anthropic  claude-opus-5'))
  line(c.gray('  nucleus model add openrouter moonshotai/kimi-k3'))
  line(c.gray('  nucleus model add ollama     kimi-k3'))
  line()
  line('内置 provider 模板（只有端点与协议，不含任何凭据）：')
  for (const [id, t] of Object.entries(PROVIDER_TEMPLATES)) {
    line(
      `  ${id.padEnd(11)} ${c.gray(t.baseUrl)}` +
        (t.apiKeyRef ? c.gray(` · ${t.apiKeyRef}`) : c.gray(' · 不需要 key')),
    )
  }
  line()
  line('不在列表里的 provider 给出端点即可：')
  line(c.gray('  nucleus model add myhost llama-4 --base-url http://x/v1 --key-ref MY_KEY'))
  line()
  line('可选参数：')
  line(c.gray('  --as <key>            自定义 key（默认 provider:模型短名）'))
  line(c.gray('  --context-window <n>  不给就先问服务，问不出来会让你填'))
  line(c.gray('  --max-tokens <n>      输出上限 —— 它决定给输出留多少余量'))
  line(c.gray('  --no-probe            不问服务，直接用你给的数字'))
}

export async function modelSet(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const key = argv[0]
  if (!key) {
    line(c.red('用法：nucleus model set <key> --context-window <n> [--max-tokens <n>]'))
    return 1
  }
  const { config } = await loadConfig(strFlag(flags, 'config'))
  const m = config.models.find((x) => x.key === key)
  if (!m) {
    line(c.red(`没有模型「${key}」`))
    line(c.gray(`现有：${config.models.map((x) => x.key).join(', ')}`))
    return 1
  }

  const cw = strFlag(flags, 'context-window')
  const mt = strFlag(flags, 'max-tokens')
  if (!cw && !mt) {
    line(c.red('要改什么？--context-window / --max-tokens'))
    return 1
  }

  const window = cw ? Number(cw) : m.contextWindow
  const output = mt ? Number(mt) : m.maxTokens
  heading(`${key} 的预算会变成`)
  if (window) {
    const before = m.contextWindow ? contextBudgetFor(m.contextWindow, m.maxTokens ?? 4096) : null
    const after = contextBudgetFor(window, output ?? 4096)
    if (before) line(c.gray(`  改之前  ${describeBudget(before)}`))
    line(`  改之后  ${describeBudget(after)}`)
    line()
    line(c.gray(`  压缩触发点：${before ? `${Math.floor(before.maxHistoryTokens * 0.7)} → ` : ''}${Math.floor(after.maxHistoryTokens * 0.7)} tok`))
  }
  line()
  line(c.gray('粘进 nucleus.config.json 对应模型里（不自动写 —— 会毁掉你的注释）：'))
  if (cw) line(`  "contextWindow": ${Number(cw)},`)
  if (mt) line(`  "maxTokens": ${Number(mt)},`)
  return 0
}

/** 让 `model` 也能在没有子命令时给出方向 */
export async function modelCmd(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const sub = argv[0]
  const rest = argv.slice(1)
  switch (sub) {
    case 'add':
      return modelAdd(rest, flags)
    case 'set':
      return modelSet(rest, flags)
    case 'list':
    case 'ls':
    case undefined:
      return modelList(rest, flags)
    default:
      line(c.red(`未知子命令 ${sub}`))
      line(c.gray('nucleus model list | add <provider> <id> | set <key> --context-window <n>'))
      return 1
  }
}
