import { boot, ask, type Nucleus } from '../boot.js'
import { defaultConfig } from '../config.js'
import { recoveryOf } from '../errors.js'
import type { MockScript } from '../providers/mock.js'
import { authList, authLogin, authLogout, authRefresh, authTest, credentialStatus } from './auth.js'
import { mcpCall, mcpEnable, mcpList, mcpTools } from './mcp.js'
import { bundleCmd, replayCmd } from './bundle.js'
import { loadConfig } from '../config-file.js'
import { c, duration, heading, ICON, line, money, parseArgv, recoveryHint, statusColor, table } from './ui.js'

/**
 * Nucleus CLI。
 *
 * 同时是三样东西：
 *  - 本地开发时观察系统行为的窗口
 *  - 部署机 RUNBOOK 里那几条命令（doctor / verify）
 *  - 出问题时的诊断入口（runs / events / bundle）
 */

/**
 * 演示脚本。
 *
 * 编排者第 1 次 attempt 只做委派 —— 委派后 worker 会 arm wake 并结束本轮，
 * 编排者**不保持活着**。子 run 终态时同事务唤醒，第 2 次 attempt 才整合。
 * 这正是真实模型该有的行为节奏。
 */
const DEMO_SCRIPT: MockScript = {
  orchestrator: [
    {
      text: '这件事需要调研，我委派给专家。',
      tool: { name: 'delegate', args: { agent: 'researcher', task: '调研目标主题，产出带来源的要点' } },
    },
    // ↓ 被 wake 唤醒后的第 2 次 attempt
    {
      submit: {
        status: 'ok',
        summary: '调研完成：专家确认方向可行，关键依据已整理成报告。',
        artifacts: [],
      },
    },
  ],
  researcher: [
    { tool: { name: 'web_search', args: { query: '目标主题' } } },
    { tool: { name: 'write_report', args: { title: '主题调研', content: '## 结论\n可行。\n\n## 依据\n见来源。' } } },
    {
      submit: {
        status: 'ok',
        summary: '主题可行，关键依据已整理成报告。',
        findings: [{ claim: '该方向可行', sources: ['内部知识', '已有实践'] }],
        artifacts: ['reports/主题调研.md'],
      },
    },
  ],
}

async function open(flags: Record<string, string | true>): Promise<Nucleus> {
  const dbUrl = (flags['db'] as string) ?? process.env['NUCLEUS_DATABASE_URL'] ?? null
  const dataDir = (flags['data'] as string) ?? process.env['NUCLEUS_PGLITE_DIR'] ?? null
  const useMock = flags['mock'] === true || !!flags['mock'] || process.env['NUCLEUS_MOCK'] === '1'

  const { config: loaded } = await loadConfig(
    typeof flags['config'] === 'string' ? flags['config'] : undefined,
  )
  const config = { ...loaded }
  if (flags['model']) {
    const chain = String(flags['model']).split(',')
    config.defaults = { ...config.defaults, modelChain: chain }
  }

  return boot({
    config,
    databaseUrl: dbUrl,
    dataDir: dbUrl ? null : (dataDir ?? '.nucleus-data/pglite'),
    ...(useMock ? { mock: DEMO_SCRIPT } : {}),
  })
}

// ── doctor ───────────────────────────────────────────────

