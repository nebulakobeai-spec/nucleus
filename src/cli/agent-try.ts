import { execFileSync } from 'node:child_process'
import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { parseAgentFile } from '../config/agent-files.js'
import type { AgentConfig, NucleusConfig } from '../config.js'
import { c, duration, heading, ICON, line, strFlag, resolveDb } from './ui.js'
import { compactTokens } from './pet.js'
import type { ModelConfig } from '../providers/types.js'

/**
 * `nucleus agent try` —— 只跑一个专家，不经编排者、不委派。
 *
 * 为什么必须有：以前试一个专家只能跑整条编排，几分钟一轮，而且结果不好时
 * **分不清是谁的问题** —— 编排者派错了？任务信封写得烂？还是这个专家自己
 * 不行？把变量降到一个，循环才有意义。
 *
 * ── 关于「怎么保证新版比旧版好」──────────────────────────
 *
 * 保证不了。单跑一次证明不了任何事（模型有随机性），三道题上更好的定义在
 * 第四道题上可能更差。所以这个命令承诺的不是「证明改进」，而是
 * **让退步无法悄悄溜过去**：
 *
 *  - `--n` 重复跑取通过率 —— 一次是噪音
 *  - `--compare <git-ref>` 与旧版并排 —— 在**不同任务**上比两个定义，
 *    「更好」这个词没有意义，所以必须同一批题
 *  - **权限面变宽直接标红** —— 纯静态、零成本、零噪音，能挡一大类真实退步
 *  - 越权尝试次数 —— 它想调没权限的工具，说明 prompt 与权限不匹配
 *
 * 能自动判的到此为止。**答案内容好不好这个命令判不了** ——
 * 要么你自己读（`nucleus artifact cat`），要么将来用裁判 agent 按信封里的
 * `acceptance` 打分。这条限制会在输出里说明，不假装。
 */

const MOCK_MODEL: ModelConfig = {
  key: 'mock:local',
  provider: 'mock',
  model: 'mock',
  baseUrl: 'http://mock.invalid/v1',
  billing: 'usage',
  costPerMTokIn: 0,
  costPerMTokOut: 0,
}

export interface RunStat {
  ok: boolean
  /** 契约被退回几次；0 表示一次过 */
  rejections: number
  steps: number
  tokens: number
  ms: number
  /** 想调但没权限的工具 */
  denied: string[]
  artifacts: number
  errorCode: string | null
}

export interface TryReport {
  agentId: string
  permissions: string[]
  runs: RunStat[]
}

export function summarize(runs: RunStat[]) {
  const n = runs.length || 1
  const clean = runs.filter((r) => r.ok && r.rejections === 0).length
  return {
    total: runs.length,
    clean,
    failed: runs.filter((r) => !r.ok).length,
    rate: clean / n,
    steps: runs.reduce((s, r) => s + r.steps, 0) / n,
    tokens: Math.round(runs.reduce((s, r) => s + r.tokens, 0) / n),
    ms: Math.round(runs.reduce((s, r) => s + r.ms, 0) / n),
    denied: runs.reduce((s, r) => s + r.denied.length, 0),
  }
}

/**
 * 跑一次：直接建一个属于该 agent 的 root run。
 *
 * 关键是**不建 conversation** —— 子 run 没有对外身份是结构性的，
 * 这里也保持一致：试跑不该往会话里写东西。
 */
async function runOnce(n: Nucleus, agent: AgentConfig, task: string): Promise<RunStat> {
  const t0 = Date.now()
  const run = await n.runs.createRun({
    agentId: agent.id,
    // 任务信封：goal 用你给的任务，另两段说明这是试跑
    input: {
      goal: task,
      context: '这是 nucleus agent try 的单独试跑，没有上游上下文。',
      acceptance: '按你的职责完成并调用 submit_result 提交。',
    },
  })
  await n.runs.enqueueAttempt(run.id)
  await n.worker.drain(50)

  const after = await n.runs.getRun(run.id)
  const attempts = await n.runs.listAttempts(run.id)

  const ev = await n.db.query<{ kind: string; payload: Record<string, unknown> }>(
    `select e.kind, e.payload from run_events e where e.run_id = $1 order by e.id`,
    [run.id],
  )
  const rejections = ev.rows.filter((e) => e.kind === 'contract.rejected').length
  // 「想调但没权限」= 模型调了一个它看不到的工具。runner 会回 tool.denied
  const denied = ev.rows
    .filter((e) => e.kind === 'tool.outcome' && e.payload['errorCode'] === 'tool.denied')
    .map((e) => String(e.payload['tool']))

  const arts = await n.db.query<{ n: number }>(
    `select count(*)::int n from artifacts where run_id = $1`,
    [run.id],
  )

  return {
    ok: after?.status === 'succeeded',
    rejections,
    steps: attempts.reduce((s, a) => s + (a.stepsUsed ?? 0), 0),
    tokens: attempts.reduce((s, a) => s + (a.tokensIn ?? 0) + (a.tokensOut ?? 0), 0),
    ms: Date.now() - t0,
    denied,
    artifacts: arts.rows[0]?.n ?? 0,
    errorCode: after?.errorCode ?? null,
  }
}

