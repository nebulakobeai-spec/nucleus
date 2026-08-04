import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot } from '../boot.js'
import { loadConfig, resolveConfigDir } from '../config-file.js'
import {
  coverageOf,
  DEFAULT_RULES_DIR,
  presenceOf,
  roughTokens,
  TIER_LABEL,
  tiersOf,
  type UserRule,
} from '../runtime/user-rules.js'
import { RESERVED_FIELDS } from '../runtime/result-schema.js'
import { confirm } from './prompt.js'
import { c, heading, ICON, line, resolveDb, strFlag } from './ui.js'

/**
 * `nucleus rule rm <id>` —— 删一条规则。
 *
 * ── 为什么这个命令原先不存在 ────────────────────────────
 *
 * 只有 `rule new`。删一条规则得自己 `rm rules/foo.md` ——
 * 而那样做**看不见你删掉了什么**：那条规则可能正在给某个 agent 加必填字段，
 * 也可能正被别的规则依赖。
 *
 * ── 删之前必须说清三件事 ────────────────────────────────
 *
 * ① **它在管什么**（哪几层、哪些字段、哪些 agent）。删规则等于放开约束，
 *    而放开约束是不会有任何报错的 —— 从此模型少交一个字段，没人会注意到。
 * ② **有没有别的规则依赖它声明的字段**。规则 A 声明 `plan`、规则 B 要求
 *    `plan[].step` 时，删掉 A 会让 B 引用一个未声明的字段 ——
 *    那时加载器会拒，而报错指向 B，不指向「你刚删了 A」。
 * ③ **能省多少每轮成本**。这是删除唯一的正面收益，值得说出来。
 *
 * 没有 `--force`。删除本身就是那个动作，「强制删除」不是另一种操作 ——
 * 非交互场景用 `--yes`，那是关于「没人能回答」，不是关于「用力一点」。
 */

export async function ruleRm(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const id = (argv[0] ?? '').trim()
  if (!id) {
    line(c.red('用法：nucleus rule rm <规则 id>'))
    line(c.gray('  看有哪些：nucleus rules'))
    return 1
  }

  // 与 rule add 同一套来源顺序：--dir > 配置的 rulesDir > 默认。
  // 漏掉中间一层的后果是「删不掉」——它去删的是另一个目录里不存在的文件。
  const { config, path: configPath } = await loadConfig(strFlag(flags, 'config'))
  const cliDir = strFlag(flags, 'dir')
  const dir = resolveConfigDir(cliDir ?? config.rulesDir ?? DEFAULT_RULES_DIR, configPath, Boolean(cliDir))
  const path = join(dir, `${id}.md`)
  if (!existsSync(path)) {
    line(c.red(`没有这条规则：${path}`))
    line(c.gray('  看有哪些：nucleus rules'))
    return 1
  }

  const n = await boot({ config, ...resolveDb(flags), skipMcp: true })

  try {
    const rules = n.config.rules ?? []
    const rule = rules.find((r) => r.id === id)
    if (!rule) {
      /**
       * 文件在，但加载器没收下它 —— 说明它现在**根本没生效**。
       *
       * 这时候直接删是对的，但要说清「你删的是一条本来就没起作用的规则」，
       * 否则会误以为刚放开了一道约束。
       */
      line(`${ICON.warn} ${c.yellow('文件在，但这条规则没被加载')} —— 它现在没有生效`)
      line(c.gray('  多半是 frontmatter 有问题：nucleus rules 会说是哪一条'))
      if (!(await ok(flags, `照样删掉 ${path}？`))) return 1
      await unlink(path)
      line(`${ICON.ok} 已删除 ${path}`)
      return 0
    }

    heading(`要删的规则：${c.bold(id)}`)
    describe(rule, n)

    const dependents = dependentsOf(rules, id)

    if (dependents.length) {
      line()
      line(`${ICON.fail} ${c.red('有别的规则依赖它声明的字段')}`)
      for (const d of dependents) {
        line(`  ${c.bold(d.rule.id)} 要求 ${c.yellow(d.fields.join(', '))}`)
      }
      line(c.gray('  删了之后那些规则会引用未声明的字段，加载时被拒 ——'))
      line(c.gray('  而报错指向它们，不指向「你刚删了这一条」。'))
      line(c.gray(`  先处理它们：nucleus rule edit <id> "…"`))
      return 1
    }

    line()
    if (!(await ok(flags, `删除 ${path}？`))) {
      line(c.gray('  没删。'))
      return 1
    }
    await unlink(path)
    line(`${ICON.ok} 已删除 ${path}`)
    line(c.gray('  确认一下：nucleus rules'))
    return 0
  } finally {
    await n.close()
  }
}

