import { boot, type Nucleus } from '../boot.js'
import { agentSpec } from '../config.js'
import { buildPrefix } from '../context/assemble.js'
import { resultJsonSchema } from '../runtime/result-schema.js'
import { loadConfig } from '../config-file.js'
import { c, heading, ICON, line, strFlag, table, visibleLength } from './ui.js'

/**
 * `nucleus agent` —— 看清一个 agent 到底是什么样。
 *
 * 为什么需要这个：写 agent 和写规则时最该看的东西是「模型实际收到了什么」，
 * 而这件事以前**看不到** —— `buildSystemPrompt` 从来没被 CLI 调用过。
 * 只能靠读配置在脑子里拼，拼错了也不知道。
 *
 * 一条纪律：这里显示的每样东西都必须由**运行时同一条代码路径**算出
 * （agentSpec / buildPrefix / resultJsonSchema），不能另写一份「展示用」的
 * 拼装逻辑 —— 那样迟早和真实请求不一致，而这个命令的全部价值就在于可信。
 */

/** 额外带回 agent 来源与试题集 —— 「这个 agent 哪来的」必须答得出 */
let lastLoaded: { agentSources: Record<string, string>; cases: Record<string, string[]> } = {
  agentSources: {},
  cases: {},
}

async function open(flags: Record<string, string | true>): Promise<Nucleus> {
  const loaded = await loadConfig(strFlag(flags, 'config'))
  const { config } = loaded
  lastLoaded = { agentSources: loaded.agentSources, cases: loaded.cases }
  return boot({
    config,
    databaseUrl: strFlag(flags, 'db') ?? process.env['NUCLEUS_DATABASE_URL'] ?? null,
    // 与其它命令同一套解析 —— 写死路径会让这个命令悄悄打开另一个（空的）库
    dataDir:
      strFlag(flags, 'data') ?? process.env['NUCLEUS_PGLITE_DIR'] ?? '.nucleus-data/pglite',
    // 只看配置不跑任务，没必要连 MCP —— 但工具可见性需要它，见下面的提示
    skipMcp: flags['mcp'] !== true,
  })
}

export async function agentList(_argv: string[], flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    heading('agent')
    const entry = n.config.defaults.entryAgent
    table(
      n.config.agents.map((a) => {
        const spec = agentSpec(a, n.config.defaults)
        return [
          (a.id === entry ? c.cyan('▸ ') : '  ') + a.id,
          a.name,
          // 「什么时候派给它」——编排者的选路依据，也是人最想先看到的一列
          a.whenToUse ?? c.red('（未声明）'),
          // 两种来源并存，所以「这个 agent 哪来的」必须一眼看到
          c.gray(sourceLabel(lastLoaded.agentSources[a.id])),
          (lastLoaded.cases[a.id]?.length ?? 0) > 0
            ? String(lastLoaded.cases[a.id]!.length)
            : c.gray('—'),
        ]
      }),
      ['ID', '名称', '什么时候派给它', '来源', '试题'],
    )
    line()
    line(c.gray(`▸ 入口 agent（用户提问先落到它手上）`))
    const noDomain = n.config.agents.filter((a) => a.id !== entry && !a.whenToUse)
    if (noDomain.length) {
      line(
        `${ICON.warn} ${c.yellow(`${noDomain.length} 个专家没声明 whenToUse`)}` +
          c.gray(` —— 编排者只能靠 id 猜派给谁：${noDomain.map((a) => a.id).join(', ')}`),
      )
    }
    line(c.gray(`能力边界矩阵：nucleus agent map · 完整定义：nucleus agent show <id>`))
    return 0
  } finally {
    await n.close()
  }
}

/** 绝对路径太长，只显示相对于 agents/ 的部分 */
function sourceLabel(src: string | undefined): string {
  if (!src) return '?'
  if (src.startsWith('(')) return src.slice(1, -1)
  const i = src.lastIndexOf('/agents/')
  return i >= 0 ? src.slice(i + 1) : src
}

