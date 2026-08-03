import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boot } from '../boot.js'
import { loadConfig } from '../config-file.js'
import {
  DEFAULT_RULES_DIR,
  INLINE_MAX_TOKENS,
  roughTokens,
  TIER_WHAT,
  validateRules,
  type UserRule,
} from '../runtime/user-rules.js'
import { FIELD_NAME, FIELD_NAME_HINT, RESERVED_FIELDS } from '../runtime/result-schema.js'
import { askNumber, closePrompts, confirm, readLine, select, type Choice } from './prompt.js'
import { c, heading, ICON, line, resolveDb, strFlag } from './ui.js'

/**
 * `nucleus rule new` —— 加一条规则。
 *
 * ── 这个向导的价值不在「帮你把话写漂亮」 ──────────────────
 *
 * 「我想加一条规则」时，人的默认冲动是**直接写一句 prompt 文本** ——
 * 而那恰好是三层里最弱的一层。所以向导的核心是**按强度倒着逼问**：
 *
 *   ① 能不能用「不给能力」表达？          边界 —— 零成本、不可违反
 *   ② 违反了能不能从**结果**里机械看出来？  检查 —— 一次重写
 *   ③ 剩下的才是提醒                      每一轮都花，而且只是说一声
 *
 * 顺序本身就是答案的一部分。先问边界，是因为一旦能用边界表达，
 * 后两层都不必写；先问提醒，就会写完提醒之后懒得再想别的。
 *
 * ── 什么能由 Nucleus 判定，什么必须你回答 ─────────────────
 *
 * 能机械判定的：工具名是否真实、字段路径是否合法、最终是否只剩提醒、
 * 提醒的常驻成本是多少。这些一律不问你。
 *
 * **判不了的是「这条约束能不能用边界表达」** —— 那要理解约束的含义。
 * 所以那一步是问你，而且问得很具体（「是不是『不许用某个工具』？」），
 * 不是让你自己去分类。
 */

interface Draft {
  id: string
  gist: string | null
  constraint: string | null
  denyTools: string[]
  requiredFields: string[]
  resultFields: Record<string, unknown>
  appliesTo: string[]
}

export async function ruleNew(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  try {
    return await wizard(argv, flags)
  } finally {
    closePrompts()
  }
}

