import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadConfig } from '../config-file.js'
import { DEFAULT_AGENTS_DIR } from '../config/agent-files.js'
import { GRANTABLE, PERMISSION_SPECS } from '../runtime/permissions.js'
import { createInterface } from 'node:readline/promises'
import { isMockOnly } from '../config.js'
import type { Nucleus } from '../boot.js'
import {
  bootForProposal,
  buildPrompt,
  printPermissions,
  proposalSchema,
  renderAgentMd,
  renderCasesMd,
  validateProposal,
  type ProposedAgent,
} from './agent-propose.js'
import { c, heading, ICON, line, strFlag } from './ui.js'

/**
 * `nucleus agent new` —— 生成专家定义的骨架。
 *
 * 骨架的内容才是这个命令的价值。空模板等于把「该怎么写」这个问题原样退回给
 * 你，而这恰恰是最难的部分 —— 尤其 `whenToUse`：它直接决定编排者能不能
 * 选对人，而写成名词（「调研」）和写成可判别条件（「需要查外部资料且结论
 * 必须带来源时」）的效果差别很大。
 *
 * 所以骨架里直接写正例反例、权限连风险一起列、并说明专家实际会收到什么。
 * 这些信息系统本来就有（权限词表、任务信封的形状），没理由让你去别处找。
 */

function goodBadExamples(): string {
  return [
    '# whenToUse 怎么写',
    '#',
    '# 它会进编排者的 delegate 工具描述，是「派给谁」的唯一依据。',
    '# 写成名词模型难判断，写成可判别的条件才有用：',
    '#',
    '#   ✗ 调研                        ← 名词',
    '#   ✗ 负责研究相关任务            ← 同义反复',
    '#   ✓ 需要查外部资料、且结论必须带可验证来源时',
    '#   ✓ 需要读写工作目录内的文件、整理数据时；不能出网',
    '#',
    '# 也要写清它**做不到**什么 —— 避免被派不可能的活。',
    '# 用结果描述，不要写工具名（工具会变，能力不会）。',
  ].join('\n')
}

function permissionTable(): string {
  const rows = PERMISSION_SPECS.filter((p) => GRANTABLE.includes(p.id)).map(
    (p) => `#   ${p.id.padEnd(9)} ${p.what}\n#             ⚠ ${p.risk}`,
  )
  return ['# 可授予的权限（工具声明自己需要什么，这里授予能力）', '#', ...rows].join('\n')
}

function envelopeNote(): string {
  return [
    '# 你的专家会收到什么',
    '#',
    '# 它**看不到会话历史** —— 结构上就没有（子 run 没有 conversationId，',
    '# 所以它不可能把结果直发给用户）。它只收到编排者填的任务信封：',
    '#',
    '#   # 任务      <goal>',
    '#   ## 背景     <context>',
    '#   ## 验收标准 <acceptance>',
    '#',
    '# 所以 identity 正文里不要假设它知道任何上下文。',
    '# 验收标准是编排者填的，你的专家应当照着自检。',
  ].join('\n')
}

/**
 * 骨架。
 *
 * **所有说明都放在 frontmatter 里的 `#` 注释行**，正文只留 prompt 的 TODO。
 *
 * 第一版把说明写在正文里，用 `#` 开头以为是注释 —— 但 markdown 正文没有
 * 注释，`#` 是标题，而正文整段就是 identity（模型收到的 prompt）。结果生成
 * 出来的骨架 prompt 有 1504 字符 58 行，全是给人看的说明。
 *
 * 和「试题不能进 context」是同一类问题：给人看的东西混进了给模型看的地方。
 * 所以下面那条断言（正文里不得出现说明标记）必须留着。
 */
export function scaffold(id: string, existingIds: string[]): string {
  const guide = [
    ...goodBadExamples().split('\n'),
    '',
    ...envelopeNote().split('\n'),
    '',
    ...permissionTable().split('\n'),
    ...(existingIds.length
      ? [
          '',
          '# 现有专家（whenToUse 不要和它们重叠 —— 语义相邻必然派错）：',
          ...existingIds.map((x) => `#   ${x}`),
        ]
      : []),
  ].join('\n')

  return `---
name: ${id}
# 一句话：什么时候该派给它。写法见下方说明。
whenToUse: TODO —— 需要…时

# 授予的能力。工具声明自己需要什么权限，这里授予权限 ——
# 所以新接一个会写文件的 MCP 工具时，没有 write 的它自动看不到。
# 可选：${GRANTABLE.join(' / ')}
permissions: [read]

# 可选：按名字收窄（给了 read，但只许用某几个读取工具）。
# 与 permissions 是「与」关系，不填表示不收窄。
# toolsAllow: [read_file]

# 可选：这个专家要交出什么结构化结果。
# 内置预设 research / code 只是用同一套词表写的两个例子。
# resultFields:
#   verdict:
#     type: string
#     description: 一句话结论
#   metrics:
#     type: object[]
#     description: 关键指标，每个都要有出处
#     fields:
#       name: string
#       value: number
#       source: string

# 可选：哪些字段必填。声明只描述形状，必填性在这里。
# a[].b 表示每一个元素的 b 都不能为空。
# requiredFields: [metrics[].source]

# 可选：覆盖模型与预算
# model: ollama:gemma4:31b
# maxSteps: 8

# ─────────────────────────────────────────────────────────
# 以下都是写法说明，**不会进 prompt**（frontmatter 的 # 行会被跳过）。
# 下面 --- 之后的正文才是模型收到的 system prompt。
# ─────────────────────────────────────────────────────────
${guide}
---

TODO —— 这段正文就是模型收到的 system prompt。

用第二人称写「你是谁、怎么做事」。写具体的做事方式，不要写「请务必…」这类
无法验证的话 —— 能力边界靠上面的 permissions 强制，结果要求靠 requiredFields
强制，两者都不依赖模型记得。
`
}

