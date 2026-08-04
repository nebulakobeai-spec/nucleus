import { describe, expect, it } from 'vitest'
import { findArrayEnd, insertIntoArray, verifyInsert } from '../src/config/json-edit.js'
import { stripJsonComments } from '../src/config-file.js'

/**
 * 往配置里插一项，**不碰其它任何字节**。
 *
 * ── 为什么不能 JSON.parse → 改 → stringify ──────────────
 *
 * `nucleus.config.json` 里全是注释：「这个数字为什么是这个值」「为什么刻意不填」。
 * JSON 序列化会把它们全部丢掉 —— 而那些注释是配置里最有价值的部分。
 * 所以 `model add` 一直只打印片段让人自己粘。
 *
 * 但「让 agent 帮我配模型」要求真的写进去，于是唯一诚实的做法是外科式插入。
 *
 * **可验证的不变量：插入区之外逐字节不变。** 这一条测试能直接断言，
 * 而「注释还在吗」只能靠人看 —— 前者才是能自动守住的形式。
 */

const CONFIG = `{
  // 模型清单。刻意只有 mock 一个 —— 见 config.ts 的说明
  "models": [
    {
      "key": "mock:local",
      /* 这个 baseUrl 是故意不可达的：mock 不联网 */
      "baseUrl": "http://mock.invalid/v1",
      "note": "路径里有 ] 和 } 的字符串：a[0] {x}"
    }
  ],
  "defaults": {
    // 宁可偏小 —— 假设偏大会直接溢出
    "assumedContextWindow": 32768
  }
}
`

const ITEM = `    {
      "key": "ollama:kimi-k3",
      "provider": "ollama"
    }`

describe('找配对的那个 ]', () => {
  /**
   * **不能用正则。** `"models": [ … ]` 里嵌着对象和字符串，而字符串里可能有 `]`
   * （上面那个 `"a[0] {x}"` 就是）。正则只能找到第一个 `]`，而那大概率是内层的。
   */
  it('跳过字符串里的括号', () => {
    const r = findArrayEnd(CONFIG, 'models')
    expect('close' in r).toBe(true)
    if ('close' in r) {
      expect(CONFIG[r.close]).toBe(']')
      // 那个 `]` 后面紧跟的是 models 的逗号
      expect(CONFIG.slice(r.close, r.close + 2)).toBe('],')
      expect(r.empty).toBe(false)
    }
  })

  it('跳过 // 与 /* *\/ 注释', () => {
    const withComment = `{ "models": [ /* ] 这个不算 */ { "key": "a" } // ] 也不算\n ] }`
    const r = findArrayEnd(withComment, 'models')
    expect('close' in r && withComment.slice(r.close).startsWith(']')).toBe(true)
  })

  it('空数组能认出来 —— 决定要不要补逗号', () => {
    const r = findArrayEnd(`{ "models": [] }`, 'models')
    expect('close' in r && r.empty).toBe(true)
  })

  it('注释与空白不算内容', () => {
    const r = findArrayEnd(`{ "models": [\n  // 还没配\n] }`, 'models')
    expect('close' in r && r.empty).toBe(true)
  })

  it('没有那个键就报错，而不是往别处插', () => {
    expect('error' in findArrayEnd(`{ "agents": [] }`, 'models')).toBe(true)
  })

  it('字符串没闭合时报错，而不是扫到文件末尾乱插', () => {
    expect('error' in findArrayEnd(`{ "models": [ "unterminated ]`, 'models')).toBe(true)
  })

  /** 转义引号：`"a\\"b"` 里那个 `\"` 不是结束 */
  it('认转义引号', () => {
    const t = `{ "models": [ { "note": "he said \\"] }\\" ok" } ] }`
    const r = findArrayEnd(t, 'models')
    expect('close' in r && t.slice(r.close).trim().startsWith(']')).toBe(true)
  })
})

describe('插入区之外逐字节不变', () => {
  /**
   * **这是整个模块的不变量。** 注释、缩进、原有的每个字符都必须原样。
   */
  it('注释与原有内容全部保留', () => {
    const r = insertIntoArray(CONFIG, 'models', ITEM)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // 插入点之前与之后都与原文逐字节相同
    expect(r.text.slice(0, r.at)).toBe(CONFIG.slice(0, r.at))
    expect(r.text.slice(r.at + (r.text.length - CONFIG.length))).toBe(CONFIG.slice(r.at))

    // 那几条注释还在
    expect(r.text).toContain('刻意只有 mock 一个')
    expect(r.text).toContain('mock 不联网')
    expect(r.text).toContain('假设偏大会直接溢出')
  })

  it('插完是合法 JSON，而且新项在数组末尾', () => {
    const r = insertIntoArray(CONFIG, 'models', ITEM)
    if (!r.ok) throw new Error(r.error)
    const parsed = JSON.parse(stripJsonComments(r.text)) as { models: Array<{ key: string }> }
    expect(parsed.models).toHaveLength(2)
    expect(parsed.models[1]!.key).toBe('ollama:kimi-k3')
    // 原有那项没被动
    expect(parsed.models[0]!.key).toBe('mock:local')
  })

  it('空数组时不补前导逗号', () => {
    const r = insertIntoArray(`{\n  "models": []\n}\n`, 'models', ITEM)
    if (!r.ok) throw new Error(r.error)
    expect(r.text).not.toMatch(/\[\s*,/)
    expect(JSON.parse(r.text).models).toHaveLength(1)
  })

  it('非空数组时补逗号', () => {
    const r = insertIntoArray(CONFIG, 'models', ITEM)
    if (!r.ok) throw new Error(r.error)
    expect(r.text).toMatch(/}\s*,\s*\n\s*{/)
  })
})

describe('写盘之前自己验一遍', () => {
  /**
   * 写坏一份配置文件的代价是「下次启动起不来」，而那时人已经不在这段上下文里。
   * 所以宁可不写，也不要留下一份起不来的配置。
   */
  it('正常插入通过校验', () => {
    const r = insertIntoArray(CONFIG, 'models', ITEM)
    if (!r.ok) throw new Error(r.error)
    expect(verifyInsert(CONFIG, r.text, 'models', 'ollama:kimi-k3', stripJsonComments)).toEqual({
      ok: true,
    })
  })

  it('插出来不是合法 JSON → 拦住', () => {
    const broken = CONFIG.replace(']', '{ 坏的 ]')
    const v = verifyInsert(CONFIG, broken, 'models', 'x', stripJsonComments)
    expect(v.ok).toBe(false)
  })

  it('数组没多一项 → 拦住', () => {
    const v = verifyInsert(CONFIG, CONFIG, 'models', 'ollama:kimi-k3', stripJsonComments)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/应该多一项/)
  })

  it('插进去的 key 不对 → 拦住', () => {
    const r = insertIntoArray(CONFIG, 'models', ITEM)
    if (!r.ok) throw new Error(r.error)
    const v = verifyInsert(CONFIG, r.text, 'models', 'expected:other', stripJsonComments)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/不是 expected:other/)
  })
})
