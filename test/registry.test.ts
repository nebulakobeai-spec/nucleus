import { describe, expect, it } from 'vitest'
import { PROVIDER_TEMPLATES, resolveModels } from '../src/providers/registry.js'

/**
 * Provider 与 model 分开。
 *
 * ── 为什么必须分 ──────────────────────────────────────
 *
 * 同一个模型跑在不同 provider 上是常态：
 *
 *   anthropic  → claude-opus-5
 *   openrouter → moonshotai/kimi-k3
 *   ollama     → kimi-k3
 *
 * 混在一起就得把 baseUrl / api / apiKeyRef 抄好几遍，而**抄漏一处不会报错** ——
 * 只会在调用时 401。那时人会去查凭据，不会想到是配置抄漏了。
 *
 * 顺带修掉一个真 bug：`rpm`/`tpm` 是**账号级**限制，原来放在 model 上、
 * 令牌桶按模型 key 记 —— 同 provider 两个模型各拿一个桶，配 rpm=60 实际发到
 * 120 然后一起撞 429。
 */

const OPENROUTER = {
  api: 'openai-completions' as const,
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyRef: 'OPENROUTER_API_KEY',
  rpm: 60,
}

describe('resolveModels', () => {
  it('模型从 provider 继承端点、协议、凭据、限流', () => {
    const { models, problems } = resolveModels(
      { openrouter: OPENROUTER },
      [{ key: 'openrouter:kimi-k3', model: 'moonshotai/kimi-k3', contextWindow: 200_000 }],
    )
    expect(problems).toEqual([])
    expect(models[0]).toMatchObject({
      key: 'openrouter:kimi-k3',
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'OPENROUTER_API_KEY',
      rpm: 60,
      contextWindow: 200_000,
    })
  })

  /** provider 不写就从 key 的冒号前段取 —— 少一次重复 */
  it('provider 可以从 key 推出来', () => {
    const { models } = resolveModels({ ollama: { baseUrl: 'http://localhost:11434/v1' } }, [
      { key: 'ollama:kimi-k3', model: 'kimi-k3' },
    ])
    expect(models[0]!.provider).toBe('ollama')
    expect(models[0]!.baseUrl).toBe('http://localhost:11434/v1')
  })

  /**
   * **同一个模型、三个 provider** —— 这就是分开的全部理由。
   * 每条只写自己特有的东西，端点与凭据一份不重复。
   */
  it('同一个模型可以挂在三个 provider 上，各自不重复端点', () => {
    const { models, problems } = resolveModels(
      {
        openrouter: OPENROUTER,
        ollama: { baseUrl: 'http://localhost:11434/v1' },
        moonshot: { baseUrl: 'https://api.moonshot.cn/v1', apiKeyRef: 'KIMI_API_KEY' },
      },
      [
        { key: 'openrouter:kimi-k3', model: 'moonshotai/kimi-k3' },
        { key: 'ollama:kimi-k3', model: 'kimi-k3' },
        { key: 'moonshot:kimi-k3', model: 'kimi-k3' },
      ],
    )
    expect(problems).toEqual([])
    expect(models.map((m) => `${m.provider}→${m.baseUrl}`)).toEqual([
      'openrouter→https://openrouter.ai/api/v1',
      'ollama→http://localhost:11434/v1',
      'moonshot→https://api.moonshot.cn/v1',
    ])
    // 三个 key 不同但真实 model id 可以相同 —— key 是别名
    expect(new Set(models.map((m) => m.model)).size).toBe(2)
  })

  /**
   * 「默认 + 覆盖」而不是「二选一」：同一个 provider 下某个模型走不同端点
   * 是真实存在的（比如 Kimi 的 coding 端点）。
   */
  it('模型上写了就覆盖 provider 的值', () => {
    const { models } = resolveModels({ kimi: { baseUrl: 'https://api.moonshot.cn/v1', rpm: 60 } }, [
      { key: 'kimi:coding', model: 'kimi-k3', baseUrl: 'https://api.moonshot.cn/coding/v1', rpm: 10 },
    ])
    expect(models[0]!.baseUrl).toBe('https://api.moonshot.cn/coding/v1')
    expect(models[0]!.rpm).toBe(10)
  })

  /** 旧写法（没有 providers 段、模型上直接写 baseUrl）必须照旧有效 */
  it('完全不用 providers 段也能跑', () => {
    const { models, problems } = resolveModels({}, [
      { key: 'x:y', model: 'y', baseUrl: 'http://h/v1', apiKeyRef: 'K' },
    ])
    expect(problems).toEqual([])
    expect(models[0]).toMatchObject({ baseUrl: 'http://h/v1', apiKeyRef: 'K' })
  })

  /**
   * 找不到 provider 时报错要**指出两条出路**，而不是只说「找不到」——
   * 「找不到 provider x」看完还得自己想怎么办。
   */
  it('provider 不存在时报错列出已定义的，并给出两条出路', () => {
    const { models, problems } = resolveModels({ a: { baseUrl: 'http://a' } }, [
      { key: 'nope:m', model: 'm' },
    ])
    expect(models).toEqual([])
    expect(problems[0]!.message).toMatch(/找不到 provider「nope」/)
    expect(problems[0]!.message).toMatch(/已定义：a/)
    expect(problems[0]!.message).toMatch(/baseUrl/)
  })

  it('key 重复时报出来，不静默取后一个', () => {
    const { problems } = resolveModels({ a: { baseUrl: 'http://a' } }, [
      { key: 'a:m', model: 'm1' },
      { key: 'a:m', model: 'm2' },
    ])
    expect(problems.some((p) => /重复/.test(p.message))).toBe(true)
  })

  /** key 只按第一个冒号切分 —— openrouter 的 id 里有斜杠但没有冒号，而 ollama 有 */
  it('模型 id 含冒号时 key 仍然解析正确', () => {
    const { models } = resolveModels({ ollama: { baseUrl: 'http://localhost:11434/v1' } }, [
      { key: 'ollama:gemma4:31b', model: 'gemma4:31b' },
    ])
    expect(models[0]!.provider).toBe('ollama')
    expect(models[0]!.model).toBe('gemma4:31b')
  })
})

