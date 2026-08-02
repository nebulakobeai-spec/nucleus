import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { Compactor } from '../runtime/compactor.js'
import { historyBudgetFor } from '../runtime/worker.js'
import {
  compressionRatio,
  decideCompact,
  renderSummary,
  DEFAULT_COMPACT_POLICY,
  type CompactPolicy,
  type ConversationSummary,
} from '../context/compact.js'
import { heuristicTokenizer } from '../context/tokenizer.js'
import { c, heading, ICON, line, resolveConversationId, resolveDb, strFlag, table } from './ui.js'
import { compactTokens } from './pet.js'
import { checkConstraints, seedConversation, type PlantedConstraint } from './seed.js'

/**
 * `nucleus conv` —— 会话的摘要状态与手动压缩。
 *
 * ── 为什么需要「手动压缩」这个命令 ────────────────────────
 *
 * 自动压缩的阈值在大窗口模型上非常高：131k 窗口下要 28000 tokens 的历史
 * 才触发，也就是四五十轮对话。后果是**这条代码路径在真实使用中很久都不会
 * 被执行到** —— 而没被执行过的路径不能算验证过。
 *
 * 而压缩的全部价值是「用户提过的约束能活过压缩」，这件事只有对着真实模型
 * 才能评估（mock 摘要器是我写的，它当然会把约束抄下来）。所以要有一个
 * 一条命令就能触发并看结果的入口。
 *
 * 顺带它也是个正常需求：问一个大问题之前主动压一次，给这一轮腾出预算。
 *
 * ── 这个命令刻意做的两件事 ──────────────────────────────
 *
 * 1. **压缩前后都打印摘要全文。** 压缩是有损且不可逆的，「丢了什么」只能靠
 *    人读一遍判断 —— 而这正是自动压缩没法替你做的部分。
 * 2. **`--dry-run` 只判定不执行。** 「为什么还没压缩」和「压缩了什么」
 *    一样需要能回答，而前者不该为了得到答案就付出一次不可逆的压缩。
 */

function fmtSummary(s: ConversationSummary): void {
  const seg = (title: string, items: string[]) => {
    if (items.length === 0) return
    line(`  ${c.bold(title)}`)
    for (const x of items) line(`    ${x}`)
  }
  // 约束排最前 —— 它是「必须活过压缩」的那一项
  seg('用户提过的要求', s.constraints)
  seg('已定下的事', s.decisions)
  seg('悬而未决', s.open)
  seg('已产出', s.artifacts)
  if (s.context.trim()) {
    line(`  ${c.bold('背景')}`)
    line(`    ${s.context.trim().replace(/\n/g, '\n    ')}`)
  }
}

async function withNucleus<T>(
  flags: Record<string, string | true>,
  fn: (n: Nucleus) => Promise<T>,
): Promise<T> {
  const { config: loaded } = await loadConfig(strFlag(flags, 'config'))
  // --mock 与其他命令一致：同时换模型链与 fetch。只换一个会让显示与事实不符
  const useMock = flags['mock'] === true || process.env['NUCLEUS_MOCK'] === '1'
  const config = useMock
    ? { ...loaded, defaults: { ...loaded.defaults, modelChain: ['mock:local'] } }
    : loaded
  const n = await boot({
    config,
    ...resolveDb(flags),
    skipMcp: true,
    ...(useMock ? { mock: {} } : {}),
  })
  try {
    return await fn(n)
  } finally {
    await n.close()
  }
}

export async function convList(
  _argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  return withNucleus(flags, async (n) => {
    const all = await n.conversations.list({ limit: Number(strFlag(flags, 'limit') ?? 20) })
    if (all.length === 0) {
      line(c.gray('（还没有会话）'))
      return 0
    }
    heading(`会话（${all.length}）`)
    table(
      all.map((x) => [
        x.id.slice(0, 8),
        x.title ?? c.gray('(无标题)'),
        String(x.lastSeq),
        x.summaryGeneration > 0
          ? `${x.summaryGeneration} 代 / 到 seq ${x.summaryThroughSeq}`
          : c.gray('未压缩'),
        x.updatedAt.toISOString().slice(0, 16).replace('T', ' '),
      ]),
      ['ID', '标题', '消息', '压缩', '更新'],
    )
    line()
    line(c.gray('看摘要：nucleus conv show <id 前缀>'))
    return 0
  })
}

