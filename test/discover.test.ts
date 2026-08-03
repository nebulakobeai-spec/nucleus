import { describe, expect, it } from 'vitest'
import {
  parseWindowFromError,
  probeModel,
  probeModelsEndpoint,
  probeOllama,
} from '../src/providers/discover.js'
import type { ModelConfig } from '../src/providers/types.js'
import type { FetchLike } from '../src/providers/openai-compat.js'

/**
 * 自动探测模型窗口。
 *
 * ── 为什么这件事值得做 ────────────────────────────────
 *
 * 窗口与输出上限决定压缩何时触发、context 怎么装配。填错**不会报错**：
 * 填小了，1M 窗口的模型在用掉 3% 的时候就开始压缩；填大了请求被拒，
 * 或者更糟 —— 有些实现静默丢掉超出的部分。
 *
 * 而这两个数字没法从代码里知道：模型版本更新比任何一份代码的知识都快。
 * 这套探测就是为了不再靠猜 —— 但**探到的数字必须带来源**，因为一个从错误
 * 文本正则出来的数字和一份官方元数据可信度完全不同。
 */

const ollamaCfg: ModelConfig = {
  key: 'ollama:gemma4:31b',
  provider: 'ollama',
  model: 'gemma4:31b',
  baseUrl: 'http://localhost:11434/v1',
  billing: 'usage',
}

const cloudCfg: ModelConfig = {
  key: 'zai:glm-5.2',
  provider: 'zai',
  model: 'glm-5.2',
  baseUrl: 'https://api.z.ai/v1',
  billing: 'subscription',
}

const json = (body: unknown, status = 200): FetchLike => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('ollama /api/show', () => {
  /** 键带架构前缀，所以按后缀找 —— 换个架构就换个前缀 */
  it('按 *.context_length 后缀找，不写死键名', async () => {
    const r = await probeOllama(
      ollamaCfg,
      json({
        model_info: {
          'general.architecture': 'gemma3',
          'gemma3.context_length': 262144,
          'gemma3.embedding_length': 5376,
        },
        capabilities: ['completion', 'tools'],
      }),
    )
    expect(r.contextWindow).toBe(262_144)
    expect(r.source).toBe('ollama-api-show')
  })

  it('llama 架构同样认得', async () => {
    const r = await probeOllama(
      ollamaCfg,
      json({ model_info: { 'llama.context_length': 131072 }, capabilities: ['tools'] }),
    )
    expect(r.contextWindow).toBe(131_072)
  })

  /**
   * **这条前提比数字本身重要。**
   *
   * /api/show 给的是**训练窗口**，不等于 ollama 实际分配的 —— 实际由 num_ctx
   * 决定，老版本默认 4096。那种情况下按训练窗口装配会被**静默截断**，
   * 两边对不上而且没有任何报错。所以探测结果必须带上这句话。
   */
  it('必须警告「这是训练窗口，不是实际分配的」', async () => {
    const r = await probeOllama(
      ollamaCfg,
      json({ model_info: { 'gemma3.context_length': 262144 }, capabilities: ['tools'] }),
    )
    expect(r.notes!.join('\n')).toMatch(/num_ctx/)
    expect(r.notes!.join('\n')).toMatch(/静默截断/)
  })

  /** 没有 tools 就跑不完一轮 —— 这比窗口重要 */
  it('模型没有 tools 能力时警告', async () => {
    const r = await probeOllama(
      ollamaCfg,
      json({ model_info: { 'x.context_length': 32768 }, capabilities: ['completion'] }),
    )
    expect(r.notes!.some((x) => x.includes('没有 tools'))).toBe(true)
  })

  it('服务返回错误时如实报出，不猜', async () => {
    const r = await probeOllama(ollamaCfg, json({ error: 'model not found' }, 404))
    expect(r.error).toMatch(/404/)
    expect(r.contextWindow).toBeUndefined()
  })

  it('没有 context_length 字段时不编数字', async () => {
    const r = await probeOllama(ollamaCfg, json({ model_info: { 'x.embedding_length': 5376 } }))
    expect(r.contextWindow).toBeUndefined()
  })
})

