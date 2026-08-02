import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findConfigFile } from '../src/config-file.js'
import { boot, ask, type Nucleus } from '../src/boot.js'
import { defaultConfig, isMockOnly } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'

/**
 * 配置发现，以及「没配置」时的报错方向。
 *
 * ── 这一组为什么存在 ────────────────────────────────────
 *
 * 真实故障：从 home 目录跑 `nucleus ask`，得到
 *
 *     provider.unreachable
 *     reason: getaddrinfo ENOTFOUND mock.invalid
 *     hint:   域名解析不了 —— 检查 baseUrl 拼写与 DNS
 *
 * 三个环节各错一点，叠起来把人指向了完全错误的方向：
 *
 *  1. 配置发现**只看 cwd**。而 nucleus 是全局命令，从项目子目录或别处跑它
 *     是正常用法 —— 那时配置静默失效
 *  2. 回落到内置默认（只有 mock）时**没说为什么**
 *  3. `provider: 'mock'` 不是 provider 实现，只是一条 baseUrl 指向
 *     mock.invalid 的普通配置。没装 mock fetch 就真的去做 DNS 解析
 *
 * **一个正确的报错指向错误的方向，比没有报错更费时间。**
 */

let root: string
let saved: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nucleus-cfg-'))
  saved = process.env['NUCLEUS_CONFIG_DIR']
})

afterEach(() => {
  if (saved === undefined) delete process.env['NUCLEUS_CONFIG_DIR']
  else process.env['NUCLEUS_CONFIG_DIR'] = saved
  rmSync(root, { recursive: true, force: true })
})

describe('findConfigFile 逐级向上', () => {
  it('当前目录里有就用它', () => {
    writeFileSync(join(root, 'nucleus.config.json'), '{}')
    expect(findConfigFile(root)).toBe(join(root, 'nucleus.config.json'))
  })

  /**
   * 这条是那次故障的直接成因：`nucleus` 是 npm link 到 PATH 的，
   * 从 `src/cli/` 或任何子目录跑它都很自然。
   */
  it('**从子目录也能找到** —— git / npm / tsconfig 都是这个行为', () => {
    writeFileSync(join(root, 'nucleus.config.json'), '{}')
    const deep = join(root, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    expect(findConfigFile(deep)).toBe(join(root, 'nucleus.config.json'))
  })

  it('最近的那个赢 —— 子目录的配置覆盖上层', () => {
    writeFileSync(join(root, 'nucleus.config.json'), '{"a":1}')
    const sub = join(root, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'nucleus.config.json'), '{"a":2}')
    expect(findConfigFile(sub)).toBe(join(sub, 'nucleus.config.json'))
  })

  it('一路到根都没有就返回 null，不死循环', () => {
    const deep = join(root, 'x', 'y')
    mkdirSync(deep, { recursive: true })
    // root 下没有配置文件；向上会走到 /tmp、/ —— 必须终止
    expect(findConfigFile(deep)).toBeNull()
  })

  it('NUCLEUS_CONFIG 显式指定时不再搜索', () => {
    const explicit = join(root, 'custom.json')
    writeFileSync(explicit, '{}')
    writeFileSync(join(root, 'nucleus.config.json'), '{}')
    process.env['NUCLEUS_CONFIG'] = explicit
    try {
      expect(findConfigFile(root)).toBe(explicit)
    } finally {
      delete process.env['NUCLEUS_CONFIG']
    }
  })
})

describe('内置默认配置只有 mock', () => {
  it('isMockOnly 认得出来 —— 那句警告靠它', () => {
    expect(isMockOnly(defaultConfig)).toBe(true)
  })
})

describe('mock 模型链在没开 --mock 时的报错方向', () => {
  let n: Nucleus

  afterEach(async () => {
    await n?.close()
    n = null as unknown as Nucleus
  })

  /**
   * 关键一条：错误码必须指向**配置**，而不是网络。
   *
   * 之前是 provider.unreachable + 「检查 baseUrl 与 DNS」——
   * 而真正的原因是「还没配置任何真实模型」。
   */
  it('报 config.no_real_model，不是 provider.unreachable', async () => {
    n = await boot({
      // 就是内置默认：模型链只有 mock:local，且**不注入 mock fetch**
      config: structuredClone(defaultConfig),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '测试')
    const run = await n.runs.getRun(runId)

    expect(run!.status).toBe('failed')
    expect(run!.errorCode).toBe('config.no_real_model')
  })

  it('拦在发请求之前 —— 不该留下任何 DNS 相关的痕迹', async () => {
    n = await boot({
      config: structuredClone(defaultConfig),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '测试')

    const attempts = await n.runs.listAttempts(runId)
    const detail = JSON.stringify(attempts[0]?.errorDetail ?? {})
    // 那条误导性的提示不能再出现
    expect(detail).not.toMatch(/ENOTFOUND|mock\.invalid|DNS/)
    // 而且要指向两个真实成因
    expect(detail).toMatch(/nucleus\.config\.json/)
    expect(detail).toMatch(/doctor/)
  })

  it('装了 mock fetch 时照常工作 —— 拦的是「没 mock 却用 mock 模型」', async () => {
    n = await boot({
      config: structuredClone(defaultConfig),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: { orchestrator: [{ submit: { status: 'ok', summary: '好了', artifacts: [] } }] },
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '测试')
    expect((await n.runs.getRun(runId))!.status).toBe('succeeded')
  })
})
