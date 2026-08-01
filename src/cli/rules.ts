import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { RULES, ruleSpec } from '../runtime/rules.js'
import { c, heading, ICON, line, strFlag, table } from './ui.js'

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
    databaseUrl: strFlag(flags, 'db') ?? process.env['NUCLEUS_DATABASE_URL'] ?? null,
    // 与其它命令同一套解析 —— 写死路径会让这个命令悄悄打开另一个（空的）库
    dataDir:
      strFlag(flags, 'data') ?? process.env['NUCLEUS_PGLITE_DIR'] ?? '.nucleus-data/pglite',
    skipMcp: true,
  })
  const days = Number(strFlag(flags, 'since') ?? 30)

  try {
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

  heading('各 agent 的契约与边界')
  const rows: string[][] = []
  for (const a of n.config.agents) {
    rows.push([
      a.id,
      a.requiredFields?.length ? c.yellow(a.requiredFields.join(', ')) : c.gray('—'),
      a.toolsAllow.join(', ') || c.gray('（无工具）'),
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

async function printAdherence(n: Nucleus, days: number): Promise<void> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  // 分母：**有契约要满足**的 attempt。
  // 委派用的 attempt 从不提交结果，算进去只会把数字冲淡。
  const models = await n.db.query<ModelRow>(
    `with contracted as (
       select a.id, a.provider, a.model,
              count(e.id) filter (where e.kind = 'contract.rejected') as rejections,
              count(e.id) filter (where e.kind = 'contract.accepted') as accepted
         from run_attempts a
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

  heading(`遵守率（最近 ${days} 天）`)
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
