import { c } from './ui.js'

/**
 * 按行差异 —— 覆盖别人的文件之前必须能看见改了什么。
 *
 * ── 为什么值得为这个写代码 ────────────────────────────
 *
 * `rule new <已存在的 id> --force` 原先是**直接盖掉**：不给差异、不留备份。
 * 而那个文件很可能被手改过 —— 调过措辞、加过一句注释、把 appliesTo 收窄过。
 * 全部无声消失。
 *
 * 这与我在 `model add` 上用的判断标准是同一条，只是我当时得出了相反的结论：
 * 那里不敢写 JSON 是因为「文件里全是注释，序列化会丢掉」。规则文件第一次
 * 创建时确实没有既有内容可毁 —— 但**第二次就有了**，而我把第一次的结论
 * 用到了第二次。
 *
 * ── 为什么自己写而不是调 diff ──────────────────────────
 *
 * 要 diff 的是两个字符串（内存里的旧文件与将要写的新内容），不是两个文件。
 * 走外部 diff 得先落临时文件，而「为了显示差异而写文件」在一个
 * 「就是不想乱写文件」的功能里说不通。LCS 二十行，纯函数，能单测。
 */

/** 最长公共子序列的长度表 —— 行数很小（规则文件几十行），O(nm) 完全够 */
function lcs(a: string[], b: string[]): number[][] {
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
    }
  }
  return t
}

export type DiffOp = { kind: ' ' | '-' | '+'; text: string }

/**
 * 行级差异。
 *
 * 相同的行也返回（kind `' '`），由调用方决定显示多少上下文 ——
 * 规则文件小，通常全显示；把「显示多少」和「差异是什么」分开，
 * 是因为前者是口味，后者要能测。
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const t = lcs(a, b)
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! })
      i++
      j++
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) {
      out.push({ kind: '-', text: a[i]! })
      i++
    } else {
      out.push({ kind: '+', text: b[j]! })
      j++
    }
  }
  while (i < a.length) out.push({ kind: '-', text: a[i++]! })
  while (j < b.length) out.push({ kind: '+', text: b[j++]! })
  return out
}

/** 只有增删算改动 —— 用来判断「其实什么都没变」 */
export function changed(ops: DiffOp[]): boolean {
  return ops.some((o) => o.kind !== ' ')
}

/** 上色。`-` 红 `+` 绿，未变的灰 —— 与 git 一致，不另创一套 */
export function renderDiff(ops: DiffOp[]): string[] {
  return ops.map((o) => {
    if (o.kind === '-') return c.red(`  - ${o.text}`)
    if (o.kind === '+') return c.green(`  + ${o.text}`)
    return c.gray(`    ${o.text}`)
  })
}