export async function convShow(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const prefix = argv[0]
  if (!prefix) {
    line(c.red('用法：nucleus conv show <id 前缀>'))
    return 1
  }
  return withNucleus(flags, async (n) => {
    const r = await resolveConversationId(n.db, prefix)
    if ('error' in r) {
      line(c.red(r.error))
      return 1
    }
    const conv = (await n.conversations.get(r.id))!

    heading(conv.title ?? conv.id.slice(0, 8))
    line(c.gray(`${conv.id} · ${conv.lastSeq} 条消息 · agent ${conv.agentId}`))
    line()

    if (!conv.summary || conv.summaryGeneration === 0) {
      line(c.gray('还没有压缩过。'))
      await printWhyNot(n, conv.id)
      return 0
    }

    line(`${ICON.info} 第 ${conv.summaryGeneration} 代摘要，覆盖到 seq ${conv.summaryThroughSeq}`)
    line(c.gray(`  seq ${conv.summaryThroughSeq} 之前的原文不再进入 context`))
    line()
    fmtSummary(conv.summary)

    const log = await n.conversations.compactions(conv.id, 50)
    const ok = log.filter((x) => x.outcome === 'ok')
    const failed = log.filter((x) => x.outcome === 'failed')
    if (log.length) {
      line()
      heading('压缩历史')
      table(
        [...ok].reverse().map((x) => [
          `第 ${x.generation} 代`,
          `seq ${x.fromSeq}-${x.throughSeq}`,
          `${x.messageCount} 条`,
          `${compactTokens(x.tokensBefore)} → ${compactTokens(x.tokensAfter)}`,
          c.green(`省 ${compressionRatio(x.tokensBefore, x.tokensAfter)}`),
          c.gray(x.model ?? '?'),
        ]),
        ['代', '区间', '消息', 'token', '', '模型'],
      )
      for (const f of failed) {
        line(`${ICON.fail} 压缩失败（seq ${f.fromSeq}-${f.throughSeq}）${c.gray(f.summary.slice(0, 120))}`)
      }
      if (failed.length) {
        line(c.gray('  失败时历史改按预算裁剪 —— 与「摘丢了」症状相同，成因不同'))
      }
    }
    return 0
  })
}

/**
 * 手动压缩用的策略。
 *
 * `--dry-run` 与真正执行**必须用同一份** —— 否则那不叫 dry run。
 * 实测踩到：dry-run 说「只有 4 条，不值得调一次模型」（用的是配置里的
 * minMessages: 8），真跑却说「单条消息过大」（用的是 minMessages: 2 +
 * triggerRatio: 0）。同一个情况两个互相矛盾的原因，两个都没说对。
 */
function manualPolicy(flags: Record<string, string | true>): CompactPolicy {
  return {
    // 命令的语义是「现在压」，不是「够了就压」
    triggerRatio: 0,
    // 仍然保留最近几条原文：摘要替代不了「上一句刚说了什么」
    keepRecent: Number(strFlag(flags, 'keep') ?? 10),
    // 但不为两条消息调一次模型
    minMessages: 2,
  }
}

/** 「为什么还没压缩」和「压缩了什么」一样需要能回答 */
async function printWhyNot(
  n: Nucleus,
  convId: string,
  policy?: CompactPolicy,
): Promise<void> {
  const conv = (await n.conversations.get(convId))!
  const msgs = await n.conversations.recent(convId, 500)
  const chain = n.config.defaults.modelChain
  const window = n.worker.agentSpecs.get(conv.agentId)
    ? n.runner.contextWindowFor(chain)
    : n.config.defaults.assumedContextWindow
  const budget = historyBudgetFor(window)

  const d = decideCompact({
    messages: msgs.map((m) => ({
      seq: m.seq,
      message: n.conversations.toChatMessages([m])[0]!,
    })),
    summaryThroughSeq: conv.summaryThroughSeq,
    historyBudget: budget,
    policy:
      policy ??
      // 没指定就用「自动压缩会怎么判」的那份
      {
        triggerRatio: n.config.runtime.compact?.triggerRatio ?? DEFAULT_COMPACT_POLICY.triggerRatio,
        keepRecent: n.config.runtime.compact?.keepRecent ?? DEFAULT_COMPACT_POLICY.keepRecent,
        minMessages: n.config.runtime.compact?.minMessages ?? DEFAULT_COMPACT_POLICY.minMessages,
      },
    tokenizer: heuristicTokenizer,
  })

  line()
  line(`${d.compact ? ICON.ok : ICON.info} ${d.reason}`)
  line(c.gray(`  窗口 ${compactTokens(window)} · 留给历史 ${compactTokens(budget)}`))
  if (!d.compact) {
    // 阈值高到实际用不到，是真实存在的情况 —— 说清怎么调
    line(c.gray('  想现在压：nucleus conv compact <id>'))
    line(c.gray('  想让自动压缩更早触发：在配置里设 runtime.compact.triggerRatio（默认 0.7）'))
  }
}

