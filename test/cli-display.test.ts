import { describe, expect, it } from 'vitest'
import { delta, fmt, outcomeMark, outcomeText, relative } from '../src/cli/schedule.js'
import { rateColor, scopeLabel, tierLabel } from '../src/cli/rules.js'
import { renderEvent } from '../src/cli/turn.js'
import type { RunEvent } from '../src/runtime/events.js'
import type { FireRecord } from '../src/store/schedules.js'

/**
 * CLI 的显示判断。
 *
 * ── 为什么这些值得单测 ────────────────────────────────
 *
 * 这不是「测排版」。这几个函数里的判断都是**说真话还是说假话**的判断，
 * 而这个项目已经在同一类错上栽过两次：
 *
 *  · `outcome: 'fired'` 只说明**触发**成功 —— run 可能随后就失败了。
 *    对着一个 failed run 打绿勾，和「系统会自动重试」那句假话是同一类错误。
 *  · `recoveryOf(errorCode)` 是「这类错原则上可自动恢复」，不是「这一次会重试」。
 *
 * 两处我都修过，而**都没有测试守着** —— 也就是说改回去不会有人发现。
 *
 * 颜色在非 TTY 下自动关闭（`ui.ts` 的 `useColor`），所以这里断言的是纯文本。
 */

const fire = (over: Partial<FireRecord> = {}): FireRecord =>
  ({
    plannedAt: new Date('2026-08-04T09:00:00Z'),
    firedAt: new Date('2026-08-04T09:00:00Z'),
    outcome: 'fired',
    runId: 'r1',
    conversationId: null,
    reason: null,
    runStatus: 'succeeded',
    runErrorCode: null,
    ...over,
  }) as FireRecord

describe('一次触发算成功还是失败', () => {
  /**
   * **这一条是那个 bug 本身。**
   *
   * `outcome: 'fired'` 是「定时器成功地把任务发出去了」，与「那件事做成了」
   * 是两回事。原先只看 outcome，于是一个每天定时失败的任务在 history 里
   * 一排绿勾。
   */
  it('触发成功但 run 失败 → 不打绿勾', () => {
    expect(outcomeMark(fire({ runStatus: 'failed' }))).not.toBe('✓')
    expect(outcomeText(fire({ runStatus: 'failed', runErrorCode: 'provider.timeout' }))).toMatch(
      /失败：provider\.timeout/,
    )
  })

  it('触发成功且 run 成功 → 才是绿勾', () => {
    expect(outcomeMark(fire())).toBe('✓')
    expect(outcomeText(fire())).toBe('完成')
  })

  it('还在跑 → 既不是成功也不是失败', () => {
    for (const s of ['pending', 'running', 'waiting_children', 'waiting_user'] as const) {
      expect(outcomeText(fire({ runStatus: s })), s).toMatch(/进行中/)
      expect(outcomeMark(fire({ runStatus: s })), s).not.toBe('✓')
    }
  })

  /**
   * 被跳过的触发**没有 run**，除了 schedule_fires 那张表以外毫无痕迹 ——
   * 所以「为什么没跑」必须写在这一行里，否则只能靠「没看到产出」发现，太晚。
   */
  it('跳过的两种原因分开说', () => {
    expect(outcomeText(fire({ outcome: 'reentrant' }))).toMatch(/上次还在跑/)
    expect(outcomeText(fire({ outcome: 'duplicate' }))).toMatch(/已触发过/)
    expect(outcomeText(fire({ outcome: 'error' }))).toBe('触发失败')
  })

  it('run 被删了也要说出来，而不是显示成失败', () => {
    expect(outcomeText(fire({ runStatus: null }))).toMatch(/已删除/)
  })
})

describe('计划时刻与实际触发的差', () => {
  /**
   * 显示差值而不是又一个时刻 —— 「迟了 3h」比「09:00 计划 / 12:00 实际」
   * 更快看出「那台机器当时没在跑」。
   */
  it('一分钟内算准时', () => {
    const p = new Date('2026-08-04T09:00:00Z')
    expect(delta(p, new Date('2026-08-04T09:00:30Z'))).toBe('准时')
    expect(delta(p, new Date('2026-08-04T08:59:40Z'))).toBe('准时')
  })

  it('迟到与提前分开 —— 提前意味着补跑', () => {
    const p = new Date('2026-08-04T09:00:00Z')
    expect(delta(p, new Date('2026-08-04T09:20:00Z'))).toBe('迟 20m')
    expect(delta(p, new Date('2026-08-04T12:00:00Z'))).toBe('迟 3h')
    expect(delta(p, new Date('2026-08-04T08:30:00Z'))).toBe('早 30m')
  })
})

