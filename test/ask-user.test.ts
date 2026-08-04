import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { ConversationBusyError } from '../src/store/conversations.js'

/**
 * `ask_user` —— 编排者反问用户。
 *
 * ── 为什么这个工具之前不存在 ────────────────────────────
 *
 * `user` 权限（「直接向用户提问」）从一开始就声明着，而**没有任何工具用它** ——
 * 「声明了但没接线」的又一个实例。后果是需求含糊时编排者只能猜，
 * 而猜错要跑完整条委派链才看得出来。
 *
 * ── 与 delegate 同构 ───────────────────────────────
 *
 * attempt 正常终结、逻辑 run 转 `waiting_user`、**不占进程不占 context**。
 * 用户下一条消息就是唤醒信号。等人回答可能要几小时，
 * 让一个进程挂在那里等是不可接受的。
 */

let n: Nucleus

const cfg = () => {
  const c = structuredClone(defaultConfig)
  c.defaults.modelChain = ['mock:local']
  return c
}

/** 编排者：先问一句，用户答完之后提交结果 */
const askThenSubmit = (question: string) => ({
  orchestrator: [
    { tool: { name: 'ask_user', args: { question, why: '这决定接下来怎么做' } } },
    { submit: { status: 'ok', summary: '按你说的做完了', artifacts: [] } },
  ],
})

afterEach(async () => {
  await n?.close()
  n = null as unknown as Nucleus
})

describe('问一句，挂起', () => {
  beforeEach(async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: askThenSubmit('你说的「报告」是指 PDF 还是 Markdown？'),
    })
  })

  it('run 停在 waiting_user，attempt 正常终结', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '给我写份报告')

    const run = await n.runs.getRun(runId)
    expect(run!.status).toBe('waiting_user')

    // attempt 是**成功**结束的 —— 提问不是失败
    const attempts = await n.db.query<{ status: string }>(
      `select status from run_attempts where run_id = $1`,
      [runId],
    )
    expect(attempts.rows.map((r) => r.status)).toEqual(['succeeded'])

    // 队列里没有东西在跑 —— 不占进程
    const q = await n.db.query<{ n: number }>(`select count(*)::int n from run_queue`)
    expect(q.rows[0]!.n).toBe(0)
  })

  /**
   * **等待中的 run 不该有结束时间。**
   *
   * 顺序是 runner 先 finishAttempt（succeeded → 终态 → 写 ended_at），
   * worker 之后才发现「还得等」。原先 armWake 只改 status 不清 ended_at，
   * 于是等待中的 run 带着结束时间，而 bundle 会显示出来。
   */
  it('ended_at 被清掉 —— 它还没结束', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '给我写份报告')
    expect((await n.runs.getRun(runId))!.endedAt).toBeNull()
  })

  it('问题作为 assistant 消息进会话 —— 那是用户真正看到的东西', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '给我写份报告')

    const msgs = await n.conversations.recent(conv.id)
    const last = msgs[msgs.length - 1]!
    expect(last.role).toBe('assistant')
    expect(last.content).toMatch(/PDF 还是 Markdown/)
    // why 也要给用户看到 —— 不然他不知道值不值得回答
    expect(last.content).toMatch(/这决定接下来怎么做/)
  })

  it('提问原文落在 wake 上，供事后对齐', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '给我写份报告')
    const w = await n.runs.pendingQuestion(runId)
    expect(w!.kind).toBe('user')
    expect(w!.question).toMatch(/PDF 还是 Markdown/)
    expect(w!.waitOnRunIds).toEqual([])
  })
})

