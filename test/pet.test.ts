import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { compactTokens, Pet, petFrame, petStill, petVerb, statusLine } from '../src/cli/pet.js'
import { renderEvent } from '../src/cli/turn.js'
import { MemoryEventSink, TeeEventSink, type RunEvent } from '../src/runtime/events.js'

/**
 * 动画与渲染的测试。
 *
 * 看起来像装饰，实际上守着两条会真出问题的线：
 *  1. 非 TTY（管道、CI、测试）必须一个转义字节都不输出 ——
 *     否则日志被污染、被断言的输出会莫名带上 \r\x1b[2K
 *  2. 动画行与永久输出必须互不覆盖 —— 撞行会把执行过程吃掉，
 *     而执行过程正是这个项目存在的理由
 */

/** 收集写入内容的假流 */
function sink(): Writable & { text: () => string } {
  const chunks: string[] = []
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return Object.assign(w, { text: () => chunks.join('') })
}

const ERASE = '\r\x1b[2K'

// ═══════════════════════════════════════════════════════
// 帧
// ═══════════════════════════════════════════════════════

describe('猫的帧', () => {
  it('按 tick 循环，不会越界', () => {
    const frames = [0, 1, 2, 3, 4].map((t) => petFrame('work', t))
    expect(frames[0]).toBe(frames[4]) // 4 帧一轮
    expect(new Set(frames).size).toBeGreaterThan(1) // 确实在动
    expect(() => petFrame('work', 1e9)).not.toThrow()
    expect(petFrame('work', -1)).toBeTruthy() // 负 tick 也不炸
  })

  it('每种情绪都有帧，且长得不一样', () => {
    const moods = ['idle', 'think', 'work', 'wait', 'happy', 'sad'] as const
    const first = moods.map((m) => petFrame(m, 0))
    expect(new Set(first).size).toBe(moods.length)
  })

  it('idle 只是偶尔眨眼 —— 空闲时不该抢注意力', () => {
    const frames = [0, 1, 2, 3].map((t) => petFrame('idle', t))
    // 4 帧里 3 帧相同，只有一帧闭眼
    expect(new Set(frames).size).toBe(2)
    expect(frames.filter((f) => f === frames[0]).length).toBe(3)
  })

  it('说法比帧慢得多 —— 否则读不完就变了', () => {
    expect(petVerb('work', 0)).toBe(petVerb('work', 19))
    expect(petVerb('work', 0)).not.toBe(petVerb('work', 20))
  })

  it('帧里只用宽度确定的字符 —— 宽度不定会让行尾抖动', () => {
    const moods = ['idle', 'think', 'work', 'wait', 'happy', 'sad'] as const
    for (const m of moods) {
      for (let t = 0; t < 4; t++) {
        // 刻意排掉 ⌒(2312) ノ(30CE) ᵕ(1D55) 这类宽度有歧义的
        expect(petFrame(m, t)).not.toMatch(/[⌒ノᵕ]/)
      }
    }
  })
})

describe('状态行', () => {
  it('带上猫、说法、耗时、用量与提示', () => {
    const s = statusLine({
      mood: 'work',
      tick: 0,
      context: 'write_report',
      elapsedMs: 3200,
      tokens: 1234,
      hint: 'Ctrl-C 取消',
    })
    expect(s).toContain('ω') // 猫在
    expect(s).toContain('write_report')
    expect(s).toContain('3.2s')
    expect(s).toContain('1.2k tok')
    expect(s).toContain('Ctrl-C 取消')
  })

  it('用量为 0 时不显示 tok —— 还没调模型就报 0 是噪音', () => {
    expect(statusLine({ mood: 'think', tick: 0, elapsedMs: 100 })).not.toContain('tok')
  })

  it('超过一分钟改用 m+s', () => {
    expect(statusLine({ mood: 'work', tick: 0, elapsedMs: 125_000 })).toContain('2m05s')
  })

  it('compactTokens 在三个量级上都可读', () => {
    expect(compactTokens(42)).toBe('42')
    expect(compactTokens(1234)).toBe('1.2k')
    expect(compactTokens(2_500_000)).toBe('2.5M')
  })
})

// ═══════════════════════════════════════════════════════
// 动画与永久输出共存
// ═══════════════════════════════════════════════════════

