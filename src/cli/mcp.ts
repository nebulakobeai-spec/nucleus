import { boot } from '../boot.js'
import { defaultConfig } from '../config.js'
import { c, heading, ICON, line, table, resolveDb } from './ui.js'

/**
 * `nucleus mcp` 命令组。
 *
 *   mcp list             server 状态与工具数
 *   mcp tools [server]   工具清单 + 副作用等级 + schema 降级提示
 *   mcp enable <id>      解除自动禁用
 *   mcp call <tool>      直接调一个工具（调试用）
 */

async function open(flags: Record<string, string | true>) {
  return boot({
    config: defaultConfig,
    dataDir: resolveDb(flags).dataDir,
    onMcpEvent: (e) => {
      if (e.kind === 'mcp.auto_disabled') {
        line(`${ICON.warn} ${e.serverId} 已被自动禁用：${JSON.stringify(e.detail)}`)
      }
    },
  })
}

export async function mcpList(_argv: string[], flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    if (!n.mcp) {
      heading('MCP')
      line(c.gray('config 中没有配置任何 MCP server。'))
      line()
      line(c.gray('在 src/config.ts 的 defaultConfig.mcp 里添加，例如：'))
      line(c.gray('  { id: "searxng", transport: "stdio", command: "npx",'))
      line(c.gray('    args: ["-y", "mcp-searxng"], env: { SEARXNG_URL: "http://localhost:8888" } }'))
      return 0
    }

    const statuses = n.mcp.statuses()
    heading(`MCP server（${statuses.length}）`)
    table(
      statuses.map((s) => [
        s.id,
        s.state === 'ready'
          ? c.green(s.state)
          : s.state === 'disabled'
            ? c.red(s.state)
            : s.state === 'failed'
              ? c.yellow(s.state)
              : c.gray(s.state),
        String(s.toolCount),
        s.failureCount > 0 ? c.yellow(String(s.failureCount)) : '0',
        c.gray((s.lastError ?? '').slice(0, 50)),
      ]),
      ['ID', '状态', '工具', '失败', '最近错误'],
    )

    const disabled = statuses.filter((s) => s.state === 'disabled')
    if (disabled.length) {
      line()
      line(`${ICON.warn} ${disabled.length} 个 server 已被自动禁用，其工具已从 agent 工具集中移除`)
      line(c.gray(`  修复后运行：nucleus mcp enable ${disabled[0]!.id}`))
    }
    return 0
  } finally {
    await n.close()
  }
}

export async function mcpTools(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    if (!n.mcpReport) {
      line(c.gray('没有注册任何 MCP 工具。'))
      return 0
    }
    const filter = argv[0]
    const rows = n.mcpReport.classification.filter((x) => !filter || x.tool.startsWith(`${filter}__`))

    heading(`MCP 工具（${rows.length}）`)
    table(
      rows.map((x) => [
        x.tool,
        x.sideEffect === 'pure'
          ? c.green(x.sideEffect)
          : x.sideEffect === 'idempotent'
            ? c.cyan(x.sideEffect)
            : c.yellow(x.sideEffect),
        c.gray(x.reason),
      ]),
      ['工具', '副作用', '依据'],
    )

    // 副作用等级决定崩溃恢复行为 —— 这条必须让人看见
    const risky = rows.filter((x) => x.sideEffect === 'non_idempotent')
    if (risky.length) {
      line()
      line(`${ICON.warn} ${risky.length} 个工具按「不可幂等」处理：崩溃后不会自动重跑，会转人工确认`)
      line(c.gray('  若确实可安全重放，在 config.mcpPolicies.policies 中显式声明'))
    }

    if (n.mcpReport.warnings.length) {
      line()
      heading('schema 降级')
      for (const w of n.mcpReport.warnings) {
        line(`${c.yellow(w.tool)}`)
        for (const msg of w.warnings) line(c.gray(`  · ${msg}`))
      }
      line(c.gray('降级是为了让 provider 接受 schema；丢掉的约束由 runtime 再校验。'))
    }

    if (n.mcpReport.skipped.length) {
      line()
      for (const s of n.mcpReport.skipped) {
        line(`${ICON.warn} 跳过 ${s.name}：${c.gray(s.reason)}`)
      }
    }
    return 0
  } finally {
    await n.close()
  }
}

export async function mcpEnable(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const id = argv[0]
  if (!id) {
    line(c.red('用法：nucleus mcp enable <server-id>'))
    return 1
  }
  const n = await open(flags)
  try {
    if (!n.mcp?.enable(id)) {
      line(c.red(`未找到 server ${id}`))
      return 1
    }
    const { tools, failed } = await n.mcp.discover()
    const f = failed.find((x) => x.id === id)
    if (f) {
      line(`${ICON.fail} ${id} 仍然无法连接：${c.gray(f.error)}`)
      return 1
    }
    line(`${ICON.ok} ${id} 已恢复，${tools.filter((t) => t.serverId === id).length} 个工具可用`)
    return 0
  } finally {
    await n.close()
  }
}

/** 直接调一个 MCP 工具，绕过 agent —— 排查 server 问题用 */
export async function mcpCall(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const tool = argv[0]
  if (!tool) {
    line(c.red('用法：nucleus mcp call <server__tool> [--args \'{"k":"v"}\']'))
    return 1
  }
  const n = await open(flags)
  try {
    if (!n.mcp) {
      line(c.red('没有配置 MCP server'))
      return 1
    }
    let args: unknown = {}
    if (typeof flags['args'] === 'string') {
      try {
        args = JSON.parse(flags['args'])
      } catch (e) {
        line(c.red(`--args 不是合法 JSON：${(e as Error).message}`))
        return 1
      }
    }

    const t0 = Date.now()
    const res = await n.mcp.call(tool, args)
    const { renderContent } = await import('../mcp/client.js')

    heading(`${tool} · ${Date.now() - t0}ms`)
    if (res.isError) line(`${ICON.fail} 工具报错`)
    line(renderContent(res))
    return res.isError ? 1 : 0
  } catch (e) {
    const err = e as { code?: string; message: string }
    line(`${ICON.fail} ${c.red(err.code ?? 'error')} ${err.message}`)
    return 1
  } finally {
    await n.close()
  }
}