describe('回答就是唤醒', () => {
  beforeEach(async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: askThenSubmit('PDF 还是 Markdown？'),
    })
  })

  /**
   * **这是整条设计的关键。**
   *
   * 不认出「这句是回答」的话：编排者问「A 还是 B」，你回「A」，系统会把「A」
   * 当成一个新任务开一个新 run，而原来那个永远停在 waiting_user。
   * 你会看到一个莫名其妙的回答，而真正在等的那件事再也不动。
   */
  it('下一条消息接到同一个 run 上，不开新 run', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const first = await ask(n, conv.id, '给我写份报告')
    expect(first.answered).toBe(false)

    const second = await ask(n, conv.id, 'Markdown')
    expect(second.answered).toBe(true)
    expect(second.runId).toBe(first.runId)

    // 全程只有一个 run
    const runs = await n.db.query<{ n: number }>(`select count(*)::int n from runs`)
    expect(runs.rows[0]!.n).toBe(1)

    const run = await n.runs.getRun(first.runId)
    expect(run!.status).toBe('succeeded')
  })

  it('答完之后 wake 落 fired，并记下是哪次 attempt 接手的', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '给我写份报告')
    await ask(n, conv.id, 'Markdown')

    const w = await n.db.query<{ status: string; fired_attempt_id: string | null }>(
      `select status, fired_attempt_id from wake_records where parent_run_id = $1 and kind = 'user'`,
      [runId],
    )
    expect(w.rows[0]!.status).toBe('fired')
    expect(w.rows[0]!.fired_attempt_id).toBeTruthy()
  })

  /**
   * **条件更新，不是「先查后写」。**
   *
   * 两条消息几乎同时到达时只有一条能点火。先查后写会给同一个提问排两次
   * attempt，那个 run 会把同一句回答处理两遍 —— 而它的副作用（比如委派）
   * 也会发生两遍。
   */
  it('同一个提问只能被点火一次', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '给我写份报告')
    const w = await n.runs.pendingQuestion(runId)

    expect(await n.runs.answerQuestion(w!.id)).not.toBeNull()
    expect(await n.runs.answerQuestion(w!.id)).toBeNull()
  })

  it('答完之后会话锁放开 —— 可以开新任务', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '给我写份报告')
    await ask(n, conv.id, 'Markdown')
    expect((await n.conversations.get(conv.id))!.activeRunId).toBeNull()
  })

  /**
   * 反过来：**没答完就一直占着**。会话正是为了接收那个回答才被占着的。
   * 放了锁，下一句就会开新 run，而原来那个永远等不到答案。
   */
  it('没答之前会话被占着', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '给我写份报告')
    expect((await n.conversations.get(conv.id))!.activeRunId).toBe(runId)
  })
})

describe('拦掉问不出去的提问', () => {
  /**
   * 子 run 没有 conversation（只有 root run 有对外身份），所以专家问出来的话
   * 根本没有收件人。**必须挡在 precondition**：让它静默成功的话，
   * 那个 run 会永远停在 waiting_user，而日志里看起来一切正常。
   */
  it('没有会话的 run 调 ask_user → 被拒，并告诉它该怎么做', async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [
          { tool: { name: 'ask_user', args: { question: '问一句' } } },
          { submit: { status: 'ok', summary: '好', artifacts: [] } },
        ],
      },
    })
    // 不带 conversationId 建 run —— 与子 run 同一种形状
    const run = await n.runs.createRun({ agentId: 'orchestrator' })
    await n.runs.enqueueAttempt(run.id)
    await n.worker.drain(10)

    const after = await n.runs.getRun(run.id)
    expect(after!.status).toBe('succeeded')

    /**
     * **被拒的调用不留意图记录** —— precondition 在写 intent 之前跑，
     * 「从未发生」的调用不该出现在 tool_invocations 里。它落的是
     * `rule.violation` 事件。
     */
    const ev = await n.db.query<{ payload: { tool: string } }>(
      `select payload from run_events where kind = 'rule.violation'`,
    )
    expect(ev.rows.map((r) => r.payload.tool)).toContain('ask_user')

    // 而且没有留下待答的提问 —— 那才是最坏的下场（run 永远停在 waiting_user）
    expect(await n.runs.pendingQuestion(run.id)).toBeNull()
  })

  it('一个 run 只能有一条待答的提问', async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [
          {
            tools: [
              { name: 'ask_user', args: { question: '第一个问题' } },
              { name: 'ask_user', args: { question: '第二个问题' } },
            ],
          },
          { submit: { status: 'ok', summary: '好', artifacts: [] } },
        ],
      },
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '做点什么')

    const w = await n.db.query<{ n: number }>(
      `select count(*)::int n from wake_records where parent_run_id = $1 and kind = 'user'`,
      [runId],
    )
    expect(w.rows[0]!.n).toBe(1)

    // 第二次调用被 precondition 拒掉 —— 落 rule.violation，不留意图记录
    const ev = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_events
        where kind = 'rule.violation' and payload->>'tool' = 'ask_user'`,
    )
    expect(ev.rows[0]!.n).toBe(1)
  })

  it('空 question 被拒', async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [
          { tool: { name: 'ask_user', args: { question: '   ' } } },
          { submit: { status: 'ok', summary: '好', artifacts: [] } },
        ],
      },
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '做点什么')
    const ev = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_events
        where kind = 'rule.violation' and payload->>'tool' = 'ask_user'`,
    )
    expect(ev.rows[0]!.n).toBe(1)
    expect(await n.runs.pendingQuestion(runId)).toBeNull()
  })
})