async function wizard(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const id = (argv[0] ?? '').trim()
  if (!id) {
    line(c.red('用法：nucleus rule new <规则 id>'))
    line(c.gray('  id 会成为文件名：rules/<id>.md。小写字母、数字、点、连字符'))
    line()
    line('向导会按**强度倒着**问 —— 先问能不能用最强的那层表达：')
    for (const t of ['boundary', 'check', 'reminder'] as const) {
      line(c.gray(`  ${TIER_WHAT[t]}`))
    }
    return 1
  }
  if (!/^[a-z][a-z0-9.-]*$/.test(id)) {
    line(c.red(`id 只能是小写字母、数字、点与连字符：${id}`))
    return 1
  }

  const dir = strFlag(flags, 'dir') ?? DEFAULT_RULES_DIR
  const path = join(resolve(dir), `${id}.md`)
  if (existsSync(path) && flags['force'] !== true) {
    line(c.red(`${path} 已存在`))
    line(c.gray('  改它直接编辑那个文件；要覆盖加 --force'))
    return 1
  }

  const { config } = await loadConfig(strFlag(flags, 'config'))
  const n = await boot({ config, ...resolveDb(flags), skipMcp: flags['mcp'] !== true })

  try {
    const draft: Draft = {
      id,
      gist: null,
      constraint: null,
      denyTools: [],
      requiredFields: [],
      resultFields: {},
      appliesTo: [],
    }

    heading(`加一条规则：${c.bold(id)}`)
    line(c.gray('三层的强制方式与代价差好几个数量级，所以从最强的那层开始问。'))
    line()

    const what = (await readLine('这条规则要求什么？（一句话）：')).trim()
    if (!what) return cancelled()
    line()

    // ── ① 边界 ──
    const tools = [...n.tools.all()].map((t) => t.name).sort()
    line(`${c.green('① 边界')} ${c.gray(TIER_WHAT['boundary'])}`)
    line(c.gray('  最强的一层：工具不出现在模型看到的定义里，所以它无从违反。'))
    const isBoundary = await select('这条约束是不是「不许用某些工具」？', [
      {
        value: 'no' as const,
        label: '不是',
        detail: '它约束的是**怎么做 / 交出什么**，不是「能不能用某个工具」',
      },
      {
        value: 'yes' as const,
        label: '是',
        detail: `选出要禁掉的工具 —— 选完这条规则就完成了，不需要写任何文本`,
      },
    ])
    if (isBoundary === null) return cancelled()

    if (isBoundary === 'yes') {
      const picked: string[] = []
      for (;;) {
        const t = await select(
          `选一个要禁掉的工具${picked.length ? `（已选 ${picked.join(', ')}）` : ''}：`,
          [
            ...tools
              .filter((x) => !picked.includes(x))
              .map((x) => ({ value: x, label: x })),
            { value: '(done)', label: picked.length ? '选完了' : '（取消）' },
          ],
        )
        if (t === null || t === '(done)') break
        picked.push(t)
      }
      if (picked.length === 0) {
        line(c.gray('  没选工具 —— 那就不是边界，继续问下一层。'))
      } else {
        draft.denyTools = picked
        // 边界够了就到此为止：再写一句「不要用它们」是白花每轮的预算
        line()
        line(`${ICON.ok} ${c.green('这条规则只需要边界')} ${c.gray('—— 零成本，且不可违反')}`)
        line(c.gray('  不需要写任何提醒文本：那些工具根本不会出现在模型看到的定义里。'))
        draft.appliesTo = await askAppliesTo(n.config.agents.map((a) => a.id))
        return finish(draft, n, path, dir, flags)
      }
    }

    // ── ② 检查 ──
    line()
    line(`${c.cyan('② 检查')} ${c.gray(TIER_WHAT['check'])}`)
    line(c.gray('  判据是：**违反了之后，能不能只看结果就机械判出来？**'))
    line(c.gray(`  核心字段有 ${RESERVED_FIELDS.join(' / ')}；不够就声明新字段。`))
    const isCheck = await select('能从结果里机械看出违反吗？', [
      {
        value: 'yes' as const,
        label: '能 —— 要求结果里有某些字段',
        detail: '例：「数据必须带来源」→ 每个数据点都要有 source 字段',
      },
      {
        value: 'no' as const,
        label: '不能 —— 需要人的判断',
        detail: '例：语气、行文风格、思路是否清晰',
      },
    ])
    if (isCheck === null) return cancelled()

    if (isCheck === 'yes') {
      const shape = await select('字段长什么样？', [
        {
          value: 'core' as const,
          label: `要求核心字段必填`,
          detail: `从 ${RESERVED_FIELDS.join(' / ')} 里选 —— 不用声明新东西`,
        },
        {
          value: 'list' as const,
          label: '要求一个「条目列表」，每条都得带某些字段',
          detail: '例：data_points[] 每条都要 value / source / fetched_at',
        },
      ])
      if (shape === null) return cancelled()

      if (shape === 'core') {
        const f = await select(
          '哪个字段必填？',
          RESERVED_FIELDS.map((x) => ({ value: x, label: x })),
        )
        if (f === null) return cancelled()
        draft.requiredFields = [f]
      } else {
        /**
         * 名字在**输入时**就校验，而不是等到最后。
         *
         * 我第一版的示例文案自己写的是 `dataPoints`（camelCase），
         * 而字段名必须 snake_case —— 于是照着提示填完，最后一步才被加载器拒。
         * 「向导让我这么填，加载器又说不行」是最难堪的那种错。
         * 正则从 result-schema 导入，不在这里重写一份（重写必然漂）。
         */
        const listName = (await readLine('  列表字段叫什么？（如 data_points）：')).trim()
        if (!listName) return cancelled()
        if (RESERVED_FIELDS.includes(listName)) {
          line(c.red(`  ${listName} 是核心字段，不能覆盖。换个名字`))
          return 1
        }
        if (!FIELD_NAME.test(listName)) {
          line(c.red(`  ${FIELD_NAME_HINT}`))
          line(c.gray(`  比如 ${toSnake(listName)}`))
          return 1
        }
        line(c.gray('  每条要带哪些字段？一行一个，空行结束。'))
        line(c.gray('  形如 `source:string` / `value:number` / `fetched_at:string`'))
        const fields: Record<string, string> = {}
        for (;;) {
          const l = (await readLine('    ')).trim()
          if (!l) break
          const [name, type = 'string'] = l.split(':').map((x) => x.trim())
          if (!name) continue
          if (!FIELD_NAME.test(name)) {
            line(c.red(`    ${FIELD_NAME_HINT} —— 比如 ${toSnake(name)}`))
            continue
          }
          if (!['string', 'number', 'boolean'].includes(type)) {
            line(c.red(`    类型只能是 string / number / boolean，收到「${type}」`))
            continue
          }
          fields[name] = type
        }
        if (Object.keys(fields).length === 0) return cancelled()

        draft.resultFields = {
          [listName]: { type: 'object[]', description: what, fields },
        }
        // 每个元素都必填 —— `a[].b` 表示 a 非空且每一条的 b 都非空
        draft.requiredFields = Object.keys(fields).map((f) => `${listName}[].${f}`)
        line()
        line(`${ICON.ok} 检查：${c.cyan(draft.requiredFields.join(', '))}`)
        line(c.gray(`  少任何一项都会被退回，规则原文回给模型让它重做。`))
      }
    }

    // ── ③ 提醒 ──
    line()
    line(`${c.yellow('③ 提醒')} ${c.gray(TIER_WHAT['reminder'])}`)
    if (draft.requiredFields.length === 0 && draft.denyTools.length === 0) {
      /**
       * 走到这里说明前两层都答了「不能」。
       *
       * 那时**不该让人继续写提醒** —— 一条只有提醒的规则会出现在规则清单里、
       * 看起来系统在管这件事，而实际什么都没管。看起来有约束比没有约束更糟。
       */
      line(c.red('  前两层都用不上 —— 那这条约束目前无法可靠强制。'))
      line()
      line(c.gray('  只写提醒的规则会被加载器拒绝，理由是：'))
      line(c.gray('  它会出现在规则清单里、看起来系统在管这件事，而实际什么都没管。'))
      line(c.gray('  **看起来有约束比没有约束更糟。**'))
      line()
      line('  两条出路：')
      line(c.gray('  · 把它写进 agent 的 identity（那里本来就是「怎么做事」的地方，'))
      line(c.gray('    而且不占每轮的约束块预算）'))
      line(c.gray('  · 想清楚它有没有可机械判定的一面 —— 往往有：'))
      line(c.gray('    「回答要简洁」判不了，但「summary 不超过 N 字」可以'))
      return 1
    }

    line(c.gray('  提醒是给模型的解释，不是强制手段 —— 强制已经由上面两层做了。'))
    line(c.gray('  可以留空。'))
    const body = (await readLine('  提醒正文（回车跳过）：')).trim()
    if (body) {
      draft.constraint = body
      const t = roughTokens(body)
      if (t > INLINE_MAX_TOKENS) {
        line()
        line(
          `  正文约 ${t} token，超过内联上限 ${INLINE_MAX_TOKENS} ——` +
            ` 需要一个索引行，正文改为按需加载（read_rule）。`,
        )
        line(c.gray('  索引行必须带**触发条件**：模型看到的只有那一行，'))
        line(c.gray('  它据此决定要不要花一次工具调用去读正文。'))
        line(c.gray('  ✓「创建或部署文件前必读 —— 路径规则」   ✗「工作区路径规则」'))
        const g = (await readLine('  索引行：')).trim()
        if (!g) return cancelled()
        draft.gist = g
      }
    }

    draft.appliesTo = await askAppliesTo(n.config.agents.map((a) => a.id))
    return finish(draft, n, path, dir, flags)
  } finally {
    await n.close()
  }
}

