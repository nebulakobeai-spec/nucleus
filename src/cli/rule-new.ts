import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boot } from '../boot.js'
import { loadConfig } from '../config-file.js'
import {
  DEFAULT_RULES_DIR,
  INLINE_MAX_TOKENS,
  roughTokens,
  coverageOf,
  TIER_WHAT,
  validateRules,
  type UserRule,
} from '../runtime/user-rules.js'
import {
  FIELD_NAME,
  FIELD_NAME_HINT,
  RESERVED_FIELDS,
  resultSchemaTokens,
} from '../runtime/result-schema.js'
import { askNumber, closePrompts, confirm, readLine, select, type Choice } from './prompt.js'
import { c, heading, ICON, line, resolveDb, strFlag } from './ui.js'
import { isMockOnly } from '../config.js'
import { parseArgs } from '../runtime/tools.js'
import {
  buildRulePrompt,
  clarifySchema,
  renderRuleMd,
  repairPrompt,
  ruleProposalSchema,
  salvageJson,
  toRule,
  validateRuleProposal,
  type ProposalProblem,
  type RuleProposal,
} from './rule-propose.js'

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
  /**
   * 这条要求里**没管住的分句**。
   *
   * 树上也要能表达「一半能管一半不能」—— 否则模型路径能拆、人的路径只能
   * 全要或全不要，而那正是我刚在模型路径上修掉的毛病。
   */
  uncovered: string[]
}

export async function ruleNew(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  try {
    /**
     * **描述一句话是主路径，问答树是退路。**
     *
     * 第一版只有问答树（先问边界、再问检查、最后提醒）。逻辑没错但不直觉：
     * 它把我的分类过程强加给使用者，而使用者心里想的是一句具体的要求，
     * 不是「这属于哪一层」。
     *
     * 而「属于哪一层」恰好是模型擅长判的 —— 它只需要理解那句要求的含义。
     * 所以：**说一句话 → 模型提议完整规则（含分层）→ 运行时校验 →
     * 只有校验不过或它自己拿不准时才问你。**
     *
     * 退路仍然留着：`--interactive`，以及配置里只有 mock 模型时自动退回
     * （那时问模型等于问一个假答案）。
     */
    const description = strFlag(flags, 'describe') ?? argv.slice(1).join(' ').trim()
    if (description && flags['interactive'] !== true) {
      return await describePath(argv[0] ?? '', description, flags)
    }
    return await wizard(argv, flags)
  } finally {
    closePrompts()
  }
}

