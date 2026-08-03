import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { agentSpec } from '../config.js'
import { RULES, ruleSpec } from '../runtime/rules.js'
import { resultSchemaTokens } from '../runtime/result-schema.js'
import {
  coverageOf,
  resultFieldsForAgent,
  TIER_LABEL,
  TIER_WHAT,
  tiersOf,
  type RuleTier,
} from '../runtime/user-rules.js'
import { c, heading, ICON, line, strFlag, table, resolveDb } from './ui.js'

/**
 * `nucleus rules` —— 规则清单与遵守率。
 *
 * 两个问题以前都答不出来：
 *
 *  1. **有哪些规则？** 规则 id 散落在 precondition 里，只能靠触发才知道
 *     某条存在。现在有 runtime/rules.ts 的注册表。
 *  2. **模型听不听？** `contract.rejected` 事件一直在落库，但没有任何
 *     统计入口。而「prompt 规则被忽略」正是这个项目要修的问题之一 ——
 *     修没修好必须能用数字回答，而不是靠印象。
 *
 * 遵守率的分母刻意不是「所有 attempt」：委派用的 attempt 从来不提交结果，
 * 它没有契约要满足，算进去会把数字冲淡成无意义。
 */

interface ModelRow {
  provider: string
  model: string
  attempts: number
  rejected_attempts: number
  rejections: number
}

export async function rulesCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { config } = await loadConfig(strFlag(flags, 'config'))
  const n = await boot({
    config,
    ...resolveDb(flags),
    skipMcp: true,
  })
  const days = Number(strFlag(flags, 'since') ?? 30)

  try {
    const only = strFlag(flags, 'agent')
    if (only) {
      const cfg = n.config.agents.find((a) => a.id === only)
      if (!cfg) {
        line(c.red(`没有 agent「${only}」`))
        line(c.gray(`现有：${n.config.agents.map((a) => a.id).join(', ')}`))
        return 1
      }
      printAgentRules(n, only)
      await printAdherence(n, days, only)
      return 0
    }
    if (argv[0] !== 'stats') {
      printRuleList(n)
    }
    await printAdherence(n, days)
    return 0
  } finally {
    await n.close()
  }
}

