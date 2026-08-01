import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { recoveryOf } from '../errors.js'
import { c, duration, heading, ICON, line, money, recoveryHint, resolveDb, strFlag, table } from './ui.js'
import { compactTokens } from './pet.js'

/**
 * `nucleus providers` —— 后端模型层面出了什么问题。
 *
 * 以前只能看到 `provider_state` 的**当前快照**（谁在熔断、还剩多少额度），
 * 所以这几个问题答不出：
 *
 *  - 熔断什么时候打开的？因为什么错误？开到几点？
 *  - 那次 429 到底试了链上哪几个模型，各自返回什么？
 *  - **为什么用了链上第 3 个模型？** 前两个为什么被跳过？
 *  - 这周每个模型失败了多少次，都是什么错误码？
 *
 * 现在这些都由 provider_events（append-only）与 usage_log 回答。
 */

export async function providersCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { config } = await loadConfig(strFlag(flags, 'config'))
  const n = await boot({ config, ...resolveDb(flags), skipMcp: true })
  const hours = Number(strFlag(flags, 'since') ?? 24)
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()

  try {
    await printHealth(n)
    await printFailures(n, since, hours)
    await printSkips(n, since)
    await printExhausted(n, since)
    await printUsage(n, since, hours)
    if (argv[0] === 'log' || flags['log'] === true) await printLog(n, since)
    else {
      line()
      line(c.gray(`逐条时间线：nucleus providers log --since ${hours}`))
    }
    return 0
  } finally {
    await n.close()
  }
}

/** 当前健康：谁能用、谁在熔断、什么时候恢复 */
async function printHealth(n: Nucleus): Promise<void> {
  heading('当前状态')
  const health = await n.router.health.all()
  if (health.length === 0) {
    line(c.gray('还没有任何 provider 记录 —— 跑一轮真实调用后再看'))
    return
  }
  const now = Date.now()
  table(
    health.map((h) => {
      const until = h.breakerUntil?.getTime() ?? 0
      const openFor = until > now ? duration(until - now) : null
      return [
        h.key,
        h.breakerState === 'closed'
          ? c.green('正常')
          : h.breakerState === 'half_open'
            ? c.yellow('半开探测')
            : c.red('熔断中'),
        openFor ? c.gray(`还有 ${openFor}`) : c.gray('—'),
        h.consecutiveErrors > 0 ? c.yellow(String(h.consecutiveErrors)) : c.gray('0'),
        h.remainingRequests === null ? c.gray('未知') : String(h.remainingRequests),
      ]
    }),
    ['模型', '状态', '恢复', '连续失败', '剩余请求'],
  )
  line(c.gray('「剩余请求」未知是正常的 —— 没有哪家提供可靠的额度查询，靠响应头被动学习'))
}

/** 失败聚合：按模型 × 错误码，并带上恢复性 */
async function printFailures(n: Nucleus, since: string, hours: number): Promise<void> {
  const r = await n.db.query<{ key: string; error_code: string; count: number; last_at: Date }>(
    `select key, coalesce(error_code, '?') as error_code, count(*)::int as count, max(at) as last_at
       from provider_events
      where kind = 'failed' and at >= $1
      group by 1, 2 order by count desc limit 20`,
    [since],
  )
  heading(`失败（最近 ${hours} 小时）`)
  if (r.rows.length === 0) {
    line(c.gray('没有失败'))
    return
  }
  table(
    r.rows.map((x) => [
      x.key,
      c.red(x.error_code),
      String(x.count),
      // 恢复性决定要不要人工介入 —— 只报错误码等于让人自己查文档
      recoveryHint(recoveryOf(x.error_code)),
      c.gray(new Date(x.last_at).toLocaleString()),
    ]),
    ['模型', '错误码', '次数', '恢复性', '最近一次'],
  )
}

/** 被跳过的候选 —— 「为什么用了链上第 3 个」 */
async function printSkips(n: Nucleus, since: string): Promise<void> {
  const r = await n.db.query<{ skipped: string; reason: string; count: number }>(
    `select s->>'key' as skipped, s->>'reason' as reason, count(*)::int as count
       from provider_events e
       cross join lateral jsonb_array_elements(e.detail->'skipped') as s
      where e.kind = 'picked' and e.at >= $1
      group by 1, 2 order by count desc limit 20`,
    [since],
  )
  if (r.rows.length === 0) return
  heading('preflight 跳过的候选')
  for (const x of r.rows) {
    line(`  ${c.yellow(x.skipped.padEnd(24))} ${x.reason.padEnd(10)} ${c.gray(`${x.count} 次`)}`)
  }
  line()
  line(c.gray('这就是「为什么用了链上第 3 个」的答案 —— 前面的被跳过了，不是没试'))
}