describe('会话锁', () => {
  /**
   * `conversations.acquire()` 用条件更新做好了 CAS，而**只有它自己的测试在调用**
   * —— 一直没接线。今天没出问题只是因为 CLI 与 REPL 都是串行的：
   * 一旦有并发入口（或两个终端同时对同一会话说话），就会两个 run 抢一个会话，
   * 各自往里追加消息，而**双方看到的历史都是错的**。
   */
  beforeEach(async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: askThenSubmit('哪一种？'),
    })
  })

  it('有提问在等时，另起一个 run 抢会话会被拒', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, conv.id, '给我写份报告')

    const other = await n.runs.createRun({ agentId: 'orchestrator', conversationId: conv.id })
    await expect(n.conversations.acquire(conv.id, other.id)).rejects.toThrow(ConversationBusyError)
  })

  /**
   * 抢不到锁时那个 run 要落终态。
   *
   * 不取消的话会留下一个永远 pending 的 run —— 它在 `nucleus runs` 里看起来
   * 像一个卡住的任务，而实际上没有任何东西会去推进它。
   */
  it('取消会落 cancelled 并清空队列', async () => {
    const run = await n.runs.createRun({ agentId: 'orchestrator' })
    await n.runs.enqueueAttempt(run.id)
    await n.runs.cancel(run.id, 'conversation.busy')

    const after = await n.runs.getRun(run.id)
    expect(after!.status).toBe('cancelled')
    expect(after!.errorCode).toBe('conversation.busy')

    const q = await n.db.query<{ n: number }>(`select count(*)::int n from run_queue where run_id = $1`, [
      run.id,
    ])
    expect(q.rows[0]!.n).toBe(0)
  })

  it('已经终态的 run 不会被 cancel 改写', async () => {
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '给我写份报告')
    await ask(n, conv.id, 'Markdown')
    await n.runs.cancel(runId, 'too_late')
    expect((await n.runs.getRun(runId))!.status).toBe('succeeded')
  })
})

/**
 * ── 问完必须真的停下 ────────────────────────────────
 *
 * 实测（gemma4:31b，真实模型）：
 *
 *     ⎿ ask_user ✓ 5ms
 *     ⎿ ollama:gemma4:31b · 706 tok      ← 又调了一次
 *     ⎿ ollama:gemma4:31b · 1.3k tok     ← 又一次
 *     ⎿ waiting_user contract.postcondition_failed
 *
 * 我第一版只在工具返回值里写了一句「**这一轮到此结束** —— 不要再调用其它工具，
 * 也不要 submit_result」。模型照样往下跑，最后以契约失败收尾。
 *
 * **那正是这个项目要修的第一个毛病，犯在我自己的代码里**：机制就在手边
 * （`delegate` 一直用着 `suspend: true`），而我写了一句劝告。
 * 提醒是三层里最弱的一层 —— 对模型如此，对我自己写的工具也一样。
 */
describe('问完就停', () => {
  it('ask_user 之后不再调模型 —— 哪怕脚本里还排着别的动作', async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [
          { tool: { name: 'ask_user', args: { question: '哪一种？' } } },
          // 脚本里还有两个回合。suspend 生效的话它们**这一轮**不会被消费
          { text: '我再想想' },
          { submit: { status: 'partial', summary: '信息不足', artifacts: [] } },
        ],
      },
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '做点什么')

    // 这一轮只应该有一次模型调用
    const calls = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_events
        where run_id = $1 and kind = 'llm.call.finished'`,
      [runId],
    )
    expect(calls.rows[0]!.n, '问完之后又调了模型').toBe(1)

    const run = await n.runs.getRun(runId)
    expect(run!.status).toBe('waiting_user')
    // 而且没有留下错误码 —— 提问不是失败
    expect(run!.errorCode).toBeNull()
  })

  /**
   * **挂起优先于提交。**
   *
   * 一次回复里既问又交是会发生的。原先 `submitted` 先判，于是那份
   * **在答案还没来之前**得出的结果会被写进 `runs.result`，
   * 而 bundle 与将来的前端都会读它。
   */
  it('同一次回复里既问又交 → 结果不落库，等答案回来再说', async () => {
    n = await boot({
      config: cfg(),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [
          {
            tools: [
              { name: 'ask_user', args: { question: '哪一种？' } },
              { name: 'submit_result', args: { status: 'ok', summary: '先交了', artifacts: [] } },
            ],
          },
          { submit: { status: 'ok', summary: '按你说的做完了', artifacts: [] } },
        ],
      },
    })
    const conv = await n.conversations.create({ agentId: 'orchestrator' })
    const { runId } = await ask(n, conv.id, '做点什么')

    const run = await n.runs.getRun(runId)
    expect(run!.status).toBe('waiting_user')
    expect(run!.result, '答案还没来就落了结果').toBeNull()

    // 答完之后才有结果
    await ask(n, conv.id, 'Markdown')
    const done = await n.runs.getRun(runId)
    expect(done!.status).toBe('succeeded')
    expect((done!.result as { summary: string }).summary).toBe('按你说的做完了')
  })
})