/** ① 运行时强制的规则（注册表） ② 各 agent 的结果契约与能力边界（配置） */
function printRuleList(n: Nucleus): void {
  heading('运行时强制的规则')
  table(
    RULES.map((r) => [
      r.id,
      c.gray(scopeLabel(r.scope)),
      r.what,
      r.configurable ? c.cyan(r.configurable) : c.gray('不可配'),
    ]),
    ['ID', '层级', '禁止什么', '配置项'],
  )
  line()
  line(
    c.gray(
      '这三层都不依赖模型配合：能力边界让模型看不见工具，precondition 在调用前拒绝，' +
        'postcondition 把不合格的结果退回重写。',
    ),
  )

  /**
   * 用户自己写的规则。
   *
   * 与内置规则分开显示：内置的由代码强制、不可增删；这些是你写的，
   * 而且**每一条都要能看出它靠什么强制** —— 三层的代价差好几个数量级：
   * 边界零成本且不可违反，提醒每一轮都吃约束块的 token 而且只是说一声。
   */
  const userRules = n.config.rules ?? []
  if (userRules.length) {
    heading(`你写的规则（${userRules.length}）`)
    table(
      userRules.map((r) => [
        r.id,
        /**
         * 「管住了多少」和「靠哪几层管」是两件事，都得显示。
         *
         * `tiersOf` 只看规则里**有什么**，看不出那条要求里还有什么**没进来**。
         * 于是管住一半的规则在清单里和全管住的长得一模一样 ——
         * 而这正是这个项目要修的第一个毛病降到了分句一级：
         * **看起来有约束比没有约束更糟。**
         */
        tiersOf(r).map(tierLabel).join(' ') +
          (coverageOf(r) === 'partial' ? ` ${c.yellow(`半 (${r.uncovered.length})`)}` : ''),
        r.appliesTo.length === 0 || r.appliesTo.includes('*') ? c.gray('全部') : r.appliesTo.join(', '),
        r.check?.requiredFields?.join(', ') ?? c.gray('—'),
        r.denyTools.join(', ') || c.gray('—'),
      ]),
      ['ID', '强制方式', '作用于', '必填字段（检查）', '禁用工具（边界）'],
    )
    line()

    /**
     * 没管住的分句要**逐条列出来**，不只在表里标一个数字。
     *
     * 标数字只说明「有遗漏」，而人需要知道**遗漏的是哪一句** ——
     * 否则「plan-first 半」看起来像个小瑕疵，而实际上没管住的
     * 可能恰好是那条要求的重点（实测就是：「必须经用户同意」）。
     */
    const partial = userRules.filter((r) => coverageOf(r) === 'partial')
    if (partial.length) {
      line(
        `${ICON.warn} ${c.yellow(`${partial.length} 条只管住了一部分`)} —— ` +
          c.gray('下面这些分句**没有任何机械强制**，靠模型自觉：'),
      )
      for (const r of partial) {
        line(`  ${c.bold(r.id)}`)
        for (const u of r.uncovered) line(`    ${c.yellow('·')} ${u}`)
      }
      line(c.gray('  多数是运行时缺原语（用户审批、验运行时事实）—— 见 docs/BACKLOG.md C-17。'))
      line()
    }
    // 把「提醒」的永久成本说出来 —— 加规则时看不到它，就会越加越多
    const withReminder = userRules.filter((r) => r.constraint)
    if (withReminder.length) {
      const tokens = withReminder.reduce(
        (n, r) => n + Math.ceil((r.gist ?? r.constraint ?? '').length / 2),
        0,
      )
      line(
        c.gray(
          `${withReminder.length} 条带「提醒」，常驻约 ${tokens} tok —— **每一轮都花**。` +
            `超出上限时会被砍半（shrink_constraints）。`,
        ),
      )
    }
    for (const r of withReminder) {
      line(`  ${c.gray(`${r.id}：`)}${r.constraint}`)
    }

    /**
     * **检查也有每轮成本，而这一直没人算。**
     *
     * 提醒的成本上面一直在报（约束块有 2000 的预算）。而字段声明进的是
     * **工具 schema** —— 每一轮都随工具定义发出去，实测约 55 tok/字段。
     * `rule new` 对这种规则原先印的是「常驻成本 0」，那是假的。
     *
     * 按 agent 分开报，因为 appliesTo 是唯一的杠杆：**这一层不能像长提醒
     * 那样按需加载**（模型必须在被调用那一刻就看到完整 schema），
     * 所以省 token 的唯一办法就是别把只有一个专家需要的字段挂到 `*` 上。
     */
    const bare = resultSchemaTokens({})
    const perAgent = n.config.agents
      .map((a) => {
        const fields = resultFieldsForAgent(userRules, a.id).fields
        const n2 = Object.keys(fields).length
        return { id: a.id, count: n2, cost: n2 ? resultSchemaTokens({ fields }) - bare : 0 }
      })
      .filter((x) => x.count > 0)
    if (perAgent.length) {
      line()
      line(
        c.gray(
          '规则声明的字段进**工具 schema**，也是每一轮都花 —— ' +
            '而且不能像长提醒那样按需加载（模型必须当场看到完整 schema）：',
        ),
      )
      for (const a of perAgent) {
        line(`  ${a.id.padEnd(16)} ${a.count} 个字段 · 约 ${a.cost} tok/轮`)
      }
      line(c.gray('  唯一的杠杆是 appliesTo：只有一个专家需要的字段别挂到 * 上。'))
    }
  } else {
    line()
    line(c.gray('还没有你自己写的规则。加一条：把 examples/rules/*.md 复制到 rules/ 下。'))
    line(c.gray('一条规则同时携带三层，运行时按字段决定它落到哪 —— 见那个目录的 README。'))
  }
  // 三层各自是什么、代价多少 —— 名字之外还要说清代价，否则「提醒」还是会被滥用
  if (userRules.length) {
    line()
    for (const t of ['boundary', 'check', 'reminder'] as RuleTier[]) {
      line(`  ${tierLabel(t)}  ${c.gray(TIER_WHAT[t])}`)
    }
  }

  heading('各 agent 的契约与边界')
  const rows: string[][] = []
  for (const a of n.config.agents) {
    rows.push([
      a.id,
      a.requiredFields?.length ? c.yellow(a.requiredFields.join(', ')) : c.gray('—'),
      (a.permissions ?? []).join(', ') || c.gray('（无权限）'),
    ])
  }
  table(rows, ['AGENT', '必填字段（postcondition）', '可用工具（capability）'])
  line()
  line(c.gray('必填字段与工具白名单都在 nucleus.config.json 里改，见 nucleus.config.example.json'))
  line(
    c.gray(
      '写在 identity/policy 正文里的软规则不在这里 —— 它们无法被运行时验证，' +
        '也就统计不出遵守率。',
    ),
  )
}

