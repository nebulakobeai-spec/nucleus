import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadConfig } from '../config-file.js'
import { DEFAULT_AGENTS_DIR } from '../config/agent-files.js'
import { GRANTABLE, PERMISSION_SPECS } from '../runtime/permissions.js'
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

export async function agentNew(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const id = argv[0]
  if (!id) {
    line(c.red('用法：nucleus agent new <id> [--dir agents]'))
    line(c.gray('  id 会成为文件名与 agent id：小写字母、数字、连字符'))
    return 1
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    line(c.red(`id 只能是小写字母、数字与连字符：${id}`))
    return 1
  }

  const dir = strFlag(flags, 'dir') ?? process.env['NUCLEUS_AGENTS_DIR'] ?? DEFAULT_AGENTS_DIR
  const path = resolve(join(dir, `${id}.md`))
  const casesPath = path.replace(/\.md$/, '.cases.md')

  if (existsSync(path)) {
    line(`${ICON.fail} ${path} 已存在`)
    line(c.gray('  改它就行；要看模型实际收到什么：nucleus agent show ' + id))
    return 1
  }

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
