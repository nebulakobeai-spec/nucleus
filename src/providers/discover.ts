import type { ModelConfig } from './types.js'
import {
  describeFetchError,
  hintFor,
  systemErrorCode,
  type FetchLike,
} from './openai-compat.js'

/**
 * 自动探测模型的上下文窗口与输出上限。
 *
 * ── 为什么需要 ────────────────────────────────────────
 *
 * 这两个数字决定压缩什么时候触发、context 怎么装配。填错的后果不是报错，
 * 而是**静默的浪费或静默的截断**：填小了，1M 窗口的模型在 3% 就开始压缩；
 * 填大了，请求会被 provider 拒绝，或者更糟 —— 有些实现会静默丢掉超出的部分。
 *
 * 而它们**没法从我这边知道**：模型版本更新比任何一份代码的知识都快。
 * 项目里那句「contextWindow 不知道就留空，宁可不填、不编造数字」就是这个意思。
 * 但「留空」的代价是回落到 assumedContextWindow，那也是猜的。
 *
 * 所以让它去问。三个来源，可靠性递减，**每个结果都带来源**：
 *
 *  1. **ollama `/api/show`** —— 权威。模型元数据里直接写着 context_length
 *  2. **OpenAI 兼容的 `/v1/models`** —— 看运气。OpenRouter 这类会返回
 *     `context_length`，多数只返回 id
 *  3. **溢出探测** —— 故意发一个超长请求，从**provider 自己的报错**里读出上限
 *     （「maximum context length is 200000 tokens」）。不生成任何 token，
 *     所以几乎不花钱，但要靠正则解析错误文本，最不可靠
 *
 * ── 来源必须留在结果里 ─────────────────────────────────
 *
 * 一个探测来的数字与一个你手填的数字，**可信度不同**。溢出探测尤其 ——
 * 它读的是错误文本，provider 换个措辞就失效。所以不能悄悄写进配置装成
 * 「已知事实」，必须标明出处，让人自己决定信不信。
 */

export type WindowSource =
  /** ollama /api/show 的模型元数据 —— 权威 */
  | 'ollama-api-show'
  /** provider 的 /v1/models 返回了 context_length */
  | 'models-endpoint'
  /** 从 provider 拒绝超长请求的报错里推断 */
  | 'inferred-from-error'

export interface ProbeResult {
  key: string
  contextWindow: number | null
  maxOutputTokens: number | null
  source: WindowSource | null
  /** 探测过程里的说明与告警 —— 尤其是「这个数字有什么前提」 */
  notes: string[]
  error: string | null
}

/** ollama 的原生根地址（`/api/*` 不在 `/v1` 下面） */
function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '')
}

function isOllamaish(cfg: ModelConfig): boolean {
  return cfg.provider === 'ollama' || /:11434(\/|$)/.test(cfg.baseUrl)
}

/**
 * ollama：`POST /api/show`。
 *
 * `model_info` 里的键带架构前缀（`llama.context_length` / `gemma3.context_length`），
 * 所以按后缀找而不是按固定键名 —— 换个架构就换个前缀。
 *
 * **一个必须说出来的前提**：这里读到的是**模型训练时的窗口**，不等于
 * ollama 实际会分配的。ollama 按 `num_ctx` 分配（`OLLAMA_CONTEXT_LENGTH`
 * 或每次请求指定），老版本默认只有 4096 —— 那种情况下按训练窗口装配，
 * ollama 会**静默丢掉超出的部分**，两边对不上而且没有任何报错。
 */