/**
 * `nucleus conv seed` —— 造一段用来测 compact 的历史。
 *
 * 自动压缩要 28000 tokens 历史才触发（131k 窗口 × 0.7），手打不现实。
 * 而评估 compact 的关键不是「有没有跑」，是「**第 2 轮说过的要求，
 * 到第 15 轮还在不在**」—— 所以这个命令会明确报出埋了哪几条约束，
 * 否则你手里没有对照物，只能读一遍摘要凭感觉判断。
 */
export async function convSeed(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const turns = Number(strFlag(flags, 'turns') ?? 15)
  if (!Number.isInteger(turns) || turns < 1 || turns > 200) {
    line(c.red('--turns 要是 1-200 的整数'))
    return 1
  }

  return withNucleus(flags, async (n) => {
    let convId: string
    const prefix = argv[0]
    if (prefix) {
      const r = await resolveConversationId(n.db, prefix)
      if ('error' in r) {
        line(c.red(r.error))
        return 1
      }
      convId = r.id
    } else {
      convId = (
        await n.conversations.create({
          agentId: n.config.defaults.entryAgent,
          title: `[合成] compact 测试 ${turns} 轮`,
        })
      ).id
    }

    const r = await seedConversation(n.conversations, convId, turns)

    heading('已写入合成历史')
    line(`  会话 ${c.bold(convId.slice(0, 8))} · ${r.turns} 轮 · ${r.messages} 条消息`)
    // 不调模型这件事要说清楚：这段历史里助手的话不是真的
    line(c.gray('  没有调用模型 —— compact 只读消息日志，所以助手那侧写死就够了。'))
    line(c.gray('  每条都带 meta.synthetic=true，事后翻会话不会误认成真对话。'))
    line()

    line(`${c.bold('埋进去的约束')}${c.gray('（压缩之后就是要看这几条还在不在）')}`)
    for (const p of r.planted) {
      line(`  第 ${p.turn} 轮  ${p.text}`)
    }
    line()
    line(c.gray('接着跑：'))
    line(c.gray(`  nucleus conv compact ${convId.slice(0, 8)} --keep 4`))
    return 0
  })
}

export async function convCompact(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const prefix = argv[0]
  if (!prefix) {
    line(c.red('用法：nucleus conv compact <id 前缀> [--dry-run]'))
    line(c.gray('  --dry-run  只判定要不要压、压到哪，不真的压'))
    return 1
  }
  const dry = flags['dry-run'] === true

  return withNucleus(flags, async (n) => {
    const r = await resolveConversationId(n.db, prefix)
    if ('error' in r) {
      line(c.red(r.error))
      return 1
    }
    const before = (await n.conversations.get(r.id))!

    if (dry) {
      heading('压缩判定（不执行）')
      // 与真正执行同一份策略 —— 否则 dry-run 预测不了真跑的结果
      await printWhyNot(n, r.id, manualPolicy(flags))
      return 0
    }

    const msgs = await n.conversations.recent(r.id, 500)
    const chain = n.config.defaults.modelChain
    const window = n.runner.contextWindowFor(chain)

    heading('压缩会话历史')
    line(c.gray(`${before.lastSeq} 条消息 · 已覆盖到 seq ${before.summaryThroughSeq}`))
    line(c.gray(`模型链 ${chain.join(' → ')}`))
    line()

    // 手动触发时把阈值降到 0：命令的语义是「现在压」，不是「够了就压」。
    // keepRecent / minMessages 仍然生效 —— 前者保证「上一句刚说了什么」还在，
    // 后者避免为两条消息调一次模型
    const compactor = new Compactor(n.conversations, n.runner.router, n.events, {
      policy: manualPolicy(flags),
    })

    const result = await compactor.maybeCompact({
      conversationId: r.id,
      messages: msgs,
      historyBudget: historyBudgetFor(window),
      modelChain: chain,
      // 手动压缩不属于任何 attempt —— 不借别人的（借了就撞
      // unique(run_attempt_id, seq)）。持久记录在 compactions 表里
      attemptId: null,
      runId: null,
    })

    if (!result.compacted) {
      line(`${ICON.warn} 没有压缩：${result.decision.reason}`)
      if (result.error) {
        line(`${ICON.fail} ${result.error}`)
        line(c.gray('  这不影响已有的会话 —— 摘要没生成，历史照旧'))
      }
      return result.error ? 1 : 0
    }

    const after = (await n.conversations.get(r.id))!
    line(
      `${ICON.ok} 第 ${result.generation} 代 · ` +
        `${compactTokens(result.tokensBefore ?? 0)} → ${compactTokens(result.tokensAfter ?? 0)} ` +
        c.green(`省 ${compressionRatio(result.tokensBefore ?? 0, result.tokensAfter ?? 0)}`),
    )
    line(c.gray(`  seq ${before.summaryThroughSeq + 1}-${after.summaryThroughSeq} 的原文已退役`))
    line()
    fmtSummary(after.summary!)

    // 合成历史里埋过约束 → 机器先筛一遍，人再确认
    await printConstraintCheck(n, r.id, after.summary!)

    line()
    // 这句是重点：压缩比好不好机器能判，丢了什么只有人能判
    line(c.yellow('压缩是有损且不可逆的 —— 上面这份就是之后每一轮会看到的全部。'))
    line(c.gray('请自己读一遍：你提过的要求还在吗？'))
    line(c.gray(`注入形式（模型实际看到的）：nucleus conv summary ${r.id.slice(0, 8)}`))
    return 0
  })
}