/** 从 git 取出某个 ref 下的 agent 定义 */
function agentFromGit(ref: string, path: string): AgentConfig | null {
  try {
    const text = execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseAgentFile(path, text).agent ?? null
  } catch {
    return null
  }
}

/** 相对仓库根的路径 —— git show 需要它 */
function repoRelative(abs: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return abs.startsWith(root) ? abs.slice(root.length + 1) : null
  } catch {
    return null
  }
}

async function runBatch(
  cfg: NucleusConfig,
  agent: AgentConfig,
  tasks: string[],
  times: number,
  flags: Record<string, string | true>,
): Promise<RunStat[]> {
  // 用只含这一个 agent 的配置 —— 试跑不该被别的 agent 干扰，
  // 也不该有 delegate（无目标时它不注册）
  const solo: NucleusConfig = {
    ...cfg,
    agents: [agent],
    defaults: { ...cfg.defaults, entryAgent: agent.id },
  }
  const useMock = flags['mock'] === true || process.env['NUCLEUS_MOCK'] === '1'
  const n = await boot({
    config: useMock
      ? { ...solo, defaults: { ...solo.defaults, modelChain: ['mock:local'] }, models: [MOCK_MODEL, ...solo.models.filter((m) => m.key !== MOCK_MODEL.key)] }
      : solo,
    ...resolveDb(flags),
    skipMcp: flags['mcp'] !== true,
    // 空脚本：任何 agent 都走到默认的 submit 兜底。
    // 这只验「定义能不能加载、权限对不对、契约跑不跑」——
    // **不能当评估用**，输出里会说明
    ...(useMock ? { mock: {} } : {}),
  })
  const out: RunStat[] = []
  try {
    for (let i = 0; i < times; i++) {
      for (const t of tasks) out.push(await runOnce(n, agent, t))
    }
  } finally {
    await n.close()
  }
  return out
}

export async function agentTry(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const id = argv[0]
  if (!id) {
    line(c.red('用法：nucleus agent try <id> ["任务"] [--n 5] [--compare HEAD~1]'))
    line(c.gray('  不给任务就用 agents/<id>.cases.md 里的试题集'))
    return 1
  }

  const loaded = await loadConfig(strFlag(flags, 'config'))
  const { config, agentSources, cases } = loaded
  const agent = config.agents.find((a) => a.id === id)
  if (!agent) {
    line(c.red(`没有 agent「${id}」`))
    line(c.gray(`现有：${config.agents.map((a) => a.id).join(', ')}`))
    return 1
  }

  const explicit = argv.slice(1).join(' ').trim()
  const tasks = explicit ? [explicit] : (cases[id] ?? [])
  if (tasks.length === 0) {
    line(c.red(`没有任务可跑`))
    line(c.gray(`  给一个：nucleus agent try ${id} "一个任务"`))
    line(c.gray(`  或写进 agents/${id}.cases.md —— 固定试题集才能做版本对比`))
    return 1
  }

  const times = Number(strFlag(flags, 'n') ?? 1)
  const compare = strFlag(flags, 'compare')

  const useMock = flags['mock'] === true || process.env['NUCLEUS_MOCK'] === '1'
  heading(`试跑 ${id}`)
  line(c.gray(`${tasks.length} 道题 × ${times} 次 = ${tasks.length * times} 次运行`))
  if (useMock) {
    // mock 的数字看起来像评估结果，但它什么模型都没调过
    line(
      `${ICON.warn} ${c.yellow('mock 模式：只验定义能不能加载、权限对不对、契约跑不跑')}`,
    )
    line(c.gray('     下面的通过率与步数**不是**对这个专家的评估 —— 没有模型参与'))
  }
  if (times === 1 && !compare) {
    // 说清一次跑的局限，否则「跑过了」会被当成「没问题」
    line(
      `${ICON.warn} ${c.yellow('单次结果是噪音')}` +
        c.gray(' —— 模型有随机性。用 --n 5 取通过率，--compare HEAD~1 与旧版并排'),
    )
  }
  line()

  const now = await runBatch(config, agent, tasks, times, flags)
  const cur = summarize(now)

  // ── 对比旧版 ──
  let old: ReturnType<typeof summarize> | null = null
  let oldAgent: AgentConfig | null = null
  if (compare) {
    const src = agentSources[id]
    const rel = src && !src.startsWith('(') ? repoRelative(src) : null
    if (!rel) {
      line(`${ICON.warn} ${id} 不是仓库里的 md 文件，无法与 ${compare} 对比`)
      line(c.gray('  只有 agents/*.md 能做版本对比 —— 这也是它该进 git 的理由'))
    } else {
      oldAgent = agentFromGit(compare, rel)
      if (!oldAgent) {
        line(`${ICON.warn} ${compare} 下没有 ${rel}（可能是新加的）`)
      } else {
        old = summarize(await runBatch(config, oldAgent, tasks, times, flags))
      }
    }
  }

  printReport(id, agent, cur, old, oldAgent)
  return 0
}