export async function agentShow(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const id = argv[0]
  if (!id) {
    line(c.red('用法：nucleus agent show <id> [--mcp]'))
    line(c.gray('  --mcp 连上 MCP，把它提供的工具也算进可见工具'))
    return 1
  }

  const n = await open(flags)
  try {
    const cfg = n.config.agents.find((a) => a.id === id)
    if (!cfg) {
      line(c.red(`没有 agent「${id}」`))
      line(c.gray(`现有：${n.config.agents.map((a) => a.id).join(', ')}`))
      return 1
    }

    const spec = agentSpec(cfg, n.config.defaults)
    const isEntry = n.config.defaults.entryAgent === id

    heading(`${id}${isEntry ? c.cyan('（入口）') : ''}`)
    line(`${c.gray('名称')}     ${cfg.name}`)
    line(`${c.gray('来源')}     ${sourceLabel(lastLoaded.agentSources[id])}`)
    const myCases = lastLoaded.cases[id] ?? []
    line(
      `${c.gray('试题')}     ` +
        (myCases.length
          ? `${myCases.length} 道（${sourceLabel(lastLoaded.agentSources[id])?.replace(/\.md$/, '.cases.md')}）`
          : c.gray('（无 —— agent try 需要它来做回归对比）')),
    )
    line(
      `${c.gray('何时用')}   ` +
        (cfg.whenToUse ?? c.red('（未声明 —— 编排者只能靠 id 猜是否该派给它）')),
    )
    line(`${c.gray('模型链')}   ${c.cyan(spec.modelChain.join(' → '))}`)
    const window = n.router.contextWindowFor(spec.modelChain, n.config.defaults.assumedContextWindow)
    const declared = spec.modelChain.some(
      (k) => n.config.models.find((m) => m.key === k)?.contextWindow !== undefined,
    )
    line(
      `${c.gray('上下文')}   ${window.toLocaleString()} tokens` +
        (declared ? '' : c.gray(`（无模型声明 contextWindow，按 assumedContextWindow 假设）`)),
    )
    line(
      `${c.gray('预算')}     ${spec.maxSteps} 步 · ${c.gray('成本上限')} $${spec.maxCostUsd}` +
        (spec.maxTokens ? ` · ${c.gray('输出上限')} ${spec.maxTokens}` : ''),
    )

    // ── 模型实际收到的 system prompt ──
    // 用 buildPrefix 算，与 runner 里那次装配是同一个函数
    const prefix = buildPrefix({ contract: spec.systemPrompt, identity: '', policy: '' })
    heading('模型收到的 system prompt')
    line(c.gray(`${prefix.length} 字符 · ${prefix.split('\n').length} 行 · 逐字节稳定（prompt cache 依赖这一点）`))
    line(c.gray('─'.repeat(Math.min(70, Math.max(...prefix.split('\n').map(visibleLength)) + 2))))
    for (const l of prefix.split('\n')) line(l ? `  ${l}` : '')
    line(c.gray('─'.repeat(Math.min(70, Math.max(...prefix.split('\n').map(visibleLength)) + 2))))

    // ── 可见工具（T3 能力边界）──
    heading('可见工具')
    const visible = n.tools.forAgent(spec.permissions, spec.toolsAllow, spec.toolsDeny).map((t) => t.name)
    const missing = (spec.toolsAllow ?? []).filter((t) => !t.includes('*') && !n.tools.get(t))
    for (const t of n.tools.forAgent(spec.permissions, spec.toolsAllow, spec.toolsDeny)) {
      // 描述可能是多行的（delegate 会列出所有可委派专家），截断会把清单切掉
      const [head, ...rest] = t.description.split('\n')
      line(`  ${t.name.padEnd(24)} ${c.gray(t.sideEffect)} ${c.gray(head ?? '')}`)
      for (const l of rest) line(`  ${' '.repeat(24)} ${' '.repeat(10)} ${c.gray(l.trim())}`)
    }
    if (visible.length === 0) line(c.gray('  （无）'))
    line()
    line(c.gray(`权限：${spec.permissions.join(', ') || '（无 —— 看不到任何工具）'}`))
    if (spec.toolsAllow?.length) line(c.gray(`按名字收窄：${spec.toolsAllow.join(', ')}`))
    if (spec.toolsDeny?.length) line(c.gray(`toolsDeny:  ${spec.toolsDeny.join(', ')}`))
    if (missing.length) {
      line()
      line(`${ICON.warn} ${c.yellow(`toolsAllow 里有 ${missing.length} 个未注册的工具`)}：${missing.join(', ')}`)
      line(
        c.gray(
          flags['mcp'] === true
            ? '  MCP 已连接，仍然找不到 —— 检查工具名（形如 server__tool）'
            : '  MCP 工具要加 --mcp 才会被算进来',
        ),
      )
    }
    // 委派关系是双向的，两边都要能看到
    const delegators = n.config.agents.filter(
      (a) => a.id !== id && (a.permissions ?? []).includes('delegate') && id !== n.config.defaults.entryAgent,
    )
    if (delegators.length) {
      line()
      line(c.gray(`可以被这些 agent 派活：${delegators.map((a) => a.id).join(', ')}`))
    }
    // 能不能委派，直接影响是否会形成委派链
    if (visible.includes('delegate')) {
      line()
      line(
        c.gray(
          `可委派给：${n.config.agents.filter((a) => a.id !== id).map((a) => a.id).join(', ') || '（无）'}` +
            ` · 深度上限 ${n.config.defaults.maxDelegationDepth} · 树内 run 上限 ${n.config.defaults.maxRunsPerRoot}`,
        ),
      )
    }

    // ── 结果契约：规则最终变成的东西 ──
    heading('结果契约')
    if (cfg.capabilities?.length) line(`${c.gray('能力段')}   ${cfg.capabilities.join(', ')}`)
    if (cfg.requiredFields?.length) {
      line(`${c.gray('必填')}     ${c.yellow(cfg.requiredFields.join(', '))}`)
      line(c.gray('         a[].b 表示每一个元素的 b 都不能为空'))
    } else {
      line(c.gray('（只有核心字段必填）'))
    }
    line()
    line(c.gray('模型收到的 submit_result 参数 schema：'))
    // 与 runner 传给模型的是同一个调用 —— spec.resultSpec 由 agentSpec 推导
    const schema = resultJsonSchema(spec.resultSpec ?? {})
    for (const l of JSON.stringify(schema, null, 2).split('\n')) line(c.gray(`  ${l}`))

    return 0
  } finally {
    await n.close()
  }
}