function casesScaffold(id: string): string {
  return `# ${id} 的试题集

每个 \`- \` 开头的段落是一道题。**试题永远不进 prompt** —— 它只被
\`nucleus agent try\` 读，用来做重复跑与版本对比。

为什么要有它：单跑一次证明不了任何事（模型有随机性），而在**不同任务**上比
两个定义，「更好」这个词没有意义。所以要有一批固定的题。

每踩一个坑就加一条，它会逐渐变成回归集 —— 和测试一样：不能证明正确，
只能让已知的错不再复发。

- TODO —— 一道典型任务
- TODO —— 一道边界情况（数据缺失 / 要求矛盾 / 超出能力范围时它该怎么做）
`
}

/**
 * 让模型提一份定义。
 *
 * 走真实 router —— 与跑任务是同一条调用路径，所以模型链、熔断、用量统计
 * 都照常生效，不是另开一个「工具用」的通道。
 */
async function propose(
  n: Nucleus,
  id: string,
  description: string,
): Promise<{ proposal: ProposedAgent; model: string; tokens: number } | null> {
  const res = await n.router.chat(n.config.defaults.modelChain, {
    messages: [
      {
        role: 'system',
        content:
          '你是设计 agent 定义的助手。只调用 propose_agent 提交结果，不要输出别的。',
      },
      { role: 'user', content: buildPrompt(n, id, description) },
    ],
    tools: [
      {
        name: 'propose_agent',
        description: '提交这个专家 agent 的设计',
        parameters: proposalSchema(),
      },
    ],
  })

  const call = res.toolCalls.find((t) => t.name === 'propose_agent')
  if (!call) {
    line(`${ICON.fail} 模型没有调用 propose_agent`)
    line(c.gray(`  它说：${res.content.slice(0, 200) || '(无输出)'}`))
    line(c.gray('  换个模型试试：--model <key>'))
    return null
  }
  let parsed: ProposedAgent
  try {
    parsed = JSON.parse(call.arguments) as ProposedAgent
  } catch (e) {
    line(`${ICON.fail} 模型给的参数不是合法 JSON：${(e as Error).message}`)
    return null
  }
  return {
    proposal: parsed,
    model: res.modelKey,
    tokens: res.usage.tokensIn + res.usage.tokensOut,
  }
}

/** 读一行确认。非 TTY 下必须显式 --yes —— 授权决定不该被管道悄悄通过 */
async function confirm(question: string, flags: Record<string, string | true>): Promise<boolean> {
  if (flags['yes'] === true) return true
  if (!process.stdin.isTTY) {
    line(`${ICON.fail} 非交互环境下需要 --yes 才能写入`)
    line(c.gray('  权限是授权决定，不该被管道悄悄通过'))
    return false
  }
  process.stdout.write(`${question} [y/N] `)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for await (const l of rl) return /^y(es)?$/i.test(l.trim())
  } finally {
    rl.close()
  }
  return false
}

