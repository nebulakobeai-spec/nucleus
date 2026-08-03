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

/**
 * 记号。
 *
 * 字形不跟着颜色降级 —— 它们是普通字符而非转义序列，重定向到文件时
 * 保留符号比退化成 `[ok]` 更易读，也让管道输出和终端输出长得一样。
 * 颜色由 `c.*` 自己按 TTY 决定，所以这里包一层就够了。
 */
export const ICON = {
  ok: c.green('✓'),
  fail: c.red('✗'),
  warn: c.yellow('!'),
  info: c.blue('·'),
  run: c.cyan('▸'),
  /** 一个步骤的开始 —— 树的节点 */
  step: '⏺',
  /** 步骤下挂的细节 —— 树的枝 */
  branch: '⎿',
  /** 输入提示符 */
  prompt: '❯',
}

export const isTty = useColor

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

/**
 * 单个字符的显示宽度。
 *
 * 输入框的光标定位完全依赖这个 —— 中文按 1 列算，光标就会越写越偏。
 */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!
  // 组合记号不占位
  if (cp >= 0x0300 && cp <= 0x036f) return 0
  return cp >= 0x1100 &&
    (cp <= 0x115f ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff))
    ? 2
    : 1
}

/** 去掉 ANSI 转义后的显示宽度（CJK 按 2 列） */
export function visibleLength(s: string): number {
  let n = 0
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) n += charWidth(ch)
  return n
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * 金额显示。
 *
 * 三种语义必须区分开（DATA-INTEGRITY：不编造数字，也不让真实值被误读）：
 *   有单价且花了钱 → $0.0123
 *   订阅制         → 「订阅」，不是 $0
 *   无单价数据     → N/A，不是 $0
 */
export function money(usd: number | null | undefined, opts: { subscription?: boolean } = {}): string {
  if (opts.subscription) return c.gray('订阅')
  if (usd === null || usd === undefined) return c.gray('N/A')
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(5)}`
  return `$${usd.toFixed(4)}`
}

/**
 * 数据库位置的统一解析。
 *
 * 抽出来是因为**同一个 bug 犯了三次**：某个命令自己写 `dataDir` 时漏掉
 * `NUCLEUS_PGLITE_DIR`，于是它悄悄打开另一个（空的）库，表现成
 * 「明明跑过任务却说没有数据」。三次之后该消掉这一类，而不是这一处。
 */
export function resolveDb(flags: Record<string, string | true>): {
  databaseUrl: string | null
  dataDir: string
} {
  const url = strFlag(flags, 'db') ?? process.env['NUCLEUS_DATABASE_URL'] ?? null
  return {
    databaseUrl: url,
    dataDir: strFlag(flags, 'data') ?? process.env['NUCLEUS_PGLITE_DIR'] ?? '.nucleus-data/pglite',
  }
}

/**
 * 不带值的开关。
 *
 * 必须显式声明：否则 `nucleus ask --mock "问题"` 里的 `--mock` 会把
 * 后面的问题当成自己的值吃掉，命令直接变成「缺少参数」——
 * 而「开关放在前面」恰恰是最自然的写法。
 */
/**
 * **带值的参数**。其余一律当布尔。
 *
 * 原来反过来：维护一份布尔白名单，不在名单里的就吞掉下一个 token 当值。
 * 于是打错一个参数名会静默改变行为 —— 真实踩到的是：
 *
 *     nucleus runs --bundle 49e12302
 *
 * `--bundle` 不是 runs 的参数，但它把 `49e12302` 当成自己的值吃掉了，
 * 于是 runs 收到空 argv，**列出了全部 run 而不是那一个**。看起来像
 * 「这个 run 不见了」，实际是参数解析。
 *
 * 反过来之后，未知参数最多是被忽略（而且会报出来），绝不会吃掉位置参数。
 * 代价是新增带值参数时要记得加进这份名单 —— 有测试守着常用的那些。
 */
const VALUE_FLAGS = new Set([
  'acceptance',
  'agent',
  'args',
  'catch-up-max',
  'compare',
  'config',
  'context',
  'conv',
  'credentials',
  'cron',
  'data',
  'db',
  'describe',
  'dir',
  'goal',
  'limit',
  'log',
  'method',
  'model',
  'n',
  'out',
  'provider',
  'run',
  'scenario',
  'since',
  'timezone',
  'tz',
  'value',
  'keep',
  'turns',
])

/** 已知的布尔参数。只用于「这个名字打错了吗」的判断，不影响解析 */
const KNOWN_BOOLEAN_FLAGS = new Set([
  'mock',
  'stdin',
  'oauth',
  'no-keychain',
  'no-browser',
  'no-transcripts',
  'catch-up',
  'mcp',
  'yes',
  'dry-run',
  'overflow',
  'help',
])

/** 参数名认不认识 —— 认不出的报出来，别让打错的参数静默生效 */
export function unknownFlags(flags: Record<string, string | true>): string[] {
  return Object.keys(flags).filter((k) => !VALUE_FLAGS.has(k) && !KNOWN_BOOLEAN_FLAGS.has(k))
}

/**
 * 取一个带值参数。
 *
 * `--conv` 这类写了名字却没给值时，flags 里存的是布尔 `true`。
 * 直接 `as string` 会让它一路流到 `.slice()` 才炸成
 * 「convId.slice is not a function」—— 错误信息完全指不到参数上。
 * 这里统一把「没给值」归成 undefined，由调用方决定默认值或报错。
 */
/**
 * `--conv` 按前缀解析。
 *
 * 终端打印的是 8 位短 id（`会话 fb8e550c`），而 uuid 列直接拿这个去查会报
 * `invalid input syntax for type uuid` —— **界面给了一个粘不回去的值**。
 * `runs` / `bundle` 早就支持前缀了，这里不支持只是漏了。
 */
export async function resolveConversationId(
  db: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  input: string,
): Promise<{ id: string } | { error: string }> {
  const s = input.trim()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return { id: s }
  if (!/^[0-9a-f]{2,}$/i.test(s)) return { error: `「${s}」不像会话 id` }

  const r = await db.query<{ id: string }>(
    `select id from conversations where id::text like $1 order by updated_at desc limit 5`,
    [`${s}%`],
  )
  if (r.rows.length === 0) return { error: `没有以「${s}」开头的会话` }
  // 前缀撞车要报出来，不能随便挑一个 —— 挑错会把消息追加到别人的会话里
  if (r.rows.length > 1) {
    return { error: `「${s}」匹配到 ${r.rows.length} 个会话：${r.rows.map((x) => x.id.slice(0, 12)).join(', ')}` }
  }
  return { id: r.rows[0]!.id }
}

export function strFlag(
  flags: Record<string, string | true>,
  name: string,
): string | undefined {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

/** 参数解析：--key value / --key=value / --flag */
export function parseArgv(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }

    // --key=value 是无歧义写法，优先
    const eq = a.indexOf('=')
    if (eq > 2) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }

    const key = a.slice(2)
    // 只有声明了带值的参数才吃下一个 token。未知参数一律当布尔 ——
    // 否则打错一个名字就会静默吞掉位置参数
    if (!VALUE_FLAGS.has(key)) {
      flags[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      // 写了名字没给值 —— 存 true，由 strFlag 兜住（见下）
      flags[key] = true
    }
  }
  return { positional, flags }
}