async function askAppliesTo(agents: string[]): Promise<string[]> {
  line()
  const scope = await select('作用于谁？', [
    { value: '*', label: '全部 agent', detail: '加新 agent 时自动生效 —— 多数规则该用这个' },
    ...(agents.length
      ? [
          {
            value: 'pick',
            label: '只对指定的几个',
            detail: `现有：${agents.join(', ')}。**加新 agent 时不会自动生效**`,
          },
        ]
      : []),
  ])
  if (scope !== 'pick') return ['*']
  const picked: string[] = []
  for (;;) {
    const a = await select(
      `选一个 agent${picked.length ? `（已选 ${picked.join(', ')}）` : ''}：`,
      [
        ...agents.filter((x) => !picked.includes(x)).map((x) => ({ value: x, label: x })),
        { value: '(done)', label: picked.length ? '选完了' : '（改为全部）' },
      ] as Array<Choice<string>>,
    )
    if (a === null || a === '(done)') break
    picked.push(a)
  }
  return picked.length ? picked : ['*']
}

/** camelCase → snake_case，用来给出「你大概想写这个」 */
function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
}

function cancelled(): number {
  line()
  line(c.gray('已取消，什么都没写。'))
  return 1
}

function render(d: Draft): string {
  const fm: string[] = []
  if (d.gist) fm.push(`gist: ${d.gist}`)
  fm.push(`appliesTo: [${d.appliesTo.map((x) => `'${x}'`).join(', ')}]`)
  if (d.denyTools.length) fm.push(`denyTools: [${d.denyTools.join(', ')}]`)
  if (d.requiredFields.length) fm.push(`requiredFields: [${d.requiredFields.join(', ')}]`)
  for (const [name, decl] of Object.entries(d.resultFields)) {
    fm.push('resultFields:')
    fm.push(`  ${name}:`)
    const o = decl as { type: string; description?: string; fields?: Record<string, string> }
    fm.push(`    type: ${o.type}`)
    if (o.description) fm.push(`    description: ${o.description}`)
    if (o.fields) {
      fm.push(`    fields:`)
      for (const [k, v] of Object.entries(o.fields)) fm.push(`      ${k}: ${v}`)
    }
  }
  return `---\n${fm.join('\n')}\n---\n${d.constraint ? `\n${d.constraint}\n` : ''}`
}

