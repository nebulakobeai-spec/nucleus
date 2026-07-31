import { ask, type Nucleus } from '../boot.js'
import { recoveryOf } from '../errors.js'
import { TeeEventSink, type RunEvent } from '../runtime/events.js'
import { compactTokens, Pet, petStill } from './pet.js'
import { c, duration, heading, ICON, line, money, recoveryHint, statusColor, table } from './ui.js'

/**
 * `ask` 与 `chat` 共用的渲染逻辑。
 *
 * 抽出来是为了避免两条命令的输出格式漂移 —— 用户在 chat 里看到的
 * 和在脚本里看到的应该是同一套。
 *
 * 过程渲染读的是**事件流**（DESIGN.md §9：事件流是可视化的唯一数据源），
 * 不是另开一套回调 —— 否则终端看到的过程和诊断包里记录的过程会各说一套，
 * 不一致时谁也不知道该信哪个。
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

const p = (e: RunEvent) => (e.payload ?? {}) as Record<string, unknown>

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 把一条事件渲染成一行永久输出。返回 null 表示这条事件不值得占一行。
 *
 * 拆成纯函数是为了能不起 worker 就测渲染 —— 过去改这里只能靠肉眼看。
 */
export function renderEvent(e: RunEvent, indent: string): string | null {
  const q = p(e)
  const br = `${indent}  ${c.gray(ICON.branch)} `

  switch (e.kind) {
    case 'attempt.started':
      return `${indent}${ICON.step} ${c.cyan(String(q['agent']))} ${c.gray(`#${q['attemptNo']}`)}`

    case 'llm.call.finished': {
      const tok = Number(q['tokensIn'] ?? 0) + Number(q['tokensOut'] ?? 0)
      const cached = Number(q['cacheRead'] ?? 0)
      return (
        br +
        c.gray(
          `${q['model']} · ${compactTokens(tok)} tok` + (cached ? ` · 缓存命中 ${compactTokens(cached)}` : ''),
        )
      )
    }

    // 推理模型的思考只报个量 —— 内容不进历史也不进终端，需要时去事件流查
    case 'llm.reasoning':
      return br + c.gray(`想了 ${compactTokens(Number(q['chars'] ?? 0))} 字`)

    case 'tool.outcome':
      return (
        br +
        `${q['tool']} ${q['ok'] ? ICON.ok : ICON.fail} ` +
        c.gray(duration(Number(q['ms'] ?? 0))) +
        (q['errorCode'] ? ` ${c.red(String(q['errorCode']))}` : '')
      )

    case 'artifact.written': {
      // 老事件没有 path，退回 ref
      const where = String(q['path'] ?? q['ref'] ?? '')
      const bytes = Number(q['bytes'] ?? 0)
      return br + c.gray('产出 ') + where + (bytes ? c.gray(` ${formatBytes(bytes)}`) : '')
    }

    // 契约与规则的违反必须显式可见 —— 「prompt 规则被忽略」是我们要修的问题，
    // 藏在事件流里等人去查等于没修
    case 'contract.rejected': {
      const fails = (q['failures'] as Array<{ path?: string }> | undefined) ?? []
      const where = fails.map((f) => f.path).filter(Boolean).join(', ')
      return (
        br +
        c.yellow(`结果被退回（第 ${q['retry']} 次）`) +
        (where ? c.gray(` 缺 ${where}`) : '') +
        c.gray(' → 已把缺项告知模型')
      )
    }

    case 'rule.violation':
      return br + c.yellow(`${q['tool']} 被规则拦下`) + c.gray(` ${q['rule'] ?? ''}`)

    // 只在**发生了降级**时才占一行。没裁东西时这条是噪音，
    // 但历史被裁掉必须说出来 —— 否则「模型突然失忆」会变成谜案
    case 'context.assembled': {
      const degs = (q['degradations'] as string[] | undefined) ?? []
      if (degs.length === 0) return null
      const dropped = Number(q['droppedMessages'] ?? 0)
      const names: Record<string, string> = {
        trim_history: dropped ? `裁掉 ${dropped} 条历史` : '裁剪历史',
        shrink_summary: '压缩摘要',
        drop_summary: '丢弃摘要',
        shrink_constraints: '收缩约束',
        needs_checkpoint: '仍然超出窗口',
      }
      return (
        br +
        c.yellow('上下文降级：') +
        degs.map((d) => names[d] ?? d).join(' → ') +
        c.gray(` （窗口 ${compactTokens(Number(q['window'] ?? 0))}）`)
      )
    }

    case 'wake.armed':
      return br + c.gray(`挂起，等 ${q['waitOn']} 个专家 —— 本轮 attempt 到此结束`)

    default:
      return null
  }
}