describe('/v1/models', () => {
  /** OpenRouter 这类会给 context_length */
  it('有 context_length 时读出来', async () => {
    const r = await probeModelsEndpoint(
      cloudCfg,
      'k',
      json({ data: [{ id: 'glm-5.2', context_length: 1_048_576, max_output_tokens: 65536 }] }),
    )
    expect(r.contextWindow).toBe(1_048_576)
    expect(r.maxOutputTokens).toBe(65_536)
    expect(r.source).toBe('models-endpoint')
  })

  it('字段别名都认（context_window / max_input_tokens）', async () => {
    expect(
      (await probeModelsEndpoint(cloudCfg, 'k', json({ data: [{ id: 'glm-5.2', context_window: 200_000 }] })))
        .contextWindow,
    ).toBe(200_000)
    expect(
      (await probeModelsEndpoint(cloudCfg, 'k', json({ data: [{ id: 'glm-5.2', max_input_tokens: 128_000 }] })))
        .contextWindow,
    ).toBe(128_000)
  })

  /**
   * OpenAI 规范里**没有**上下文长度字段，多数厂只返回 id 与 owned_by。
   * 那时必须如实说「没有」—— 猜出来的数字会被当成已知事实。
   */
  it('只有 id 时明说没有这个字段，不猜', async () => {
    const r = await probeModelsEndpoint(
      cloudCfg,
      'k',
      json({ data: [{ id: 'glm-5.2', object: 'model', owned_by: 'zai' }] }),
    )
    expect(r.contextWindow).toBeUndefined()
    expect(r.notes!.join('')).toMatch(/没有上下文长度字段/)
  })

  it('模型不在列表里时说清楚', async () => {
    const r = await probeModelsEndpoint(cloudCfg, 'k', json({ data: [{ id: 'other' }] }))
    expect(r.notes!.join('')).toMatch(/没有 glm-5\.2/)
  })
})

describe('parseWindowFromError', () => {
  it('OpenAI 系的措辞', () => {
    expect(
      parseWindowFromError(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 3000000 tokens.",
      ),
    ).toBe(128_000)
  })

  it('带千分位逗号', () => {
    expect(parseWindowFromError('maximum context length is 1,048,576 tokens')).toBe(1_048_576)
  })

  it('其它措辞与中文', () => {
    expect(parseWindowFromError('context window exceeded: max 200000')).toBe(200_000)
    expect(parseWindowFromError('上下文长度最多 262144 tokens')).toBe(262_144)
  })

  /**
   * 小于 1000 的几乎肯定不是窗口 —— 可能是别的数字碰巧被正则捞到。
   * 宁可返回 null，也不要给一个错的窗口：那会让压缩每轮都触发。
   */
  it('明显不合理的数字不采纳', () => {
    expect(parseWindowFromError('context length is 8 tokens')).toBeNull()
    expect(parseWindowFromError('rate limited, retry after 30s')).toBeNull()
    expect(parseWindowFromError('')).toBeNull()
  })
})

describe('probeModel 的取舍顺序', () => {
  it('ollama 走 /api/show，不去碰 /models', async () => {
    let calledUrl = ''
    const f: FetchLike = async (url) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ model_info: { 'g.context_length': 262144 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const r = await probeModel(ollamaCfg, null, f)
    expect(calledUrl).toMatch(/\/api\/show$/)
    expect(r.contextWindow).toBe(262_144)
  })

  /**
   * 探不到就**如实说探不到**，并给出唯一可靠的下一步：去文档查、自己填。
   *
   * 曾经有个 `--overflow`：故意发 3M token 的输入，从被拒的报错里读上限。
   * 我当时的理由是「生成之前就被拒，几乎不花钱」——**那是假设，不是事实**：
   * 有的厂对被拒的请求照样按输入计费，更糟的是有的厂**接受并截断**，
   * 那就真的处理了 3M token 的输入。已删掉。
   */
  it('/models 没给出窗口时如实说探不到，并给出下一步', async () => {
    const r = await probeModel(cloudCfg, 'k', json({ data: [{ id: 'glm-5.2' }] }))
    expect(r.contextWindow).toBeNull()
    expect(r.notes.join('')).toMatch(/探不到/)
    // 下一步必须是可靠的那条，而不是「再猜一次」
    expect(r.notes.join('')).toMatch(/文档/)
    expect(r.notes.join('')).not.toMatch(/overflow/)
  })

  it('探测抛异常时记进 error，不崩', async () => {
    const boom: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const r = await probeModel(cloudCfg, 'k', boom)
    expect(r.error).toMatch(/ECONNREFUSED/)
  })
})