async function doctor(flags: Record<string, string | true>): Promise<number> {
  heading('nucleus doctor')
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []

  checks.push({
    name: 'node 版本',
    ok: Number(process.versions.node.split('.')[0]) >= 20,
    detail: process.versions.node,
  })

  // 配置来源：部署机最常见的问题是「改了配置但没生效」
  try {
    const { path, overrides } = await loadConfig(
      typeof flags['config'] === 'string' ? flags['config'] : undefined,
    )
    checks.push({
      name: '配置文件',
      ok: true,
      detail: path ? `${path}（覆盖 ${overrides.join(', ') || '无'}）` : '内置默认（无 nucleus.config.json）',
    })
  } catch (e) {
    checks.push({ name: '配置文件', ok: false, detail: (e as Error).message })
  }

  let n: Nucleus | null = null
  try {
    n = await open(flags)
    checks.push({
      name: '数据库连接',
      ok: true,
      detail: n.db.kind === 'pglite' ? 'pglite（本地，生产应使用真 Postgres）' : n.db.kind,
    })

    const tables = await n.db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    )
    checks.push({ name: 'schema 已应用', ok: (tables.rows[0]?.n ?? 0) > 10, detail: `${tables.rows[0]?.n} 张表` })

    const ver = await n.db.query<{ v: string }>(`select version() as v`)
    const major = Number(/PostgreSQL (\d+)/.exec(ver.rows[0]?.v ?? '')?.[1] ?? 0)
    checks.push({
      name: 'Postgres 版本 ≥ 14',
      ok: major >= 14,
      detail: `${major}${n.db.kind === 'pglite' ? '（PGlite）' : ''}`,
    })

    checks.push({ name: '工具注册', ok: n.tools.size > 0, detail: `${n.tools.size} 个` })
    checks.push({ name: 'agent 配置', ok: n.config.agents.length > 0, detail: n.config.agents.map((a) => a.id).join(', ') })

    // 凭据：只报来源与有效性，绝不打印值
    for (const s of await credentialStatus(n.config)) {
      checks.push({ name: `凭据 ${s.ref}`, ok: s.ok, detail: s.detail })
    }

    // MCP：起不来的 server 会静默降级，必须显式报出来
    for (const st of n.mcp?.statuses() ?? []) {
      checks.push({
        name: `MCP ${st.id}`,
        ok: st.state === 'ready',
        detail: st.state === 'ready' ? `${st.toolCount} 个工具` : `${st.state}${st.lastError ? ` — ${st.lastError}` : ''}`,
      })
    }

    const health = await n.router.health.all()
    for (const h of health) {
      checks.push({
        name: `provider ${h.key}`,
        ok: h.breakerState === 'closed',
        detail: h.breakerState === 'closed' ? '正常' : `${h.breakerState} 至 ${h.breakerUntil?.toISOString() ?? '?'}`,
      })
    }
  } catch (e) {
    checks.push({ name: '启动', ok: false, detail: (e as Error).message })
  } finally {
    await n?.close()
  }

  for (const ch of checks) {
    line(`${ch.ok ? ICON.ok : ICON.fail} ${ch.name.padEnd(24)} ${c.gray(ch.detail)}`)
  }
  const failed = checks.filter((x) => !x.ok)
  line()
  line(failed.length === 0 ? c.green('全部通过') : c.red(`${failed.length} 项未通过`))
  return failed.length === 0 ? 0 : 1
}

// ── ask：跑一轮对话 ──────────────────────────────────────

async function askCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const text = argv.join(' ')
  if (!text) {
    line(c.red('用法：nucleus ask "你的问题" [--mock] [--conv <id>]'))
    return 1
  }

  const n = await open(flags)
  try {
    const convId = (flags['conv'] as string) ?? (await n.conversations.create({ agentId: 'orchestrator', title: text.slice(0, 40) })).id

    heading(`会话 ${convId.slice(0, 8)}`)
    line(`${c.bold('你')}  ${text}`)
    line()

    const t0 = Date.now()
    const { runId } = await ask(n, convId, text, {
      onAttemptStart: (i) =>
        line(`${ICON.run} ${c.cyan(i.agentId)} ${c.gray(`attempt ${i.attemptNo} · run ${i.runId.slice(0, 8)}`)}`),
      onAttemptEnd: (i) => {
        const icon = i.status === 'succeeded' ? ICON.ok : i.status === 'waiting_children' ? ICON.info : ICON.fail
        const note = i.status === 'waiting_children' ? c.gray('（挂起，等待专家）') : ''
        line(
          `  ${icon} ${statusColor(i.status)}${note}` +
            (i.errorCode ? ` ${c.gray(i.errorCode)} ${recoveryHint(recoveryOf(i.errorCode))}` : ''),
        )
      },
    })

    line()
    const msgs = await n.conversations.recent(convId, 5)
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      line(`${c.bold('助手')} ${last.content}`)
      if (last.artifacts.length) line(c.gray(`产出：${last.artifacts.join(', ')}`))
    } else {
      const run = await n.runs.getRun(runId)
      line(`${ICON.warn} 未产生回复；run 状态 ${statusColor(run?.status ?? '?')} ${c.gray(run?.errorCode ?? '')}`)
    }

    // 成本与耗时
    const tree = await n.runs.tree(runId)
    let cost = 0
    let tokens = 0
    for (const r of tree) {
      for (const a of await n.runs.listAttempts(r.id)) {
        cost += Number(a.costUsd ?? 0)
        tokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
      }
    }
    line()
    line(c.gray(`${tree.length} 个 run · ${tokens} tokens · ${money(cost)} · ${duration(Date.now() - t0)}`))
    line(c.gray(`详情：nucleus runs ${runId.slice(0, 8)}`))
    return 0
  } finally {
    await n.close()
  }
}

