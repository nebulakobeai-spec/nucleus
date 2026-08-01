import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { ModelRouter } from '../src/providers/router.js'
import { describeFetchError, hintFor, systemErrorCode } from '../src/providers/openai-compat.js'
import { extractHint } from '../src/cli/turn.js'
import { recoveryOf } from '../src/errors.js'
import type { ModelConfig } from '../src/providers/types.js'
import { scriptedFetch } from './harness/provider.js'

/**
 * 连不上 ≠ 超时。
 *
 * 实测撞出来的：让 Nucleus 去连一个到不了的 ollama，540ms 就报
 * `provider.timeout`、界面显示「系统会自动重试」，而队列是空的、
 * 什么都不会重试；诊断里专门为保留根因写的 `reason` 字段是**空字符串**。
 *
 * 三个问题叠在一起：分类错、恢复性承诺错、根因丢了。
 */

const CFG: ModelConfig = {
  key: 'ollama:x',
  provider: 'ollama',
  model: 'x',
  baseUrl: 'http://localhost:11434/v1',
  billing: 'usage',
  costPerMTokIn: 0,
  costPerMTokOut: 0,
}

let db: Db
let deps: Deps

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  deps = { clock: new FakeClock(), ids: new FakeIds() }
})
afterEach(async () => {
  await db.close()
})

/** 造一个 undici 风格的 fetch 失败：外层只说 fetch failed，真相在 cause */
function fetchFailure(code: string, message = ''): Error {
  const cause = Object.assign(new Error(message), { code })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

function router(f: ReturnType<typeof scriptedFetch>) {
  return new ModelRouter(db, deps, new Map([[CFG.key, CFG]]), () => null, {
    fetch: f,
    inPlaceRetries: 0,
  })
}

// ═══════════════════════════════════════════════════════
// 挖根因
// ═══════════════════════════════════════════════════════

describe('systemErrorCode', () => {
  it('从 cause 链里挖出系统码 —— 它在 code 上而不在 message 上', () => {
    expect(systemErrorCode(fetchFailure('ECONNREFUSED'))).toBe('ECONNREFUSED')
    // EPERM 的 message 常常是空的，这正是原来 reason 变空字符串的原因
    expect(systemErrorCode(fetchFailure('EPERM', ''))).toBe('EPERM')
  })

  it('穿过 AggregateError —— undici 会把 IPv6/IPv4 两次尝试包起来', () => {
    const agg = Object.assign(new AggregateError([fetchFailure('ECONNREFUSED')], 'all failed'), {})
    expect(systemErrorCode(Object.assign(new TypeError('fetch failed'), { cause: agg }))).toBe(
      'ECONNREFUSED',
    )
  })

  it('没有系统码时返回 null，不编一个', () => {
    expect(systemErrorCode(new Error('随便'))).toBeNull()
    expect(systemErrorCode(undefined)).toBeNull()
  })

  it('不会在自引用的 cause 链上死循环', () => {
    const e = new Error('a') as Error & { cause?: unknown }
    e.cause = e
    expect(() => systemErrorCode(e)).not.toThrow()
  })
})

describe('describeFetchError', () => {
  it('message 为空时退回系统码，绝不返回空串', () => {
    // 原来的实现在这里返回 ''，于是诊断包里什么根因都没有
    expect(describeFetchError(fetchFailure('EPERM', ''))).toBe('EPERM（fetch failed）')
    expect(describeFetchError(fetchFailure('EPERM', ''))).not.toBe('')
  })

  it('两者都有时都带上', () => {
    const s = describeFetchError(fetchFailure('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434'))
    expect(s).toContain('ECONNREFUSED')
    expect(s).toContain('127.0.0.1:11434')
  })

  it('完全未知也给一句话，不是空白', () => {
    expect(describeFetchError({})).toBe('未知网络错误')
  })
})

describe('hintFor', () => {
  it('每种常见系统码都给出可操作的下一步', () => {
    expect(hintFor('ECONNREFUSED')).toContain('ollama serve')
    expect(hintFor('ENOTFOUND')).toContain('baseUrl')
    expect(hintFor('EPERM')).toContain('出网权限')
  })

  it('未知码也不留空 —— 只报错误码等于让人自己猜', () => {
    expect(hintFor(null).length).toBeGreaterThan(0)
    expect(hintFor('SOMETHING_NEW').length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════
// 分类与恢复性
// ═══════════════════════════════════════════════════════

describe('连不上与超时分开', () => {
  it('连接被拒是 provider.unreachable，不是 timeout', async () => {
    const f = scriptedFetch([
      () => {
        throw fetchFailure('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434')
      },
    ])
    const err = await router(f)
      .chat([CFG.key], { messages: [] })
      .then(() => null, (e: unknown) => e as { code: string; detail?: Record<string, unknown> })
    expect(err!.code).toBe('provider.unreachable')
  })

  it('unreachable 的恢复性是 needs_user —— 重试永远不会成功', () => {
    expect(recoveryOf('provider.unreachable')).toBe('needs_user')
    // 归成 timeout 会让界面说「系统会自动重试」，把人往错方向引
    expect(recoveryOf('provider.timeout')).toBe('automatic')
  })

  it('错误详情里带 baseUrl、系统码与提示', async () => {
    const f = scriptedFetch([
      () => {
        throw fetchFailure('EPERM', '')
      },
    ])
    const err = await router(f)
      .chat([CFG.key], { messages: [] })
      .then(() => null, (e: unknown) => e as { detail?: Record<string, unknown> })

    // router 会把各模型的失败包成 { attempts, lastError }
    const inner = (err!.detail as { lastError?: Record<string, unknown> }).lastError!
    expect(inner['syscallCode']).toBe('EPERM')
    expect(inner['baseUrl']).toBe(CFG.baseUrl)
    expect(String(inner['hint'])).toContain('出网权限')
    // reason 一度是空字符串
    expect(String(inner['reason']).length).toBeGreaterThan(0)
  })

  it('消息里带上 baseUrl —— 连不上时第一件要核对的就是它', async () => {
    const f = scriptedFetch([
      () => {
        throw fetchFailure('ENOTFOUND')
      },
    ])
    const err = await router(f)
      .chat([CFG.key], { messages: [] })
      .then(() => null, (e: unknown) => e as Error)
    expect(err!.message).toContain('localhost:11434')
  })
})

describe('extractHint', () => {
  it('直接带 hint 的取出来', () => {
    expect(extractHint({ hint: '启动服务' })).toBe('启动服务')
  })

  it('router 包了一层时从 lastError 里取', () => {
    expect(extractHint({ attempts: [], lastError: { hint: '检查 baseUrl' } })).toBe('检查 baseUrl')
  })

  it('没有就返回 null，不显示空行', () => {
    expect(extractHint(null)).toBeNull()
    expect(extractHint({})).toBeNull()
    expect(extractHint({ hint: '' })).toBeNull()
    expect(extractHint('字符串')).toBeNull()
  })
})