/**
 * `nucleus agent map` —— 能力边界矩阵。
 *
 * 单看每个 agent 的 toolsAllow 很难发现问题；横过来一眼就看得出
 * 「谁权限过大」「哪个工具人人都能用」「有没有第二个 agent 也能委派
 * （多一个能委派的就多一条成环的路）」。
 *
 * 这张表是 T3 能力边界的全貌 —— 而 T3 是唯一不依赖模型配合的一层。
 */
export async function agentMap(_argv: string[], flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    const entry = n.config.defaults.entryAgent
    const specs = n.config.agents.map((a) => ({ cfg: a, spec: agentSpec(a, n.config.defaults) }))

    // 列 = 所有被任何 agent 声明过的工具（含通配），按被引用次数排
    const counts = new Map<string, number>()
    for (const { spec } of specs) {
      for (const t of n.tools.forAgent(spec.permissions, spec.toolsAllow, spec.toolsDeny)) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
    }
    const tools = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)

    heading('能力边界矩阵')
    if (tools.length === 0) {
      line(c.gray('没有任何 agent 声明了工具。'))
      return 0
    }

    const rows = specs.map(({ cfg, spec }) => [
      (cfg.id === entry ? c.cyan('▸ ') : '  ') + cfg.id,
      ...tools.map((t) => {
        if (spec.toolsDeny?.includes(t)) return c.red('✗')
        const visible = n.tools
          .forAgent(spec.permissions, spec.toolsAllow, spec.toolsDeny)
          .some((x) => x.name === t)
        if (visible) return c.green('●')
        // 区分「没授权」和「授权了但被名字收窄挡住」—— 排查时是两件事
        const lacking = n.tools.missingPermissions(spec.permissions, t)
        return lacking.length ? c.gray(lacking.join('+')) : c.yellow('·')
      }),
    ])
    table(rows, ['AGENT', ...tools])

    line()
    line(
      `${c.green('●')} 可用   ${c.gray('权限名')} 缺这个权限   ` +
        `${c.yellow('·')} 权限够但被 toolsAllow 收窄挡住   ${c.red('✗')} 显式拒绝`,
    )
    line(c.gray('缺权限时直接显示缺哪个 —— 排查时「没授权」和「被名字挡住」是两件事'))

    // 几条一眼能看出的风险，直接点出来而不是让人自己数
    const delegators = specs.filter((x) => x.spec.permissions.includes('delegate'))
    if (delegators.length > 1) {
      line()
      line(
        `${ICON.info} ${delegators.length} 个 agent 能委派（${delegators.map((x) => x.cfg.id).join(', ')}）` +
          c.gray(` —— 多一个就多一条成环的路，深度上限 ${n.config.defaults.maxDelegationDepth} 是唯一兜底`),
      )
    }
    // 用**声明的副作用等级**判断风险，不靠工具名正则。
    // 名字正则会把 write_report 也算成「改变外部状态」，而它和 write_file
    // 一样受 fs.workdir-boundary 约束，只写 run 的工作目录内。
    // non_idempotent 才是真风险：结果未知时不能自动重跑（§3.2）。
    const risky = specs
      .map((x) => ({
        id: x.cfg.id,
        tools: n.tools
          .forAgent(x.spec.permissions, x.spec.toolsAllow, x.spec.toolsDeny)
          .filter((t) => t.sideEffect === 'non_idempotent')
          .map((t) => t.name),
      }))
      .filter((x) => x.tools.length > 0)
    if (risky.length) {
      line(
        `${ICON.warn} ${c.yellow('可执行不可重试的操作')}：` +
          risky.map((x) => `${x.id}(${x.tools.join(',')})`).join('  ') +
          c.gray('  —— 结果未知时不会自动重跑，转 needs_human_confirmation'),
      )
    }
    const idle = specs.filter((x) => x.spec.permissions.length === 0)
    if (idle.length) {
      line(
        `${ICON.warn} ${c.yellow(`${idle.map((x) => x.cfg.id).join(', ')} 没有任何工具`)}` +
          c.gray(' —— 只能靠 submit_result 直接作答'),
      )
    }
    return 0
  } finally {
    await n.close()
  }
}