describe('PROVIDER_TEMPLATES', () => {
  /**
   * 模板里**绝不能有凭据值**。端点与协议是公开的协议事实，
   * 而 apiKeyRef 只是一个环境变量**名字**，不是值。
   */
  it('只有端点、协议、凭据的**引用名**，没有任何值', () => {
    for (const [id, t] of Object.entries(PROVIDER_TEMPLATES)) {
      expect(t.baseUrl, `${id} 没有 baseUrl`).toBeTruthy()
      // 引用名应该长得像环境变量，而不像一个真的 key
      if (t.apiKeyRef) expect(t.apiKeyRef, id).toMatch(/^[A-Z][A-Z0-9_]*$/)
      const json = JSON.stringify(t)
      expect(json, `${id} 里像是有真凭据`).not.toMatch(/sk-|xai-|Bearer /)
    }
  })

  /**
   * **模板里不能带 contextWindow。** 模型更新比这份代码快，
   * 猜出来的数字会被当成已知事实 —— 这条与 DATA-INTEGRITY 一致。
   */
  it('不猜 contextWindow / maxTokens', () => {
    for (const [id, t] of Object.entries(PROVIDER_TEMPLATES)) {
      expect((t as unknown as Record<string, unknown>)['contextWindow'], id).toBeUndefined()
      expect((t as unknown as Record<string, unknown>)['maxTokens'], id).toBeUndefined()
    }
  })

  it('anthropic 用 anthropic-messages 协议，其余默认 openai 兼容', () => {
    expect(PROVIDER_TEMPLATES['anthropic']!.api).toBe('anthropic-messages')
    expect(PROVIDER_TEMPLATES['openrouter']!.api).toBe('openai-completions')
  })

  it('ollama 不需要凭据', () => {
    expect(PROVIDER_TEMPLATES['ollama']!.apiKeyRef).toBeUndefined()
  })
})
