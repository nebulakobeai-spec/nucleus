/**
 * Token 估算。
 *
 * 可插拔接口；默认实现是启发式，不依赖任何 tokenizer 依赖。
 * 预算判断只需要「够准以避免超窗」，不需要精确 —— 且真实用量由 provider
 * 回填的 usage 为准，这里只用于装配期的预算决策。
 */
export interface Tokenizer {
  count(text: string): number
}

/**
 * 启发式估算：CJK 约 1 token/字，拉丁约 4 字/token。
 *
 * 刻意**高估**而非低估 —— 低估会导致超窗被 provider 拒绝，
 * 高估只是少放一点内容。
 */
export const heuristicTokenizer: Tokenizer = {
  count(text: string): number {
    if (!text) return 0
    let cjk = 0
    for (const ch of text) {
      const c = ch.codePointAt(0)!
      if (
        (c >= 0x4e00 && c <= 0x9fff) || // CJK 统一表意
        (c >= 0x3040 && c <= 0x30ff) || // 假名
        (c >= 0xac00 && c <= 0xd7af) || // 谚文
        (c >= 0x3400 && c <= 0x4dbf)
      ) {
        cjk++
      }
    }
    const rest = text.length - cjk
    return Math.ceil(cjk + rest / 3.5)
  },
}

/** 消息级估算：加上 role / 分隔符的固定开销 */
export function countMessage(t: Tokenizer, m: { role: string; content: string }): number {
  return t.count(m.content) + 4
}