describe('相对时刻', () => {
  const now = new Date('2026-08-04T09:00:00Z').getTime()

  it('按量级选单位', () => {
    expect(relative(new Date(now + 30_000), now)).toBe('30s 后')
    expect(relative(new Date(now + 20 * 60_000), now)).toBe('20m 后')
    expect(relative(new Date(now + 5 * 3600_000), now)).toBe('5h 后')
    expect(relative(new Date(now + 3 * 86400_000), now)).toBe('3d 后')
  })

  it('过去用「前」 —— 一条「3d 前」的下次触发说明它卡住了', () => {
    expect(relative(new Date(now - 3 * 86400_000), now)).toBe('3d 前')
  })

  it('null 返回空串，而不是「NaN 后」', () => {
    expect(relative(null, now)).toBe('')
  })
})

describe('时刻按计划自己的时区显示', () => {
  /**
   * 一条「每天 9:00（Asia/Shanghai）」的计划，用 UTC 显示成 01:00 会让人
   * 以为配错了。所以显示用计划自己的时区 —— 而这依赖 `wallClock`（Intl），
   * 不是手算偏移。
   */
  it('同一时刻在不同时区显示不同', () => {
    const d = new Date('2026-08-04T01:00:00Z')
    expect(fmt(d, 'UTC')).toBe('2026-08-04 01:00')
    expect(fmt(d, 'Asia/Shanghai')).toBe('2026-08-04 09:00')
    expect(fmt(d, 'America/Los_Angeles')).toBe('2026-08-03 18:00')
  })

  it('null 显示成横线，而不是 Invalid Date', () => {
    expect(fmt(null)).toBe('—')
  })
})

describe('规则清单的标签', () => {
  it('三层用名字，不是编号', () => {
    expect(tierLabel('boundary')).toContain('边界')
    expect(tierLabel('check')).toContain('检查')
    expect(tierLabel('reminder')).toContain('提醒')
  })

  it('内置规则的层级说的是「谁在强制」', () => {
    expect(scopeLabel('capability')).toMatch(/能力|边界/)
    expect(scopeLabel('precondition')).toMatch(/调用前|前置/)
    expect(scopeLabel('postcondition')).toMatch(/结果|提交后|后置/)
  })

  /**
   * 遵守率的颜色是**给人一个「要不要管」的判断**，所以阈值本身是个决定：
   * 100% 与 99% 该是不同的颜色，否则那一次被退回就看不见了。
   */
  it('遵守率的颜色分档', () => {
    expect(rateColor(1)).not.toBe(rateColor(0.99))
    expect(rateColor(0.5)).not.toBe(rateColor(1))
  })
})

/**
 * ── 「参数被退回」不是故障 ──────────────────────────────
 *
 * 实测：`create_rule` 第一次被校验拒（引用了未声明的字段），第二次改对了 ——
 * **那正是设计要的行为**。而终端显示的是 `create_rule ✗ 0ms`，看起来像出了故障，
 * 于是使用者的反馈是「create_user 第一次失败了」。
 *
 * 这两件事该给的提示完全不同：
 *
 *   故障  写文件失败、网络断了 —— 你要去查环境
 *   退回  模型给的参数不合规，理由已回给它 —— 你什么都不用做
 *
 * `contract.rejected` 那一档早就分开了，工具校验没有 ——
 * 同一类错的两个位置，修了一个漏了一个。
 */
describe('工具结果：退回与故障要分开', () => {
  const ev = (payload: Record<string, unknown>): RunEvent =>
    ({ kind: 'tool.outcome', runId: 'r', attemptId: 'a', payload, seq: 1 }) as unknown as RunEvent

  it('参数被退回 → 说清「已告知模型」，不打红叉', () => {
    const out = renderEvent(ev({ tool: 'create_rule', ok: false, ms: 0, rejected: true }), '')!
    expect(out).toMatch(/参数被退回/)
    expect(out).toMatch(/已把原因告知模型/)
    expect(out, '退回不该显示成失败').not.toContain('✗')
  })

  it('真故障照旧打红叉并带错误码', () => {
    const out = renderEvent(ev({ tool: 'write_file', ok: false, ms: 12, errorCode: 'fs.denied' }), '')!
    expect(out).toContain('✗')
    expect(out).toContain('fs.denied')
  })

  it('成功照旧打勾', () => {
    expect(renderEvent(ev({ tool: 'create_rule', ok: true, ms: 4 }), '')!).toContain('✓')
  })
})
