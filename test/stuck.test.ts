import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { findStuckRuns, findUnknownToolOutcomes } from '../src/runtime/stuck.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 「有 run 挂住了吗」。
 *
 * ── 这一组为什么必须在**普通**测试里，而不是 live 里 ──────────
 *
 * 这段判据原来住在 `test/live/ollama.test.ts`，而那个文件在开发机上跑不了
 * （Node 出网是 EPERM）。结果它引用了两个**根本不存在的列** ——
 * `tool_invocations.args`（真名 `args_json`）与 `run_queue.run_attempt_id`
 * （那张表的键是 `(run_id, attempt_no)`）—— 一路带到部署机才炸，而且炸了两轮。
 *
 * **跑不到的代码不该放判据。**
 *
 * ── 判据本身容易写错 ─────────────────────────────────────
 *
 * 直觉写法是「队列必须空」「不能有 waiting 的 wake」，但那会把**正确的行为**
 * 报成故障：`waiting_retry` 的 run 队列里本来就该有一条未来才可执行的记录，
 * `waiting_children` 的 run 本来就该有一条 waiting 的 wake。
 *
 * 真正的故障形状只有一个：非终态，但既没有排队、也没有在等还活着的子 run。
 */

const SCRIPT: MockScript = {
  orchestrator: [{ submit: { status: 'ok', summary: '好了', artifacts: [] } }],
}

function config(): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  return c
}

let n: Nucleus

beforeEach(async () => {
  n = await boot({
    config: config(),
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    mock: SCRIPT,
  })
})

afterEach(async () => {
  await n.close()
  n = null as unknown as Nucleus
})

describe('findStuckRuns', () => {
  it('正常跑完的树没有挂住的 run', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '一个问题')
    expect(await findStuckRuns(n.db, runId)).toEqual([])
    expect(await findStuckRuns(n.db)).toEqual([])
  })

  /**
   * 这条是最要紧的：**已排好重试的 run 不算挂住**。
   * 按「队列必须空」去判会把它误报，而那正是我第一版写的判据。
   */
  it('waiting_retry + 队列里有未来的记录 → 不算挂住', async () => {
    const run = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'x' } })
    // 排一个「一小时后才可执行」的 attempt
    await n.runs.enqueueAttempt(run.id, { availableAt: new Date(Date.now() + 3600_000) })
    await n.db.query(`update runs set status = 'waiting_retry' where id = $1`, [run.id])

    expect(await findStuckRuns(n.db, run.id)).toEqual([])
  })

  /** 同理：等着还活着的子 run 也不算挂住 */
  it('waiting_children + 子 run 还活着 → 不算挂住', async () => {
    const parent = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'p' } })
    const child = await n.runs.createRun({
      agentId: 'researcher',
      parentRunId: parent.id,
      depth: 1,
      input: { goal: 'c' },
    })
    await n.runs.enqueueAttempt(child.id)
    await n.db.query(`update runs set status = 'waiting_children' where id = $1`, [parent.id])

    const stuck = await findStuckRuns(n.db, parent.id)
    // parent 在等 child；child 在队列里 —— 两个都不算挂住
    expect(stuck).toEqual([])
  })

  /** 真的挂住：非终态，队列空，也没有活着的子 run */
  it('非终态 + 队列空 + 没有活着的子 run → 挂住了', async () => {
    const run = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'x' } })
    await n.db.query(`update runs set status = 'waiting_children' where id = $1`, [run.id])

    const stuck = await findStuckRuns(n.db, run.id)
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatchObject({ agentId: 'orchestrator', status: 'waiting_children' })
  })

  it('子 run 都终态了而 parent 还挂着 → 挂住了（wake 没被触发）', async () => {
    const parent = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'p' } })
    const child = await n.runs.createRun({
      agentId: 'researcher',
      parentRunId: parent.id,
      depth: 1,
      input: { goal: 'c' },
    })
    await n.db.query(`update runs set status = 'succeeded', ended_at = now() where id = $1`, [child.id])
    await n.db.query(`update runs set status = 'waiting_children' where id = $1`, [parent.id])

    const stuck = await findStuckRuns(n.db, parent.id)
    expect(stuck.map((s) => s.agentId)).toEqual(['orchestrator'])
  })

  it('带上最后一次 attempt 的错误码 ——「为什么停在这」的第一条线索', async () => {
    const run = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'x' } })
    const a = await n.runs.enqueueAttempt(run.id)
    const claimed = await n.runs.claimNext('w1', 60_000)
    await n.runs.finishAttempt({
      attemptId: claimed!.id,
      fenceToken: claimed!.fenceToken!,
      status: 'failed',
      errorCode: 'provider.timeout',
    })
    // 人为把 run 拨回非终态并清空队列，制造「挂住」
    await n.db.query(`update runs set status = 'waiting_retry', ended_at = null where id = $1`, [run.id])
    await n.db.query(`delete from run_queue where run_id = $1`, [run.id])
    expect(a.id).toBeTruthy()

    const stuck = await findStuckRuns(n.db, run.id)
    expect(stuck[0]!.lastErrorCode).toBe('provider.timeout')
  })

  it('不给 rootRunId 时扫全库', async () => {
    const r1 = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'a' } })
    const r2 = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'b' } })
    await n.db.query(`update runs set status = 'waiting_children' where id in ($1, $2)`, [r1.id, r2.id])
    expect((await findStuckRuns(n.db)).length).toBe(2)
  })
})

describe('findUnknownToolOutcomes', () => {
  it('正常跑完的树没有未知结果', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '一个问题')
    expect(await findUnknownToolOutcomes(n.db, runId)).toEqual([])
  })

  /**
   * run 还在跑时，「意图已写、结果未回」是正常状态 —— 只有 run 到了终态
   * 还留着未知结果才是问题。这条区分很重要：否则每次查都会有假阳性。
   */
  it('run 还没终态时不报 —— 那时未知结果是正常的', async () => {
    const run = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'x' } })
    await n.runs.enqueueAttempt(run.id)
    const claimed = await n.runs.claimNext('w1', 60_000)
    await n.runs.recordIntent({
      runAttemptId: claimed!.id,
      seq: 1,
      toolName: 'write_file',
      argsHash: 'h',
      sideEffectClass: 'non_idempotent',
    })
    // run 仍是 running
    expect(await findUnknownToolOutcomes(n.db, run.id)).toEqual([])
  })

  it('run 到终态还留着未知结果 → 报出来，并带上副作用等级', async () => {
    const run = await n.runs.createRun({ agentId: 'orchestrator', input: { goal: 'x' } })
    await n.runs.enqueueAttempt(run.id)
    const claimed = await n.runs.claimNext('w1', 60_000)
    await n.runs.recordIntent({
      runAttemptId: claimed!.id,
      seq: 1,
      toolName: 'write_file',
      argsHash: 'h',
      sideEffectClass: 'non_idempotent',
    })
    await n.runs.finishAttempt({
      attemptId: claimed!.id,
      fenceToken: claimed!.fenceToken!,
      status: 'failed',
      errorCode: 'runtime.worker_died',
    })

    const unknown = await findUnknownToolOutcomes(n.db, run.id)
    expect(unknown).toHaveLength(1)
    // non_idempotent 的未知结果是「绝不能自动重跑」的那一类
    expect(unknown[0]).toMatchObject({ toolName: 'write_file', sideEffectClass: 'non_idempotent' })
  })
})
