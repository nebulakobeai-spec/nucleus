import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { CronError, describeCron, nextFireAt, wallClock } from '../runtime/cron.js'
import {
  assertTimeZone,
  ScheduleStore,
  type FireRecord,
  type Schedule,
} from '../store/schedules.js'
import { c, heading, ICON, line, strFlag, table, resolveDb } from './ui.js'

/**
 * `nucleus schedule` —— 定时任务。
 *
 * 三个问题是这个命令必须答出来的：
 *
 *  1. **下次什么时候跑？** 表达式写对没有 —— 靠人读五段 cron 很容易读错，
 *     所以 add 之后立刻回显「下次触发时刻」与一句人话
 *  2. **上次跑了吗？** `history` 读 schedule_fires。被跳过的触发没有 run，
 *     除了那张表以外毫无痕迹 —— 只能靠「没看到产出」发现，太晚
 *  3. **为什么没跑？** 跳过的原因（重入 / 已触发过 / 出错）写在同一行
 *
 * 定时任务的执行不需要额外进程：worker tick 里就地触发。所以只要有一个
 * `nucleus chat` 或长驻 worker 在跑，计划就会到点执行。**这条必须说清楚**
 * —— 否则你会加了计划然后奇怪为什么什么都没发生。
 */

/**
 * 时刻按**计划自己的时区**显示。
 *
 * 用 UTC 显示是个陷阱：你设了「上海 8:30」，回显 `00:30Z`，第一反应是算错了。
 * 时区名跟在后面，所以也不会误以为是本机时间。
 */