/**
 * 合成历史埋过约束时，机器先筛一遍。
 *
 * **这是筛查不是判定。** 查关键词而不是整句（摘要会改写措辞），所以
 * 「都在」也不代表意思没变。输出要说清机器只能查到这一步 ——
 * 但人读一遍时手里有这份清单，比空手读有用得多。
 */
async function printConstraintCheck(
  n: Nucleus,
  convId: string,
  summary: ConversationSummary,
): Promise<void> {
  const msgs = await n.conversations.recent(convId, 500)
  const planted = plantedFrom(msgs)
  if (planted.length === 0) return

  const checks = checkConstraints(planted, renderSummary(summary))
  line()
  line(`${c.bold('埋进去的约束')}${c.gray('（合成历史，关键词筛查）')}`)
  for (const x of checks) {
    if (x.survived) {
      line(`  ${ICON.ok} 第 ${x.constraint.turn} 轮：${x.constraint.text.slice(0, 40)}…`)
    } else {
      line(`  ${ICON.fail} ${c.red(`第 ${x.constraint.turn} 轮丢了`)}：${x.constraint.text.slice(0, 40)}…`)
      line(c.gray(`      摘要里找不到：${x.missing.join('、')}`))
    }
  }
  const lost = checks.filter((x) => !x.survived).length
  line(
    c.gray(
      lost
        ? `  ${lost}/${checks.length} 条没通过筛查 —— 这是压缩质量问题，不是代码 bug`
        : `  ${checks.length} 条关键词都在。但**改写措辞会骗过这个筛查**，仍需读一遍`,
    ),
  )
}

/** 从消息的 meta 里还原埋过哪些约束 —— 只有 seed 出来的会话有 */
function plantedFrom(
  msgs: Array<{ content: string; meta: Record<string, unknown> }>,
): PlantedConstraint[] {
  const out: PlantedConstraint[] = []
  for (const m of msgs) {
    if (m.meta['constraint'] !== true) continue
    const turn = Number(m.meta['seedTurn'] ?? 0)
    // 关键词从原话里取：与 seed.ts 里的声明保持一致靠 seed 时写下的 meta，
    // 这里只需要能找回原话
    out.push({ turn, text: m.content, keywords: keywordsOf(m.content) })
  }
  return out
}

/** 从原话里挑几个不容易被改写掉的词 */
function keywordsOf(text: string): string[] {
  const known: Array<[RegExp, string[]]> = [
    [/default 模型/, ['default', '模型']],
    [/运行时强制|运行时/, ['运行时', 'prompt']],
    [/agents\/\*\.md|agents/, ['agents', '来源']],
  ]
  for (const [re, kw] of known) if (re.test(text)) return kw
  // 兜底：取最长的两个中文词片段
  return text
    .replace(/[，。、；：（）()【】\s]+/g, ' ')
    .split(' ')
    .filter((x) => x.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2)
}

/** 摘要**注入 context 时的实际文本** —— 存下来但没注入等于没有 */
export async function convSummary(
  argv: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const prefix = argv[0]
  if (!prefix) {
    line(c.red('用法：nucleus conv summary <id 前缀>'))
    return 1
  }
  return withNucleus(flags, async (n) => {
    const r = await resolveConversationId(n.db, prefix)
    if ('error' in r) {
      line(c.red(r.error))
      return 1
    }
    const conv = (await n.conversations.get(r.id))!
    if (!conv.summary) {
      line(c.gray('还没有摘要。'))
      return 0
    }
    // 原样打印，不加装饰 —— 这就是模型看到的字节
    line(renderSummary(conv.summary, conv.summaryGeneration))
    return 0
  })
}
