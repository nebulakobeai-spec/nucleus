import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { ScheduleStore, idempotencyKey } from '../src/store/schedules.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 定时任务。
 *
 * 这一组盯的是「时间相关的东西为什么总在生产上才炸」那几类：
 *  - 逾期任务会不会一次补一堆（笔记本合盖一晚上，醒来跑 8 次）
 *  - 同一个计划点会不会被触发两次（幂等键用**计划**时刻的理由）
 *  - 上次还没跑完时这次怎么办（重入 = 跳过 + 留痕）
 *  - 没跑的那次能不能事后查到（被跳过的触发没有 run，没有记账表就毫无痕迹）
 */

const SCRIPT: MockScript = {
  researcher: [{ submit: { status: 'ok', summary: '定时任务完成。', findings: [{ claim: 'x', sources: ['s'] }], artifacts: [] } }],
  orchestrator: [{ submit: { status: 'ok', summary: '完成。', artifacts: [] } }],
}

function config(): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  return c
}

let n: Nucleus
let clock: FakeClock
let store: ScheduleStore

// 2026-01-01T00:00:00Z 是 FakeClock 的默认起点
const T0 = Date.parse('2026-01-01T00:00:00.000Z')

beforeEach(async () => {
  clock = new FakeClock()
  n = await boot({
    config: config(),
    deps: { clock, ids: new FakeIds() },
    mock: SCRIPT,
  })
  store = new ScheduleStore(n.db, { clock, ids: new FakeIds() })
})

afterEach(async () => {
  await n.close()
  n = null as unknown as Nucleus
})

const at = (iso: string) => new Date(iso)

describe('创建', () => {
  it('创建时就算出 next_fire_at', async () => {
    const s = await store.create({
      name: 'daily',
      cron: '30 8 * * *',
      timezone: 'UTC',
      agentId: 'researcher',
      goal: '每天早上看一眼',
    })
    expect(s.nextFireAt!.toISOString()).toBe('2026-01-01T08:30:00.000Z')
    expect(s.enabled).toBe(true)
    // 默认不补偿 —— 错过就错过
    expect(s.catchUp).toBe(false)
  })

  it('坏表达式在**创建时**就被拒，不是等到触发', async () => {
    await expect(
      store.create({ name: 'bad', cron: '0 99 * * *', agentId: 'researcher', goal: 'x' }),
    ).rejects.toThrow(/0-23/)
  })

  it('坏时区在创建时就被拒', async () => {
    await expect(
      store.create({ name: 'bad', cron: '@daily', timezone: 'Mars/Olympus', agentId: 'researcher', goal: 'x' }),
    ).rejects.toThrow(/未知时区/)
  })

  it('永不触发的表达式被拒 —— 建了也白建', async () => {
    await expect(
      store.create({ name: 'never', cron: '0 0 30 2 *', agentId: 'researcher', goal: 'x' }),
    ).rejects.toThrow(/永不触发/)
  })

  it('重名被拒', async () => {
    await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    await expect(
      store.create({ name: 'daily', cron: '@hourly', agentId: 'researcher', goal: 'y' }),
    ).rejects.toThrow()
  })
})