/** 描述 → 模型提议 → 校验 → 只问不确定的 */
async function describePath(
  id: string,
  description: string,
  flags: Record<string, string | true>,
): Promise<number> {
  if (!/^[a-z][a-z0-9.-]*$/.test(id)) {
    line(c.red(`id 只能是小写字母、数字、点与连字符：${id || '(空)'}`))
    return 1
  }
  const dir = strFlag(flags, 'dir') ?? DEFAULT_RULES_DIR
  const path = join(resolve(dir), `${id}.md`)
  if (existsSync(path) && flags['force'] !== true) {
    line(c.red(`${path} 已存在（--force 覆盖）`))
    return 1
  }

  const { config } = await loadConfig(strFlag(flags, 'config'))
  const n = await boot({ config, ...resolveDb(flags), skipMcp: flags['mcp'] !== true })

  try {
    if (isMockOnly(n.config)) {
      // 问一个 mock 模型等于问一个假答案 —— 退回问答树，并说明为什么
      line(`${ICON.warn} 配置里只有 mock 模型 —— 让它判层等于拿一个假答案。`)
      line(c.gray('  退回一问一答。配好真实模型后再用 --describe 会顺很多。'))
      line()
      return await wizardWith(n, id, path, dir, flags, description)
    }

    heading(`加一条规则：${c.bold(id)}`)
    line(c.gray(`模型链 ${n.config.defaults.modelChain.join(' → ')}`))
    line(`  ${c.gray('你的要求：')}${description}`)
    line()
    line(c.gray('正在判它属于哪一层…'))

    const got = await converse(n, id, description)
    if (!got) return 1
    const p = got.proposal
    const problems = got.problems
    // ── 模型自己说强制不了 ──
    if (p.cannotEnforce) {
      /**
       * **两种「强制不了」，建议完全相反。**
       *
       * 实测：「执行前必须写计划，用户审核同意后再执行」被判 cannotEnforce，
       * 理由（模型自己推的，完全正确）是 check 只能验模型自己提交的字段，
       * 加一个 `plan_approved` 等于让它给自己签字。
       *
       * 而我当时给的建议是「写进 agent 的 identity」——**那是错的建议**。
       * identity 就是提醒，正是这套设计要减少依赖的东西。这条约束不是
       * 本质判不了，是运行时缺一个原语。把它埋进 identity 等于把一个
       * 能修的缺口变成一句没人强制的话，而且从此没人会再想起它。
       */
      const kind = p.unenforceableKind ?? guessKind(p)
      line(
        `${ICON.warn} ${c.yellow('模型判断这条约束无法可靠强制')}` +
          c.gray(kind === 'missing_mechanism' ? ' —— 运行时缺原语' : ' —— 本质判不了'),
      )
      line(`  ${p.reasoning}`)
      line()

      if (kind === 'missing_mechanism') {
        line(c.cyan('  注意这不是「这条要求不好」——'))
        line('  它**本可以机械判定**，只是 Nucleus 现在缺一个原语：')
        if (p.missingMechanism) line(`    ${c.bold(p.missingMechanism)}`)
        line()
        line(c.gray('  已知的缺口，都在 backlog 上：'))
        for (const g of KNOWN_GAPS) line(c.gray(`  · ${g}`))
        line()
        line(`  ${c.yellow('所以：不要把它写进 agent 的 identity。')}`)
        line(c.gray('  identity 就是「提醒」，而提醒对这条要求恰好是最没用的一层 ——'))
        line(c.gray('  把一个能修的缺口埋成一句没人强制的话，从此没人会再想起它。'))
        line(c.gray('  现在能做的：先不加这条规则，等原语落地；'))
        line(c.gray('  或者找出它可机械判定的那一面（往往有一小块能立刻管住）。'))
      } else {
        line(c.gray('  只有提醒的规则会被加载器拒绝，理由是它会出现在规则清单里、'))
        line(c.gray('  看起来系统在管，实际什么都没管。'))
        line()
        line('  两条出路：')
        line(c.gray('  · 写进 agent 的 identity —— 那里本来就是「怎么做事」的地方，'))
        line(c.gray('    而且不占每轮的约束块预算'))
        line(c.gray('  · 想清楚它有没有可机械判定的一面：'))
        line(c.gray('    「回答要简洁」判不了，但「summary 不超过 N 字」可以'))
      }
      line()
      /**
       * 这里**不该推荐决策树**。
       *
       * 树问的是「能不能从结果里机械看出来」—— 模型刚论证了不能，而且论证得对。
       * 让人再走一遍只会走到一个不相干的检查上（实测：plan-first 落在
       * `requiredFields: [open_questions]`）。而上面已经把两条出路说清了，
       * 不需要再问一句。
       *
       * `--interactive` 仍然在，但那是明确要求走树的时候用，不是兜底。
       */
      return 1
    }

    // ── 展示分层与理由 ──
    line(`${c.bold('分层')}  ${p.tier.map(tierColor).join(' + ')}`)
    line(`  ${c.gray(p.reasoning)}`)
    line()

    const rule = toRule(id, p, path)

    heading('这条规则')
    const text = renderRuleMd(rule)
    for (const l of text.split('\n')) line(`  ${c.gray(l)}`)

    line()
    for (const l of costLines(rule)) line(l)
    for (const x of problems.filter((y) => !y.fatal)) line(`${ICON.warn} ${x.message}`)

    /**
     * **机器判不了「这个检查真的对应那句要求吗」。**
     *
     * 模型可能编一个形式合法但不相干的检查来满足「提醒必须配检查」。
     * 那比只有提醒更糟 —— 看起来还多了一层保障。所以这一条显式问出来。
     */
    if (rule.check) {
      line()
      line(c.yellow('机器判不了的一件事：这个检查真的对应你那句要求吗？'))
      line(c.gray('  形式合法但不相干的检查比没有检查更糟 —— 它看起来像多了一层保障。'))
    }

    /**
     * **管住了一半就要说清是哪一半** —— 这是这次改动的核心。
     *
     * 复合要求几乎是常态，而 `cannotEnforce` 是整条规则的布尔值，
     * 于是模型只能二选一，实测就整条判了强制不了。而那条要求的前半句
     * 「必须写计划」今天就能查。现在它能拆，代价是必须把没管住的那半
     * 一路显示到底、并写进文件 —— 否则清单上一条「检查」看起来就是全管住了。
     */
    if (coverageOf(rule) === 'partial') {
      line()
      line(`${ICON.warn} ${c.yellow('这条规则只管住了一部分。')} 没管住的：`)
      for (const u of rule.uncovered) line(`  ${c.yellow('·')} ${u}`)
      line(c.gray('  会写进文件的 uncovered，并在 nucleus rules 里标成「半」。'))
      line(c.gray('  管一半比不管好 —— 但前提是没人误以为整条都生效了。'))
    }
    for (const u of p.uncertain ?? []) {
      line(`${ICON.warn} ${c.yellow('模型拿不准')}：${u}`)
    }

    line()
    if (!(await confirm(`写入 ${path}？`))) {
      line(c.gray('已取消。想自己一条条定：--interactive'))
      return 1
    }
    await writeFile(path, text, 'utf8')
    line(`${ICON.ok} 已写入 ${path}`)
    line(c.gray('  看一眼：nucleus rules'))
    return 0
  } finally {
    await n.close()
  }
}