/**
 * 单个 agent 视角的规则全貌。
 *
 * 只列**这个 agent 实际会碰到**的规则 —— fs.workdir-boundary 对没有文件
 * 工具的 agent 是空文；delegate.* 对不能委派的 agent 也是。把全部规则一股脑
 * 列出来会让人分不清哪条真的约束着它。
 */
function printAgentRules(n: Nucleus, id: string): void {
  const cfg = n.config.agents.find((a) => a.id === id)!
  const spec = agentSpec(cfg, n.config.defaults)
  const tools = n.tools.forAgent(spec.permissions, spec.toolsAllow, spec.toolsDeny).map((t) => t.name)

  heading(`${id} 的规则`)
  line(`${c.gray('负责领域')} ${cfg.whenToUse ?? c.red('（未声明）')}`)
  line(`${c.gray('是否入口')} ${n.config.defaults.entryAgent === id ? c.cyan('是') : c.gray('否')}`)

  heading('内置的能力边界')
  line(`  ${c.gray('授予权限')} ${spec.permissions.join(', ') || c.gray('（无）')}`)
  line(`  ${c.gray('可用工具')} ${tools.join(', ') || c.gray('（无）')}`)
  if (spec.toolsAllow?.length) line(`  ${c.gray('名字收窄')} ${spec.toolsAllow.join(', ')}`)
  if (spec.toolsDeny?.length) line(`  ${c.gray('显式拒绝')} ${spec.toolsDeny.join(', ')}`)
  const unavailable = (spec.toolsAllow ?? []).filter((t) => !t.includes('*') && !n.tools.get(t))
  if (unavailable.length) {
    line(`  ${ICON.warn} ${c.yellow('声明了但未注册')}：${unavailable.join(', ')}`)
  }
  line(c.gray('  这一层最强：不给工具，模型无从违反，成本为零'))

  heading('内置的结果契约（检查）')
  if (cfg.requiredFields?.length) {
    for (const f of cfg.requiredFields) line(`  ${c.yellow(f)}`)
    line(c.gray('  缺了会被退回并把缺项告知模型，重试上限内改对即可'))
  } else {
    line(c.gray('  只有核心字段（status / summary / artifacts）'))
  }

  // 只列它可能触发的运行时规则
  heading('会碰到的运行时规则')
  // 按规则**声明**的强制工具判断，不猜名字
  const reachable = RULES.filter((r) => r.tools.length === 0 || r.tools.some((t) => tools.includes(t)))
  if (reachable.length === 0) {
    line(c.gray('  （无 —— 它的工具集触发不到任何一条）'))
  }
  for (const r of reachable) {
    line(`  ${c.yellow(r.id.padEnd(24))} ${r.what}`)
    line(c.gray(`  ${' '.repeat(24)} 由 ${r.enforcedBy} 强制${r.configurable ? ` · 配置项 ${r.configurable}` : ''}`))
  }

  const notReachable = RULES.filter((r) => !reachable.includes(r))
  if (notReachable.length) {
    line()
    line(c.gray(`触发不到（缺相应工具）：${notReachable.map((r) => r.id).join(', ')}`))
  }
}