function printReport(
  id: string,
  agent: AgentConfig,
  cur: ReturnType<typeof summarize>,
  old: ReturnType<typeof summarize> | null,
  oldAgent: AgentConfig | null,
): void {
  const rows: Array<[string, string, string, 'up' | 'down' | 'same' | null]> = []
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`

  const add = (
    label: string,
    curV: string,
    oldV: string | null,
    better: 'higher' | 'lower',
    curN: number,
    oldN: number | null,
  ) => {
    let dir: 'up' | 'down' | 'same' | null = null
    if (oldN !== null) {
      const d = curN - oldN
      dir = d === 0 ? 'same' : (better === 'higher') === d > 0 ? 'up' : 'down'
    }
    rows.push([label, curV, oldV ?? '', dir])
  }

  add('契约一次过', `${cur.clean}/${cur.total}（${pct(cur.rate)}）`,
    old ? `${old.clean}/${old.total}（${pct(old.rate)}）` : null, 'higher', cur.rate, old?.rate ?? null)
  add('失败', String(cur.failed), old ? String(old.failed) : null, 'lower', cur.failed, old?.failed ?? null)
  add('平均步数', cur.steps.toFixed(1), old ? old.steps.toFixed(1) : null, 'lower', cur.steps, old?.steps ?? null)
  add('平均 token', compactTokens(cur.tokens), old ? compactTokens(old.tokens) : null, 'lower', cur.tokens, old?.tokens ?? null)
  add('平均耗时', duration(cur.ms), old ? duration(old.ms) : null, 'lower', cur.ms, old?.ms ?? null)
  add('越权尝试', String(cur.denied), old ? String(old.denied) : null, 'lower', cur.denied, old?.denied ?? null)

  heading(old ? '当前 vs 旧版' : '结果')
  const w = Math.max(...rows.map((r) => r[0].length)) + 2
  for (const [label, curV, oldV, dir] of rows) {
    const mark = dir === 'up' ? c.green('↑') : dir === 'down' ? c.red('↓') : dir === 'same' ? c.gray('=') : ''
    line(`  ${label.padEnd(w)} ${curV.padEnd(16)}${oldV ? c.gray(oldV.padEnd(16)) : ''}${mark}`)
  }

  // ── 权限面：静态检查，最值钱的一条 ──
  if (oldAgent) {
    const now = new Set(agent.permissions ?? [])
    const before = new Set(oldAgent.permissions ?? [])
    const added = [...now].filter((p) => !before.has(p))
    const removed = [...before].filter((p) => !now.has(p))
    line()
    if (added.length) {
      // 不管试题跑得多好，权限变宽都是退步
      line(`${ICON.fail} ${c.red(`权限面变宽：+${added.join(', ')}`)}`)
      line(c.gray('  这是纯静态的退步信号 —— 与试题表现无关。确认真的需要吗？'))
    }
    if (removed.length) line(`${ICON.ok} 权限收紧：-${removed.join(', ')}`)
    if (!added.length && !removed.length) line(c.gray(`权限面不变：${[...now].join(', ') || '（无）'}`))
  } else {
    line()
    line(c.gray(`权限：${(agent.permissions ?? []).join(', ') || '（无）'}`))
  }

  if (cur.denied > 0) {
    line()
    line(
      `${ICON.warn} ${c.yellow(`${cur.denied} 次越权尝试`)}` +
        c.gray(' —— 它想调没权限的工具，说明 prompt 与 permissions 不匹配'),
    )
  }

  // ── 这个命令判不了什么，说清楚 ──
  line()
  line(c.gray('以上都是可自动判定的。**答案内容好不好判不了** ——'))
  line(c.gray(`读产出：nucleus artifact list · 看过程：nucleus runs`))
  if (!old) {
    line(c.gray('与旧版并排：nucleus agent try ' + id + ' --compare HEAD~1 --n 5'))
  }
}