describe('Pet 的输出', () => {
  it('非动画模式一个转义字节都不写', () => {
    const out = sink()
    const pet = new Pet({ out, animate: false })
    pet.start('work').mood('think').addTokens(500).say('永久的一行').stop()

    const t = out.text()
    expect(t).not.toContain('\x1b')
    expect(t).not.toContain('\r')
    // 永久输出照常，动画完全消失
    expect(t).toBe('永久的一行\n')
  })

  it('非动画模式下 say 之外不产生任何输出', () => {
    const out = sink()
    new Pet({ out, animate: false }).start('work').stop()
    expect(out.text()).toBe('')
  })

  it('动画模式下每帧重绘前先清行 —— 帧宽会变，不清会留尾巴', () => {
    const out = sink()
    const pet = new Pet({ out, animate: true, intervalMs: 10_000 })
    pet.start('work')
    expect(out.text()).toContain(ERASE)
    pet.stop()
  })

  it('say 先擦动画再打印再重绘 —— 这是两者唯一安全的共存方式', () => {
    const out = sink()
    const pet = new Pet({ out, animate: true, intervalMs: 10_000 })
    pet.start('work')
    const before = out.text().length
    pet.say('⏺ researcher')

    const after = out.text().slice(before)
    // 顺序必须是：擦 → 永久行 → 重绘
    const erasePos = after.indexOf(ERASE)
    const linePos = after.indexOf('⏺ researcher')
    expect(erasePos).toBeGreaterThanOrEqual(0)
    expect(linePos).toBeGreaterThan(erasePos)
    // 永久行后面还有一次重绘
    expect(after.slice(linePos).includes(ERASE)).toBe(true)
    pet.stop()
  })

  it('永久输出以换行结尾 —— 否则下一行会接在后面', () => {
    const out = sink()
    const pet = new Pet({ out, animate: true, intervalMs: 10_000 }).start('work')
    pet.say('一行')
    pet.stop()
    expect(out.text()).toContain('一行\n')
  })

  it('stop 擦掉动画行，不留残迹', () => {
    const out = sink()
    const pet = new Pet({ out, animate: true, intervalMs: 10_000 })
    pet.start('work')
    pet.stop()
    // 最后一次写入就是清行
    expect(out.text().endsWith(ERASE)).toBe(true)
  })

  it('stop 可以在原位留下一句结论', () => {
    const out = sink()
    new Pet({ out, animate: true, intervalMs: 10_000 }).start('work').stop('搞定')
    expect(out.text().endsWith('搞定\n')).toBe(true)
  })

  it('重复 stop 不报错 —— 异常路径上会走到两次', () => {
    const pet = new Pet({ out: sink(), animate: true, intervalMs: 10_000 }).start('work')
    expect(() => {
      pet.stop()
      pet.stop()
    }).not.toThrow()
  })

  it('耗时用注入的时钟 —— 不依赖真实时间', () => {
    let t = 1000
    const pet = new Pet({ out: sink(), animate: false, now: () => t })
    pet.start('work')
    t = 4200
    expect(pet.render()).toContain('3.2s')
  })

  it('petStill 给 banner 用，是静止的一帧', () => {
    expect(petStill('happy')).toBe(petFrame('happy', 0))
  })
})

// ═══════════════════════════════════════════════════════
// 事件 → 一行
// ═══════════════════════════════════════════════════════

const ev = (kind: string, payload: unknown): RunEvent => ({
  attemptId: 'a1',
  runId: 'r1',
  kind,
  payload,
})

describe('事件渲染', () => {
  it('attempt.started 是树的节点', () => {
    const l = renderEvent(ev('attempt.started', { agent: 'researcher', attemptNo: 2, depth: 1 }), '  ')
    expect(l).toContain('researcher')
    expect(l).toContain('#2')
    expect(l!.startsWith('  ')).toBe(true) // 缩进由调用方给
  })

  it('llm.call.finished 报出真正服务的模型 —— 降级链里到底谁接了', () => {
    const l = renderEvent(
      ev('llm.call.finished', { model: 'zai:glm-5.2', tokensIn: 1000, tokensOut: 234 }),
      '',
    )
    expect(l).toContain('zai:glm-5.2')
    expect(l).toContain('1.2k tok')
  })

  it('缓存命中单独标出 —— 它直接影响这轮的钱', () => {
    const l = renderEvent(
      ev('llm.call.finished', { model: 'm', tokensIn: 1000, tokensOut: 0, cacheRead: 800 }),
      '',
    )
    expect(l).toContain('缓存命中')
  })

  it('思考只报字数，内容不进终端', () => {
    const l = renderEvent(ev('llm.reasoning', { chars: 2400, excerpt: '我需要先调研…' }), '')
    expect(l).toContain('2.4k')
    expect(l).not.toContain('我需要先调研')
  })

  it('工具失败带上 error_code', () => {
    const l = renderEvent(ev('tool.outcome', { tool: 'web_search', ok: false, ms: 120, errorCode: 'tool.failed' }), '')
    expect(l).toContain('web_search')
    expect(l).toContain('tool.failed')
  })

  it('契约退回要显式可见 —— 「规则被忽略」藏起来等于没修', () => {
    const l = renderEvent(
      ev('contract.rejected', { retry: 2, failures: [{ path: 'findings[].sources', message: '缺来源' }] }),
      '',
    )
    expect(l).toContain('第 2 次')
    expect(l).toContain('findings[].sources')
  })

  it('规则拦截报出是哪条规则', () => {
    const l = renderEvent(ev('rule.violation', { tool: 'write_file', rule: 'workdir-only' }), '')
    expect(l).toContain('write_file')
    expect(l).toContain('workdir-only')
  })

  it('挂起说清楚「本轮 attempt 结束了」—— 否则会被当成卡住', () => {
    const l = renderEvent(ev('wake.armed', { waitOn: 3 }), '')
    expect(l).toContain('3')
    expect(l).toContain('attempt')
  })

  it('产出报 ref', () => {
    expect(renderEvent(ev('artifact.written', { ref: 'reports/x.md' }), '')).toContain('reports/x.md')
  })

  it('不值得占一行的事件返回 null', () => {
    expect(renderEvent(ev('llm.call.started', {}), '')).toBeNull()
    expect(renderEvent(ev('attempt.finished', { status: 'succeeded' }), '')).toBeNull()
  })

  it('payload 缺字段不炸 —— 事件是 append-only 的，老数据可能没有新字段', () => {
    for (const kind of ['attempt.started', 'llm.call.finished', 'tool.outcome', 'contract.rejected', 'wake.armed']) {
      expect(() => renderEvent(ev(kind, {}), '')).not.toThrow()
      expect(() => renderEvent(ev(kind, null), '')).not.toThrow()
    }
  })
})