async function printAdherence(n: Nucleus, days: number, agentId?: string): Promise<void> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  // 按 agent 过滤时 join runs 取 agent_id
  const agentJoin = agentId ? `join runs r on r.id = a.run_id and r.agent_id = '${agentId.replace(/'/g, "''")}'` : ''

  // 分母：**有契约要满足**的 attempt。
  // 委派用的 attempt 从不提交结果，算进去只会把数字冲淡。
  const models = await n.db.query<ModelRow>(
    `with contracted as (
       select a.id, a.provider, a.model,
              count(e.id) filter (where e.kind = 'contract.rejected') as rejections,
              count(e.id) filter (where e.kind = 'contract.accepted') as accepted
         from run_attempts a
         ${agentJoin}
         left join run_events e on e.run_attempt_id = a.id
        where a.provider is not null
          and a.created_at >= $1
        group by a.id, a.provider, a.model
       having count(e.id) filter (where e.kind in ('contract.accepted','contract.rejected')) > 0
          or bool_or(a.error_code like 'contract.%')
     )
     select provider, model,
            count(*)::int as attempts,
            count(*) filter (where rejections > 0)::int as rejected_attempts,
            coalesce(sum(rejections), 0)::int as rejections
       from contracted
      group by provider, model
      order by attempts desc`,
    [since],
  )

  heading(`遵守率（最近 ${days} 天${agentId ? ` · ${agentId}` : ''}）`)
  if (models.rows.length === 0) {
    line(c.gray('还没有需要满足结果契约的 attempt。'))
    line(c.gray('跑一轮真实任务后再看：nucleus ask "..." --model <模型>'))
    return
  }

  table(
    models.rows.map((r) => {
      const clean = r.attempts - r.rejected_attempts
      const rate = r.attempts ? clean / r.attempts : 0
      return [
        `${r.provider}:${r.model}`,
        String(r.attempts),
        String(clean),
        r.rejected_attempts ? c.yellow(String(r.rejected_attempts)) : c.gray('0'),
        rateColor(rate),
      ]
    }),
    ['模型', '有契约的 attempt', '一次过', '被退回', '遵守率'],
  )
  line()
  line(c.gray('「一次过」= 第一次提交就通过校验。被退回不等于失败 —— 缺项会回喂给模型重写。'))

  // 哪个字段最常缺 —— 这决定该改规则还是换模型
  const fields = await n.db.query<{ path: string; n: number }>(
    `select f->>'path' as path, count(*)::int as n
       from run_events e
       cross join lateral jsonb_array_elements(e.payload->'failures') as f
      where e.kind = 'contract.rejected' and e.created_at >= $1
      group by 1 order by n desc limit 12`,
    [since],
  )
  if (fields.rows.length) {
    heading('最常缺的字段')
    for (const f of fields.rows) {
      line(`  ${c.yellow(String(f.path).padEnd(28))} ${f.n} 次`)
    }
    line()
    line(
      c.gray(
        '同一个字段反复缺，说明这条规则对当前模型太难 —— 换模型或简化契约，' +
          '比继续往 prompt 里加话有用。',
      ),
    )
  }

  // 运行时规则的拦截次数
  const viol = await n.db.query<{ rule: string; tool: string; n: number }>(
    `select payload->>'rule' as rule, payload->>'tool' as tool, count(*)::int as n
       from run_events
      where kind = 'rule.violation' and created_at >= $1
      group by 1, 2 order by n desc limit 20`,
    [since],
  )
  if (viol.rows.length) {
    heading('运行时规则拦截')
    for (const v of viol.rows) {
      const spec = ruleSpec(v.rule)
      line(
        `  ${c.yellow((v.rule ?? '?').padEnd(26))} ${String(v.n).padStart(3)} 次  ` +
          c.gray(`${v.tool ?? ''}${spec ? '' : '  ← 未注册的规则 id'}`),
      )
    }
    line()
    line(c.gray('拦截不是错误：模型收到明确原因后改路，任务照样能完成。'))
  }

  // 上下文降级：不是规则，但同样影响「模型为什么没照做」
  const deg = await n.db.query<{ n: number }>(
    `select count(*)::int as n from run_events
      where kind = 'context.assembled'
        and created_at >= $1
        and jsonb_array_length(payload->'degradations') > 0`,
    [since],
  )
  const degN = deg.rows[0]?.n ?? 0
  if (degN > 0) {
    line()
    line(
      `${ICON.warn} ${c.yellow(`${degN} 次装配发生了上下文降级`)}` +
        c.gray(' —— 历史被裁掉时模型可能是「没看到」而不是「不听话」'),
    )
    line(c.gray('  逐次查看：nucleus events <run-id> | grep context.assembled'))
  }
}

function scopeLabel(s: string): string {
  switch (s) {
    case 'capability':
      return '能力边界'
    case 'precondition':
      return '调用前拒绝'
    case 'postcondition':
      return '结果契约'
    default:
      return s
  }
}

function rateColor(rate: number): string {
  const pct = `${(rate * 100).toFixed(1)}%`
  if (rate >= 0.9) return c.green(pct)
  if (rate >= 0.6) return c.yellow(pct)
  return c.red(pct)
}


/**
 * **颜色即代价**：
 * 边界绿（零成本、不可违反）、检查青（一次重写）、提醒黄（每轮都花，而且只是提示）。
 */
function tierLabel(t: RuleTier): string {
  const s = TIER_LABEL[t]
  if (t === 'boundary') return c.green(s)
  if (t === 'check') return c.cyan(s)
  return c.yellow(s)
}