/**
 * 与模型来回，直到拿到一份能过校验的提案。
 *
 * ── 为什么兜底不再是决策树 ────────────────────────────
 *
 * 我说过树的毛病是「把我的分类过程强加给使用者」，然后**把它留成了兜底** ——
 * 于是模型路径一失败，人就正好掉回那个毛病里。实测反馈：
 * 「你给我的那几个选项我甚至都不知道选什么。」
 *
 * 三种失败，三种正确的应对，**没有一种是决策树**：
 *
 * ① **模型把 JSON 写成了散文**（实测 gemma4 干过一次，内容完全正确）。
 *    → 捞出来用。协议洁癖不该摆在结果前面。
 *
 * ② **校验没过**（字段名不合法、引用了未声明的字段、工具不存在）。
 *    → 把问题回给模型重做。运行时对 agent 一直是这么做的
 *      （`contract.rejected` 把规则原文回给它）—— 我在这里没用这套。
 *      而这些问题**全是机械的**，模型改比人快。
 *
 * ③ **真的有歧义**（「用户审核」是每次都要，还是只在改生产时？）。
 *    → 让**模型用人话问**。它问的是具体的那件事，回答它不需要理解任何分层；
 *      而树问的是「这属于哪一层」，那是我的活。
 *
 * 轮数有上限：本地模型一轮约 3k tok，无限重试会把「模型答不对」
 * 变成「命令永远不返回」。
 */
const MAX_ROUNDS = 4

