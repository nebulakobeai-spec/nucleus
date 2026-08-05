import { ask, type Nucleus } from '../boot.js'
import { recoveryOf } from '../errors.js'
import { TeeEventSink, type RunEvent } from '../runtime/events.js'
import { compressionRatio } from '../context/compact.js'
import { formatCtx } from '../context/budget.js'
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
  /** 错误里附的可操作提示（如「服务没在监听」），没有则为 null */
  hint: string | null
  /** run 在等重试时，下一次尝试的时刻 */
  retryAt: Date | null
  /**
   * 这一轮实际发出去的 context 与窗口。
   *
   * 取自最后一次 `context.assembled` 事件 —— 那是**真的发出去的那一份**，
   * 不是估算。没有该事件（比如 run 在调模型之前就失败了）时为 null。
   */
  ctx: { used: number; window: number } | null
}

const p = (e: RunEvent) => (e.payload ?? {}) as Record<string, unknown>

/**
 * 从 error_detail 里取出 hint。
 *
 * 结构有两层：runner 抛的错直接带 detail.hint，而 router 会把各模型的失败
 * 包成 `{attempts, lastError}`，真正的提示在 lastError 里。
 */
export function extractHint(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as { hint?: unknown; lastError?: { hint?: unknown } }
  if (typeof d.hint === 'string' && d.hint) return d.hint
  const inner = d.lastError?.hint
  return typeof inner === 'string' && inner ? inner : null
}

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
      /**
       * **带上 run 前缀。**
       *
       * 实测有一次同一轮里出现了三个 `orchestrator #1`，而底下写着「1 个 run」——
       * 两者矛盾，而屏幕上没有任何东西能区分「同一个 run 的第二次 attempt」
       * 与「另一个 run 的第一次」。我去查时数据库已经坏了，于是**查不出来**。
       *
       * 一行里多八个字符，换来的是这类问题下次能自己回答。
       */
      return (
        `${indent}${ICON.step} ${c.cyan(String(q['agent']))} ` +
        c.gray(`#${q['attemptNo']} · ${e.runId.slice(0, 8)}`)
      )

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
      /**
       * 「参数被退回」不是故障，不该显示成红叉。
       *
       * 实测：`create_rule` 第一次被校验拒、第二次改对 —— 那是设计要的行为，
       * 而屏幕上是 `create_rule ✗ 0ms`，看起来像出了故障。
       * 与 `contract.rejected` 那一档同一个道理：说清「已经告知模型」，
       * 人就知道自己什么都不用做。
       */
      if (q['rejected']) {
        return (
          br +
          `${q['tool']} ${c.yellow('参数被退回')} ` +
          c.gray('→ 已把原因告知模型，它会自己改')
        )
      }
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

    // 一次就写对是常态，不占行。退回后才通过要说出来 ——
    // 否则只看到「被退回」而不知道后来到底成没成
    case 'contract.accepted': {
      const retries = Number(q['retries'] ?? 0)
      if (retries === 0) return null
      return br + c.green(`结果通过`) + c.gray(`（退回 ${retries} 次后）`)
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
        // 这两档差别很大：前者保住了用户约束，后者把约束一起丢了
        summary_to_constraints: '摘要降到只剩要求',
        drop_summary: '丢弃摘要（连用户约束一起）',
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

    /**
     * 压缩必须可见。
     *
     * 它是**有损且不可逆**的：那几条原文之后再也不进 context 了。
     * 悄悄发生的话，「模型怎么忘了我刚说的」就成了谜案 —— 而这正是
     * 上下文管理里最容易被归因成「模型不行」的一类问题。
     */
    case 'compact.started':
      return (
        br +
        c.gray(
          `压缩历史：退役 ${q['messages']} 条（${compactTokens(Number(q['tokensBefore'] ?? 0))}）…`,
        )
      )

    case 'compact.finished': {
      const before = Number(q['tokensBefore'] ?? 0)
      const after = Number(q['tokensAfter'] ?? 0)
      const kept: string[] = []
      // 把「留住了几条约束/决定」说出来 —— 压缩比再好，丢了约束也是失败
      if (Number(q['constraints'] ?? 0) > 0) kept.push(`${q['constraints']} 条约束`)
      if (Number(q['decisions'] ?? 0) > 0) kept.push(`${q['decisions']} 条决定`)
      return (
        br +
        c.green(`历史已压缩`) +
        c.gray(
          ` ${compactTokens(before)} → ${compactTokens(after)}` +
            `（省 ${compressionRatio(before, after)}）` +
            (kept.length ? ` · 留住 ${kept.join(' / ')}` : ''),
        )
      )
    }

    case 'compact.failed':
      // 说清「任务继续」—— 否则一条红字会让人以为要挂了
      return (
        br +
        c.yellow('压缩失败') +
        c.gray(`：${q['error']} —— 任务继续，历史改按预算裁剪`)
      )

    case 'wake.armed':
      /**
       * 两种挂起原因，两句话。
       *
       * 原先只有「等 N 个专家」，而 user wake 没有 `waitOn` ——
       * 实测打出来是「挂起，等 **undefined** 个专家」。
       * 一个占位符没填的字符串，比不打这一行更糟：它让人以为派了专家。
       */
      return (
        br +
        c.gray(
          q['kind'] === 'user'
            ? '挂起，等你回答 —— 本轮 attempt 到此结束'
            : `挂起，等 ${q['waitOn']} 个专家 —— 本轮 attempt 到此结束`,
        )
      )

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
        // waiting_retry 不是失败 —— 猫不该哭，也不该说「需要你处理」
        const retrying = i.status === 'waiting_retry'
        /**
         * **恢复性提示不能只看错误码。**
         *
         * `recoveryOf('contract.postcondition_failed')` 是 `automatic`，
         * 于是这一行原先对着一个**终态 failed** 的 run 打出
         * 「系统会自动重试」—— 而重试预算已经用完了，不会再有下一次。
         *
         * 这和「对着 failed run 打绿勾」是同一类错，我在 history / doctor
         * 里修过一次，这里漏了：判据必须是**实际排没排重试**（waiting_retry），
         * 而错误码只说明「这类错原则上可自动恢复」。
         *
         * 终态时改为不提恢复性 —— 状态本身（红色 failed）已经说明了结果，
         * 加一句假的承诺只会让人等一个不会发生的重试。
         */
        pet.mood(retrying ? 'wait' : 'sad')
        const tail = retrying
          ? ` ${c.cyan('已排重试')}`
          : i.status === 'waiting_user'
            ? ` ${c.cyan('等你回答')}`
            : ''
        pet.say(
          `${indentOf(i.runId)}  ${c.gray(ICON.branch)} ${statusColor(i.status)}` +
            (i.errorCode ? ` ${c.gray(i.errorCode)}${tail}` : tail),
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
    hint: extractHint(run?.errorDetail),
    retryAt: run?.status === 'waiting_retry' ? await nextRetryAt(n, runId) : null,
    ctx: await lastCtx(n, runId),
  }
}