// ── runs：run 树与状态 ───────────────────────────────────

async function runsCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    const prefix = argv[0]
    if (!prefix) {
      const r = await n.db.query<{ id: string; agent_id: string; status: string; error_code: string | null; created_at: Date }>(
        `select id, agent_id, status, error_code, created_at from runs
          where parent_run_id is null order by created_at desc limit 20`,
      )
      heading('最近的 run')
      table(
        r.rows.map((x) => [
          x.id.slice(0, 8),
          x.agent_id,
          statusColor(x.status),
          x.error_code ? `${c.gray(x.error_code)} ${recoveryHint(recoveryOf(x.error_code))}` : '',
          c.gray(new Date(x.created_at).toLocaleString()),
        ]),
        ['ID', 'AGENT', '状态', '错误', '时间'],
      )
      return 0
    }

    const found = await n.db.query<{ id: string }>(`select id from runs where id::text like $1 limit 1`, [`${prefix}%`])
    const rootId = found.rows[0]?.id
    if (!rootId) {
      line(c.red(`未找到 run ${prefix}`))
      return 1
    }

    const root = (await n.runs.getRun(rootId))!
    const tree = await n.runs.tree(root.rootRunId)

    heading(`run 树 ${root.rootRunId.slice(0, 8)}`)
    for (const r of tree) {
      const attempts = await n.runs.listAttempts(r.id)
      const cost = attempts.reduce((s, a) => s + Number(a.costUsd ?? 0), 0)
      const indent = '  '.repeat(r.depth)
      line(
        `${indent}${r.depth === 0 ? '●' : '└─'} ${c.cyan(r.agentId)} ${statusColor(r.status)} ` +
          c.gray(`${r.id.slice(0, 8)} · ${attempts.length} attempt · ${money(cost)}`),
      )
      if (r.errorCode) {
        line(`${indent}   ${ICON.warn} ${c.gray(r.errorCode)} ${recoveryHint(recoveryOf(r.errorCode))}`)
      }
      const summary = (r.result as { summary?: string } | null)?.summary
      if (summary) line(`${indent}   ${c.gray(summary.slice(0, 100))}`)
      for (const a of attempts) {
        if (attempts.length === 1 && a.status === 'succeeded') continue
        line(`${indent}   ${c.gray(`#${a.attemptNo}`)} ${statusColor(a.status)} ${c.gray(a.errorCode ?? '')}`)
      }
    }
    return 0
  } finally {
    await n.close()
  }
}

// ── events：timeline ─────────────────────────────────────

