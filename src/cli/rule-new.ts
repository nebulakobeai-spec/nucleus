import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boot } from '../boot.js'
import { loadConfig } from '../config-file.js'
import {
  coverageOf,
  DEFAULT_RULES_DIR,
  roughTokens,
  TIER_WHAT,
  validateRules,
  type UserRule,
} from '../runtime/user-rules.js'
import { resultSchemaTokens } from '../runtime/result-schema.js'
import { changed, diffLines, renderDiff } from './diff.js'
import { closePrompts, confirm, readLine } from './prompt.js'
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
 * ── 说一句话，剩下的和模型聊 ────────────────────────────
 *
 *     nucleus rule new plan-first "每次执行任务前必须写计划，用户同意后再执行"
 *
 * 模型判它落在哪几层、提议完整规则；运行时机械校验；**不满意就说一句，它改**。
 *
 * ── 这里原先有一棵决策树，删了 ──────────────────────────
 *
 * 第一版是问答树：先问「是不是不许用某些工具」，再问「能不能从结果里看出来」。
 * 逻辑没错，毛病是**谁的语言** —— 要先理解边界/检查/提醒三层才能回答，
 * 而使用者心里想的是一句具体的要求。实测反馈两次指向同一件事：
 * 「一问一答不如直接和模型对话来确定这个 rule」、
 * 「你给我的那几个选项我甚至都不知道选什么」。
 *
 * 第一次我只把树降级成兜底 —— 于是模型路径一失败就掉回同一个毛病。
 * 所以整棵删掉。
 *
 * ── 什么由 Nucleus 判定，什么必须你回答 ─────────────────
 *
 * 机械判定的一律不问你：工具名是否真实、字段路径是否合法、是否只剩提醒、
 * 每轮成本多少。判不了的只有一件 —— **这个检查真的对应你那句要求吗** ——
 * 那一条会显式说出来，因为形式合法但不相干的检查比没有检查更糟。
 */