/**
 * 别的规则会不会因为这次删除而坏掉。
 *
 * ── 为什么单独拆成纯函数 ──────────────────────────────
 *
 * 这是删除唯一会**让别的东西坏掉**的方式：规则 A 声明 `plan`、规则 B 要求
 * `plan[].step`，删掉 A 之后 B 引用一个未声明的字段，加载器会拒 ——
 * 而报错指向 B，**不指向「你刚删了 A」**。那种错误最难查：你以为自己动的是 A。
 *
 * 判据本身很小，但它是「删除安不安全」的全部依据，所以要能单测 ——
 * 埋在一个需要 boot 和真数据库的命令里，实际上等于没人验过。
 */
export function dependentsOf(
  rules: UserRule[],
  id: string,
): Array<{ rule: UserRule; fields: string[] }> {
  const target = rules.find((r) => r.id === id)
  if (!target) return []
  // 只看这条规则**自己声明**的顶层字段；核心字段不算，它们一直都在
  const mine = new Set(Object.keys(target.check?.resultFields ?? {}))
  if (!mine.size) return []
  return rules
    .filter((r) => r.id !== id)
    .map((r) => ({
      rule: r,
      fields: (r.check?.requiredFields ?? []).filter((f) => mine.has(f.split(/[.[]/)[0]!)),
    }))
    .filter((x) => x.fields.length > 0)
}

/** 非 TTY 下没人能回答，必须显式 `--yes` —— 那不是「强制」，是「无人可问」 */
async function ok(flags: Record<string, string | true>, q: string): Promise<boolean> {
  if (flags['yes'] === true) return true
  if (!process.stdin.isTTY) {
    line(c.red(`${q} —— 非交互环境需要 --yes`))
    return false
  }
  return await confirm(q, false)
}

/** 这条规则在管什么、花多少 —— 删之前唯一该看的东西 */
function describe(rule: UserRule, n: Awaited<ReturnType<typeof boot>>): void {
  line(`${c.gray('强制方式')} ${tiersOf(rule).map((t) => TIER_LABEL[t]).join(' + ') || c.red('（无）')}`)

  const scope =
    rule.appliesTo.length === 0 || rule.appliesTo.includes('*')
      ? `全部（${n.config.agents.map((a) => a.id).join(', ')}）`
      : rule.appliesTo.join(', ')
  line(`${c.gray('作用于')} ${scope}`)

  if (rule.denyTools.length) {
    line(`${c.gray('会放开')} ${c.yellow(rule.denyTools.join(', '))} ${c.gray('—— 这些工具将重新可见')}`)
  }
  const req = rule.check?.requiredFields ?? []
  if (req.length) {
    line(`${c.gray('会不再必填')} ${c.yellow(req.join(', '))}`)
    // 核心字段与规则声明的字段，删除后的下场不同，要分开说
    const declared = Object.keys(rule.check?.resultFields ?? {})
    if (declared.length) {
      line(c.gray(`  其中 ${declared.join(', ')} 是这条规则声明的 —— 会从结果 schema 里整个消失`))
    }
    const core = req.filter((f) => RESERVED_FIELDS.includes(f.split(/[.[]/)[0]!))
    if (core.length) {
      line(c.gray(`  ${core.join(', ')} 是核心字段 —— 字段还在，只是不再强制`))
    }
  }

  if (coverageOf(rule) === 'partial') {
    line()
    line(c.gray(`这条本来也只管住了一部分，没管住的：`))
    for (const u of rule.uncovered) line(c.gray(`  · ${u}`))
  }

  // 删除唯一的正面收益，说出来
  const resident = presenceOf(rule) === 'none' ? '' : (rule.gist ?? rule.constraint ?? '')
  if (resident) {
    line()
    line(`${c.green('会省下')} 约 ${roughTokens(resident)} tok/轮${c.gray('（提醒不再注入）')}`)
  }

  line()
  line(c.yellow('删规则等于放开约束，而放开约束不会有任何报错。'))
  line(c.gray('  从此模型少交一个字段、多用一个工具，都不会有人提醒你。'))
}
