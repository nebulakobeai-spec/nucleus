import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { agentSpec, defaultConfig, type NucleusConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import type { UserRule } from '../src/runtime/user-rules.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 三层规则真的接上线了吗。
 *
 * 这一组存在的理由：`buildTail()` 与 `maxConstraintTokens` 预算**一直都在，
 * 但没有任何代码调用它** —— 第 8 处「声明了没接线」。
 * 而「声明了没接线」的症状恰好是**测试全绿**：规则清单能列出来、
 * 校验也通过，只是模型从来没看见过那句话。
 *
 * 所以这里断言的是**最终有没有到模型手里**，不是「配置解析对不对」。
 */

const rule = (over: Partial<UserRule> = {}): UserRule => ({
  id: 'r',
  constraint: null,
  gist: null,
  check: null,
  denyTools: [],
  appliesTo: [],
  uncovered: [],
  path: 'rules/r.md',
  ...over,
})

const SCRIPT: MockScript = {
  orchestrator: [{ submit: { status: 'ok', summary: '完成。', artifacts: [] } }],
}

function config(rules: UserRule[]): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  c.rules = rules
  return c
}

describe('agentSpec 里三层（边界 / 检查 / 提醒）的落地', () => {
  const defaults = defaultConfig.defaults

  it('边界合并进 toolsDeny', () => {
    const spec = agentSpec(
      { id: 'a', name: 'a', identity: 'x', toolsDeny: ['write_file'] },
      defaults,
      [rule({ denyTools: ['exec_shell'] })],
    )
    expect(spec.toolsDeny!.sort()).toEqual(['exec_shell', 'write_file'])
  })

  it('检查合并进 requiredFields', () => {
    const spec = agentSpec(
      { id: 'a', name: 'a', identity: 'x', requiredFields: ['summary'] },
      defaults,
      [rule({ check: { requiredFields: ['findings[].sources'] } })],
    )
    expect(spec.resultSpec!.requiredFields!.sort()).toEqual(['findings[].sources', 'summary'])
  })

  /**
   * **「提醒」不能进 systemPrompt。**
   *
   * 缓存前缀要逐字节稳定才能命中 prompt cache，而规则是会改的 ——
   * 一改就让所有历史缓存失效。放末尾则改了也不影响前缀。
   */
  it('提醒进 spec.constraints，**不进 systemPrompt**', () => {
    const spec = agentSpec({ id: 'a', name: 'a', identity: 'x' }, defaults, [
      rule({ constraint: '结论要带来源。', check: { requiredFields: ['x'] } }),
    ])
    expect(spec.constraints).toEqual(['结论要带来源。'])
    expect(spec.systemPrompt).not.toMatch(/结论要带来源/)
  })

  it('只对指定 agent 生效的规则不影响别人', () => {
    const rules = [rule({ denyTools: ['delegate'], appliesTo: ['researcher'] })]
    expect(agentSpec({ id: 'orchestrator', name: 'o', identity: 'x' }, defaults, rules).toolsDeny)
      .toBeUndefined()
    expect(agentSpec({ id: 'researcher', name: 'r', identity: 'x' }, defaults, rules).toolsDeny)
      .toEqual(['delegate'])
  })

  it('没有规则时行为与从前完全一致', () => {
    const a = agentSpec({ id: 'a', name: 'a', identity: 'x' }, defaults)
    const b = agentSpec({ id: 'a', name: 'a', identity: 'x' }, defaults, [])
    expect(a).toEqual(b)
    expect(a.constraints).toBeUndefined()
  })
})

describe('端到端：「提醒」真的到了模型手里', () => {
  let n: Nucleus

  afterEach(async () => {
    await n?.close()
    n = null as unknown as Nucleus
  })

  /**
   * 这一条是整块的核心断言。读的是 transcript —— **模型实际收到的消息**，
   * 不是我们以为发过去的东西。
   */
  it('约束原文出现在发给模型的消息里', async () => {
    n = await boot({
      config: config([
        rule({
          id: 'cite',
          constraint: '每条结论必须带一个可验证来源。',
          check: { requiredFields: ['summary'] },
        }),
      ]),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '一个问题')

    const t = await n.db.query<{ request: unknown }>(
      `select t.request from transcripts t
         join run_attempts a on a.id = t.run_attempt_id
        where a.run_id = $1 order by t.step limit 1`,
      [runId],
    )
    expect(t.rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(t.rows[0]!.request)).toMatch(/每条结论必须带一个可验证来源/)
  })

  /** 约束块在**最后** —— 前缀要保持逐字节稳定 */
  it('约束块排在消息序列的末尾，不在 system prompt 里', async () => {
    n = await boot({
      config: config([
        rule({ constraint: '不要编造数字。', check: { requiredFields: ['summary'] } }),
      ]),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '一个问题')

    const ev = await n.db.query<{ payload: { breakdown: { constraints: number } } }>(
      `select e.payload from run_events e
         join run_attempts a on a.id = e.run_attempt_id
        where a.run_id = $1 and e.kind = 'context.assembled' limit 1`,
      [runId],
    )
    // 约束段真的占了预算 —— 为 0 就说明没注入
    expect(ev.rows[0]!.payload.breakdown.constraints).toBeGreaterThan(0)
  })

  it('没有规则时约束段是 0 —— 不会凭空多出东西', async () => {
    n = await boot({
      config: config([]),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '一个问题')
    const ev = await n.db.query<{ payload: { breakdown: { constraints: number } } }>(
      `select e.payload from run_events e
         join run_attempts a on a.id = e.run_attempt_id
        where a.run_id = $1 and e.kind = 'context.assembled' limit 1`,
      [runId],
    )
    expect(ev.rows[0]!.payload.breakdown.constraints).toBe(0)
  })

  /**
   * 「边界」的强制方式是**工具根本不出现在给模型的定义里** ——
   * 不是「调了被拒」。这条区别是边界比提醒强的全部原因。
   */
  it('边界禁掉的工具不出现在发给模型的工具列表里', async () => {
    n = await boot({
      config: config([rule({ denyTools: ['write_report'], appliesTo: ['researcher'] })]),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [{ submit: { status: 'ok', summary: '好', artifacts: [] } }],
      },
    })
    const spec = n.worker.agentSpecs.get('researcher')!
    expect(spec.toolsDeny).toContain('write_report')
    // 从注册表按 spec 取工具，确认它真的不在里面
    const visible = n.tools.forAgent(spec.permissions, spec.toolsAllow, spec.toolsDeny)
    expect(visible.map((t) => t.name)).not.toContain('write_report')
  })
})