async function converse(
  n: Awaited<ReturnType<typeof boot>>,
  id: string,
  description: string,
): Promise<{ proposal: RuleProposal; problems: ProposalProblem[] } | null> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    {
      role: 'system',
      content:
        '你在设计运行时规则。拿不准的地方调用 ask_clarification 问一句；' +
        '想清楚了调用 propose_rule 提交。不要输出纯文本。',
    },
    { role: 'user', content: buildRulePrompt(n, id, description) },
  ]
  const tools = [
    { name: 'propose_rule', description: '提交这条规则的设计', parameters: ruleProposalSchema() },
    {
      name: 'ask_clarification',
      description: '有歧义时先问使用者一句。用他的语言问，一次一个',
      parameters: clarifySchema(),
    },
  ]

  let spent = 0
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const res = await n.router.chat(n.config.defaults.modelChain, { messages, tools })
    spent += res.usage.tokensIn + res.usage.tokensOut

    // ── ③ 模型想先问一句 ──
    const ask = res.toolCalls.find((t) => t.name === 'ask_clarification')
    if (ask) {
      const args = parseArgs(ask.arguments)
      const q = (args.ok ? (args.value as { question?: string; why?: string }) : {}) ?? {}
      if (!q.question) {
        messages.push({ role: 'user', content: 'ask_clarification 缺 question。重来。' })
        continue
      }
      line()
      line(`${c.cyan('?')} ${q.question}`)
      if (q.why) line(c.gray(`  （${q.why}）`))
      const answer = (await readLine('  ')).trim()
      if (!answer) {
        line(c.gray('  没答 —— 让它自己定。'))
        messages.push({ role: 'user', content: '不回答这个问题，你按最合理的假设定，并写进 uncertain。' })
      } else {
        messages.push({ role: 'user', content: `回答：${answer}` })
      }
      continue
    }

    // ── ① 提案，或者散文里的提案 ──
    let raw: unknown = null
    const call = res.toolCalls.find((t) => t.name === 'propose_rule')
    if (call) {
      const parsed = parseArgs(call.arguments)
      if (parsed.ok) raw = parsed.value
      else raw = salvageJson(call.arguments)
    } else {
      raw = salvageJson(res.content)
      if (raw) {
        // 说出来 —— 它没按协议来是个事实，只是不该因此把结果扔掉
        line(c.gray('  （模型把结果写成了文本而不是工具调用，已从文本里取出）'))
      }
    }
    if (!raw) {
      if (round === MAX_ROUNDS) break
      line(c.gray(`  第 ${round} 轮没拿到结构化结果，让它重来…`))
      messages.push({
        role: 'user',
        content: '你没有调用任何工具。必须调用 propose_rule 或 ask_clarification，不要输出纯文本。',
      })
      continue
    }

    // ── ② 校验，不过就回给它重做 ──
    const p = raw as RuleProposal
    const problems = validateRuleProposal(n, p)
    const fatal = problems.filter((x) => x.fatal)
    if (!fatal.length) {
      line(`${ICON.ok} ${c.gray(`${res.modelKey} · ${spent} tok · ${round} 轮`)}`)
      line()
      return { proposal: p, problems }
    }
    if (round === MAX_ROUNDS) {
      line(`${ICON.fail} ${c.red('改了几轮还是没过校验')}`)
      for (const x of fatal) line(`  ${c.red(x.field)}：${x.message}`)
      break
    }
    line(c.gray(`  第 ${round} 轮没过校验（${fatal.map((x) => x.field).join(', ')}），回给它改…`))
    messages.push({ role: 'assistant', content: JSON.stringify(p) })
    messages.push({ role: 'user', content: repairPrompt(fatal) })
  }

  line()
  line(c.gray(`  ${MAX_ROUNDS} 轮用完了，共 ${spent} tok。`))
  line(c.gray('  换个模型试试：--model <key>。或者直接照着 examples/rules/*.md 写一个文件 ——'))
  line(c.gray('  格式很简单，而且比一问一答快。'))
  return null
}

/**
 * 已知的原语缺口 —— 「强制不了」时要能说出**缺的是什么**。 *
 * 说不出来的话，「无法可靠强制」听起来就像「你这条要求不好」，
 * 而实际情况往往相反：要求本身完全可机械判定，是运行时还没长出那只手。
 * 这三条都在 backlog 上，不是永久限制。
 */
const KNOWN_GAPS = [
  '用户审批（ask_user / waiting_user）—— 「等人点头再继续」目前没有落点',
  '对**运行时事实**的检查 —— 现在只能验模型提交的字段，验不了「它到底调了什么」',
  '跨 run 的图条件 —— 「计划必须先过 Critic」这类门，没有表达它的地方',
]