/** 排在队列里的下一次尝试时刻 */
async function nextRetryAt(n: Nucleus, runId: string): Promise<Date | null> {
  const r = await n.db.query<{ available_at: Date }>(
    `select available_at from run_queue where run_id = $1 order by available_at limit 1`,
    [runId],
  )
  return r.rows[0]?.available_at ?? null
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
    /**
     * **提问就是这一轮的回复** —— 它以 assistant 消息落库，所以上面那段
     * 已经把问题打出来了。缺的只是「这一轮在等你」这个标记。
     *
     * 没有它的话，一个提问看起来和一个已经答完的回复一模一样 ——
     * 而你不会知道系统正停在那里等一句话。
     */
    if (r.status === 'waiting_user') {
      line()
      line(`${ICON.info} ${c.cyan('它在等你回答')} ${c.gray('—— 你的下一句就是答案')}`)
      line(c.gray('  想改做别的：/new 另起会话（这个提问会一直留在这里等）'))
    }
  } else if (r.status === 'waiting_retry') {
    // **恢复性提示必须跟着实际行为**，不能只看错误码。
    // all_exhausted 的 recovery 是 needs_user，但 run 已经排好了重试 ——
    // 这时显示「需要你处理」就是在说谎，而那正是我批评过的毛病
    line(
      `${ICON.info} ${c.cyan('已排重试')} ${c.gray(r.errorCode ?? '')}` +
        (r.retryAt ? c.gray(` · ${r.retryAt.toLocaleTimeString()} 自动再试`) : ''),
    )
    if (r.hint) line(c.gray(`  ${r.hint}`))
    line(c.gray('  这一轮没有回复，但任务没有丢 —— worker 到点会自己继续'))
  } else {
    /**
     * **终态时不提恢复性。**
     *
     * `recoveryOf('contract.postcondition_failed')` 是 `automatic`，于是这里
     * 原先对着一个终态 failed 的 run 打「系统会自动重试」—— 而重试预算已经
     * 用完，不会再有下一次。错误码说的是「这类错原则上可自动恢复」，
     * 不是「这一次会重试」。
     */
    const terminal = ['failed', 'cancelled'].includes(r.status)
    line(
      `${ICON.warn} 未产生回复；run ${statusColor(r.status)} ${c.gray(r.errorCode ?? '')} ` +
        (terminal ? c.gray('（已用完重试预算，不会再试）') : recoveryHint(recoveryOf(r.errorCode))),
    )
    // 错误里带了可操作提示就显示出来 —— 只报错误码等于让人自己猜
    if (r.hint) line(c.gray(`  ${r.hint}`))
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
  /**
   * ctx 占用放在最后一格。
   *
   * `tok` 是**这一轮花掉的** token（计费用），`ctx` 是**这一轮发出去的
   * context 有多大**（离撞墙还有多远）—— 两个数字含义完全不同，
   * 混成一个会让人以为「才花了 2k token，离窗口还远」，
   * 而实际上 context 已经 80% 满了。
   */
  if (r.ctx) {
    const f = formatCtx(r.ctx.used, r.ctx.window)
    parts.push(f.level === 'high' ? c.red(f.text) : f.level === 'warn' ? c.yellow(f.text) : f.text)
  }
  // 猫报账：成功时高兴，失败时难过 —— 一行里既有结论也有情绪
  const mood = r.reply ? 'happy' : 'sad'
  line(`${petStill(mood)} ${c.gray(parts.join(' · '))}`)
}