export async function ruleNew(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  try {
    const id = (argv[0] ?? '').trim()
    const description = strFlag(flags, 'describe') ?? argv.slice(1).join(' ').trim()
    if (!id || !description) {
      line(c.red('用法：nucleus rule new <规则 id> "你的要求"'))
      line(c.gray('  id 会成为文件名：rules/<id>.md。小写字母、数字、点、连字符'))
      line()
      line('  例：')
      line(c.gray('    nucleus rule new cite-sources "结论必须标明来源"'))
      line(c.gray('    nucleus rule new no-writes "不许写文件"'))
      line()
      line('  要求怎么写都行 —— 模型来判它落在哪一层：')
      for (const t of ['boundary', 'check', 'reminder'] as const) {
        line(c.gray(`    ${TIER_WHAT[t]}`))
      }
      line()
      line(c.gray('  --interactive  别急着接受第一份提案，每一版都让我过一眼'))
      return 1
    }
    return await describePath(id, description, flags)
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

  /**
   * **已存在不是错误，是「你想改它」。**
   *
   * 原先这里只有两条路：拦下来，或者加 `--force` 直接盖掉 ——
   * 不给差异、不留备份。而那个文件很可能被手改过（调过措辞、
   * 收窄过 appliesTo、加过一句注释），全部无声消失。
   *
   * 我在 `model add` 上用过同一条判断标准，却得出了相反的结论：那里不敢写
   * JSON 是因为「文件里全是注释，序列化会丢掉」。规则文件**第一次**创建时
   * 确实没有既有内容可毁 —— 但第二次就有了，而我把第一次的结论用到了第二次。
   *
   * 现在：把现有内容读出来喂给模型，你说要改什么，它改。写之前给差异。
   * `--force` 退化成「别管现在写的什么，从头再来」，而那也仍然要看差异。
   */
  const existing = existsSync(path) ? await readFile(path, 'utf8') : null
  const fresh = flags['force'] === true

  const { config } = await loadConfig(strFlag(flags, 'config'))
  const n = await boot({ config, ...resolveDb(flags), skipMcp: flags['mcp'] !== true })

  try {
    if (isMockOnly(n.config)) {
      /**
       * 没有真实模型时**不再退回一问一答** —— 树已经删了，而且它本来也不是
       * 这个场景的正确答案。
       *
       * 正确答案是：照着 `examples/rules/*.md` 写一个文件。frontmatter 加一段
       * 正文，比答五个用我的分类法提的问题快得多，而且写完就能
       * `nucleus rules` 看到它落在哪几层、每轮花多少。
       */
      line(`${ICON.warn} 配置里只有 mock 模型 —— 让它判层等于拿一个假答案。`)
      line()
      line('  两条路：')
      line(c.gray('  · 配一个真实模型（nucleus model config），然后重跑这条命令'))
      line(c.gray(`  · 直接写文件 —— ${join(resolve(dir), `${id}.md`)}`))
      line(c.gray('    照着 examples/rules/*.md，frontmatter 加一段正文就行'))
      line(c.gray('    写完 nucleus rules 会告诉你它落在哪几层、每轮花多少'))
      return 1
    }

    const revising = existing !== null && !fresh
    heading(`${revising ? '改一条规则' : '加一条规则'}：${c.bold(id)}`)
    line(c.gray(`模型链 ${n.config.defaults.modelChain.join(' → ')}`))
    if (revising) {
      line(c.gray(`  这条已经有了 —— ${path}`))
      line(c.gray('  下面这句会当成「要改成什么」，而不是从头写一条：'))
    }
    line(`  ${c.gray(revising ? '你说的：' : '你的要求：')}${description}`)
    if (existing !== null && fresh) {
      line(`  ${ICON.warn} ${c.yellow('--force：不管现在写的什么，从头再来')}`)
      line(c.gray('    写之前仍然会给你看差异。'))
    }
    line()
    line(c.gray(revising ? '正在看现在这条，然后改…' : '正在判它属于哪一层…'))

    /**
     * **提案 → 你看 → 不满意就说一句 → 它改。**
     *
     * 这才是「和模型对话来确定这个 rule」。原先这里只有一次机会：
     * 展示完就问「写入吗？[Y/n]」，答 N 就什么都没有 ——
     * 而你想要的往往不是「不写」，是「plan 应该是步骤列表而不是一个字符串」。
     *
     * 循环没有硬上限：每一轮都是你**主动**说了一句才发生的，
     * 花的 token 你自己看得见（每轮都报）。真正需要上限的是模型
     * 自己反复重试那一段（MAX_ROUNDS），那你按不了刹车。
     */
    const session = newSession(n, id, description, revising ? existing : null)
    for (;;) {
    const got = await session.next()
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
       * **这里也该能接着说话。**
       *
       * 最有用的一句往往就是「那就只要求写计划那部分」—— 把要求缩到可强制的
       * 那一半。原先这里直接 return，等于让人重新想一句描述再跑一遍命令，
       * 而模型刚刚已经把「哪一半可强制」分析得很清楚了，扔掉那个上下文很浪费。
       */
      line(c.gray('  想缩一缩要求？说一句就行 —— 它照着重提。回车＝先不加。'))
      line(c.gray('  例：「那就只要求写计划那部分，审核先不管」'))
      const narrow = (await readLine('  ')).trim()
      if (!narrow) return 1
      session.tell(narrow)
      line()
      continue
    }

    // ── 展示分层与理由 ──
    line(`${c.bold('分层')}  ${p.tier.map(tierColor).join(' + ')}`)
    line(`  ${c.gray(p.reasoning)}`)
    line()

    const rule = toRule(id, p, path)

    /**
     * **拿既有规则一起校验** —— 否则上一轮加的同名字段检查在创建时根本不跑。
     *
     * `validateRuleProposal` 只看这一份提案，看不出「`plan` 已经被别的规则
     * 声明过了」。而那正是最容易犯的一种：写第二条规则时不会去翻前面 17 个文件。
     *
     * 这个坑我自己刚踩过一次：上一轮把冲突检查加进 `validateRules`，
     * 而这里只 import 了它、从来没调用 —— 又一个「声明了但没接线」，
     * 距离我修同一类问题只隔了一轮。所以不满足于「函数写好了」，要看调用点。
     */
    const cross = validateRules([...(n.config.rules ?? []), rule], {
      agents: n.config.agents.map((a) => a.id),
      tools: [...n.tools.all()].map((t) => t.name),
    }).filter((x) => x.path.includes(path))
    const crossFatal = cross.filter((x) => x.fatal)
    if (crossFatal.length) {
      line(`${ICON.fail} ${c.red('和既有规则冲突')}`)
      for (const x of crossFatal) line(`  ${x.message}`)
      line()
      line(c.gray('  说一句让它改（比如换个字段名），回车＝放弃：'))
      const fix = (await readLine('  ')).trim()
      if (!fix) return 1
      session.tell(`${crossFatal.map((x) => x.message).join('\n')}\n\n使用者说：${fix}`)
      line()
      continue
    }

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
    /**
     * **答 N 不等于「不要这条规则」。**
     *
     * 原先答 N 就直接退出并建议 `--interactive`（那棵树）。而不满意的真实内容
     * 往往很具体：「plan 应该是步骤列表而不是一个字符串」、「只对会改生产的
     * 那几个 agent 生效」。那一句话说给模型比走一遍分类树快得多，
     * 也不需要你知道 boundary/check/reminder 是什么。
     */
    /**
     * **盖别人的文件之前给差异。** 没有差异的「确认覆盖」等于让人闭眼签字：
     * 手改过的措辞、收窄过的 appliesTo，从提示里一个字都看不出来。
     */
    if (existing !== null) {
      const ops = diffLines(existing, text)
      if (!changed(ops)) {
        line(c.gray('  和现在的文件一模一样 —— 不用写。'))
        line()
        line(c.gray('  想改什么？说一句（回车＝退出）：'))
        const again = (await readLine('  ')).trim()
        if (!again) return 0
        session.tell(again)
        line()
        continue
      }
      line()
      heading('会怎么改')
      for (const l of renderDiff(ops)) line(l)
      line()
    }
    if (await confirm(`${existing !== null ? '覆盖' : '写入'} ${path}？`)) {
      await writeFile(path, text, 'utf8')
      line(`${ICON.ok} 已${existing !== null ? '更新' : '写入'} ${path}`)
      line(c.gray('  看一眼：nucleus rules'))
      return 0
    }

    line()
    line(c.gray('  哪里不对？说一句就行 —— 它照着改。回车＝放弃。'))
    line(c.gray('  例：「plan 要是步骤列表，不是一个字符串」'))
    line(c.gray('      「只对会改生产环境的 agent 生效」'))
    line(c.gray('      「提醒那段太长了，删掉」'))
    const feedback = (await readLine('  ')).trim()
    if (!feedback) {
      line(c.gray('  放弃了，什么都没写。'))
      return 1
    }
    session.tell(feedback)
    line()
    }
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

interface Session {
  next(): Promise<{ proposal: RuleProposal; problems: ProposalProblem[] } | null>
  /** 你说一句，下一轮它照着改 */
  tell(text: string): void
}

function newSession(
  n: Awaited<ReturnType<typeof boot>>,
  id: string,
  description: string,
  /**
   * 现在这条规则的原文（改的时候有值）。
   *
   * 喂给模型而不是让它从头写 —— 否则「把提醒那段删掉」这种要求它无从下手，
   * 而且会把你手改过的部分一起丢掉。
   */
  existing: string | null = null,
): Session {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    {
      role: 'system',
      content:
        '你在设计运行时规则。拿不准的地方调用 ask_clarification 问一句；' +
        '想清楚了调用 propose_rule 提交。不要输出纯文本。',
    },
    { role: 'user', content: buildRulePrompt(n, id, description, existing) },
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
  let round = 0
  const next = async (): Promise<{ proposal: RuleProposal; problems: ProposalProblem[] } | null> => {
   for (let i = 0; i < MAX_ROUNDS; i++) {
    round++
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
      if (i === MAX_ROUNDS - 1) break
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
    if (i === MAX_ROUNDS - 1) {
      line(`${ICON.fail} ${c.red('改了几轮还是没过校验')}`)
      for (const x of fatal) line(`  ${c.red(x.field)}：${x.message}`)
      break
    }
    line(c.gray(`  第 ${round} 轮没过校验（${fatal.map((x) => x.field).join(', ')}），回给它改…`))
    messages.push({ role: 'assistant', content: JSON.stringify(p) })
    messages.push({ role: 'user', content: repairPrompt(fatal) })
  }

   line()
   line(c.gray(`  ${MAX_ROUNDS} 轮用完了，这一段共 ${spent} tok。`))
   line(c.gray('  换个模型试试：--model <key>。或者直接照着 examples/rules/*.md 写一个'))
   line(c.gray('  文件 —— frontmatter 加一段正文，很快。'))
   return null
  }

  return {
    next,
    tell: (text: string) => {
      messages.push({ role: 'user', content: `${text}\n\n照这个改，重新调用 propose_rule 提交完整的提案。` })
    },
  }
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

/**
 * 决策树删掉了。
 *
 * ── 为什么整棵砍掉，而不是换个入口 ────────────────────────
 *
 * 实测反馈两次指向同一件事：「一问一答不如直接和模型对话来确定这个 rule」、
 * 「你给我的那几个选项我甚至都不知道选什么」。
 *
 * 树的毛病是**谁的语言**：它问「这条约束是不是『不许用某些工具』？」，
 * 要先理解边界/检查/提醒三层才能回答 —— 而那正是我批评它时说的
 * 「把我的分类过程强加给使用者」。我当时只把它降级成兜底，
 * 于是模型路径一失败就掉回同一个毛病。
 *
 * 它唯一还剩的用处是「没有模型时也能走完」。但那个场景的真实答案是
 * **照着 examples/rules/*.md 写一个文件** —— frontmatter 加一段正文，
 * 比答五个用我的分类法提的问题快得多。
 *
 * 450 行、零测试覆盖、已经出过一个真 bug（把 plan-first 引到
 * `requiredFields: [open_questions]`）。留着只会继续烂。
 *
 * `--interactive` 现在的意思是**别急着接受第一份提案** —— 见 describePath 的循环。
 */