// ═══════════════════════════════════════════════════════
// 旁路监听
// ═══════════════════════════════════════════════════════

describe('TeeEventSink', () => {
  it('照常落库，同时通知监听者', async () => {
    const inner = new MemoryEventSink()
    const tee = new TeeEventSink(inner)
    const seen: string[] = []
    tee.subscribe((e) => seen.push(e.kind))

    await tee.emit('a1', 'r1', 'attempt.started', { agent: 'x' })
    expect(inner.kinds()).toEqual(['attempt.started'])
    expect(seen).toEqual(['attempt.started'])
  })

  it('监听者抛异常不影响落库 —— 渲染出错绝不能拖垮运行时', async () => {
    const inner = new MemoryEventSink()
    const tee = new TeeEventSink(inner)
    tee.subscribe(() => {
      throw new Error('渲染炸了')
    })
    const ok: string[] = []
    tee.subscribe((e) => ok.push(e.kind))

    await expect(tee.emit('a1', 'r1', 'tool.intent', {})).resolves.toBeUndefined()
    expect(inner.kinds()).toEqual(['tool.intent'])
    // 前一个监听者抛错不影响后一个
    expect(ok).toEqual(['tool.intent'])
  })

  it('退订后不再收到', async () => {
    const tee = new TeeEventSink(new MemoryEventSink())
    const seen: string[] = []
    const off = tee.subscribe((e) => seen.push(e.kind))
    await tee.emit('a1', 'r1', 'one', {})
    off()
    await tee.emit('a1', 'r1', 'two', {})
    expect(seen).toEqual(['one'])
  })

  it('没有监听者时是透明转发', async () => {
    const inner = new MemoryEventSink()
    await new TeeEventSink(inner).emit('a1', 'r1', 'k', { v: 1 })
    expect(inner.events).toEqual([{ attemptId: 'a1', runId: 'r1', kind: 'k', payload: { v: 1 } }])
  })
})

describe('上下文降级的显示', () => {
  it('没有降级时不占一行 —— 每轮都报一遍是噪音', () => {
    expect(
      renderEvent(ev('context.assembled', { window: 32768, degradations: [], breakdown: {} }), ''),
    ).toBeNull()
  })

  it('裁掉历史时必须说出来，并报出条数', () => {
    const l = renderEvent(
      ev('context.assembled', {
        window: 8000,
        degradations: ['trim_history'],
        droppedMessages: 12,
        breakdown: {},
      }),
      '',
    )
    // 不说的话「模型突然失忆」会变成谜案
    expect(l).toContain('裁掉 12 条历史')
    expect(l).toContain('8.0k')
  })

  it('多项降级按施加顺序显示', () => {
    const l = renderEvent(
      ev('context.assembled', {
        window: 4000,
        degradations: ['trim_history', 'drop_summary', 'shrink_constraints'],
        droppedMessages: 3,
        breakdown: {},
      }),
      '',
    )
    expect(l).toMatch(/裁掉 3 条历史.*丢弃摘要.*收缩约束/)
  })
})

describe('契约通过的显示', () => {
  it('一次写对不占行 —— 那是常态', () => {
    expect(renderEvent(ev('contract.accepted', { step: 2, retries: 0 }), '')).toBeNull()
  })

  it('退回后才通过要说出来，否则只看到被退回、不知道后来成没成', () => {
    const l = renderEvent(ev('contract.accepted', { step: 4, retries: 2 }), '')
    expect(l).toContain('结果通过')
    expect(l).toContain('退回 2 次后')
  })
})
