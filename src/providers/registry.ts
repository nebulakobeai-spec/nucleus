import type { Billing, ModelConfig, WireApi } from './types.js'

/**
 * Provider 与 model 分开。
 *
 * ── 为什么必须分 ──────────────────────────────────────
 *
 * `ModelConfig` 原来把两类东西塞在一起：
 *
 *   provider 的属性：baseUrl / api / apiKeyRef / rpm / tpm / anthropicVersion
 *   model 的属性：  model / contextWindow / maxTokens / 单价
 *
 * 后果一眼可见 —— 同一个模型跑在不同 provider 上是常态：
 *
 *   anthropic  → claude-opus-5
 *   openrouter → moonshotai/kimi-k3
 *   ollama     → kimi-k3
 *
 * 三条都要重复写一遍 baseUrl / api / apiKeyRef。再往 openrouter 上加第二个
 * 模型，又抄一遍。抄漏一处（比如 apiKeyRef）**不会报错**，只会在调用时
 * 401 —— 而那时你会去查凭据，不会想到是配置抄漏了。
 *
 * ── 一个真 bug：限流桶记在模型上 ──────────────────────────
 *
 * `rpm` / `tpm` 是**账号级**的限制，而它们放在 model 上、令牌桶按模型 key 记。
 * 于是同一个 provider 上两个模型各拿一个桶：配了 rpm=60，实际会发到 120，
 * 然后撞 429。分开之后桶按 provider 记，这个问题自然消失。
 *
 * ── 兼容 ─────────────────────────────────────────────
 *
 * 模型上仍然可以写 provider 级的字段，**写了就覆盖** —— 同一个 provider 下
 * 某个模型走不同端点是真实存在的（比如 Kimi 的 coding 端点）。
 * 所以这不是「二选一」，是「默认 + 覆盖」。
 */

export interface ProviderConfig {
  /** 线路协议。默认 openai-completions */
  api?: WireApi
  baseUrl: string
  /** env 变量名；值不进 config、不进 git */
  apiKeyRef?: string
  /** anthropic-messages 专用 */
  anthropicVersion?: string
  /**
   * 每分钟请求数 / token 数上限。
   *
   * **这是账号级的限制**，所以住在 provider 上 —— 同一个 provider 下所有模型
   * 共用一个令牌桶。放在模型上会让 N 个模型各发满 rpm，然后一起撞 429。
   */
  rpm?: number
  tpm?: number
  /** 默认计费方式，模型可覆盖 */
  billing?: Billing
  /** 订阅月费，仅用于展示 */
  subscriptionUsdPerMonth?: number
  /** 单次请求超时；模型可覆盖（本地大模型要几分钟，云端两分钟够） */
  timeoutMs?: number
}

/** 配置里 models 数组的一项 —— provider 级字段可省略，也可覆盖 */
export interface ModelEntry {
  /** 全系统唯一键，形如 `provider:别名`。**只按第一个冒号切分** */
  key: string
  /** 引用 providers 里的哪一个。省略时从 key 的冒号前段取 */
  provider?: string
  /** 发给 provider 的真实模型 id（可能含斜杠，如 moonshotai/kimi-k3） */
  model: string

  contextWindow?: number
  maxTokens?: number
  costPerMTokIn?: number
  costPerMTokOut?: number
  costPerMTokCacheRead?: number
  supportsTools?: boolean

  // ↓ 以下都是 provider 级字段的**覆盖**。写了就用模型上的
  api?: WireApi
  baseUrl?: string
  apiKeyRef?: string
  anthropicVersion?: string
  billing?: Billing
  subscriptionUsdPerMonth?: number
  timeoutMs?: number
  rpm?: number
  tpm?: number
}

export interface ResolveProblem {
  key: string
  message: string
}

/**
 * `providers` + `models` → 运行时用的扁平 `ModelConfig[]`。
 *
 * 扁平结构是**运行时**要的（router 拿到一个模型就该知道往哪发），
 * 分层结构是**配置**要的（别让人抄四遍 baseUrl）。这个函数就是那道边界。
 */
