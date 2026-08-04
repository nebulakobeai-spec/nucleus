import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { bundleCmd } from '../src/cli/bundle.js'

/**
 * `nucleus bundle` —— 故障诊断包。
 *
 * ── 为什么这个必须有测试 ────────────────────────────────
 *
 * 这个模块的文档注释写着「所有内容过 `redactText`，密钥不会进包」——
 * 而在这之前**它一条测试都没有**。一个「保证不泄密」的断言没有测试守着，
 * 等于一句希望。
 *
 * 而它的用途恰好是**把内容交给别人**（部署机出问题跑一条命令、把文件发上来）。
 * 所以这里不测「函数会不会调 redactText」，测的是**一次真实的 run 导出来的包里
 * 有没有密钥** —— 那才是那句保证的实际含义。
 *
 * 顺带说明为什么这次才写：写落盘日志时发现 `redactText` 漏掉转义引号形态
 * （`{"body":"{\\"api_key\\":\\"...\\"}"}`，日志与请求体里最常见的样子）。
 * 那个缺口同样在 bundle 上 —— 而 bundle 是「交给别人」的那一个。
 */

let n: Nucleus | null = null
let dir: string | null = null

afterEach(async () => {
  await n?.close()
  n = null
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

/** 构造的假密钥 —— 测试数据里不放任何真实凭据，哪怕已经轮换过 */
const FAKE = {
  openai: 'sk-proj-FAKE1234567890abcdefFAKE',
  xai: 'xai-FAKEabcdefghijklmnopqrst',
  zai: '00000000000000000000000000000000.FAKEAAAAAAAAAAA',
  bearer: 'eyJhbGciOiJIUzI1NiJ9.FAKEPAYLOAD.FAKESIG',
  plain: 'FAKESECRETVALUE12345',
}

async function bundleOf(mock: Record<string, unknown[]>, userText: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'nuc-bundle-'))
  const cfg = structuredClone(defaultConfig)
  cfg.defaults.modelChain = ['mock:local']
  n = await boot({
    config: cfg,
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    dataDir: join(dir, 'pglite'),
    mock: mock as never,
  })
  const conv = await n.conversations.create({ agentId: 'orchestrator' })
  const { runId } = await ask(n, conv.id, userText)
  await n.close()
  n = null

  const out = join(dir, 'bundle.json')
  const code = await bundleCmd([runId], {
    out,
    data: join(dir, 'pglite'),
    // 内置默认配置就够 —— 这里要验的是脱敏，不是配置加载
  } as never)
  expect(code, 'bundle 应该导出成功').toBe(0)
  return await readFile(out, 'utf8')
}

describe('诊断包不含凭据', () => {
  /**
   * **对话内容里的密钥。**
   *
   * 最真实的泄露路径不是配置，是**人把 key 粘进对话里**（「用这个 key 帮我查…」）。
   * 那句话会落进 conversation、落进 transcript、然后落进诊断包。
   */
  it('用户粘进对话的各家密钥形态都不进包', async () => {
    const text =
      `帮我查一下，我的 key 是 ${FAKE.openai}，备用 ${FAKE.xai}，` +
      `还有 {"api_key":"${FAKE.zai}"}，以及 Authorization: Bearer ${FAKE.bearer}`
    const json = await bundleOf(
      { orchestrator: [{ submit: { status: 'ok', summary: '好', artifacts: [] } }] },
      text,
    )
    for (const [name, secret] of Object.entries(FAKE)) {
      if (name === 'plain') continue // 裸字符串没有可识别形态，见下一条
      expect(json, `${name} 泄漏进诊断包`).not.toContain(secret)
    }
  })

  /**
   * **转义引号形态** —— 这是写落盘日志时才发现 `redactText` 漏掉的那个。
   *
   * 一段 JSON 被当成字符串写进外层（请求体、工具返回值、错误详情里都这样），
   * 引号会被转义。而诊断包本身就是一层 JSON，所以**包里的一切嵌套内容都是
   * 这个形态** —— 也就是说这个缺口对 bundle 的影响比对日志更大。
   */
  it('嵌套 JSON 里的 api_key 也不进包（转义引号形态）', async () => {
    const json = await bundleOf(
      { orchestrator: [{ submit: { status: 'ok', summary: '好', artifacts: [] } }] },
      `请求体是 {"headers":{"api_key":"${FAKE.plain}"}}`,
    )
    expect(json).not.toContain(FAKE.plain)
  })

  /**
   * **不能把有用的内容也抹掉。**
   *
   * 一个过度脱敏的诊断包和没有诊断包差不多 —— 它存在的理由是
   * 「一次往返拿到最多信息」。
   */
  it('正常内容照旧在包里 —— 否则这个包就没用了', async () => {
    const json = await bundleOf(
      { orchestrator: [{ submit: { status: 'ok', summary: '查到了 2026 年的价格', artifacts: [] } }] },
      '帮我查一下 2026 年的显卡价格',
    )
    expect(json).toContain('2026 年的显卡价格')
    expect(json).toContain('查到了 2026 年的价格')
  })
})

describe('诊断包的骨架', () => {
  it('该有的段都在 —— 少一段就少一次往返', async () => {
    const json = await bundleOf(
      { orchestrator: [{ submit: { status: 'ok', summary: '好', artifacts: [] } }] },
      '做点什么',
    )
    const b = JSON.parse(json) as Record<string, unknown>
    for (const k of ['meta', 'environment', 'run']) {
      expect(b, `缺 ${k}`).toHaveProperty(k)
    }
    const meta = b['meta'] as Record<string, unknown>
    // 「运行的是哪份代码」—— 没有它，基于包的分析会指向错误的地方
    expect(meta).toHaveProperty('gitSha')
    expect(meta).toHaveProperty('gitDirty')
    expect(meta).toHaveProperty('schemaHash')
    expect(meta).toHaveProperty('dbKind')
  })

  /**
   * **凭据只报「有没有」，不报值。**
   *
   * 「模型调不通」最常见的原因是 apiKeyRef 指的环境变量根本没设 ——
   * 那件事必须能在包里看出来，而看出来**不需要值**。
   */
  it('凭据段只说 present，不带值', async () => {
    const json = await bundleOf(
      { orchestrator: [{ submit: { status: 'ok', summary: '好', artifacts: [] } }] },
      '做点什么',
    )
    const env = (JSON.parse(json) as { environment: { credentials: unknown[] } }).environment
    for (const cred of env.credentials as Array<Record<string, unknown>>) {
      expect(Object.keys(cred).sort()).toEqual(['present', 'ref'])
      expect(typeof cred['present']).toBe('boolean')
    }
  })

  it('找不到 run 时不导出空包，而是报错退出', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nuc-bundle-'))
    const code = await bundleCmd(['deadbeef'], {
      out: join(dir, 'x.json'),
      data: join(dir, 'pglite'),
    } as never)
    expect(code).not.toBe(0)
  })
})
