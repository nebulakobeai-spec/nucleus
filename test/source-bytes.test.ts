import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 源码里不该有的字节。
 *
 * ── 为什么值得一条测试 ────────────────────────────────
 *
 * 这个仓库已经三次被同一类问题咬到，都是用脚本改文件时写坏的：
 *
 *  1. 5 个替换字符（U+FFFD）—— 其中一个让一次字符串替换**静默失效**，
 *     因为要匹配的那段文本里有个字符已经不是原来那个了
 *  2. 又 2 个，在 CLI 的取消提示和一句注释里 —— 使用者会直接看到
 *  3. 2 个 NUL，在 `validateRules` 的去重 key 里
 *
 * 第 3 个最能说明为什么要自动查：**功能完全正常**（NUL 当分隔符照样能用），
 * `tsc` 不报，测试全绿。露出来是因为 `grep` 开始把那个文件当二进制，
 * 于是搜不到刚写的代码 —— 一个纯靠运气发现的问题。
 *
 * 手动扫一遍不算修好：已经扫过两次，第三次照样出现。
 *
 * ── 这个文件本身的约束 ────────────────────────────────
 *
 * **要找的字符一律用转义写，不许在这里出现字面量** —— 否则这条测试会
 * 因为自己而失败（第一版就是这样）。把待查文件排除掉也不行，那是个洞。
 */

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])
const EXTS = ['.ts', '.json', '.sql', '.md']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXTS.some((e) => p.endsWith(e))) out.push(p)
  }
  return out
}

const FILES = walk('.')

/** 位置要指到行 —— 「某个文件里有个坏字节」等于没说 */
function scan(ch: string): string[] {
  const out: string[] = []
  for (const f of FILES) {
    const lines = readFileSync(f, 'utf8').split('\n')
    const at = lines.flatMap((l, i) => (l.includes(ch) ? [i + 1] : []))
    if (at.length) out.push(`${f}:${at.join(',')}`)
  }
  return out
}

describe('源码里的坏字节', () => {
  it('扫到的文件不是空的 —— 否则这条测试永远是绿的', () => {
    expect(FILES.length).toBeGreaterThan(50)
    expect(FILES).toContain(join('src', 'runtime', 'user-rules.ts'))
  })

  /**
   * NUL。功能上往往无害（当分隔符甚至能用），所以只能靠扫。
   * 代价是 grep / ripgrep 把整个文件当二进制，从此搜不到里面的东西。
   */
  it('没有 NUL', () => {
    expect(scan('\u0000'), 'NUL 会让 grep 把文件当二进制').toEqual([])
  })

  /**
   * 替换字符是**已经丢掉的信息** —— 原来那个字符找不回来了。
   * 最坏的一次是它出现在一段要替换的文本里，于是替换静默失败。
   */
  it('没有替换字符（U+FFFD）', () => {
    expect(scan('\ufffd'), 'U+FFFD 表示那个字符已经丢了，找不回来').toEqual([])
  })

  /**
   * 零宽字符。粘贴时最容易带进来，而且**完全看不见** ——
   * 落在标识符里就是「这两个名字明明一样，为什么对不上」。
   */
  it('没有零宽字符', () => {
    const bad = ['\u200b', '\u200c', '\u200d', '\ufeff'].flatMap((ch) =>
      scan(ch).map((x) => `${x} (U+${ch.codePointAt(0)!.toString(16)})`),
    )
    expect(bad).toEqual([])
  })
})