export async function probeOllama(
  cfg: ModelConfig,
  fetchImpl: FetchLike,
): Promise<Partial<ProbeResult>> {
  const res = await fetchImpl(`${ollamaRoot(cfg.baseUrl)}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model }),
  })
  if (!res.ok) {
    return { error: `/api/show 返回 ${res.status}` }
  }
  const body = (await res.json()) as {
    model_info?: Record<string, unknown>
    capabilities?: string[]
  }
  const info = body.model_info ?? {}
  const key = Object.keys(info).find((k) => k.endsWith('.context_length'))
  const window = key ? Number(info[key]) : NaN

  const notes: string[] = []
  if (key) notes.push(`读自 model_info["${key}"]`)
  // 这条前提比数字本身更重要
  notes.push(
    'ollama 读到的是**训练窗口**，不等于它实际分配的 —— 实际由 num_ctx 决定' +
      '（OLLAMA_CONTEXT_LENGTH 或每请求指定）。老版本默认 4096，' +
      '那种情况下按训练窗口装配会被静默截断。用 45k 左右的输入实测一次 ' +
      'prompt_eval_count 才能确认。',
  )
  if (body.capabilities && !body.capabilities.includes('tools')) {
    // 没有 function calling 就跑不完一轮 —— 这比窗口重要
    notes.push(
      `⚠ capabilities 里没有 tools（${body.capabilities.join(', ')}）—— ` +
        'Nucleus 靠 submit_result 收尾，没有 function calling 根本跑不完一轮',
    )
  }
  return {
    ...(Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
    source: 'ollama-api-show',
    notes,
  }
}

/**
 * OpenAI 兼容的 `/v1/models`。
 *
 * 规范里**没有**上下文长度这个字段，所以这条是看运气：OpenRouter 之类会给
 * `context_length`，多数厂只返回 id 与 owned_by。返回不了就返回不了，
 * 不要猜 —— 猜出来的数字和没有一样，但会被当成已知事实。
 */
export async function probeModelsEndpoint(
  cfg: ModelConfig,
  apiKey: string | null,
  fetchImpl: FetchLike,
): Promise<Partial<ProbeResult>> {
  const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/models`, {
    method: 'GET',
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  })
  if (!res.ok) return { error: `/models 返回 ${res.status}` }

  const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
  const entry = (body.data ?? []).find((m) => String(m['id']) === cfg.model)
  if (!entry) {
    return { notes: [`/models 里没有 ${cfg.model}（返回了 ${(body.data ?? []).length} 个）`] }
  }

  // 各家字段名不一 —— 按一组已知别名找，找不到就如实说没有
  const WINDOW_KEYS = ['context_length', 'context_window', 'max_context_length', 'max_input_tokens']
  const OUTPUT_KEYS = ['max_output_tokens', 'max_completion_tokens', 'max_tokens']
  const pick = (keys: string[]): number | null => {
    for (const k of keys) {
      const v = Number(entry[k] ?? (entry['top_provider'] as Record<string, unknown>)?.[k])
      if (Number.isFinite(v) && v > 0) return v
    }
    return null
  }
  const window = pick(WINDOW_KEYS)
  const output = pick(OUTPUT_KEYS)
  if (window === null && output === null) {
    return {
      notes: [
        `/models 返回了 ${cfg.model} 但**没有上下文长度字段** ——` +
          ' OpenAI 规范里没有这一项，多数厂不给。可用字段：' +
          Object.keys(entry).slice(0, 8).join(', '),
      ],
    }
  }
  return {
    ...(window !== null ? { contextWindow: window } : {}),
    ...(output !== null ? { maxOutputTokens: output } : {}),
    source: 'models-endpoint',
    notes: [`读自 /models 的 ${WINDOW_KEYS.find((k) => entry[k] !== undefined) ?? '(字段名未知)'}`],
  }
}

/**
 * 从 provider 拒绝超长请求的报错里读上限。
 *
 * 故意发一个远超任何窗口的输入、把输出上限设成 1。请求在**生成之前**就被拒，
 * 所以几乎不花钱（多数厂对被拒的请求不计费，即便计费也只算输入的一小部分）。
 *
 * 但它靠解析错误文本 —— provider 换个措辞就失效。所以来源标成
 * `inferred-from-error`，可信度最低。
 */