/**
 * 模型没给 unenforceableKind 时的兜底判断。
 *
 * 只在 reasoning 里找**它自己说出来的**那些词，不做语义推测 ——
 * 猜错方向给出的是相反的建议，宁可落回保守的那一边（inherent，
 * 它的建议至少不会把人引去埋一个能修的缺口）。
 */
export function guessKind(p: RuleProposal): 'inherent' | 'missing_mechanism' {
  const t = p.reasoning ?? ''
  return /跨回合|跨轮|状态|审核|审批|同意|伪造|幻觉|历史对话|状态机|无法验证用户/.test(t)
    ? 'missing_mechanism'
    : 'inherent'
}

/**
 * 这条规则每轮花多少 token —— **两处都要算**。
 *
 * ── 我原先在这里印的是假话 ────────────────────────────
 *
 * 原文：`常驻成本 0 —— 纯边界 / 纯检查，不占约束块`。
 * 前半句「不占约束块」是对的，但「0」是错的：字段声明进的是**工具 schema**，
 * 每一轮都随工具定义发出去，实测约 55 tok / 字段。
 *
 * 也就是说我一边告诉人「检查比提醒便宜」（对），一边告诉他「检查免费」（错）。
 * 而检查恰好是我在鼓励人多用的那一层 —— 把它的成本印成 0，
 * 等于让人在不知情的情况下把预算花在 schema 上。
 *
 * **边界才真的是 0**：它只是让工具不出现，不加任何字段。
 */
function costLines(rule: UserRule): string[] {
  const out: string[] = []
  const resident = rule.gist ?? rule.constraint ?? ''
  if (resident) {
    out.push(
      `提醒 约 ${roughTokens(resident)} tok/轮` +
        c.gray(rule.gist ? '（只有索引行，正文按需加载）' : '（正文直接内联）'),
    )
  }
  const fields = rule.check?.resultFields
  if (fields && Object.keys(fields).length) {
    // 只算这条规则加进去的那部分，不含核心字段的底噪
    const delta = resultSchemaTokens({ fields }) - resultSchemaTokens({})
    out.push(
      `检查 约 ${Math.max(0, delta)} tok/轮 ` +
        c.gray('（字段声明进工具 schema）'),
    )
    out.push(
      c.gray('  这一层**不能**像长提醒那样按需加载 —— 模型必须在被调用那一刻就'),
    )
    out.push(c.gray('  看到完整 schema。唯一的杠杆是 appliesTo：别把只有一个专家'))
    out.push(c.gray('  需要的字段挂到 * 上。'))
  }
  if (!out.length) {
    out.push(
      `每轮成本 ${c.green('0')} ` +
        c.gray(rule.denyTools.length ? '—— 纯边界，只是让工具不出现' : '—— 没有常驻内容'),
    )
  }
  return out
}

function tierColor(t: string): string {  if (t === 'boundary') return c.green('边界')
  if (t === 'check') return c.cyan('检查')
  return c.yellow('提醒')
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
    return await wizardWith(n, id, path, dir, flags)
  } finally {
    await n.close()
  }
}

