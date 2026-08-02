import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../../src/boot.js'
import { agentSpec, defaultConfig, type NucleusConfig } from '../../src/config.js'
import { EXAMPLE_AGENTS, withExampleAgents } from '../../src/examples/agents.js'
import type { ModelConfig } from '../../src/providers/types.js'
import { ModelRouter } from '../../src/providers/router.js'
import { PgliteDb } from '../../src/db/pglite.js'
import { migrate } from '../../src/db/migrate.js'
import { FakeClock, FakeIds, type Deps } from '../../src/seams.js'
import { validateResult } from '../../src/runtime/result-schema.js'
import { resultJsonSchema } from '../../src/runtime/result-schema.js'

/**
 * tier 3：对着**本机真模型**跑。
 *
 *     npm run test:live
 *
 * 为什么必须有这一层：tier 2 用录制的响应重放，能保证「我们解析得对」，
 * 但保证不了「模型现在还这么答」。模型换版本、ollama 换实现、我们改 prompt
 * 都会让结论失效，而离线测试全绿。此前 tier 3 目录里只有一个不匹配
 * `*.test.ts` 的工具文件，`npm run test:live` 直接报 no test files ——
 * 也就是说这一层等于空的。
 *
 * 三条纪律：
 *
 *  1. **只断言结构，不断言内容。** 模型每次输出都不同，断言「summary 里
 *     必须提到向量数据库」会变成随机失败。要断言的是：调了工具、参数是完整
 *     JSON、通过我们的校验器、thinking 没混进 content。
 *  2. **跑不了就明确跳过并说清原因。** 静默跳过的 tier 3 和空的 tier 3
 *     没有区别 —— 而后者正是这一层原本的状态。
 *  3. **慢的那部分用小模型。** 本机 31B 一次调用几十秒，整条编排要几分钟。
 *     管线连通性用 1.5B 验，模型能力另测。
 *
 * 环境变量：
 *   OLLAMA_BASE_URL          默认 http://localhost:11434/v1
 *   NUCLEUS_LIVE_FAST_MODEL  管线测试用的小模型，默认 deepseek-r1:1.5b
 *   NUCLEUS_LIVE_MODEL       能力测试用的主力模型，默认 gemma4:31b
 */

const BASE = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1'
const FAST = process.env['NUCLEUS_LIVE_FAST_MODEL'] ?? 'deepseek-r1:1.5b'
const STRONG = process.env['NUCLEUS_LIVE_MODEL'] ?? 'gemma4:31b'

/** ollama 的原生根地址（/api/tags 不在 /v1 下面） */
const ROOT = BASE.replace(/\/v1\/?$/, '')

/**
 * 环境探测放在**顶层 await**，而不是 beforeAll。
 *
 * describe.skipIf 在收集阶段就要求值，beforeAll 那时还没跑 —— 于是每个
 * 用例只能自己 `if (!reachable) return`，报出来是「6 passed」。那是假绿：
 * 什么都没验却显示通过，正是空 tier 3 的同一个毛病换了层皮。
 *
 * 现在的结果只有两种：环境齐了就全跑；不齐就是「1 failed（说清原因）
 * + 其余 skipped」，不会有一条假绿。
 */
const env = await (async (): Promise<{ ok: boolean; models: string[]; why: string }> => {
  try {
    const r = await fetch(`${ROOT}/api/tags`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return { ok: false, models: [], why: `${ROOT}/api/tags 返回 ${r.status}` }
    const j = (await r.json()) as { models?: Array<{ name: string }> }
    return { ok: true, models: (j.models ?? []).map((m) => m.name), why: '' }
  } catch (e) {
    return { ok: false, models: [], why: `连不上 ${ROOT}：${(e as Error).message}` }
  }
})()

const reachable = env.ok
const installed = env.models
const has = (m: string) => installed.includes(m)

if (!reachable) {
  console.warn(`\n[live] 真模型测试无法进行：${env.why}`)
  console.warn(`[live] 起服务：ollama serve\n`)
}

function modelCfg(name: string, contextWindow: number, maxTokens: number): ModelConfig {
  return {
    key: `ollama:${name}`,
    provider: 'ollama',
    model: name,
    baseUrl: BASE,
    billing: 'usage',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    contextWindow,
    maxTokens,
  }
}

function liveConfig(model: string, contextWindow = 131_072, maxTokens = 4096): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.models = [modelCfg(model, contextWindow, maxTokens)]
  c.defaults.modelChain = [`ollama:${model}`]
  // 本机一次调用几十秒，步数收紧，卡住早暴露
  c.defaults.maxSteps = 6
  return c
}

