import { ask, type Nucleus } from '../boot.js'
import { recoveryOf } from '../errors.js'
import { c, duration, heading, ICON, line, money, recoveryHint, statusColor, table } from './ui.js'

/**
 * `ask` 与 `chat` 共用的渲染逻辑。
 *
 * 抽出来是为了避免两条命令的输出格式漂移 —— 用户在 chat 里看到的
 * 和在脚本里看到的应该是同一套。
 */

export interface TurnResult {
  runId: string
  /** 助手回复；未产生回复时为 null */
  reply: string | null
  artifacts: string[]
  tokens: number
  costUsd: number
  /** 全部用订阅制模型时为 true —— 显示「订阅」而非 $0 */
  allSubscription: boolean
  elapsedMs: number
  /** run 终态与错误，用于失败时给出下一步 */
  status: string
  errorCode: string | null
}

/**
 * 跑一轮对话并把执行过程实时打印出来。
 *
 * 复用 `boot.ts` 的 `ask` 管线 —— 不新建 HTTP 层，chat 与 ask 走同一条路。
 */
export async function runTurn(n: Nucleus, conversationId: string, text: string): Promise<TurnResult> {
  const t0 = Date.now()

  const { runId } = await ask(n, conversationId, text, {
    onAttemptStart: (i) =>
      line(`${ICON.run} ${c.cyan(i.agentId)} ${c.gray(`attempt ${i.attemptNo} · run ${i.runId.slice(0, 8)}`)}`),
    onAttemptEnd: (i) => {
      const icon =
        i.status === 'succeeded' ? ICON.ok : i.status === 'waiting_children' ? ICON.info : ICON.fail
      const note = i.status === 'waiting_children' ? c.gray('（挂起，等待专家）') : ''
      line(
        `  ${icon} ${statusColor(i.status)}${note}` +
          (i.errorCode ? ` ${c.gray(i.errorCode)} ${recoveryHint(recoveryOf(i.errorCode))}` : ''),
      )
    },
  })

  // 汇总成本：订阅制模型不产生边际成本，但仍要显示 token 用量
  const tree = await n.runs.tree(runId)
  let cost = 0
  let tokens = 0
  const usedKeys = new Set<string>()
  for (const r of tree) {
    for (const a of await n.runs.listAttempts(r.id)) {
      cost += Number(a.costUsd ?? 0)
      tokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
      if (a.provider && a.model) usedKeys.add(`${a.provider}:${a.model}`)
    }
  }
  const allSubscription =
    usedKeys.size > 0 &&
    [...usedKeys].every((k) => n.config.models.find((m) => m.key === k)?.billing === 'subscription')

  const msgs = await n.conversations.recent(conversationId, 5)
  const last = msgs[msgs.length - 1]
  const reply = last?.role === 'assistant' ? last.content : null
  const run = await n.runs.getRun(runId)

  return {
    runId,
    reply,
    artifacts: last?.artifacts ?? [],
    tokens,
    costUsd: cost,
    allSubscription,
    elapsedMs: Date.now() - t0,
    status: run?.status ?? 'unknown',
    errorCode: run?.errorCode ?? null,
  }
}

/** 打印一轮的结果：回复 + 产出 + 成本行 */
export function printTurn(r: TurnResult, opts: { runCount?: number } = {}): void {
  line()
  if (r.reply) {
    line(`${c.bold('助手')} ${r.reply}`)
    if (r.artifacts.length) line(c.gray(`产出：${r.artifacts.join(', ')}`))
  } else {
    line(
      `${ICON.warn} 未产生回复；run ${statusColor(r.status)} ${c.gray(r.errorCode ?? '')} ` +
        recoveryHint(recoveryOf(r.errorCode)),
    )
    // 反复失败时给出下一步，而不是让人自己猜
    if (r.errorCode?.startsWith('contract.')) {
      line(c.gray(`  模型输出不合 schema。反复出现请导出诊断包：nucleus bundle --run ${r.runId.slice(0, 8)}`))
    }
  }

  line()
  const parts = [
    `${opts.runCount ?? 1} 个 run`,
    `${r.tokens} tokens`,
    money(r.costUsd, { subscription: r.allSubscription }),
    duration(r.elapsedMs),
  ]
  line(c.gray(parts.join(' · ')))
}

/** 列出最近的 root run */
export async function printRunList(n: Nucleus, limit = 20): Promise<void> {
  const r = await n.db.query<{
    id: string
    agent_id: string
    status: string
    error_code: string | null
    created_at: Date
  }>(
    `select id, agent_id, status, error_code, created_at from runs
      where parent_run_id is null order by created_at desc limit $1`,
    [limit],
  )

  heading('最近的 run')
  if (r.rows.length === 0) {
    line(c.gray('（还没有 run）'))
    return
  }
  table(
    r.rows.map((x) => [
      x.id.slice(0, 8),
      x.agent_id,
      statusColor(x.status),
      x.error_code ? `${c.gray(x.error_code)} ${recoveryHint(recoveryOf(x.error_code))}` : '',
      c.gray(new Date(x.created_at).toLocaleString()),
    ]),
    ['ID', 'AGENT', '状态', '错误', '时间'],
  )
}

/** 打印一棵 run 树。找不到时返回 false。 */
export async function printRunTree(n: Nucleus, prefix: string): Promise<boolean> {
  const found = await n.db.query<{ id: string }>(`select id from runs where id::text like $1 limit 1`, [
    `${prefix}%`,
  ])
  const rootId = found.rows[0]?.id
  if (!rootId) return false

  const root = (await n.runs.getRun(rootId))!
  const tree = await n.runs.tree(root.rootRunId)

  heading(`run 树 ${root.rootRunId.slice(0, 8)}`)
  for (const r of tree) {
    const attempts = await n.runs.listAttempts(r.id)
    const cost = attempts.reduce((s, a) => s + Number(a.costUsd ?? 0), 0)
    const subscription = attempts.every((a) => {
      const key = a.provider && a.model ? `${a.provider}:${a.model}` : null
      return key ? n.config.models.find((m) => m.key === key)?.billing === 'subscription' : false
    })
    const indent = '  '.repeat(r.depth)
    line(
      `${indent}${r.depth === 0 ? '●' : '└─'} ${c.cyan(r.agentId)} ${statusColor(r.status)} ` +
        c.gray(
          `${r.id.slice(0, 8)} · ${attempts.length} attempt · ${money(cost, { subscription: subscription && attempts.length > 0 })}`,
        ),
    )
    if (r.errorCode) {
      line(`${indent}   ${ICON.warn} ${c.gray(r.errorCode)} ${recoveryHint(recoveryOf(r.errorCode))}`)
    }
    const summary = (r.result as { summary?: string } | null)?.summary
    if (summary) line(`${indent}   ${c.gray(summary.slice(0, 100))}`)
    for (const a of attempts) {
      if (attempts.length === 1 && a.status === 'succeeded') continue
      line(`${indent}   ${c.gray(`#${a.attemptNo}`)} ${statusColor(a.status)} ${c.gray(a.errorCode ?? '')}`)
    }
  }
  return true
}
