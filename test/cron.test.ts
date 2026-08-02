import { describe, expect, it } from 'vitest'
import {
  CronError,
  describeCron,
  latestPlanned,
  matches,
  nextFireAt,
  parseCron,
  plannedBetween,
  prevFireAt,
  wallClock,
} from '../src/runtime/cron.js'

/**
 * Cron 表达式。
 *
 * 自己解析而不引依赖：需要的只是五段表达式与「某时刻在某时区是否命中」。
 * 但**时区必须靠 Intl** —— 手算偏移在夏令时切换日会漂一小时，
 * 或者在春季被跳过的那一小时上死循环。
 */

const utc = (s: string) => new Date(s)

describe('parseCron', () => {
  it('五段基本形式', () => {
    const f = parseCron('30 8 * * *')
    expect([...f.minute]).toEqual([30])
    expect([...f.hour]).toEqual([8])
    expect(f.dayRestricted).toBe(false)
    expect(f.weekRestricted).toBe(false)
  })

  it('区间、列表、步进', () => {
    expect([...parseCron('0 9-11 * * *').hour]).toEqual([9, 10, 11])
    expect([...parseCron('0 8,12,18 * * *').hour]).toEqual([8, 12, 18])
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45])
    expect([...parseCron('0 9-17/4 * * *').hour]).toEqual([9, 13, 17])
  })

  it('别名', () => {
    expect([...parseCron('@daily').hour]).toEqual([0])
    expect([...parseCron('@hourly').minute]).toEqual([0])
    expect([...parseCron('@weekly').dayOfWeek]).toEqual([0])
  })

  it('段数不对时报错并提示别名', () => {
    expect(() => parseCron('0 8 * *')).toThrow(CronError)
    expect(() => parseCron('0 8 * *')).toThrow(/@daily/)
  })

  it('越界与倒置的区间被拒', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/0-59/)
    expect(() => parseCron('0 25 * * *')).toThrow(/0-23/)
    expect(() => parseCron('0 17-9 * * *')).toThrow(CronError)
    expect(() => parseCron('0 * * * 7')).toThrow(/0-6/)
  })

  it('非法步进被拒', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/正整数/)
    expect(() => parseCron('*/x * * * *')).toThrow(/正整数/)
  })
})

describe('wallClock', () => {
  it('把 UTC 时刻换成目标时区的挂钟', () => {
    // 2026-08-01 12:00 UTC = 20:00 上海
    const w = wallClock(utc('2026-08-01T12:00:00Z'), 'Asia/Shanghai')
    expect(w).toMatchObject({ year: 2026, month: 8, day: 1, hour: 20, minute: 0 })
  })

  it('午夜是 0 点而不是 24 点', () => {
    expect(wallClock(utc('2026-08-01T16:00:00Z'), 'Asia/Shanghai').hour).toBe(0)
  })

  it('星期正确', () => {
    // 2026-08-01 是周六
    expect(wallClock(utc('2026-08-01T12:00:00Z'), 'UTC').dow).toBe(6)
  })
})