/**
 * 跑一轮对话并把执行过程实时打印出来。
 *
 * 复用 `boot.ts` 的 `ask` 管线 —— 不新建 HTTP 层，chat 与 ask 走同一条路。
 */
export async function runTurn(n: Nucleus, conversationId: string, text: string): Promise<TurnResult> {
  const t0 = Date.now()
  const pet = new Pet().hint('Ctrl-C 取消')

  // runId → depth，用于缩进；从 attempt.started 的 payload 学到
  const depth = new Map<string, number>()
  const indentOf = (runId: string) => '  '.repeat(depth.get(runId) ?? 0)

  const tee = n.events instanceof TeeEventSink ? n.events : null
  const unsubscribe =
    tee?.subscribe((e) => {
      const q = p(e)
      if (e.kind === 'attempt.started') depth.set(e.runId, Number(q['depth'] ?? 0))

      // 猫的情绪跟着事件走，这样「在想 / 在干活 / 挂起等人」一眼能分清
      switch (e.kind) {
        case 'attempt.started':
          pet.mood('think', String(q['agent']))
          break
        case 'llm.call.started':
          pet.mood('think')
          break
        case 'tool.intent':
          pet.mood('work', String(q['tool']))
          break
        case 'llm.call.finished':
          pet.addTokens(Number(q['tokensIn'] ?? 0) + Number(q['tokensOut'] ?? 0))
          break
            case 'wake.armed':
          pet.mood('wait')
          break
      }

      const l = renderEvent(e, indentOf(e.runId))
      // say() 会先擦掉动画行再打印 —— 直接 console.log 会和动画撞在一起
      if (l !== null) pet.say(l)
    }) ?? (() => {})

  pet.start('think')
  let runId: string
  try {
    ;({ runId } = await ask(n, conversationId, text, {
      // 事件流没覆盖到的只有「attempt 以失败收尾」——
      // attempt.finished 不带恢复性，这里补上「系统会不会自己重试」
      onAttemptEnd: (i) => {
        if (i.status === 'succeeded' || i.status === 'waiting_children') return
        pet.mood('sad')
        pet.say(
          `${indentOf(i.runId)}  ${c.gray(ICON.branch)} ${statusColor(i.status)}` +
            (i.errorCode ? ` ${c.gray(i.errorCode)} ${recoveryHint(recoveryOf(i.errorCode))}` : ''),
        )
      },
    }))
  } finally {
    unsubscribe()
    pet.stop()
  }

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
    line(`${ICON.step} ${c.bold('助手')}`)
    // 回复缩进两格，和上面的过程树对齐，长文本读起来有边界
    for (const l of r.reply.split('\n')) line(`  ${l}`)
    if (r.artifacts.length) {
      line()
      line(`  ${c.gray('产出')} ${r.artifacts.join(', ')}`)
    }
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
    `${compactTokens(r.tokens)} tok`,
    money(r.costUsd, { subscription: r.allSubscription }),
    duration(r.elapsedMs),
  ]
  // 猫报账：成功时高兴，失败时难过 —— 一行里既有结论也有情绪
  const mood = r.reply ? 'happy' : 'sad'
  line(`${petStill(mood)} ${c.gray(parts.join(' · '))}`)
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