describe('触发', () => {
  it('到点建一个新会话与一个 run，并入队', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: '看一眼' })
    const results = await store.fire(s, at('2026-01-02T00:00:00.000Z'))

    expect(results).toHaveLength(1)
    expect(results[0]!.runId).toBeTruthy()
    expect(results[0]!.skipped).toBeNull()

    const run = await n.runs.getRun(results[0]!.runId!)
    expect(run!.agentId).toBe('researcher')
    expect(run!.status).toBe('pending')
    // 来源可回溯
    expect(run!.scheduleId).toBe(s.id)
    // 幂等键用**计划**时刻
    expect(run!.idempotencyKey).toBe(idempotencyKey(s.id, at('2026-01-02T00:00:00.000Z')))
  })

  it('每次都是新会话，不复用 —— 每次运行是独立的一件工作', async () => {
    const s = await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    const a = await store.fire(s, at('2026-01-01T01:00:00.000Z'))
    // 先跑完 —— 否则命中的是重入跳过，那是另一条测试的事
    await n.worker.drain(30)
    const s2 = (await store.byName('h'))!
    const b = await store.fire(s2, at('2026-01-01T02:00:00.000Z'))

    expect(a[0]!.conversationId).toBeTruthy()
    expect(b[0]!.conversationId).toBeTruthy()
    expect(a[0]!.conversationId).not.toBe(b[0]!.conversationId)
  })

  it('信封里写明「没有人在线」—— 否则它会留一句「需要你确认」然后没人看', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: '看一眼' })
    const r = await store.fire(s, at('2026-01-02T00:00:00.000Z'))
    const run = await n.runs.getRun(r[0]!.runId!)
    const input = run!.input as { context: string }
    expect(input.context).toMatch(/没有人在线/)
    expect(input.context).toMatch(/open_questions/)
  })

  it('触发后 next_fire_at 前进', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    // 创建于 T0=01-01T00:00，所以 due 是次日 —— 在 due 那一刻触发
    expect(s.nextFireAt!.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    await store.fire(s, at('2026-01-02T00:00:00.000Z'))
    const after = (await store.byName('daily'))!
    expect(after.nextFireAt!.toISOString()).toBe('2026-01-03T00:00:00.000Z')
    expect(after.lastFiredAt).not.toBeNull()
  })
})

describe('逾期与补偿', () => {
  /**
   * 这条是我自己写错过的地方：next_fire_at 原本从「最后一个计划点」往后推，
   * 于是一个逾期三小时的每小时任务会被连续的 tick 一路补到追平 ——
   * 正好是 catch_up=false 想避免的事。推进基准必须是 now。
   */
  it('关了 catch_up：逾期三小时只跑一次，而且 next 跳过所有错过的点', async () => {
    const s = await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    // 创建时 next = 01:00。现在已经是 04:30
    const results = await store.fire(s, at('2026-01-01T04:30:00.000Z'))
    expect(results.filter((r) => r.runId)).toHaveLength(1)

    const after = (await store.byName('h'))!
    // 关键：next 是 05:00 而不是 02:00 —— 否则下一个 tick 又会触发
    expect(after.nextFireAt!.toISOString()).toBe('2026-01-01T05:00:00.000Z')
  })

  it('关了 catch_up：连续 tick 不会补出一串 run', async () => {
    await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    const now = at('2026-01-01T04:30:00.000Z')
    let total = 0
    for (let i = 0; i < 5; i++) {
      const cur = (await store.byName('h'))!
      const due = await store.claimDue(now)
      if (due.length === 0) break
      total += (await store.fire(cur, now)).filter((r) => r.runId).length
    }
    expect(total).toBe(1)
  })

  it('开了 catch_up：补跑，但受 catch_up_max 约束', async () => {
    const s = await store.create({
      name: 'h',
      cron: '@hourly',
      agentId: 'researcher',
      goal: 'x',
      catchUp: true,
      catchUpMax: 2,
    })
    const results = await store.fire(s, at('2026-01-01T06:30:00.000Z'))
    const ran = results.filter((r) => r.runId)
    expect(ran).toHaveLength(2)
    // **取最近的两次，不是最早的两次** —— 补日报要昨天那份，不要三天前那份
    expect(ran.map((r) => r.plannedAt.toISOString())).toEqual([
      '2026-01-01T05:00:00.000Z',
      '2026-01-01T06:00:00.000Z',
    ])
  })
})

describe('幂等', () => {
  it('同一个计划点触发两次，第二次是 duplicate 而不是第二个 run', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    const when = s.nextFireAt!
    const first = await store.fire(s, when)
    expect(first[0]!.runId).toBeTruthy()
    // 跑到终态，把重入这条排除掉 —— 这里要验的是幂等键，不是重入
    await n.worker.drain(30)

    // 手动重放同一个计划点（模拟两个 worker 同时到点 / 崩溃后重启）
    const again = await store.fire({ ...s, nextFireAt: when }, when)
    expect(again[0]!.skipped).toBe('duplicate')
    expect(again[0]!.runId).toBeNull()

    const runs = await n.db.query<{ n: number }>(
      `select count(*)::int n from runs where schedule_id = $1`,
      [s.id],
    )
    expect(runs.rows[0]!.n).toBe(1)
  })

  it('幂等键截到分钟 —— 秒级差异不该产生新的键', () => {
    const a = idempotencyKey('abc', at('2026-01-01T08:30:00.000Z'))
    const b = idempotencyKey('abc', at('2026-01-01T08:30:59.000Z'))
    expect(a).toBe(b)
  })
})