describe('nextFireAt', () => {
  it('每天固定时刻', () => {
    const next = nextFireAt('30 8 * * *', 'UTC', utc('2026-08-01T07:00:00Z'))
    expect(next!.toISOString()).toBe('2026-08-01T08:30:00.000Z')
  })

  it('已过今天的点就顺延到明天', () => {
    const next = nextFireAt('30 8 * * *', 'UTC', utc('2026-08-01T09:00:00Z'))
    expect(next!.toISOString()).toBe('2026-08-02T08:30:00.000Z')
  })

  it('不含 after 本身那一分钟 —— 否则会在同一分钟内反复触发', () => {
    const next = nextFireAt('* * * * *', 'UTC', utc('2026-08-01T08:30:00Z'))
    expect(next!.toISOString()).toBe('2026-08-01T08:31:00.000Z')
  })

  it('按时区解释，不是按 UTC', () => {
    // 上海早上 8:30 = 前一天 00:30 UTC
    const next = nextFireAt('30 8 * * *', 'Asia/Shanghai', utc('2026-08-01T00:00:00Z'))
    expect(next!.toISOString()).toBe('2026-08-01T00:30:00.000Z')
    const w = wallClock(next!, 'Asia/Shanghai')
    expect(w.hour).toBe(8)
    expect(w.minute).toBe(30)
  })

  it('夏令时切换日仍然是本地 8:30 —— 手算偏移会漂一小时', () => {
    // 美东 2026-03-08 凌晨 2 点跳到 3 点
    const next = nextFireAt('30 8 * * *', 'America/New_York', utc('2026-03-08T00:00:00Z'))
    const w = wallClock(next!, 'America/New_York')
    expect(w.hour).toBe(8)
    expect(w.minute).toBe(30)
    expect(w.day).toBe(8)
  })

  it('每周一', () => {
    // 2026-08-01 是周六，下一个周一是 08-03
    const next = nextFireAt('0 9 * * 1', 'UTC', utc('2026-08-01T00:00:00Z'))
    expect(next!.toISOString()).toBe('2026-08-03T09:00:00.000Z')
  })

  it('日与周都限定时取**或** —— cron 的传统语义，反直觉但一致', () => {
    // 每月 1 号 或 每周一
    const f = parseCron('0 0 1 * 1')
    // 2026-08-03 周一，不是 1 号 → 命中
    expect(matches(f, wallClock(utc('2026-08-03T00:00:00Z'), 'UTC'))).toBe(true)
    // 2026-09-01 是 1 号（周二）→ 也命中
    expect(matches(f, wallClock(utc('2026-09-01T00:00:00Z'), 'UTC'))).toBe(true)
    // 2026-08-05 周三、不是 1 号 → 不命中
    expect(matches(f, wallClock(utc('2026-08-05T00:00:00Z'), 'UTC'))).toBe(false)
  })

  it('不可能的表达式返回 null 而不是死循环', () => {
    // 2 月 30 号
    expect(nextFireAt('0 0 30 2 *', 'UTC', utc('2026-08-01T00:00:00Z'))).toBeNull()
  })

  it('跨月与跨年', () => {
    expect(nextFireAt('0 0 1 1 *', 'UTC', utc('2026-08-01T00:00:00Z'))!.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    )
  })
})

describe('plannedBetween（停机补偿）', () => {
  it('列出区间内所有**计划**时刻', () => {
    const list = plannedBetween(
      '0 * * * *',
      'UTC',
      utc('2026-08-01T00:00:00Z'),
      utc('2026-08-01T03:00:00Z'),
      10,
    )
    expect(list.map((d) => d.toISOString())).toEqual([
      '2026-08-01T01:00:00.000Z',
      '2026-08-01T02:00:00.000Z',
      '2026-08-01T03:00:00.000Z',
    ])
  })

  it('受 max 约束 —— 关机一个月不该炸出 720 个 run', () => {
    const list = plannedBetween(
      '0 * * * *',
      'UTC',
      utc('2026-07-01T00:00:00Z'),
      utc('2026-08-01T00:00:00Z'),
      3,
    )
    expect(list).toHaveLength(3)
  })

  it('区间内没有计划点就返回空', () => {
    expect(
      plannedBetween('0 0 1 1 *', 'UTC', utc('2026-08-01T00:00:00Z'), utc('2026-08-02T00:00:00Z'), 5),
    ).toEqual([])
  })
})

describe('describeCron', () => {
  /**
   * 这个函数存在的唯一理由是「读一遍确认表达式对不对」。
   * 照字段直译没用 —— 「每小时 *∕15 分」和原表达式一样难读。
   */
  it('每天固定时刻', () => {
    expect(describeCron('30 8 * * *', 'Asia/Shanghai')).toBe('每天 8:30（Asia/Shanghai）')
    expect(describeCron('@daily', 'UTC')).toBe('每天 0:00（UTC）')
  })

  it('间隔型说人话，不直译', () => {
    expect(describeCron('* * * * *', 'UTC')).toBe('每分钟（UTC）')
    expect(describeCron('*/15 * * * *', 'UTC')).toBe('每 15 分钟（UTC）')
    expect(describeCron('0 */6 * * *', 'UTC')).toBe('每 6 小时的第 0 分钟（UTC）')
    expect(describeCron('@hourly', 'UTC')).toBe('每小时第 0 分钟（UTC）')
  })

  it('星期用汉字，不是数字', () => {
    expect(describeCron('0 9 * * 1', 'UTC')).toBe('每周一 9:00（UTC）')
    expect(describeCron('0 9 * * 1,5', 'UTC')).toBe('每周一、周五 9:00（UTC）')
    expect(describeCron('@weekly', 'UTC')).toBe('每周日 0:00（UTC）')
  })

  it('每月与月份', () => {
    expect(describeCron('@monthly', 'UTC')).toBe('每月 1 号 0:00（UTC）')
    expect(describeCron('0 0 1 1 *', 'UTC')).toBe('每月 1 号 + 1 月 0:00（UTC）')
  })

  it('时区永远带上 —— 不然「8 点」是哪个 8 点', () => {
    expect(describeCron('30 8 * * *', 'America/New_York')).toContain('America/New_York')
  })
})

