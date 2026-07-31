/**
 * 注入接缝（seams）。
 *
 * 设计文档 §14：所有不确定性来源必须可注入，否则可靠性逻辑无法确定性测试。
 * 这里是唯一允许触碰 Date.now / Math.random / crypto 的地方；
 * 其余代码一律通过 Clock / Ids 接口取。
 */

export interface Clock {
  now(): number
  /** 返回 Postgres 可用的 ISO 串 */
  nowIso(): string
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
      const t = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    }),
}

/**
 * 可控时钟。测试中推进时间而不真的等待。
 *
 * 关键性质：advance() 会唤醒所有到期的 sleep，用于测 lease 过期、
 * heartbeat 超时、退避重试等时间边界（§14 强断言第 6 项相关）。
 */
export class FakeClock implements Clock {
  #now: number
  #timers: Array<{ at: number; resolve: () => void; reject: (e: unknown) => void }> = []

  constructor(startMs = Date.parse('2026-01-01T00:00:00.000Z')) {
    this.#now = startMs
  }

  now() {
    return this.#now
  }

  nowIso() {
    return new Date(this.#now).toISOString()
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    return new Promise<void>((resolve, reject) => {
      const entry = { at: this.#now + ms, resolve, reject }
      this.#timers.push(entry)
      signal?.addEventListener(
        'abort',
        () => {
          this.#timers = this.#timers.filter((t) => t !== entry)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  }

  /** 推进时间并唤醒到期的 sleep。返回后微任务队列已 flush。 */
  async advance(ms: number): Promise<void> {
    this.#now += ms
    const due = this.#timers.filter((t) => t.at <= this.#now)
    this.#timers = this.#timers.filter((t) => t.at > this.#now)
    for (const t of due) t.resolve()
    await Promise.resolve()
  }

  /** 当前挂起的 sleep 数量。测试用来判断被测代码是否已进入等待。 */
  get pendingTimers(): number {
    return this.#timers.length
  }

  /**
   * 等到至少有 `n` 个 sleep 挂起，再推进时间。
   *
   * 避免「advance 跑在 sleep 注册之前」这类时序竞态 —— 直接 advance 会静默失效，
   * 表现为测试超时，很难定位。
   */
  async advanceWhenPending(ms: number, n = 1, maxTicks = 1000): Promise<void> {
    for (let i = 0; i < maxTicks && this.#timers.length < n; i++) {
      await new Promise((r) => setImmediate(r))
    }
    await this.advance(ms)
  }

  set(ms: number) {
    this.#now = ms
  }
}

export interface Ids {
  uuid(): string
  /** 用于 fence token、幂等键后缀等；不要求密码学强度 */
  token(): string
}

export const systemIds: Ids = {
  uuid: () => crypto.randomUUID(),
  token: () => crypto.randomUUID().replaceAll('-', ''),
}

/** 确定性 id：测试断言里可以直接写死 `run-1`。 */
export class FakeIds implements Ids {
  #n = 0
  #t = 0
  constructor(private prefix = '00000000-0000-4000-8000-') {}
  uuid() {
    return this.prefix + String(++this.#n).padStart(12, '0')
  }
  token() {
    return `fence-${++this.#t}`
  }
}

/** 贯穿全系统的运行时依赖包。任何模块都不直接 import systemClock。 */
export interface Deps {
  clock: Clock
  ids: Ids
}

export const systemDeps: Deps = { clock: systemClock, ids: systemIds }

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return { clock: new FakeClock(), ids: new FakeIds(), ...overrides }
}