export function parseWindowFromError(message: string): number | null {
  const PATTERNS = [
    // OpenAI 系：This model's maximum context length is 128000 tokens
    /maximum context length is (\d[\d,_]*)/i,
    // 一些实现：context length exceeded, max 200000
    /context (?:length|window)[^\d]{0,24}(\d[\d,_]*)/i,
    /max(?:imum)?[_ ]?(?:input|prompt)[_ ]?tokens?[^\d]{0,12}(\d[\d,_]*)/i,
    // 中文错误
    /上下文[^\d]{0,12}(\d[\d,_]*)/,
  ]
  for (const re of PATTERNS) {
    const m = re.exec(message)
    if (!m) continue
    const n = Number(m[1]!.replace(/[,_]/g, ''))
    // 合理性检查：小于 1000 的几乎肯定不是窗口（可能是别的数字碰巧匹配）
    if (Number.isFinite(n) && n >= 1_000) return n
  }
  return null
}

export async function probeByOverflow(
  cfg: ModelConfig,
  apiKey: string | null,
  fetchImpl: FetchLike,
): Promise<Partial<ProbeResult>> {
  // 约 3M token 的输入 —— 超过目前任何模型的窗口
  const huge = 'x'.repeat(12_000_000)
  const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: huge }],
      // 输出设成 1：确保不会真的生成东西
      max_tokens: 1,
    }),
  })

  const text = await res.text()
  if (res.ok) {
    // 竟然没被拒 —— 那说明它静默截断了输入，这本身是要警告的事
    return {
      notes: [
        '⚠ 发了 3M token 的输入却**没有被拒绝** —— 说明这个 provider 会' +
          '**静默截断**超长输入。那意味着 context 溢出不会报错，只会让模型看不到' +
          '前面的内容。窗口只能靠文档或实测确定。',
      ],
    }
  }
  const window = parseWindowFromError(text)
  if (window === null) {
    return { error: `拒绝了超长请求（${res.status}）但报错里读不出窗口：${text.slice(0, 200)}` }
  }
  return {
    contextWindow: window,
    source: 'inferred-from-error',
    notes: [
      `从 provider 的报错里读出：${text.slice(0, 160)}`,
      '⚠ 这是**解析错误文本**得来的，provider 换个措辞就失效 —— 可信度最低，请核对',
    ],
  }
}

/**
 * 按可靠性依次尝试。
 *
 * ollama 走 `/api/show`（权威）；其余先试 `/models`，不给就溢出探测。
 * 每一步的失败都记进 notes —— 「为什么没探到」和探到的数字一样有用。
 */
export async function probeModel(
  cfg: ModelConfig,
  apiKey: string | null,
  fetchImpl: FetchLike,
  opts: { allowOverflow?: boolean } = {},
): Promise<ProbeResult> {
  const out: ProbeResult = {
    key: cfg.key,
    contextWindow: null,
    maxOutputTokens: null,
    source: null,
    notes: [],
    error: null,
  }
  const merge = (p: Partial<ProbeResult>) => {
    if (p.contextWindow) out.contextWindow = p.contextWindow
    if (p.maxOutputTokens) out.maxOutputTokens = p.maxOutputTokens
    if (p.source && out.contextWindow) out.source = p.source
    if (p.notes) out.notes.push(...p.notes)
    if (p.error) out.notes.push(p.error)
  }

  try {
    if (isOllamaish(cfg)) {
      merge(await probeOllama(cfg, fetchImpl))
      return out
    }
    merge(await probeModelsEndpoint(cfg, apiKey, fetchImpl))
    if (out.contextWindow) return out

    if (!opts.allowOverflow) {
      out.notes.push(
        '/models 没给出窗口。溢出探测能问出来（发一个超长请求，从报错里读）——' +
          ' 加 --overflow 启用。它不生成 token，但会真的发一次请求。',
      )
      return out
    }
    merge(await probeByOverflow(cfg, apiKey, fetchImpl))
  } catch (e) {
    /**
     * `fetch failed` 这四个字什么都没说。
     *
     * 项目里已经有 `describeFetchError` / `hintFor` 专门把 ENOTFOUND /
     * ECONNREFUSED / EPERM 翻成人话 —— 不用它就等于又造了一个「正确但指向
     * 错误方向」的报错，那正是这个项目反复在修的毛病。
     */
    const sys = systemErrorCode(e)
    out.error = `${describeFetchError(e)}${sys ? ` —— ${hintFor(sys)}` : ''}`
  }
  return out
}