/**
 * 这一轮**实际发出去**的 context 有多大。
 *
 * 读 `context.assembled` 事件的 breakdown.total，而不是自己估 ——
 * 那个事件是装配器写的，记的就是真的发出去的那一份。自己估会与实际漂移，
 * 而这个数字的全部用处就是「离撞墙还有多远」，漂了就没意义。
 *
 * 取**根 run 的最后一次**：编排者整合那一轮的 context 最大（历史最长），
 * 子 run 的 context 不含会话历史，拿它报会低估。
 */
export async function lastCtx(
  n: Nucleus,
  rootRunId: string,
): Promise<{ used: number; window: number } | null> {
  const r = await n.db.query<{ payload: { window?: number; breakdown?: { total?: number } } }>(
    `select e.payload from run_events e
       join run_attempts a on a.id = e.run_attempt_id
      where a.run_id = $1 and e.kind = 'context.assembled'
      order by e.id desc limit 1`,
    [rootRunId],
  )
  const p = r.rows[0]?.payload
  if (!p?.window || p.breakdown?.total === undefined) return null
  return { used: p.breakdown.total, window: p.window }
}

/** 列出最近的 root run */
export async function printRunList(n: Nucleus, limit = 20): Promise<void> {
  const r = await n.db.query<{
    id: string
    agent_id: string
    status: string
    error_code: string | null
    created_at: Date
    retry_at: Date | null
  }>(
    `select r.id, r.agent_id, r.status, r.error_code, r.created_at,
            (select min(available_at) from run_queue q where q.run_id = r.id) as retry_at
       from runs r
      where r.parent_run_id is null order by r.created_at desc limit $1`,
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
      // waiting_retry 时说「等到几点」而不是错误码的恢复性 ——
      // 后者会说「需要你处理」，而实际上系统会自己继续
      x.status === 'waiting_retry'
        ? `${c.gray(x.error_code ?? '')} ${c.cyan(x.retry_at ? `${new Date(x.retry_at).toLocaleTimeString()} 自动再试` : '已排重试')}`
        : x.error_code
          ? `${c.gray(x.error_code)} ${recoveryHint(recoveryOf(x.error_code))}`
          : '',
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