export function resolveModels(
  providers: Record<string, ProviderConfig>,
  models: ModelEntry[],
): { models: ModelConfig[]; problems: ResolveProblem[] } {
  const problems: ResolveProblem[] = []
  const out: ModelConfig[] = []
  const seen = new Set<string>()

  for (const m of models) {
    if (seen.has(m.key)) {
      problems.push({ key: m.key, message: `模型 key 重复` })
      continue
    }
    seen.add(m.key)

    // provider 没写就从 key 的冒号前段取 —— `openrouter:kimi-k3` → openrouter
    const providerId = m.provider ?? m.key.split(':')[0] ?? ''
    const p = providers[providerId]

    // baseUrl 是唯一没有默认值的必需项：不知道往哪发就什么也做不了
    const baseUrl = m.baseUrl ?? p?.baseUrl
    if (!baseUrl) {
      problems.push({
        key: m.key,
        message: p
          ? `provider「${providerId}」没有 baseUrl，模型上也没写`
          : `找不到 provider「${providerId}」（已定义：${Object.keys(providers).join(', ') || '无'}）` +
            ` —— 要么在 providers 里加它，要么在模型上直接写 baseUrl`,
      })
      continue
    }

    const pick = <K extends keyof ProviderConfig & keyof ModelEntry>(k: K) =>
      (m[k] ?? p?.[k]) as ProviderConfig[K] | undefined

    const cfg: ModelConfig = {
      key: m.key,
      provider: providerId,
      model: m.model,
      baseUrl,
    }
    const api = pick('api')
    if (api) cfg.api = api
    const billing = pick('billing')
    if (billing) cfg.billing = billing
    const apiKeyRef = pick('apiKeyRef')
    if (apiKeyRef) cfg.apiKeyRef = apiKeyRef
    const anthropicVersion = pick('anthropicVersion')
    if (anthropicVersion) cfg.anthropicVersion = anthropicVersion
    const timeoutMs = pick('timeoutMs')
    if (timeoutMs !== undefined) cfg.timeoutMs = timeoutMs
    const sub = pick('subscriptionUsdPerMonth')
    if (sub !== undefined) cfg.subscriptionUsdPerMonth = sub
    const rpm = pick('rpm')
    if (rpm !== undefined) cfg.rpm = rpm
    const tpm = pick('tpm')
    if (tpm !== undefined) cfg.tpm = tpm

    for (const k of [
      'contextWindow',
      'maxTokens',
      'costPerMTokIn',
      'costPerMTokOut',
      'costPerMTokCacheRead',
      'supportsTools',
    ] as const) {
      if (m[k] !== undefined) (cfg as unknown as Record<string, unknown>)[k] = m[k]
    }

    out.push(cfg)
  }

  return { models: out, problems }
}

/** 这个 provider 的凭据能怎么来 */
export type AuthOption =
  /** 直接发 API key —— 存进 keychain，配置里只留 ref */
  | 'api-key'
  /**
   * OAuth。**需要你自己申请 clientId** —— Nucleus 不内置任何第三方的
   * client_id（借用别人的等于把本程序声明成对方，配额与审计都记在人家头上）。
   * 端点模板在 `src/auth/providers.ts`。
   */
  | 'oauth'

/**
 * 内置的 provider 端点模板 —— **只有端点与协议，没有 clientId、没有 key**。
 *
 * 名字叫 `MODEL_PROVIDERS` 而不是 `PROVIDER_TEMPLATES`：后者在
 * `src/auth/providers.ts` 里已经被 **OAuth 端点模板**占用了。
 * 同名不同义最容易在几个月后被搞混 —— 那和 tools.js 的 DEFAULT_MAX_OUTPUT
 * 是同一类问题。
 *
 * 不猜 contextWindow：模型版本更新比这份代码快，猜出来的数字会被当成已知事实
 * （见 `providers probe` 与 DATA-INTEGRITY）。
 */
export const MODEL_PROVIDERS: Record<
  string,
  ProviderConfig & {
    note?: string
    modelIdHint?: string
    /**
     * 凭据能怎么来。顺序即推荐顺序。
     *
     * 空数组 = 不需要凭据（ollama）。有 'oauth' 不代表能直接用 ——
     * 还需要你在 `oauthProviders` 里给出 clientId。
     */
    auth: AuthOption[]
    /** 能不能列出可用模型，以及要不要凭据 */
    listModels?: 'ollama-tags' | 'openai-models'
  }
> = {
  ollama: {
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    // 本机服务，不需要凭据 —— 也因此是唯一能在没有 key 时就列出模型的
    auth: [],
    listModels: 'ollama-tags',
    modelIdHint: '本机 `ollama list` 里的名字，形如 kimi-k3、gemma4:31b',
    note: '窗口能从 /api/show 权威读出（但那是训练窗口，实际由 num_ctx 决定）',
  },
  anthropic: {
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyRef: 'ANTHROPIC_API_KEY',
    auth: ['api-key'],
    // Anthropic 的 /v1/models 存在，但走的是 anthropic-messages 那套头部
    listModels: 'openai-models',
    modelIdHint: '形如 claude-opus-5 / claude-sonnet-5',
  },
  openrouter: {
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'OPENROUTER_API_KEY',
    auth: ['api-key'],
    listModels: 'openai-models',
    modelIdHint: '带命名空间，形如 moonshotai/kimi-k3、anthropic/claude-opus-5',
    note: '/models 会返回 context_length —— 窗口能直接问出来，不用你填',
  },
  openai: {
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRef: 'OPENAI_API_KEY',
    // 订阅不发 API key，所以 OAuth 排前面
    auth: ['oauth', 'api-key'],
    listModels: 'openai-models',
    note: '订阅不发 API key，只能走 OAuth；按量付费的 API key 两者都行',
  },
  xai: {
    api: 'openai-completions',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyRef: 'XAI_API_KEY',
    auth: ['oauth', 'api-key'],
    listModels: 'openai-models',
    note: '订阅不发 API key，只能走 OAuth（auth_code 或 device flow）',
  },
  zai: {
    api: 'openai-completions',
    baseUrl: 'https://api.z.ai/v1',
    apiKeyRef: 'ZAI_API_KEY',
    auth: ['api-key'],
    listModels: 'openai-models',
  },
  kimi: {
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyRef: 'KIMI_API_KEY',
    auth: ['api-key'],
    listModels: 'openai-models',
  },
}

/** 兼容旧名。新代码用 MODEL_PROVIDERS */
export const PROVIDER_TEMPLATES = MODEL_PROVIDERS