/** 全链不可用 —— 「429 打挂整条 fallback 链」就是这一条 */
async function printExhausted(n: Nucleus, since: string): Promise<void> {
  const r = await n.db.query<{ at: Date; detail: Record<string, unknown> }>(
    `select at, detail from provider_events
      where kind = 'exhausted' and at >= $1 order by id desc limit 10`,
    [since],
  )
  if (r.rows.length === 0) return
  heading(`全链不可用（${r.rows.length} 次）`)
  for (const e of r.rows) {
    const per = (e.detail['perModel'] as Array<{ key: string; reason: string; availableAt: string | null }>) ?? []
    line(
      `${ICON.fail} ${c.gray(new Date(e.at).toLocaleString())} ` +
        c.gray(`最早可用 ${e.detail['earliestAvailableAt'] ?? '未知'}`),
    )
    for (const p of per) {
      line(`    ${p.key.padEnd(22)} ${c.yellow(p.reason)} ${c.gray(p.availableAt ?? '')}`)
    }
  }
  line()
  line(c.gray('这时 run 会失败。补 run 级重试（BACKLOG B9）之后才会自动等到恢复再继续'))
}

/** 用量与成本：逐次调用聚合 */
async function printUsage(n: Nucleus, since: string, hours: number): Promise<void> {
  const r = await n.db.query<{
    provider: string
    model: string
    calls: number
    tin: number
    tout: number
    cache: number
    cost: string
  }>(
    `select provider, model, count(*)::int as calls,
            sum(tokens_in)::int as tin, sum(tokens_out)::int as tout,
            sum(cache_read)::int as cache, sum(cost_usd) as cost
       from usage_log where created_at >= $1
      group by 1, 2 order by calls desc`,
    [since],
  )
  heading(`用量（最近 ${hours} 小时）`)
  if (r.rows.length === 0) {
    line(c.gray('还没有用量记录'))
    return
  }
  table(
    r.rows.map((x) => {
      const key = `${x.provider}:${x.model}`
      const cfg = n.config.models.find((m) => m.key === key)
      return [
        key,
        String(x.calls),
        compactTokens(x.tin),
        compactTokens(x.tout),
        x.cache > 0 ? c.green(compactTokens(x.cache)) : c.gray('0'),
        money(Number(x.cost), { subscription: cfg?.billing === 'subscription' }),
      ]
    }),
    ['模型', '调用', '输入', '输出', '缓存命中', '成本'],
  )
  line(c.gray('缓存命中按更低单价计费；订阅制显示「订阅」而不是 $0 —— 两者含义不同'))
}

/** 逐条时间线 */
async function printLog(n: Nucleus, since: string): Promise<void> {
  const r = await n.db.query<{
    at: Date
    key: string
    kind: string
    error_code: string | null
    detail: Record<string, unknown>
  }>(
    `select at, key, kind, error_code, detail from provider_events
      where at >= $1 order by id desc limit 100`,
    [since],
  )
  heading(`时间线（最近 ${r.rows.length} 条，新的在上）`)
  for (const e of r.rows) {
    const t = new Date(e.at).toLocaleTimeString()
    const icon =
      e.kind === 'ok' ? ICON.ok : e.kind === 'failed' ? ICON.fail : e.kind === 'picked' ? ICON.info : ICON.warn
    let detail = ''
    if (e.kind === 'ok') {
      detail = `${e.detail['latencyMs']}ms · ${e.detail['tokensIn']}+${e.detail['tokensOut']} tok`
    } else if (e.kind === 'failed') {
      detail = `${c.red(String(e.error_code))} ${String(e.detail['message'] ?? '').slice(0, 60)}`
      if (e.detail['hint']) detail += c.gray(` · ${e.detail['hint']}`)
    } else if (e.kind === 'picked') {
      const sk = (e.detail['skipped'] as Array<{ key: string; reason: string }>) ?? []
      detail = `${e.detail['reason']}` + (sk.length ? c.gray(` · 跳过 ${sk.map((x) => `${x.key}(${x.reason})`).join(', ')}`) : '')
    } else if (e.kind.startsWith('breaker.')) {
      detail = c.yellow(`${e.detail['from']} → ${e.kind.slice(8)}`) + c.gray(` 至 ${e.detail['until'] ?? '?'}`)
    }
    line(`${c.gray(t)} ${icon} ${e.key.padEnd(22)} ${c.gray(e.kind.padEnd(16))} ${detail}`)
  }
}
