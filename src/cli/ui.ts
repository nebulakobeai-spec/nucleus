/**
 * 终端输出辅助。无依赖，TTY 检测自动降级为无色。
 */
const useColor = process.stdout.isTTY && !process.env['NO_COLOR']

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
}

export const ICON = {
  ok: useColor ? c.green('✓') : '[ok]',
  fail: useColor ? c.red('✗') : '[fail]',
  warn: useColor ? c.yellow('!') : '[warn]',
  info: useColor ? c.blue('·') : '[info]',
  run: useColor ? c.cyan('▸') : '>',
}

export function line(s = ''): void {
  process.stdout.write(s + '\n')
}

export function heading(s: string): void {
  line()
  line(c.bold(s))
  line(c.gray('─'.repeat(Math.min(60, s.length + 20))))
}

/** 状态 → 颜色，全 CLI 一致 */
export function statusColor(status: string): string {
  switch (status) {
    case 'succeeded':
      return c.green(status)
    case 'failed':
    case 'lost':
    case 'timed_out':
      return c.red(status)
    case 'running':
    case 'queued':
    case 'pending':
      return c.cyan(status)
    case 'waiting_children':
    case 'waiting_retry':
    case 'needs_human_confirmation':
      return c.yellow(status)
    default:
      return c.gray(status)
  }
}

/**
 * 恢复性 → 一句人话。
 *
 * DESIGN.md §10：让用户在异常时立刻知道系统会不会自己恢复，
 * 而不是自己从 status 推断。
 */
export function recoveryHint(recovery: string | null): string {
  switch (recovery) {
    case 'automatic':
      return c.cyan('系统会自动重试')
    case 'needs_user':
      return c.yellow('需要你处理')
    case 'terminal':
      return c.gray('不会再变')
    default:
      return ''
  }
}

export function table(rows: string[][], headers?: string[]): void {
  const all = headers ? [headers, ...rows] : rows
  if (all.length === 0) return
  const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => visibleLength(r[i] ?? ''))))
  const fmt = (r: string[]) =>
    r.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - visibleLength(cell)))).join('  ')

  if (headers) {
    line(c.gray(fmt(headers)))
    line(c.gray(widths.map((w) => '─'.repeat(w)).join('  ')))
  }
  for (const r of rows) line(fmt(r))
}

/** 计算去掉 ANSI 转义后的显示宽度（CJK 按 2 列） */
function visibleLength(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '')
  let n = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!
    n += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) ? 2 : 1
  }
  return n
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function money(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(5)}`
  return `$${usd.toFixed(4)}`
}

/** 参数解析：--key value / --flag */
export function parseArgv(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}
