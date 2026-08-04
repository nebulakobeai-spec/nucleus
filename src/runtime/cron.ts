/**
 * Cron 表达式与下次触发时刻。
 *
 * 不引依赖：需要的只是五段表达式与「某时刻在某时区是否命中」。
 *
 * **时区靠 `Intl` 而不是自己算偏移。** 夏令时是硬伤 —— 手算偏移的话，
 * 「每天早上 8 点」在切换日会漂一小时，或者在不存在的本地时刻（春季跳过的
 * 那一小时）上无限循环。`Intl` 用的是系统 tz 数据库，切换规则由它负责。
 *
 * 支持：`*`、数字、`a-b`、`a,b,c`、`* /n`（步进），以及几个常用别名。
 * 不支持月份/星期的英文名与 `L`/`#`/`?` 这类扩展 —— 用不到就不做，
 * 语法越小越不容易在边界上出错。
 */

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  /** 日与周是否都被限定 —— 影响匹配语义，见 matches() */
  dayRestricted: boolean
  weekRestricted: boolean
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const RANGES: Record<keyof Omit<CronFields, 'dayRestricted' | 'weekRestricted'>, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
}

export class CronError extends Error {}

function parseField(spec: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`${name} 的步进「${stepPart}」不是正整数`)
    }

    let start = lo
    let end = hi
    if (rangePart !== '*') {
      const bounds = rangePart!.split('-')
      if (bounds.length > 2) throw new CronError(`${name} 的区间「${rangePart}」格式不对`)
      start = Number(bounds[0])
      end = bounds.length === 2 ? Number(bounds[1]) : start
      // 只有 `*` 与 `a-b` 能带步进；`5/10` 语义含糊，明确拒绝
      if (bounds.length === 1 && stepPart !== undefined) end = hi
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new CronError(`${name} 的「${rangePart}」不是数字`)
      }
      if (start < lo || end > hi || start > end) {
        throw new CronError(`${name} 的「${rangePart}」超出 ${lo}-${hi}`)
      }
    }
    for (let v = start; v <= end; v += step) out.add(v)
  }
  if (out.size === 0) throw new CronError(`${name} 解析出空集合：${spec}`)
  return out
}

export function parseCron(expr: string): CronFields {
  const normalized = ALIASES[expr.trim().toLowerCase()] ?? expr.trim()
  const parts = normalized.split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError(
      `需要 5 段（分 时 日 月 周），收到 ${parts.length} 段：${expr}` +
        `（也可以用 ${Object.keys(ALIASES).join(' / ')}）`,
    )
  }
  const [mi, h, dom, mo, dow] = parts
  return {
    minute: parseField(mi!, RANGES.minute, '分'),
    hour: parseField(h!, RANGES.hour, '时'),
    dayOfMonth: parseField(dom!, RANGES.dayOfMonth, '日'),
    month: parseField(mo!, RANGES.month, '月'),
    dayOfWeek: parseField(dow!, RANGES.dayOfWeek, '周'),
    dayRestricted: dom !== '*',
    weekRestricted: dow !== '*',
  }
}

/** 某个 UTC 时刻在指定时区的挂钟字段 */
export function wallClock(
  at: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    // 24 小时制下午夜可能是 "24"
    hour: Number(parts['hour']) % 24,
    minute: Number(parts['minute']),
    dow: DOW[(parts['weekday'] ?? 'Sun') as keyof typeof DOW],
  }
}

/**
 * 是否命中。
 *
 * 日与周的组合遵循 cron 的传统语义：**两者都被限定时取「或」**。
 * 也就是 `0 0 1 * 1` 是「每月 1 号**或**每周一」，不是「1 号且是周一」。
 * 这条反直觉，但所有 cron 实现都这样，改掉会让人写出预期外的表达式。
 */
export function matches(fields: CronFields, w: ReturnType<typeof wallClock>): boolean {
  if (!fields.minute.has(w.minute)) return false
  if (!fields.hour.has(w.hour)) return false
  if (!fields.month.has(w.month)) return false

  const dayHit = fields.dayOfMonth.has(w.day)
  const weekHit = fields.dayOfWeek.has(w.dow)
  if (fields.dayRestricted && fields.weekRestricted) return dayHit || weekHit
  if (fields.dayRestricted) return dayHit
  if (fields.weekRestricted) return weekHit
  return true
}

const MINUTE = 60_000

/**
 * `after` 之后的下一次触发时刻（不含 after 本身那一分钟）。
 *
 * 实现是逐分钟试，但先按天粗筛 —— 日/月/周不匹配时整天跳过。
 * 上限一年：不可能的表达式（比如 2 月 30 号）必须返回 null 而不是死循环。
 */
export function nextFireAt(expr: string, timeZone: string, after: Date): Date | null {
  const fields = parseCron(expr)
  // 对齐到下一分钟整
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE
  const limit = after.getTime() + 366 * 24 * 60 * MINUTE

  while (t <= limit) {
    const w = wallClock(new Date(t), timeZone)

    // 整天粗筛：这一天根本不可能命中就跳过剩下的分钟
    const dayHit = fields.dayOfMonth.has(w.day)
    const weekHit = fields.dayOfWeek.has(w.dow)
    const dayOk =
      fields.month.has(w.month) &&
      (fields.dayRestricted && fields.weekRestricted
        ? dayHit || weekHit
        : fields.dayRestricted
          ? dayHit
          : fields.weekRestricted
            ? weekHit
            : true)
    if (!dayOk) {
      // 跳到本地时间的次日零点附近。多跳一点没关系，下一轮会重新判
      t += (24 - w.hour) * 60 * MINUTE - w.minute * MINUTE
      continue
    }
    if (!fields.hour.has(w.hour)) {
      t += (60 - w.minute) * MINUTE
      continue
    }
    if (fields.minute.has(w.minute)) return new Date(t)
    t += MINUTE
  }
  return null
}