describe('prevFireAt（反向）', () => {
  it('before 之前最近的一次，不含 before 那一分钟', () => {
    expect(prevFireAt('0 * * * *', 'UTC', utc('2026-08-01T03:00:00Z'))!.toISOString()).toBe(
      '2026-08-01T02:00:00.000Z',
    )
  })

  it('跨天回退', () => {
    expect(prevFireAt('30 8 * * *', 'UTC', utc('2026-08-01T07:00:00Z'))!.toISOString()).toBe(
      '2026-07-31T08:30:00.000Z',
    )
  })

  it('按时区回退，夏令时不漂', () => {
    const p = prevFireAt('30 8 * * *', 'America/New_York', utc('2026-03-09T00:00:00Z'))!
    const w = wallClock(p, 'America/New_York')
    expect([w.day, w.hour, w.minute]).toEqual([8, 8, 30])
  })

  it('与 nextFireAt 互逆', () => {
    const n = nextFireAt('*/17 * * * *', 'Asia/Shanghai', utc('2026-08-01T00:00:00Z'))!
    expect(prevFireAt('*/17 * * * *', 'Asia/Shanghai', new Date(n.getTime() + 60_000))!.toISOString()).toBe(
      n.toISOString(),
    )
  })

  it('不可能的表达式返回 null', () => {
    expect(prevFireAt('0 0 30 2 *', 'UTC', utc('2026-08-01T00:00:00Z'))).toBeNull()
  })
})

describe('latestPlanned（补偿取最近的 N 个）', () => {
  /**
   * 这是 plannedBetween 做不到的事：正向生成受 max 卡在前端，
   * 拿到的是最早的 N 个。补跑日报你要昨天那份，不是三天前那份。
   */
  it('取区间末尾的 N 个，不是开头的 N 个', () => {
    const from = utc('2026-08-01T01:00:00Z')
    const to = utc('2026-08-01T06:30:00Z')
    expect(latestPlanned('0 * * * *', 'UTC', from, to, 2).map((d) => d.toISOString())).toEqual([
      '2026-08-01T05:00:00.000Z',
      '2026-08-01T06:00:00.000Z',
    ])
    // 对比：正向生成拿到的是开头两个
    expect(plannedBetween('0 * * * *', 'UTC', from, to, 2).map((d) => d.toISOString())).toEqual([
      '2026-08-01T02:00:00.000Z',
      '2026-08-01T03:00:00.000Z',
    ])
  })

  it('from 含在内 —— 它就是逾期未跑的那个点', () => {
    const from = utc('2026-08-01T05:00:00Z')
    expect(latestPlanned('0 * * * *', 'UTC', from, utc('2026-08-01T06:30:00Z'), 5).map((d) => d.toISOString())).toEqual([
      '2026-08-01T05:00:00.000Z',
      '2026-08-01T06:00:00.000Z',
    ])
  })

  it('迭代次数是 max，与区间长度无关 —— 关机一个月不该生成 720 个点', () => {
    // 一个月的区间，只要 3 个点
    const list = latestPlanned('0 * * * *', 'UTC', utc('2026-07-01T00:00:00Z'), utc('2026-08-01T00:00:00Z'), 3)
    expect(list.map((d) => d.toISOString())).toEqual([
      '2026-07-31T22:00:00.000Z',
      '2026-07-31T23:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ])
  })

  it('区间内没有计划点就返回空', () => {
    expect(latestPlanned('0 0 1 1 *', 'UTC', utc('2026-08-01T00:00:00Z'), utc('2026-08-02T00:00:00Z'), 5)).toEqual([])
  })
})