async function eventsCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    const prefix = argv[0]
    if (!prefix) {
      line(c.red('用法：nucleus events <run-id 前缀>'))
      return 1
    }
    const found = await n.db.query<{ id: string; root_run_id: string }>(
      `select id, root_run_id from runs where id::text like $1 limit 1`,
      [`${prefix}%`],
    )
    const root = found.rows[0]
    if (!root) {
      line(c.red(`未找到 run ${prefix}`))
      return 1
    }

    const ev = await n.db.query<{
      run_id: string
      kind: string
      payload: Record<string, unknown>
      created_at: Date
    }>(
      `select e.run_id, e.kind, e.payload, e.created_at
         from run_events e join runs r on r.id = e.run_id
        where r.root_run_id = $1 order by e.id`,
      [root.root_run_id],
    )

    heading(`timeline ${root.root_run_id.slice(0, 8)}（${ev.rows.length} 条）`)
    const t0 = ev.rows[0] ? new Date(ev.rows[0].created_at).getTime() : 0
    for (const e of ev.rows) {
      const dt = new Date(e.created_at).getTime() - t0
      const p = e.payload ?? {}
      let detail = ''
      switch (e.kind) {
        case 'attempt.started':
          detail = `${p['agent']} #${p['attemptNo']}`
          break
        case 'llm.call.finished':
          detail = `${p['model']} ${p['tokensIn']}+${p['tokensOut']} tok ${money(Number(p['costUsd'] ?? 0))}`
          break
        case 'tool.intent':
          detail = `${p['tool']} ${c.gray(String(p['sideEffect']))}`
          break
        case 'tool.outcome':
          detail = `${p['tool']} ${p['ok'] ? ICON.ok : ICON.fail} ${duration(Number(p['ms'] ?? 0))}`
          break
        case 'rule.violation':
          detail = `${p['tool']} ← ${c.yellow(String(p['rule']))}`
          break
        case 'contract.rejected':
          detail = c.yellow(`第 ${p['retry']} 次退回`)
          break
        case 'artifact.written':
          detail = String(p['ref'])
          break
        case 'attempt.finished':
          detail = `${statusColor(String(p['status']))} ${money(Number(p['costUsd'] ?? 0))}`
          break
        default:
          detail = c.gray(JSON.stringify(p).slice(0, 60))
      }
      line(`${c.gray(String(dt).padStart(6) + 'ms')} ${c.gray(e.run_id.slice(0, 6))} ${e.kind.padEnd(20)} ${detail}`)
    }
    return 0
  } finally {
    await n.close()
  }
}

// ── verify：端到端冒烟 ───────────────────────────────────

async function verify(flags: Record<string, string | true>): Promise<number> {
  heading('nucleus verify')
  const n = await boot({ mock: DEMO_SCRIPT })
  const results: Array<[string, boolean, string]> = []

  try {
    const conv = await n.conversations.create({ agentId: 'orchestrator', title: 'verify' })
    const { runId } = await ask(n, conv.id, '帮我调研一个主题')

    const tree = await n.runs.tree(runId)
    const root = tree.find((r) => r.depth === 0)!
    const child = tree.find((r) => r.depth === 1)

    results.push(['编排者完成', root.status === 'succeeded', root.status])
    results.push(['专家被委派并完成', child?.status === 'succeeded', child?.status ?? '无子 run'])
    results.push(['专家无对外身份', child?.conversationId === null, String(child?.conversationId)])

    const msgs = await n.conversations.recent(conv.id, 10)
    const assistant = msgs.filter((m) => m.role === 'assistant')
    results.push(['结果回流到会话', assistant.length === 1, `${assistant.length} 条助手消息`])

    const artifacts = await n.db.query<{ n: number }>(`select count(*)::int n from artifacts`)
    results.push(['产出已登记', (artifacts.rows[0]?.n ?? 0) > 0, `${artifacts.rows[0]?.n} 个 artifact`])

    const ev = await n.db.query<{ n: number }>(`select count(*)::int n from run_events`)
    results.push(['timeline 已记录', (ev.rows[0]?.n ?? 0) > 5, `${ev.rows[0]?.n} 条事件`])

    const inv = await n.db.query<{ n: number }>(`select count(*)::int n from tool_invocations where outcome is null`)
    results.push(['无悬挂的工具调用', (inv.rows[0]?.n ?? 0) === 0, `${inv.rows[0]?.n} 条未完成`])

    const stuck = await n.db.query<{ n: number }>(
      `select count(*)::int n from run_attempts where status in ('queued','running')`,
    )
    results.push(['无悬挂 attempt', (stuck.rows[0]?.n ?? 0) === 0, `${stuck.rows[0]?.n} 个未终态`])
  } catch (e) {
    results.push(['执行', false, (e as Error).message])
  } finally {
    await n.close()
  }

  for (const [name, ok, detail] of results) {
    line(`${ok ? ICON.ok : ICON.fail} ${name.padEnd(22)} ${c.gray(detail)}`)
  }
  const failed = results.filter(([, ok]) => !ok).length
  line()
  line(failed === 0 ? c.green('verify 通过') : c.red(`${failed} 项失败`))
  return failed === 0 ? 0 : 1
}