/**
 * 补偿：列出 `from`（不含）到 `to`（含）之间所有**计划**触发时刻。
 *
 * 用计划时刻而不是实际时刻，是为了让幂等键稳定：同一个计划点无论什么时候
 * 被补跑，键都一样，所以 reconciler 重放不会重复触发外部副作用。
 */

/**
 * `before` 之前（不含 before 那一分钟）最近的一次触发时刻。
 *
 * 为什么需要反向：补偿要的是**最近的 N 次**，不是最早的 N 次 ——
 * 补跑日报你要昨天那份，不是三天前那份。正向生成再截尾的话，
 * 上限会卡在前端（生成 [1点,2点,3点] 然后取后两个 = 2点3点，
 * 而真正想要的是 5点6点）；要拿到后端就得把整个区间都生成出来，
 * 关机一个月的每分钟任务是 4 万个点。反向走，迭代次数恰好等于 N。
 */
export function prevFireAt(expr: string, timeZone: string, before: Date): Date | null {
  const fields = parseCron(expr)
  let t = Math.ceil(before.getTime() / MINUTE) * MINUTE - MINUTE
  const limit = before.getTime() - 366 * 24 * 60 * MINUTE

  while (t >= limit) {
    const w = wallClock(new Date(t), timeZone)
    const dayHit = fields.dayOfMonth.has(w.day)
    const weekHit = fields.dayOfWeek.has(w.dow)
    const dayOk =
      fields.month.has(w.month) &&
      (fields.dayRestricted && fields.weekRestricted
        ? dayHit || weekHit
        : fields.dayRestricted
          ? dayHit
          : fields.weekRestricted
            ? weekHit
            : true)
    if (!dayOk) {
      // 退到本地时间的前一天 23:59 附近。多退一点没关系，下一轮重新判
      t -= (w.hour * 60 + w.minute + 1) * MINUTE
      continue
    }
    if (!fields.hour.has(w.hour)) {
      t -= (w.minute + 1) * MINUTE
      continue
    }
    if (fields.minute.has(w.minute)) return new Date(t)
    t -= MINUTE
  }
  return null
}

/**
 * `[from, to]` 里**最近的** `max` 个计划点，按时间升序。
 *
 * `from` 含在内（它就是逾期未跑的那个点），`to` 也含在内。
 */
export function latestPlanned(
  expr: string,
  timeZone: string,
  from: Date,
  to: Date,
  max: number,
): Date[] {
  const out: Date[] = []
  // +1 分钟让 to 本身也算候选
  let cursor = new Date(to.getTime() + MINUTE)
  for (let i = 0; i < max; i++) {
    const p = prevFireAt(expr, timeZone, cursor)
    if (!p || p.getTime() < from.getTime()) break
    out.unshift(p)
    cursor = p
  }
  return out
}

/**
 * 给人看的一句话。
 *
 * 存在的唯一理由是「读一遍确认表达式对不对」，所以照字段直译没用 ——
 * 「每小时 *∕15 分」和原表达式一样难读。常见形状单独说人话。
 */
export function describeCron(expr: string, timeZone: string): string {
  const normalized = ALIASES[expr.trim().toLowerCase()] ?? expr.trim()
  const [mi, h, dom, mo, dow] = normalized.split(/\s+/) as [string, string, string, string, string]
  const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const tzSuffix = `（${timeZone}）`

  if (mi === '*' && h === '*' && dom === '*' && mo === '*' && dow === '*') {
    return `每分钟${tzSuffix}`
  }

  // 间隔型：每 n 分钟 / 每 n 小时。这两个最常用，也最容易直译成天书
  const miStep = /^\*\/(\d+)$/.exec(mi)
  if (miStep && h === '*' && dom === '*' && mo === '*' && dow === '*') {
    return `每 ${miStep[1]} 分钟${tzSuffix}`
  }
  const hStep = /^\*\/(\d+)$/.exec(h)
  if (hStep && /^\d+$/.test(mi) && dom === '*' && mo === '*' && dow === '*') {
    return `每 ${hStep[1]} 小时的第 ${mi} 分钟${tzSuffix}`
  }
  if (h === '*' && /^\d+$/.test(mi) && dom === '*' && mo === '*' && dow === '*') {
    return `每小时第 ${mi} 分钟${tzSuffix}`
  }

  const time = /^\d+$/.test(h) && /^\d+$/.test(mi) ? `${h}:${mi.padStart(2, '0')}` : null

  // 周期型：每周 / 每月 / 每天
  const when: string[] = []
  if (dow !== '*') {
    const days = dow
      .split(',')
      .map((d) => (/^\d$/.test(d) ? (DOW_CN[Number(d)] ?? `周${d}`) : `周${d}`))
    when.push(`每${days.join('、')}`)
  }
  if (dom !== '*') when.push(`每月 ${dom} 号`)
  if (mo !== '*') when.push(`${mo} 月`)
  if (when.length === 0) when.push('每天')

  return `${when.join(' + ')} ${time ?? `${h} 点 ${mi} 分`}${tzSuffix}`
}