/** 问答树本体。`described` 有值时把它作为第一个问题的默认答案 */
async function wizardWith(
  n: Awaited<ReturnType<typeof boot>>,
  id: string,
  path: string,
  dir: string,
  flags: Record<string, string | true>,
  described?: string,
): Promise<number> {
  {
    const draft: Draft = {
      id,
      gist: null,
      constraint: null,
      denyTools: [],
      requiredFields: [],
      resultFields: {},
      appliesTo: [],
      uncovered: [],
    }

    heading(`加一条规则：${c.bold(id)}`)
    line(c.gray('三层的强制方式与代价差好几个数量级，所以从最强的那层开始问。'))
    line()

    const what = described ?? (await readLine('这条规则要求什么？（一句话）：')).trim()
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
        value: 'runtime' as const,
        label: '要验的不是我提交的内容，而是**过程中发生了什么**',
        detail: '例：有没有人批准过、调了哪个工具、是不是先过了某个 agent',
      },
      {
        value: 'no' as const,
        label: '不能 —— 需要人的判断',
        detail: '例：语气、行文风格、思路是否清晰',
      },
    ])
    if (isCheck === null) return cancelled()

    /**
     * **树也必须有这个出口。**
     *
     * 实测：「执行前必须写计划、用户同意后再执行」被模型正确判为强制不了，
     * 而退回树之后，树把人一路问到了 `requiredFields: [open_questions]` ——
     * 一个和那句要求毫无关系的检查。
     *
     * 树问的是「能不能从结果里机械看出来」，而它只有「能 / 不能」两个答案。
     * 于是「能判，但要判的不是我提交的东西」这个真实答案无处可去，
     * 人只能选「能」，然后随便挑一个字段。**那正是 cannotEnforce 要防的事**，
     * 而我的模型路径防住了，人的路径没防住。
     */
    if (isCheck === 'runtime') {
      line()
      line(c.yellow('  这一句目前强制不了 —— 但原因是运行时缺原语，不是你这条要求不好。'))
      line(c.gray('  check 校验的只有**模型自己提交的那份结果**，没有别的信息源。'))
      line(c.gray('  所以「它有没有真的先问过人」这种事现在验不了 ——'))
      line(c.gray('  加一个 `approved: true` 是同一个模型自己填的，等于给自己签字。'))
      line()
      line(c.gray('  已知的缺口，都在 backlog 上：'))
      for (const g of KNOWN_GAPS) line(c.gray(`  · ${g}`))
      line()

      /**
       * **不要在这里就放弃整条规则。**
       *
       * 这是我刚在模型路径上修掉的同一个毛病：要求几乎都是复合的，
       * 「有一句管不住」不等于「整条管不住」。实测那条就是两句 ——
       * 「必须写计划」今天能查，「必须经用户同意」不能。
       *
       * 所以先把管不住的那句记下来（它会写进文件、显示在清单里），
       * 然后**接着问剩下的部分**。整条都管不住时，末尾的
       * 「只有提醒」判据自然会拒掉它，不需要在这里提前下结论。
       */
      const clause = (await readLine('  把管不住的那一句抄下来（回车＝整条都是这一句）：')).trim()
      draft.uncovered.push(clause || what)
      line(c.gray(`  记下了，它会写进规则文件的 uncovered，并在 nucleus rules 里标出来 ——`))
      line(c.gray('  否则下个月清单上写着「已有检查」，没人记得这半句从来没生效。'))
      line()
      line('  现在看**剩下的部分**：')
      const rest = await select('去掉那一句之后，还有能从结果里机械看出来的吗？', [
        {
          value: 'yes' as const,
          label: '有 —— 继续定检查',
          detail: `管住能管的那部分。例：「必须写计划」→ 要求结果里有 plan 字段`,
        },
        {
          value: 'no' as const,
          label: '没有了 —— 整条要求都靠那个缺的原语',
          detail: '那就先不加这条规则，等原语落地',
        },
      ])
      if (rest === null) return cancelled()
      if (rest === 'no') {
        line()
        line(c.yellow('  那先不加 —— 整条都没有机械强制的部分。'))
        line(`  ${c.yellow('也不要写进 agent 的 identity。')}`)
        line(c.gray('  identity 就是提醒 —— 把一个能修的缺口埋成一句没人强制的话，'))
        line(c.gray('  从此没人会再想起它。它现在记在 backlog 的 C-17 上。'))
        return 1
      }
      line()
      if (!(await fillCheck(draft, what))) return cancelled()
    }

    if (isCheck === 'yes' && !(await fillCheck(draft, what))) return cancelled()

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
  }
}