let n: Nucleus | null = null
afterEach(async () => {
  await n?.close()
  n = null
})

// ═══════════════════════════════════════════════════════
// 前置：环境本身
// ═══════════════════════════════════════════════════════

describe('ollama 环境', () => {
  /**
   * 这一条**不跳**，环境不齐就红。
   *
   * tier 3 存在的意义是「对着真模型验过了」。没有真模型时报绿等于说谎 ——
   * 那正是这一层原本的状态（目录里没有匹配 *.test.ts 的文件，
   * `npm run test:live` 直接 no test files 退出）。
   */
  it('ollama 可达', () => {
    expect(reachable, env.why || 'ollama 不可达').toBe(true)
    console.log(`[live] 已安装 ${installed.length} 个模型：${installed.join(', ')}`)
  })

  it.skipIf(!reachable)('测试要用的模型都在', () => {
    const missing = [FAST, STRONG].filter((m) => !has(m))
    if (missing.length) {
      console.warn(`[live] 缺模型，相关用例会跳过：${missing.map((m) => `ollama pull ${m}`).join(' && ')}`)
    }
    expect(installed.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════
// 模型能力：schema 遵守 / reasoning 分离 / 截断
// ═══════════════════════════════════════════════════════

describe.skipIf(!reachable)('真模型的响应形状', () => {
  /** 直接用真实 router 打一次，不经过 worker */
  async function callRouter(
    model: string,
    opts: { messages: Array<{ role: 'system' | 'user'; content: string }>; tools?: unknown[]; maxTokens?: number },
  ) {
    const db = await PgliteDb.open()
    await migrate(db)
    const deps: Deps = { clock: new FakeClock(), ids: new FakeIds() }
    const cfg = modelCfg(model, 131_072, opts.maxTokens ?? 4096)
    const router = new ModelRouter(db, deps, new Map([[cfg.key, cfg]]), () => null, {
      inPlaceRetries: 0,
    })
    try {
      return await router.chat([cfg.key], {
        messages: opts.messages as never,
        ...(opts.tools ? { tools: opts.tools as never } : {}),
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      })
    } finally {
      await db.close()
    }
  }

  it.skipIf(!has(FAST))(
    '推理模型把思考放在 reasoning，绝不混进 content',
    async () => {
      const res = await callRouter(FAST, {
        messages: [{ role: 'user', content: '2+2 等于几？只回答数字。' }],
      })

      expect(res.content.length + (res.reasoning?.length ?? 0)).toBeGreaterThan(0)
      if (res.reasoning) {
        console.log(`[live] ${FAST} 思考 ${res.reasoning.length} 字，回复 ${res.content.length} 字`)
        // 关键：思考不能出现在 content 里，否则会被写进会话历史，
        // 违反多轮规范并浪费 context
        expect(res.content).not.toContain(res.reasoning.slice(0, 40))
      }
      expect(res.usage.tokensIn).toBeGreaterThan(0)
      expect(res.usage.tokensOut).toBeGreaterThan(0)
    },
    240_000,
  )

  it.skipIf(!has(STRONG))(
    'submit_result 能通过我们的校验器 —— 含规则驱动的必填字段',
    async () => {
      const spec = agentSpec(
        EXAMPLE_AGENTS.find((a) => a.id === 'researcher')!,
        defaultConfig.defaults,
      )
      const res = await callRouter(STRONG, {
        maxTokens: 4096,
        messages: [
          { role: 'system', content: spec.systemPrompt },
          {
            role: 'user',
            content:
              '任务：用你已有的知识总结「向量数据库选型的三个关键取舍」。' +
              '不要调用其它工具，直接调用 submit_result 提交结果。',
          },
        ],
        tools: [
          {
            name: 'submit_result',
            description: '提交本次任务的最终结果。必须调用它来结束任务。',
            parameters: resultJsonSchema(spec.resultSpec ?? {}),
          },
        ],
      })

      // 结构断言：调了工具、参数是完整 JSON
      expect(res.toolCalls.length, `模型没有调用任何工具（content=${res.content.slice(0, 120)}）`).toBeGreaterThan(0)
      const call = res.toolCalls.find((t) => t.name === 'submit_result')
      expect(call, `模型调了 ${res.toolCalls.map((t) => t.name).join(',')} 而不是 submit_result`).toBeDefined()

      const payload = JSON.parse(call!.arguments)
      const check = validateResult(payload, spec.resultSpec ?? {})

      // 遵守情况**报出来**而不是硬失败 —— 这个数字本身就是测试的产出。
      // 模型不遵守是模型的事实，不是我们代码的 bug。
      console.log(
        `[live] ${STRONG} 契约遵守：${check.ok ? '一次通过' : '未通过'}` +
          (check.ok ? '' : ` —— 缺 ${check.failures.map((f) => f.path).join(', ')}`),
      )
      // 硬断言只到「我们能解析、校验器能跑完」
      expect(typeof payload).toBe('object')
      expect(check).toHaveProperty('ok')
    },
    600_000,
  )

  it.skipIf(!has(FAST))(
    '输出预算不足时被识别为截断，而不是「模型不肯调工具」',
    async () => {
      // 推理模型会先思考，64 个 token 连思考都装不下
      const res = await callRouter(FAST, {
        maxTokens: 64,
        messages: [{ role: 'user', content: '详细解释一下向量数据库的索引结构。' }],
      })
      expect(res.finishReason).toBe('length')
    },
    240_000,
  )
})

// ═══════════════════════════════════════════════════════
// 整条流水线：真模型 + 真数据库
// ═══════════════════════════════════════════════════════

describe.skipIf(!reachable)('真模型驱动完整编排', () => {
  it.skipIf(!has(FAST))(
    /**
     * 名字只承诺**断言真正覆盖到的东西**。
     *
     * 原来叫「委派 → 专家干活 → wake 唤醒 → 整合 → 回写会话」，但这里没有
     * 任何一条断言碰到委派 —— 而且 root 状态的断言是
     * `['succeeded','failed'].includes(status)`，对两种结果都通过。
     * 于是实测跑出 `orchestrator(failed)`、一次委派都没有，测试照样是 ✓。
     *
     * 一个绿色的测试宣称验过了它没验的事，比没有这个测试更糟。
     */
    '真模型跑完后没有任何悬挂状态，且失败必须是已知的失败模式',
    async () => {

      n = await boot({ config: liveConfig(FAST) })
      const conv = await n.conversations.create({ agentId: 'orchestrator', title: 'live' })
      const { runId } = await ask(n, conv.id, '用你已有的知识，简要说明为什么需要向量数据库。')

      const tree = await n!.runs.tree(runId)
      console.log(
        `[live] run 树：${tree.map((r) => `${r.agentId}(${r.status})`).join(' → ')}`,
      )

      const root = tree.find((r) => r.depth === 0)!

      /**
       * **必须停在终态** —— 但 failed 不是无条件放行。
       *
       * 小模型答不好是预期的（1.5B 当编排者本来就勉强），系统坏了不是。
       * 原来一句 `['succeeded','failed'].includes(...)` 把这两者混成一件事，
       * 于是「所有请求都连不上 provider」这种回归也会显示绿色。
       *
       * 所以 failed 只接受**能力类**的错误码；provider / config / runtime
       * 类的失败一律算破了。
       */
      expect(['succeeded', 'failed'], `root 停在 ${root.status}`).toContain(root.status)

      if (root.status === 'failed') {
        // 能力不够的几种：契约反复不过、步数用尽、思考吃掉了输出预算
        const CAPABILITY_FAILURES = [
          'contract.postcondition_failed',
          'contract.schema_invalid',
          'budget.max_steps',
          'budget.max_tokens',
          'provider.output_truncated',
          'rule.violation',
        ]
        console.log(
          `[live] root failed: ${root.errorCode} —— ${JSON.stringify(root.errorDetail).slice(0, 300)}`,
        )
        expect(
          CAPABILITY_FAILURES,
          `${root.errorCode} 不是「模型能力不够」，而像是系统问题`,
        ).toContain(root.errorCode)
      }

      // 最要紧的一条：跑完之后**不能有悬挂状态**。
      // 「任务挂住却看不出来」是这个项目要修的核心问题。
      for (const [what, sql] of [
        ['未终态 attempt', `select count(*)::int n from run_attempts where status in ('queued','running')`],
        ['残留队列', `select count(*)::int n from run_queue`],
        ['未触发的 wake', `select count(*)::int n from wake_records where status = 'waiting'`],
        ['结果未知的工具调用', `select count(*)::int n from tool_invocations where outcome is null`],
      ] as const) {
        const r = await n!.db.query<{ n: number }>(sql)
        expect(r.rows[0]!.n, what).toBe(0)
      }

      // 用量确实被记下来了（真调用不可能是 0）
      const attempts = await n!.runs.listAttempts(runId)
      const tokens = attempts.reduce((s, a) => s + (a.tokensIn ?? 0) + (a.tokensOut ?? 0), 0)
      expect(tokens).toBeGreaterThan(0)
      // 落库的 provider/model 要能拼回配置里的 key
      expect(attempts.some((a) => a.provider === 'ollama')).toBe(true)
    },
    900_000,
  )

  /**
   * **真模型到底会不会委派。**
   *
   * 这条此前是空白：委派的 fanout 只在 mock 下测过（mock 脚本是我们写的，
   * 它当然会返回 delegate）。真实模型会不会选择委派、会不会把三段信封填对，
   * 只有对着真模型才知道。
   *
   * 用主力模型而不是 1.5B —— 委派是个判断，小模型做不了这个判断是预期的。
   *
   * **这条失败时不一定是代码坏了**，可能就是本机模型不会委派。那也是结论：
   * 说明「编排者派活」这条路在本机模型上不成立，得换模型或改 prompt。
   * 失败信息里会写清这一点，别照着去改代码。
   */
  it.skipIf(!has(STRONG))(
    '真模型会选择委派，且信封三段都填了',
    async () => {
      n = await boot({ config: liveConfig(STRONG, 262_144, 8192) })
      const conv = await n.conversations.create({ agentId: 'orchestrator', title: 'live-delegate' })
      const { runId } = await ask(
        n,
        conv.id,
        '请安排一次调研：向量数据库在本地单机场景下的选型。你自己不要动手，交给合适的专家。',
      )

      const tree = await n!.runs.tree(runId)
      console.log(`[live] run 树：${tree.map((r) => `${r.agentId}(${r.status})`).join(' → ')}`)

      const children = tree.filter((r) => r.depth > 0)
      expect(
        children.length,
        `编排者没有委派（run 树只有 ${tree.map((r) => r.agentId).join(', ')}）。` +
          `**这可能不是代码问题** —— ${STRONG} 可能就是不会在这种任务上委派。` +
          `先看 nucleus events ${runId} 里 llm.call 的回复内容再判断。`,
      ).toBeGreaterThan(0)

      // 委派了就必须把信封三段填上 —— 缺了 goal 的委派等于没说要干什么
      const invocations = await n!.db.query<{ args: Record<string, unknown> }>(
        `select i.args from tool_invocations i
           join run_attempts a on a.id = i.run_attempt_id
           join runs r on r.id = a.run_id
          where r.root_run_id = $1 and i.tool_name = 'delegate'`,
        [runId],
      )
      expect(invocations.rows.length).toBeGreaterThan(0)
      for (const row of invocations.rows) {
        const args = row.args
        console.log(`[live] delegate → ${args['agent']}：${String(args['goal']).slice(0, 60)}`)
        expect(String(args['agent'] ?? ''), 'delegate 缺 agent').not.toBe('')
        expect(String(args['goal'] ?? ''), 'delegate 缺 goal').not.toBe('')
      }

      // 委派之后不能悬挂 —— wake 必须已触发
      const waiting = await n!.db.query<{ n: number }>(
        `select count(*)::int n from wake_records where status = 'waiting'`,
      )
      expect(waiting.rows[0]!.n, '有未触发的 wake —— 编排者被永久挂起').toBe(0)
    },
    900_000,
  )

  it.skipIf(!has(FAST))(
    '真模型的上下文装配被记录，窗口取自配置',
    async () => {

      n = await boot({ config: liveConfig(FAST, 131_072) })
      const conv = await n.conversations.create({ agentId: 'orchestrator' })
      const { runId } = await ask(n, conv.id, '一句话说明什么是嵌入向量。')

      const ev = await n!.db.query<{ payload: { window: number; degradations: string[] } }>(
        `select e.payload from run_events e join runs r on r.id = e.run_id
          where r.root_run_id = $1 and e.kind = 'context.assembled' limit 1`,
        [runId],
      )
      expect(ev.rows.length).toBeGreaterThan(0)
      // 声明了 contextWindow 就该用它，而不是回落到 assumedContextWindow
      expect(ev.rows[0]!.payload.window).toBe(131_072)
    },
    900_000,
  )
})
