import { redactText } from '../auth/credentials.js'

/**
 * 往 `nucleus.config.json` 的数组里插一项，**不碰其它任何字节**。
 *
 * ── 为什么不能 JSON.parse → 改 → stringify ──────────────
 *
 * 那份配置里全是注释：「这个数字为什么是这个值」「为什么刻意不填」。
 * JSON 序列化会把它们**全部丢掉** —— 而那些注释是配置里最有价值的部分。
 * 所以 `model add` 一直只打印片段让人自己粘。
 *
 * 但「让 agent 帮我配模型」要求真的写进去。于是唯一诚实的做法是
 * **外科式插入**：找到那个数组的 `]`，在它前面插一项，其余一个字节都不动。
 *
 * ── 可验证的不变量 ────────────────────────────────────
 *
 * 插入区之外**逐字节不变**。这一条能被测试直接断言，而
 * 「注释还在吗」只能靠人看 —— 前者才是能自动守住的形式。
 *
 * ── 为什么自己扫括号而不用正则 ──────────────────────────
 *
 * `"models": [ … ]` 里嵌着对象、数组和字符串，而字符串里可能有 `]`
 * （比如 `"description": "a[0]"`）。正则找不到「配对的那个 `]`」——
 * 它只能找到第一个，而那大概率是某个内层数组的。
 */

export interface InsertResult {
  ok: true
  text: string
  /** 插入位置（字节偏移），用于断言其余部分没动 */
  at: number
}
export interface InsertError {
  ok: false
  error: string
}

/**
 * 跳过一个 JSON 字符串（`i` 指向起始引号），返回结束引号之后的位置。
 *
 * 转义要认：`"a\\"b"` 里那个 `\"` 不是结束。漏掉这一条会让扫描在字符串中间
 * 就以为结束了，然后把字符串里的 `]` 当成数组结尾。
 */
function skipString(s: string, i: number): number {
  i++ // 起始引号
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2
      continue
    }
    if (s[i] === '"') return i + 1
    i++
  }
  return -1
}

/** 跳过 `//` 与 `/* *\/` 注释 —— 配置里到处是它们 */
function skipComment(s: string, i: number): number {
  if (s[i] === '/' && s[i + 1] === '/') {
    const nl = s.indexOf('\n', i)
    return nl === -1 ? s.length : nl
  }
  if (s[i] === '/' && s[i + 1] === '*') {
    const end = s.indexOf('*/', i + 2)
    return end === -1 ? s.length : end + 2
  }
  return -1
}

/**
 * 找 `"<key>"` 后面那个数组的配对 `]`。
 *
 * 返回 `]` 的下标，以及数组里有没有内容（决定要不要补逗号）。
 */
export function findArrayEnd(
  text: string,
  key: string,
): { close: number; empty: boolean } | { error: string } {
  const keyRe = new RegExp(`"${key}"\\s*:\\s*\\[`)
  const m = keyRe.exec(text)
  if (!m) return { error: `配置里没有 "${key}" 数组` }

  let i = m.index + m[0].length // 紧跟在 `[` 之后
  const contentStart = i
  let depth = 1

  while (i < text.length) {
    const ch = text[i]!
    const c = skipComment(text, i)
    if (c !== -1) {
      i = c
      continue
    }
    if (ch === '"') {
      const j = skipString(text, i)
      if (j === -1) return { error: '字符串没有结束引号，配置文件可能是坏的' }
      i = j
      continue
    }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) {
        if (ch !== ']') return { error: `"${key}" 的括号不配对` }
        // 数组里有没有实质内容（注释与空白不算）
        const inner = text
          .slice(contentStart, i)
          .replace(/\/\/[^\n]*/g, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim()
        return { close: i, empty: inner.length === 0 }
      }
    }
    i++
  }
  return { error: `"${key}" 数组没有结束` }
}

/**
 * 在数组末尾插一项。
 *
 * `item` 已经是格式化好的 JSON 文本（含缩进），由调用方渲染 ——
 * 这里只负责放进去，不负责决定长什么样。
 */
export function insertIntoArray(text: string, key: string, item: string): InsertResult | InsertError {
  const found = findArrayEnd(text, key)
  if ('error' in found) return { ok: false, error: found.error }

  /**
   * 插入点是 `]` **之前最后一个非空白字符之后** —— 不是紧贴 `]`。
   *
   * 紧贴 `]` 插会把新项塞到收尾缩进的后面，长成
   * `…}\n  , {新项}]`。能解析，但下一次 diff 会难读，而这份文件是要人读的。
   */
  let at = found.close
  while (at > 0 && /\s/.test(text[at - 1]!)) at--

  const sep = found.empty ? '' : ','
  const inserted = `${sep}\n${item}\n  `
  return { ok: true, text: text.slice(0, at) + inserted + text.slice(at), at }
}

/**
 * 改完之后必须能解析回来，而且**只多了预期的那一项**。
 *
 * 写坏一份配置文件的代价是「下次启动起不来」，而那时人已经不在这段上下文里了。
 * 所以写盘之前先自己验一遍：解析、数组长度 +1、新项的 key 对得上。
 */
export function verifyInsert(
  before: string,
  after: string,
  key: string,
  expectKey: string,
  stripComments: (s: string) => string,
): { ok: true } | { ok: false; error: string } {
  let a: Record<string, unknown[]>
  let b: Record<string, unknown[]>
  try {
    a = JSON.parse(stripComments(before)) as Record<string, unknown[]>
  } catch (e) {
    return { ok: false, error: `原配置就解析不了：${(e as Error).message}` }
  }
  try {
    b = JSON.parse(stripComments(after)) as Record<string, unknown[]>
  } catch (e) {
    // 这是这个函数存在的理由：宁可不写，也不要留下一份起不来的配置
    return { ok: false, error: `插入后不是合法 JSON：${redactText((e as Error).message)}` }
  }
  const oldLen = (a[key] ?? []).length
  const newLen = (b[key] ?? []).length
  if (newLen !== oldLen + 1) {
    return { ok: false, error: `${key} 应该多一项（${oldLen} → ${oldLen + 1}），实际是 ${newLen}` }
  }
  const added = (b[key] ?? [])[newLen - 1] as { key?: string } | undefined
  if (added?.key !== expectKey) {
    return { ok: false, error: `插进去的不是 ${expectKey}，而是 ${added?.key ?? '(没有 key)'}` }
  }
  return { ok: true }
}