// ── 入口 ─────────────────────────────────────────────────

const HELP = `${c.bold('nucleus')} — 多 agent 编排运行时

${c.bold('对话与诊断')}
  ask <文本>          发起一轮对话并执行到静止
  runs [id 前缀]      列出 run / 查看 run 树
  events <id 前缀>    查看 timeline

${c.bold('凭据')}
  auth login <REF>            录入 API key（静默输入，不回显）
  auth login <REF> --oauth    浏览器授权（device flow + PKCE）
  auth list                   列出凭据来源与状态
  auth test [REF]             用真实请求验证凭据可用
  auth refresh <REF>          刷新 OAuth token
  auth logout <REF>           删除凭据

${c.bold('MCP')}
  mcp list                    server 状态与工具数
  mcp tools [server]          工具清单 + 副作用等级 + schema 降级
  mcp enable <id>             解除自动禁用
  mcp call <tool> --args '{}' 直接调用（调试）

${c.bold('运维')}
  doctor              环境与配置自检
  verify              端到端冒烟（内置 mock provider）
  migrate             应用数据库迁移
  bundle [--run <id>] 导出诊断包（已脱敏，可直接提交）
  replay <文件>       读取诊断包，还原现场

${c.bold('通用参数')}
  --mock              用内置 mock provider（无网络环境）
  --model a,b         覆盖模型链，如 --model zai:glm-4.7,openai:gpt-5
  --db <url>          用真 Postgres 而非本地 PGlite
  --data <dir>        PGlite 数据目录（默认 .nucleus-data/pglite）
  --conv <id>         复用已有会话
  --no-keychain       不使用 macOS keychain，只用文件后端
  --config <file>     指定配置文件（默认找 ./nucleus.config.json）

${c.bold('示例')}
  nucleus auth login ZAI_API_KEY
  echo "$KEY" | nucleus auth login ZAI_API_KEY --stdin
  nucleus auth test
  nucleus verify
  nucleus ask "帮我调研一下 X" --model zai:glm-4.7
`

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgv(argv)
  const cmd = positional[0]
  const rest = positional.slice(1)

  switch (cmd) {
    case 'ask':
      return askCmd(rest, flags)
    case 'runs':
      return runsCmd(rest, flags)
    case 'events':
      return eventsCmd(rest, flags)
    case 'doctor':
      return doctor(flags)
    case 'verify':
      return verify(flags)
    case 'auth': {
      const sub = rest[0]
      const args = rest.slice(1)
      switch (sub) {
        case 'login':
          return authLogin(args, flags)
        case 'list':
        case 'ls':
          return authList(args, flags)
        case 'test':
          return authTest(args, flags)
        case 'refresh':
          return authRefresh(args, flags)
        case 'logout':
        case 'rm':
          return authLogout(args, flags)
        default:
          line(c.red(sub ? `未知子命令：auth ${sub}` : '用法：nucleus auth <login|list|test|refresh|logout>'))
          return 1
      }
    }
    case 'mcp': {
      const sub = rest[0]
      const args = rest.slice(1)
      switch (sub) {
        case 'list':
        case undefined:
          return mcpList(args, flags)
        case 'tools':
          return mcpTools(args, flags)
        case 'enable':
          return mcpEnable(args, flags)
        case 'call':
          return mcpCall(args, flags)
        default:
          line(c.red(`未知子命令：mcp ${sub}`))
          return 1
      }
    }
    case 'bundle':
      return bundleCmd(rest, flags)
    case 'replay':
      return replayCmd(rest, flags)
    case 'migrate': {
      const n = await open(flags)
      line(`${ICON.ok} migration 已应用（${n.db.kind}）`)
      await n.close()
      return 0
    }
    case undefined:
    case 'help':
    case '--help':
      line(HELP)
      return 0
    default:
      line(c.red(`未知命令：${cmd}`))
      line(HELP)
      return 1
  }
}

const entry = process.argv[1] ?? ''
const isMain = /(?:cli[/\\]index\.(?:ts|js)|[/\\]nucleus)$/.test(entry)
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      line(c.red(`\n${(e as Error).message}`))
      if (process.env['NUCLEUS_DEBUG']) console.error(e)
      process.exit(1)
    })
}