/**
 * 填 check 的具体形状。返回 false 表示取消 / 填不下去。
 *
 * ── 为什么从树里拆出来 ────────────────────────────────
 *
 * 有两条路会到这里：直接答「能从结果里看出来」，以及答「要验的是运行时事实」
 * 之后**剩下的那部分**仍然能查。后者是关键 —— 一条要求里有一句管不住时，
 * 不该整条放弃，而该管住能管的、把管不住的记进 uncovered。
 *
 * 填完两条路都要继续问「提醒」，所以这里只填不收尾。
 */
async function fillCheck(draft: Draft, what: string): Promise<boolean> {

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
    if (shape === null) return false

    if (shape === 'core') {
      const f = await select(
        '哪个字段必填？',
        RESERVED_FIELDS.map((x) => ({ value: x, label: x })),
      )
      if (f === null) return false
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
      if (!listName) return false
      if (RESERVED_FIELDS.includes(listName)) {
        line(c.red(`  ${listName} 是核心字段，不能覆盖。换个名字`))
        return false
      }
      if (!FIELD_NAME.test(listName)) {
        line(c.red(`  ${FIELD_NAME_HINT}`))
        line(c.gray(`  比如 ${toSnake(listName)}`))
        return false
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
      if (Object.keys(fields).length === 0) return false

      draft.resultFields = {
        [listName]: { type: 'object[]', description: what, fields },
      }
      // 每个元素都必填 —— `a[].b` 表示 a 非空且每一条的 b 都非空
      draft.requiredFields = Object.keys(fields).map((f) => `${listName}[].${f}`)
      line()
      line(`${ICON.ok} 检查：${c.cyan(draft.requiredFields.join(', '))}`)
      line(c.gray(`  少任何一项都会被退回，规则原文回给模型让它重做。`))
    }
  
  return true
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

/**
 * 树以前有**自己一份渲染器**，和 rule-propose 的 renderRuleMd 并存。
 *
 * 删掉了：两份渲染同一种文件的代码必然漂 —— 加 uncovered 时就得改两处，
 * 漏掉一处的症状是「树生成的规则少了一半信息」，而且**不报错**。
 * `finish` 本来就已经拼出一个 UserRule，直接用那一个。
 */
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
    uncovered: d.uncovered,
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
  const text = renderRuleMd(rule)
  for (const l of text.split('\n')) line(`  ${c.gray(l)}`)

  line()
  // 成本要在写之前就说出来 —— 事后才发现「怎么每轮都多几百 token」太晚
  for (const l of costLines(rule)) line(l)
  for (const p of problems.filter((x) => !x.fatal)) line(`${ICON.warn} ${p.message}`)

  /**
   * **机器判不了「这个检查真的对应那句要求吗」。**
   *
   * 这句话原先只在 `--describe` 路径上说 —— 但树同样会走到不相干的检查上，
   * 而且树上人更容易走过去：一路按回车挑一个字段就成了。
   * 实测 plan-first 就落在了 `requiredFields: [open_questions]`。
   */
  if (rule.check) {
    line()
    line(c.yellow('机器判不了的一件事：这个检查真的对应你那句要求吗？'))
    line(c.gray('  形式合法但不相干的检查比没有检查更糟 —— 它看起来像多了一层保障。'))
  }

  /**
   * **管住了一半，就得在写之前说清是哪一半。**
   *
   * 这条信息也会跟着规则进文件（frontmatter 的 uncovered）并显示在
   * `nucleus rules` 里 —— 只在创建时打印一次是不够的：下个月清单上写着
   * 「plan-first：检查」，没人会记得另一半从来没生效。
   */
  if (coverageOf(rule) === 'partial') {
    line()
    line(`${ICON.warn} ${c.yellow('这条规则只管住了一部分。')} 没管住的：`)
    for (const u of rule.uncovered) line(`  ${c.yellow('·')} ${u}`)
    line(c.gray('  会写进文件的 uncovered，并在 nucleus rules 里标成「半」。'))
    line(c.gray('  管一半比不管好 —— 但前提是没人误以为整条都生效了。'))
  }

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