function fmt(d: Date | null, tz = 'UTC'): string {
  if (!d) return '—'
  const w = wallClock(d, tz)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${w.year}-${p2(w.month)}-${p2(w.day)} ${p2(w.hour)}:${p2(w.minute)}`
}

/** 距离现在多久，给人一个量级感 */
function relative(d: Date | null, now: number): string {
  if (!d) return ''
  const ms = d.getTime() - now
  const abs = Math.abs(ms)
  const unit =
    abs < 60_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 3600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 86400_000
          ? `${Math.round(abs / 3600_000)}h`
          : `${Math.round(abs / 86400_000)}d`
  return ms >= 0 ? `${unit} 后` : `${unit} 前`
}

async function withStore<T>(
  flags: Record<string, string | true>,
  fn: (n: Nucleus, store: ScheduleStore) => Promise<T>,
): Promise<T> {
  const { config } = await loadConfig(strFlag(flags, 'config'))
  const n = await boot({ config, ...resolveDb(flags), skipMcp: true })
  try {
    return await fn(n, new ScheduleStore(n.db, n.deps))
  } finally {
    await n.close()
  }
}

export async function scheduleList(
  _argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  return withStore(flags, async (n, store) => {
    const all = await store.list()
    if (all.length === 0) {
      heading('定时任务')
      line(c.gray('（还没有）'))
      line()
      line('加一个：')
      line(c.gray('  nucleus schedule add 每日简报 --cron "30 8 * * *" --tz Asia/Shanghai \\'))
      line(c.gray('    --agent analyst --goal "汇总昨天的进展"'))
      return 0
    }

    const now = Date.now()
    heading(`定时任务（${all.length}）`)
    table(
      all.map((s) => [
        s.enabled ? s.name : c.gray(s.name),
        s.cron,
        s.agentId,
        s.enabled ? fmt(s.nextFireAt, s.timezone) : c.gray('已停用'),
        s.enabled ? c.gray(relative(s.nextFireAt, now)) : '',
        c.gray(s.timezone),
        fmt(s.lastFiredAt, s.timezone),
      ]),
      ['名称', '表达式', 'agent', '下次', '', '时区', '上次'],
    )

    // agent 不存在的计划会在触发时静默失败 —— 提前说
    const known = new Set(n.config.agents.map((a) => a.id))
    const orphans = all.filter((s) => !known.has(s.agentId))
    if (orphans.length) {
      line()
      for (const o of orphans) {
        line(`${ICON.fail} ${c.red(o.name)} 指向不存在的 agent「${o.agentId}」—— 触发时会失败`)
      }
      line(c.gray(`  现有 agent：${[...known].join(', ')}`))
    }

    line()
    line(c.gray('执行不需要额外进程：worker tick 里就地触发。'))
    line(c.gray('所以要有一个 nucleus chat 或长驻 worker 在跑，计划才会到点执行。'))
    line(c.gray('看某条的历史：nucleus schedule history <名称>'))
    return 0
  })
}

export async function scheduleAdd(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const name = argv.join(' ').trim()
  const cron = strFlag(flags, 'cron')
  const agentId = strFlag(flags, 'agent')
  const goal = strFlag(flags, 'goal')

  if (!name || !cron || !agentId || !goal) {
    line(c.red('用法：nucleus schedule add <名称> --cron "<表达式>" --agent <id> --goal "<目标>"'))
    line()
    line('可选：')
    line(c.gray('  --tz <IANA>        时区，默认 UTC（夏令时靠系统 tz 数据库处理）'))
    line(c.gray('  --context "<背景>"  信封的背景段'))
    line(c.gray('  --acceptance "<…>"  验收标准'))
    line(c.gray('  --catch-up          停机期间错过的补跑（默认不补）'))
    line(c.gray('  --catch-up-max <n>  最多补几次，默认 3'))
    line()
    line('表达式：五段 `分 时 日 月 周`，或 @daily / @hourly / @weekly / @monthly')
    line(c.gray('  "30 8 * * *"    每天 8:30'))
    line(c.gray('  "0 9 * * 1"     每周一 9:00'))
    line(c.gray('  "*/15 * * * *"  每 15 分钟'))
    return 1
  }

  return withStore(flags, async (n, store) => {
    if (!n.config.agents.some((a) => a.id === agentId)) {
      line(c.red(`没有 agent「${agentId}」`))
      line(c.gray(`现有：${n.config.agents.map((a) => a.id).join(', ')}`))
      return 1
    }

    const tz = strFlag(flags, 'tz') ?? strFlag(flags, 'timezone') ?? 'UTC'
    try {
      assertTimeZone(tz)
      const s = await store.create({
        name,
        cron,
        timezone: tz,
        agentId,
        goal,
        context: strFlag(flags, 'context') ?? '',
        acceptance: strFlag(flags, 'acceptance') ?? '',
        catchUp: flags['catch-up'] === true,
        catchUpMax: Number(strFlag(flags, 'catch-up-max') ?? 3),
      })
      printOne(s)
      return 0
    } catch (e) {
      if (e instanceof CronError) {
        line(`${ICON.fail} 表达式有问题：${e.message}`)
        return 1
      }
      if (/duplicate key|unique/i.test(String((e as Error).message))) {
        line(c.red(`已经有叫「${name}」的计划了`))
        line(c.gray(`  改它：先 nucleus schedule rm ${name}，再重新 add`))
        return 1
      }
      line(`${ICON.fail} ${(e as Error).message}`)
      return 1
    }
  })
}

function printOne(s: Schedule): void {
  line(`${ICON.ok} 已加计划 ${c.bold(s.name)}`)
  line(`  ${describeCron(s.cron, s.timezone)}`)
  line(
    `  下次触发 ${c.bold(fmt(s.nextFireAt, s.timezone))} ${c.gray(s.timezone)}` +
      ` ${c.gray(relative(s.nextFireAt, Date.now()))}`,
  )
  line(`  交给 ${s.agentId}`)
  if (s.catchUp) line(c.gray(`  停机会补跑，最多 ${s.catchUpMax} 次`))
  else line(c.gray('  停机期间错过的不补（--catch-up 可开）'))
  line()
  // 最常见的困惑：加了但什么都没发生
  line(c.gray('要有 worker 在跑才会执行 —— 开一个 nucleus chat 放着即可。'))
  // 接下来的两次，让人自己确认表达式的意思对不对
  const preview: string[] = []
  let cursor = s.nextFireAt
  for (let i = 0; i < 3 && cursor; i++) {
    preview.push(fmt(cursor, s.timezone))
    cursor = nextFireAt(s.cron, s.timezone, cursor)
  }
  if (preview.length > 1) line(c.gray(`接下来：${preview.join(' · ')}`))
}

export async function scheduleRm(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const name = argv.join(' ').trim()
  if (!name) {
    line(c.red('用法：nucleus schedule rm <名称>'))
    return 1
  }
  return withStore(flags, async (_n, store) => {
    // 触发历史随计划一起删（on delete cascade）—— 说一声，别让人事后发现
    const s = await store.byName(name)
    if (!s) {
      line(c.red(`没有叫「${name}」的计划`))
      return 1
    }
    const h = await store.history(name, 200)
    await store.remove(name)
    line(`${ICON.ok} 已删除 ${name}`)
    if (h.length) line(c.gray(`  ${h.length} 条触发历史一并删除（已跑出的 run 与产出仍在）`))
    return 0
  })
}

export async function scheduleToggle(
  argv: string[],
  flags: Record<string, string | true>,
  enabled: boolean,
): Promise<number> {
  const name = argv.join(' ').trim()
  if (!name) {
    line(c.red(`用法：nucleus schedule ${enabled ? 'enable' : 'disable'} <名称>`))
    return 1
  }
  return withStore(flags, async (_n, store) => {
    const s = await store.setEnabled(name, enabled)
    if (!s) {
      line(c.red(`没有叫「${name}」的计划`))
      return 1
    }
    if (enabled) {
      line(`${ICON.ok} ${name} 已启用，下次触发 ${fmt(s.nextFireAt, s.timezone)} ${s.timezone}`)
      // 这条容易踩：停用一周再打开，人会以为要补一周的量
      line(c.gray('  next_fire_at 是重算的 —— 停用期间的计划点不算欠账，不会补'))
    } else {
      line(`${ICON.ok} ${name} 已停用`)
    }
    return 0
  })
}

export async function scheduleHistory(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const name = argv.join(' ').trim()
  if (!name) {
    line(c.red('用法：nucleus schedule history <名称>'))
    return 1
  }
  return withStore(flags, async (_n, store) => {
    const s = await store.byName(name)
    if (!s) {
      line(c.red(`没有叫「${name}」的计划`))
      return 1
    }
    const h = await store.history(name, Number(strFlag(flags, 'limit') ?? 20))
    heading(`${name} 的触发历史`)
    line(c.gray(`${describeCron(s.cron, s.timezone)} · 交给 ${s.agentId}`))
    line(c.gray(`时刻按 ${s.timezone} 显示`))
    line()
    if (h.length === 0) {
      line(c.gray('（还没触发过）'))
      line(c.gray(`下次 ${fmt(s.nextFireAt, s.timezone)} ${s.timezone}`))
      return 0
    }

    table(
      h.map((x) => [
        outcomeMark(x),
        fmt(x.plannedAt, s.timezone),
        // 计划与实际的差就是延迟/补偿的证据，所以显示差值而不是又一个时刻
        delta(x.plannedAt, x.firedAt),
        outcomeText(x),
        x.runId ? x.runId.slice(0, 8) : c.gray(x.reason ?? '—'),
      ]),
      ['', '计划时刻', '实际', '结果', 'run'],
    )

    // 分母按**最终结果**算，不是按触发成功算 —— 触发成功但 run 失败的
    // 那几次才是最要紧的
    const ok = h.filter((x) => x.outcome === 'fired' && x.runStatus === 'succeeded').length
    const failed = h.filter((x) => x.outcome === 'fired' && x.runStatus === 'failed').length
    const skipped = h.filter((x) => x.outcome === 'reentrant' || x.outcome === 'duplicate').length
    const errored = h.filter((x) => x.outcome === 'error').length
    line()
    const bits = [`${ok} 次成功`]
    if (failed) bits.push(c.red(`${failed} 次跑失败`))
    if (skipped) bits.push(`${skipped} 次跳过`)
    if (errored) bits.push(c.red(`${errored} 次触发失败`))
    line(bits.join(' · '))

    const badCode = h.find((x) => x.runErrorCode)?.runErrorCode
    if (badCode === 'config.agent_not_found') {
      line(
        `${ICON.fail} ${c.red(`agent「${s.agentId}」不存在`)}` +
          c.gray(' —— 每次触发都会这样失败。改名了？nucleus agent list'),
      )
    }
    if (errored) {
      line(c.gray('触发失败的原因在最后一列'))
    }
    line(c.gray('看某次跑出了什么：nucleus runs <run 前缀>'))
    return 0
  })
}

/**
 * 一次触发到底算成功还是失败。
 *
 * `outcome: 'fired'` 只说明**触发**成功 —— run 可能随后就失败了。
 * 对着一个 failed run 打绿勾，和「系统会自动重试」那句假话是同一类错误。
 */
function outcomeMark(x: FireRecord): string {
  if (x.outcome === 'error') return ICON.fail
  if (x.outcome === 'reentrant') return ICON.warn
  if (x.outcome === 'duplicate') return c.gray('=')
  if (x.runStatus === 'failed') return ICON.fail
  if (x.runStatus === 'succeeded') return ICON.ok
  return c.gray('·')
}

function outcomeText(x: FireRecord): string {
  switch (x.outcome) {
    case 'reentrant':
      return '跳过（上次还在跑）'
    case 'duplicate':
      return '跳过（已触发过）'
    case 'error':
      return '触发失败'
  }
  switch (x.runStatus) {
    case 'succeeded':
      return '完成'
    case 'failed':
      return c.red(`失败：${x.runErrorCode ?? '未知'}`)
    case null:
      return c.gray('run 已删除')
    default:
      // pending / running / waiting_* —— 还在跑
      return c.gray(`进行中（${x.runStatus}）`)
  }
}

/** 计划时刻与实际触发的差 —— 延迟多久 / 提前多久 */
function delta(planned: Date, fired: Date): string {
  const ms = fired.getTime() - planned.getTime()
  if (Math.abs(ms) < 60_000) return c.gray('准时')
  const m = Math.round(Math.abs(ms) / 60_000)
  const txt = m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
  return ms > 0 ? c.yellow(`迟 ${txt}`) : c.gray(`早 ${txt}`)
}