describe('重入', () => {
  it('上一次还没跑完就跳过这一次，不排队', async () => {
    const s = await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    await store.fire(s, at('2026-01-01T01:00:00.000Z'))
    // 上一个 run 还是 pending（没 drain）

    const s2 = (await store.byName('h'))!
    const second = await store.fire(s2, at('2026-01-01T02:00:00.000Z'))
    expect(second[0]!.skipped).toBe('reentrant')
    expect(second[0]!.reason).toMatch(/还在跑/)

    // 只有一个 run —— 排队会让每小时的任务在单次要跑两小时时越积越多
    const runs = await n.db.query<{ n: number }>(
      `select count(*)::int n from runs where schedule_id = $1`,
      [s.id],
    )
    expect(runs.rows[0]!.n).toBe(1)
  })

  it('上一次跑完了就正常触发', async () => {
    const s = await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    await store.fire(s, at('2026-01-01T01:00:00.000Z'))
    await n.worker.drain(30)

    const s2 = (await store.byName('h'))!
    const second = await store.fire(s2, at('2026-01-01T02:00:00.000Z'))
    expect(second[0]!.skipped).toBeNull()
    expect(second[0]!.runId).toBeTruthy()
  })
})

describe('留痕（schedule_fires）', () => {
  /**
   * 被跳过的触发**没有 run**，所以除了这张表以外没有任何痕迹 ——
   * 「今天早上那次没跑」只能靠「没看到产出」发现，而那已经太晚。
   */
  it('跑了的记 fired，带 run 与会话', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    await store.fire(s, s.nextFireAt!)
    const h = await store.history('daily')
    expect(h).toHaveLength(1)
    expect(h[0]!.outcome).toBe('fired')
    expect(h[0]!.runId).toBeTruthy()
    expect(h[0]!.conversationId).toBeTruthy()
  })

  it('被跳过的也记，而且写清为什么', async () => {
    const s = await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    await store.fire(s, at('2026-01-01T01:00:00.000Z'))
    const s2 = (await store.byName('h'))!
    await store.fire(s2, at('2026-01-01T02:00:00.000Z'))

    const h = await store.history('h')
    expect(h.map((x) => x.outcome)).toEqual(['reentrant', 'fired'])
    expect(h[0]!.reason).toMatch(/还在跑/)
    expect(h[0]!.runId).toBeNull()
  })

  it('触发失败也记 —— 否则症状是产出静默消失', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    await store.recordError(s.id, at('2026-01-01T00:00:00.000Z'), 'agent 被删了')
    const h = await store.history('daily')
    expect(h[0]!.outcome).toBe('error')
    expect(h[0]!.reason).toBe('agent 被删了')
  })

  it('planned_at 与 fired_at 分开存 —— 两者的差就是延迟的证据', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    // 计划 01-02T00:00，但 FakeClock 还停在 T0 —— 于是「提前触发」被记下来了。
    // 真实场景里差值的方向相反（延迟/补偿），存两列的意义就是差值能被看见
    await store.fire(s, s.nextFireAt!)
    const h = await store.history('daily')
    expect(h[0]!.plannedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(h[0]!.firedAt.getTime()).toBe(T0)
  })
})