async function describeFlow(
  id: string,
  description: string,
  dir: string,
  flags: Record<string, string | true>,
): Promise<number> {
  const n = await bootForProposal(flags)
  try {
    if (isMockOnly(n.config)) {
      // mock 生成出来的是垃圾，但看起来像样 —— 这比报错更糟
      line(`${ICON.fail} 当前只有 mock 模型，生成不出有用的定义`)
      line(c.gray('  配置真实模型：cp nucleus.config.example.json nucleus.config.json'))
      line(c.gray('  或者不带 --describe，先生成空骨架自己填'))
      return 1
    }

    heading(`让模型设计 ${id}`)
    line(c.gray(`模型链：${n.config.defaults.modelChain.join(' → ')}`))
    line(c.gray(`已知：${n.tools.all().length} 个工具 · ${n.config.agents.length} 个现有 agent`))
    line()

    const got = await propose(n, id, description)
    if (!got) return 1
    const { proposal, model, tokens } = got

    const problems = validateProposal(n, id, proposal)
    const fatal = problems.filter((p) => p.fatal)

    heading('提案')
    line(`${c.gray('何时用')} ${proposal.whenToUse}`)
    line()
    line(c.gray('正文（模型收到的 prompt）：'))
    for (const l of proposal.identity.trim().split('\n')) line(`  ${l}`)
    line()
    line(c.gray('建议权限：'))
    printPermissions(proposal.permissions ?? [])
    if (proposal.rationale) {
      line()
      line(c.gray(`理由：${proposal.rationale}`))
    }
    if (proposal.resultFields && Object.keys(proposal.resultFields).length) {
      line()
      line(c.gray(`结果字段：${Object.keys(proposal.resultFields).join(', ')}`))
      if (proposal.requiredFields?.length) {
        line(c.gray(`必填：${proposal.requiredFields.join(', ')}`))
      }
    }
    line()
    line(c.gray(`试题 ${proposal.cases?.length ?? 0} 道 · ${model} · ${tokens} tokens`))

    if (problems.length) {
      heading('检查')
      for (const p of problems) {
        line(`${p.fatal ? ICON.fail : ICON.warn} ${c.gray(p.field)} ${p.message}`)
      }
    }
    if (fatal.length) {
      line()
      line(c.red(`有 ${fatal.length} 项必须修正，未写入。`))
      line(c.gray('  重跑一次，或不带 --describe 自己写'))
      return 1
    }

    line()
    // 权限是授权决定，必须显式确认 —— 模型顺手给个 execute 是真会发生的
    if (!(await confirm(`写入 ${dir}/${id}.md？`, flags))) {
      line(c.gray('未写入。'))
      return 1
    }

    const path = resolve(join(dir, `${id}.md`))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, renderAgentMd(id, proposal), 'utf8')
    const casesPath = path.replace(/\.md$/, '.cases.md')
    if (proposal.cases?.length && !existsSync(casesPath)) {
      await writeFile(casesPath, renderCasesMd(id, proposal.cases), 'utf8')
    }

    line(`${ICON.ok} ${path}`)
    if (proposal.cases?.length) line(`${ICON.ok} ${casesPath}`)
    line()
    line('接下来：')
    line(`  ${c.cyan(`nucleus agent show ${id}`)} —— 看模型实际会收到什么`)
    line(`  ${c.cyan(`nucleus agent try ${id} --n 3`)} —— 跑试题集`)
    line()
    line(
      c.gray(
        '模型不知道你的数据源与验收标准，所以 whenToUse 会「读起来合理但偏泛」。' +
          '靠上面那个循环修，不是靠再生成一遍。',
      ),
    )
    return 0
  } finally {
    await n.close()
  }
}

export async function agentNew(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const id = argv[0]
  if (!id) {
    line(c.red('用法：nucleus agent new <id> [--describe "…"] [--dir agents]'))
    line(c.gray('  --describe 让模型据你的描述生成完整定义（需要真实模型）'))
    line(c.gray('  id 会成为文件名与 agent id：小写字母、数字、连字符'))
    return 1
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    line(c.red(`id 只能是小写字母、数字与连字符：${id}`))
    return 1
  }

  const dir = strFlag(flags, 'dir') ?? process.env['NUCLEUS_AGENTS_DIR'] ?? DEFAULT_AGENTS_DIR
  const describe = strFlag(flags, 'describe')
  const path = resolve(join(dir, `${id}.md`))
  const casesPath = path.replace(/\.md$/, '.cases.md')

  if (existsSync(path)) {
    line(`${ICON.fail} ${path} 已存在`)
    line(c.gray('  改它就行；要看模型实际收到什么：nucleus agent show ' + id))
    return 1
  }

  if (describe) return describeFlow(id, describe, dir, flags)

  // 已有专家的 id —— 写进骨架提醒不要语义重叠
  let existing: string[] = []
  try {
    const { config } = await loadConfig(strFlag(flags, 'config'))
    existing = config.agents
      .filter((a) => a.id !== config.defaults.entryAgent)
      .map((a) => `${a.id}${a.whenToUse ? `：${a.whenToUse}` : ''}`)
  } catch {
    // 配置坏了也要能建骨架 —— 否则「配置错了想加个 agent 修」会卡死
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, scaffold(id, existing), 'utf8')
  if (!existsSync(casesPath)) await writeFile(casesPath, casesScaffold(id), 'utf8')

  heading(`已创建 ${id}`)
  line(`${ICON.ok} ${path}`)
  line(`${ICON.ok} ${casesPath}`)
  line()
  line('接下来：')
  line(`  1. 改 ${c.cyan(`${dir}/${id}.md`)} —— 填 whenToUse 与正文（文件里有写法说明）`)
  line(`  2. ${c.cyan(`nucleus agent show ${id}`)} —— 看模型实际收到什么`)
  line(`  3. ${c.cyan(`nucleus agent try ${id} "一个任务"`)} —— 单独试一次，不经编排者`)
  line()
  line(c.gray('骨架里的 TODO 不改也能加载，但 whenToUse 写成 TODO 会让编排者派错人。'))
  return 0
}
