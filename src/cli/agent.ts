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

async function open(flags: Record<string, string | true>): Promise<Nucleus> {
  const { config } = await loadConfig(strFlag(flags, 'config'))
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
          c.gray(spec.modelChain.join(' → ')),
          String(spec.toolsAllow.length),
          a.requiredFields?.length ? c.yellow(String(a.requiredFields.length)) : c.gray('0'),
        ]
      }),
      ['ID', '名称', '模型链', '工具', '必填'],
    )
    line()
    line(c.gray(`▸ 表示入口 agent（用户提问先落到它手上）`))
    line(c.gray(`看某个的完整定义：nucleus agent show <id>`))
    return 0
  } finally {
    await n.close()
  }
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
    const visible = n.tools.forAgent(spec.toolsAllow, spec.toolsDeny).map((t) => t.name)
    const missing = spec.toolsAllow.filter((t) => !t.includes('*') && !n.tools.get(t))
    for (const t of n.tools.forAgent(spec.toolsAllow, spec.toolsDeny)) {
      line(`  ${t.name.padEnd(24)} ${c.gray(t.sideEffect)} ${c.gray(t.description.slice(0, 44))}`)
    }
    if (visible.length === 0) line(c.gray('  （无）'))
    line()
    line(c.gray(`toolsAllow: ${spec.toolsAllow.join(', ') || '（空）'}`))
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