async function finish(
  d: Draft,
  n: Awaited<ReturnType<typeof boot>>,
  path: string,
  dir: string,
  flags: Record<string, string | true>,
): Promise<number> {
  const rule: UserRule = {
    id: d.id,
    gist: d.gist,
    constraint: d.constraint,
    check:
      d.requiredFields.length || Object.keys(d.resultFields).length
        ? {
            ...(d.requiredFields.length ? { requiredFields: d.requiredFields } : {}),
            ...(Object.keys(d.resultFields).length
              ? { resultFields: d.resultFields as never }
              : {}),
          }
        : null,
    denyTools: d.denyTools,
    appliesTo: d.appliesTo,
    path,
  }

  // 写之前拿真注册表校验 —— 与 agent new --describe 同一套分工
  const problems = validateRules([rule], {
    agents: n.config.agents.map((a) => a.id),
    tools: [...n.tools.all()].map((t) => t.name),
  })
  const fatal = problems.filter((p) => p.fatal)
  if (fatal.length) {
    line()
    for (const p of fatal) line(`${ICON.fail} ${p.message}`)
    return 1
  }

  line()
  heading('这条规则')
  const text = render(d)
  for (const l of text.split('\n')) line(`  ${c.gray(l)}`)

  line()
  // 常驻成本要在写之前就说出来 —— 事后才发现「怎么每轮都多几百 token」太晚
  const resident = d.gist ?? d.constraint ?? ''
  if (resident) {
    line(
      `常驻成本约 ${roughTokens(resident)} token/轮` +
        c.gray(d.gist ? '（只有索引行；正文按需加载）' : '（正文直接内联）'),
    )
  } else {
    line(`常驻成本 ${c.green('0')} ${c.gray('—— 纯边界 / 纯检查，不占约束块')}`)
  }
  for (const p of problems.filter((x) => !x.fatal)) line(`${ICON.warn} ${p.message}`)

  line()
  /**
   * 这里**直接写文件**，与 `model add` 不同。
   *
   * 区别在于：规则是**新文件**，没有既有注释可毁；而模型配置要改
   * `nucleus.config.json`，那份文件里全是「这个数字为什么是这个值」的注释，
   * JSON 序列化会把它们全部丢掉。同一个判断标准，不同的结论。
   */
  if (!(await confirm(`写入 ${path}？`))) return cancelled()
  await writeFile(path, text, 'utf8')
  line(`${ICON.ok} 已写入 ${path}`)
  line(c.gray(`  看一眼：nucleus rules`))
  if (dir !== DEFAULT_RULES_DIR) line(c.gray(`  注意目录不是默认的 —— 需要 rulesDir: "${dir}"`))
  void flags
  return 0
}
