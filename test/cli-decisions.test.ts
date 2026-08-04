import { describe, expect, it } from 'vitest'
import { stripMeta } from '../src/cli/model.js'
import { manualPolicy } from '../src/cli/conv.js'
import { MODEL_PROVIDERS } from '../src/providers/registry.js'
import { DEFAULT_COMPACT_POLICY } from '../src/context/compact.js'

/**
 * 两个「被人顺手整理掉就静默失效」的判断。
 *
 * 它们都不是排版：一个决定写进你 config 的是什么，一个决定 `conv compact`
 * 到底压不压。而两者出错的症状都是**什么都没发生，也没有报错**。
 */

describe('模板 → 配置：只留配置认识的键', () => {
  /**
   * 模板里带着**只给向导用**的字段（note / modelIdHint / auth / listModels）。
   * 它们不是配置的一部分 —— 写进 `nucleus.config.json` 会变成一堆运行时
   * 不认识的键，而配置校验会因此报错，或者更糟：静默忽略。
   */
  it('向导专用的字段一个都不留', () => {
    for (const [name, tpl] of Object.entries(MODEL_PROVIDERS)) {
      const out = stripMeta(tpl) as unknown as Record<string, unknown>
      for (const k of ['note', 'modelIdHint', 'auth', 'listModels']) {
        expect(out, `${name} 的 ${k} 没被剥掉`).not.toHaveProperty(k)
      }
    }
  })

  it('该留的留下 —— 剥太多的话生成的配置连不上', () => {
    const out = stripMeta(MODEL_PROVIDERS['ollama']!) as unknown as Record<string, unknown>
    expect(out).toHaveProperty('baseUrl')
    expect(out).toHaveProperty('api')
  })

  /**
   * **这是那条安全约束的落点。**
   *
   * 「模板里绝不能有凭据」有测试守着（registry 那边），而 `stripMeta` 是唯一
   * 会把模板内容**复制进用户配置**的地方 —— 将来若有人往模板里加了一个
   * apiKey 字段，这里是它流出去的路径。
   */
  it('剥完之后不含任何像凭据的键', () => {
    for (const [name, tpl] of Object.entries(MODEL_PROVIDERS)) {
      for (const k of Object.keys(stripMeta(tpl))) {
        expect(k, `${name}.${k} 看起来像凭据`).not.toMatch(/^(apiKey|token|secret|password)$/i)
      }
      // apiKeyRef（引用名）是允许的 —— 它不是值
    }
  })
})

describe('conv compact 的语义是「现在压」', () => {
  /**
   * ── 为什么要覆盖默认策略 ────────────────────────────
   *
   * 自动压缩的判据是「历史占了预算的 70%」并且「值得为它调一次模型」。
   * 而手动命令的语义是**我现在就要压** —— 那两个门槛都不该拦着它。
   *
   * 这三项如果被人「顺手统一成 DEFAULT_COMPACT_POLICY」，`conv compact`
   * 会变成一条**什么都不做还说得通**的命令（「历史还不够长，不用压」）——
   * 而那正是这个项目最不该有的那种输出。
   */
  it('触发阈值归零 —— 不管历史多短都压', () => {
    expect(manualPolicy({}).triggerRatio).toBe(0)
    expect(DEFAULT_COMPACT_POLICY.triggerRatio).toBeGreaterThan(0)
  })

  it('「值不值得」的门槛降到 1 tok —— 那个判断该由人做', () => {
    expect(manualPolicy({}).minRetireTokens).toBe(1)
    expect(DEFAULT_COMPACT_POLICY.minRetireTokens).toBeGreaterThan(1)
  })

  /**
   * `--keep N` 是「留 N 条」，所以按 token 比例留的那一档要让位 ——
   * 否则你说留 2 条而它按比例留了 8 条，而且不会告诉你。
   */
  it('给了 --keep 就按条数，不再按 token 比例', () => {
    const p = manualPolicy({ keep: '2' })
    expect(p.keepRecentMin).toBe(2)
    expect(p.keepRecentRatio).toBe(0)
  })

  it('没给 --keep 时沿用默认的比例与下限', () => {
    const p = manualPolicy({})
    expect(p.keepRecentRatio).toBe(DEFAULT_COMPACT_POLICY.keepRecentRatio)
    expect(p.keepRecentMin).toBe(DEFAULT_COMPACT_POLICY.keepRecentMin)
  })
})