describe('触发成功 ≠ 跑成功', () => {
  /**
   * `outcome: 'fired'` 只说明**触发**成功。指向已删掉 agent 的计划每次触发
   * 都会产出一个 config.agent_not_found 的 failed run —— 有痕迹，但没人会去看，
   * 因为定时任务没有人在旁边等结果。对着它打绿勾就是骗人。
   */
  it('history 带上 run 的最终状态与错误码', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    await store.fire(s, s.nextFireAt!)
    await n.worker.drain(30)

    const h = await store.history('daily')
    expect(h[0]!.outcome).toBe('fired')
    expect(h[0]!.runStatus).toBe('succeeded')
    expect(h[0]!.runErrorCode).toBeNull()
  })

  it('agent 不存在时：触发算 fired，但 run 是 failed —— 两者都要能看到', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    // 模拟「专家 md 被删了」：直接把计划改指向一个不存在的 agent
    await n.db.query(`update schedules set agent_id = 'gone' where id = $1`, [s.id])
    const s2 = (await store.byName('daily'))!

    await store.fire(s2, s2.nextFireAt!)
    await n.worker.drain(30)

    const h = await store.history('daily')
    // 触发本身是成功的 —— run 建出来了
    expect(h[0]!.outcome).toBe('fired')
    // 但结果是失败，而且错误码指得很明确
    expect(h[0]!.runStatus).toBe('failed')
    expect(h[0]!.runErrorCode).toBe('config.agent_not_found')
  })

  it('还在跑的时候 runStatus 不是终态 —— 不该显示成完成', async () => {
    const s = await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    await store.fire(s, s.nextFireAt!)
    const h = await store.history('daily')
    expect(h[0]!.runStatus).toBe('pending')
  })
})

describe('启停', () => {
  it('停用后不再进 claimDue', async () => {
    await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    await store.setEnabled('h', false)
    expect(await store.claimDue(at('2026-06-01T00:00:00.000Z'))).toHaveLength(0)
  })

  /**
   * 重新启用时重算 next_fire_at。沿用旧值的话，停用一周再打开会立刻触发；
   * 如果还开了 catch_up，一次补出一周的量。停用期间的点不是「欠账」。
   */
  it('重新启用时重算 next_fire_at，不沿用停用前的旧值', async () => {
    await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    await store.setEnabled('h', false)
    await clock.advance(7 * 24 * 60 * 60_000)
    const s = (await store.setEnabled('h', true))!
    // 现在是 2026-01-08T00:00Z，下一个整点是 01:00 —— 不是一周前那个
    expect(s.nextFireAt!.toISOString()).toBe('2026-01-08T01:00:00.000Z')
  })

  it('删除', async () => {
    await store.create({ name: 'h', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    expect(await store.remove('h')).toBe(true)
    expect(await store.remove('h')).toBe(false)
    expect(await store.byName('h')).toBeNull()
  })
})

describe('worker 接线', () => {
  /**
   * 定时不需要单独进程：worker tick 里就地触发。
   * 这一条验的是「到点的任务在同一个 tick 里被塞进队列并跑完」。
   */
  it('worker tick 到点自动触发并执行到终态', async () => {
    await store.create({
      name: 'daily',
      cron: '@hourly',
      agentId: 'researcher',
      goal: '每小时看一眼',
    })
    // 推到第一个整点之后
    await clock.advance(61 * 60_000)

    const fires: string[] = []
    await n.worker.drain(30, { onScheduleFire: (r) => fires.push(r.skipped ?? 'fired') })

    expect(fires).toEqual(['fired'])
    const runs = await n.db.query<{ status: string }>(
      `select r.status from runs r join schedules s on s.id = r.schedule_id where s.name = 'daily'`,
    )
    expect(runs.rows.map((r) => r.status)).toEqual(['succeeded'])
  })

  it('一条坏计划不打断 worker —— 其余照跑', async () => {
    // 好的那条
    await store.create({ name: 'good', cron: '@hourly', agentId: 'researcher', goal: 'x' })
    // 坏的那条：指向不存在的 agent
    const bad = await store.create({ name: 'bad', cron: '@hourly', agentId: 'researcher', goal: 'y' })
    await n.db.query(`update schedules set agent_id = 'gone' where id = $1`, [bad.id])

    await clock.advance(61 * 60_000)
    await n.worker.drain(40)

    // 好的那条跑成功了
    const good = await store.history('good')
    expect(good[0]!.runStatus).toBe('succeeded')
    // 坏的那条留下了可查的失败，而不是让 worker 挂掉
    const b = await store.history('bad')
    expect(b[0]!.runErrorCode).toBe('config.agent_not_found')
  })

  it('没有到点的计划时 tick 不做事', async () => {
    await store.create({ name: 'daily', cron: '@daily', agentId: 'researcher', goal: 'x' })
    // 创建时 next = 明天 00:00，现在还没到
    const fires: string[] = []
    const worked = await n.worker.tick({ onScheduleFire: (r) => fires.push(r.name) })
    expect(fires).toEqual([])
    expect(worked).toBe(false)
  })
})
