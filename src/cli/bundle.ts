import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { boot } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { redactText } from '../auth/credentials.js'
import { errorSpec } from '../errors.js'
import { c, heading, ICON, line } from './ui.js'

/**
 * `nucleus bundle` —— 故障诊断包。
 *
 * 目标（见 DESIGN.md 的开发回路）：**一次往返拿到最多信息**。
 * 部署机出问题时跑一条命令产出一个文件，提交上来即可在本地复现，
 * 不需要来回问「你再看看那个日志」。
 *
 * 所有内容过 `redactText`，密钥不会进包。
 */

export interface Bundle {
  meta: {
    createdAt: string
    gitSha: string | null
    nodeVersion: string
    platform: string
    configPath: string | null
    configOverrides: string[]
    dbKind: string
    schemaHash: string | null
  }
  environment: {
    /** 只报有没有，不报值 */
    credentials: Array<{ ref: string; present: boolean }>
    providerHealth: unknown[]
    mcpServers: unknown[]
    toolCount: number
    agents: string[]
  }
  run?: {
    root: unknown
    tree: unknown[]
    attempts: unknown[]
    events: unknown[]
    toolInvocations: unknown[]
    wakes: unknown[]
    artifacts: unknown[]
    /** 每个 error_code 的恢复性，避免对方还要查文档 */
    errorSpecs: Record<string, unknown>
  }
  recentFailures?: unknown[]
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export async function bundleCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const runPrefix = (flags['run'] as string) ?? argv[0]
  const { config, path: configPath, overrides } = await loadConfig(
    typeof flags['config'] === 'string' ? flags['config'] : undefined,
  )

  const n = await boot({
    config,
    databaseUrl: (flags['db'] as string) ?? process.env['NUCLEUS_DATABASE_URL'] ?? null,
    dataDir: (flags['data'] as string) ?? '.nucleus-data/pglite',
    // 诊断时不要真去连 MCP —— 那可能正是出问题的地方，会拖慢或挂住
    skipMcp: true,
  })

  try {
    const schemaHash = await n.db
      .query<{ sha: string }>(`select sha from _migrations order by name desc limit 1`)
      .then((r) => r.rows[0]?.sha ?? null)
      .catch(() => null)

    const bundle: Bundle = {
      meta: {
        createdAt: new Date().toISOString(),
        gitSha: gitSha(),
        nodeVersion: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        configPath,
        configOverrides: overrides,
        dbKind: n.db.kind,
        schemaHash,
      },
      environment: {
        credentials: config.models
          .filter((m) => m.apiKeyRef)
          .map((m) => ({ ref: m.apiKeyRef!, present: Boolean(process.env[m.apiKeyRef!]) })),
        providerHealth: await n.router.health.all(),
        mcpServers: (config.mcp ?? []).map((s) => ({
          id: s.id,
          transport: s.transport,
          command: s.command ?? null,
          url: s.url ?? null,
          // envRefs 的 key 保留（说明需要什么），值不含密钥
          envRefs: Object.keys(s.envRefs ?? {}),
        })),
        toolCount: n.tools.size,
        agents: config.agents.map((a) => a.id),
      },
    }

    if (runPrefix) {
      const found = await n.db.query<{ id: string; root_run_id: string }>(
        `select id, root_run_id from runs where id::text like $1 limit 1`,
        [`${runPrefix}%`],
      )
      const hit = found.rows[0]
      if (!hit) {
        line(c.red(`未找到 run ${runPrefix}`))
        return 1
      }

      const rootId = hit.root_run_id
      const tree = await n.db.query(`select * from runs where root_run_id = $1 order by depth, created_at`, [rootId])
      const attempts = await n.db.query(
        `select a.* from run_attempts a join runs r on r.id = a.run_id
          where r.root_run_id = $1 order by a.created_at`,
        [rootId],
      )
      const events = await n.db.query(
        `select e.* from run_events e join runs r on r.id = e.run_id
          where r.root_run_id = $1 order by e.id`,
        [rootId],
      )
      const invocations = await n.db.query(
        `select i.* from tool_invocations i
           join run_attempts a on a.id = i.run_attempt_id
           join runs r on r.id = a.run_id
          where r.root_run_id = $1 order by i.intent_at`,
        [rootId],
      )
      const wakes = await n.db.query(
        `select w.* from wake_records w join runs r on r.id = w.parent_run_id
          where r.root_run_id = $1`,
        [rootId],
      )
      const artifacts = await n.db.query(
        `select a.ref, a.path, a.kind, a.bytes, a.trust_level, a.summary, a.created_at
           from artifacts a join runs r on r.id = a.run_id where r.root_run_id = $1`,
        [rootId],
      )

      // 把出现过的 error_code 连同恢复性一起打包，省去对方查文档
      const codes = new Set<string>()
      for (const row of [...tree.rows, ...attempts.rows]) {
        const code = (row as { error_code?: string }).error_code
        if (code) codes.add(code)
      }
      const errorSpecs: Record<string, unknown> = {}
      for (const code of codes) errorSpecs[code] = errorSpec(code)

      bundle.run = {
        root: tree.rows.find((r) => (r as { id: string }).id === rootId) ?? null,
        tree: tree.rows,
        attempts: attempts.rows,
        events: events.rows,
        toolInvocations: invocations.rows,
        wakes: wakes.rows,
        artifacts: artifacts.rows,
        errorSpecs,
      }
    } else {
      // 没指定 run 就带上最近的失败，通常就是要看的那些
      const recent = await n.db.query(
        `select id, agent_id, status, error_code, error_detail, created_at, ended_at
           from runs
          where status in ('failed','needs_human_confirmation')
          order by created_at desc limit 20`,
      )
      bundle.recentFailures = recent.rows
    }

    // 落盘前统一脱敏 —— 这是唯一的出口，不能绕过
    const json = redactText(JSON.stringify(bundle, null, 2))

    const outPath = resolve(
      typeof flags['out'] === 'string'
        ? flags['out']
        : `diagnostics/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${gitSha() ?? 'nogit'}.json`,
    )
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, json + '\n')

    heading('诊断包')
    line(`${ICON.ok} ${outPath}`)
    line(c.gray(`  ${(json.length / 1024).toFixed(1)} KB · git ${bundle.meta.gitSha ?? '?'} · ${bundle.meta.dbKind}`))
    if (bundle.run) {
      const r = bundle.run
      line(
        c.gray(
          `  ${r.tree.length} run · ${r.attempts.length} attempt · ${r.events.length} 事件 · ${r.toolInvocations.length} 工具调用`,
        ),
      )
    } else {
      line(c.gray(`  最近失败 ${bundle.recentFailures?.length ?? 0} 条（用 --run <id> 可导出单条完整链路）`))
    }
    line()
    line(c.gray('已脱敏，可直接提交。本地复现：nucleus replay <文件>'))
    return 0
  } finally {
    await n.close()
  }
}

/**
 * `nucleus replay` —— 读取诊断包并还原现场。
 *
 * 不重跑模型（那需要相同的 provider 状态），而是把事件流按时间轴重放，
 * 让「它当时为什么那样做」变得可读。
 */
export async function replayCmd(argv: string[], _flags: Record<string, string | true>): Promise<number> {
  const path = argv[0]
  if (!path) {
    line(c.red('用法：nucleus replay <诊断包.json>'))
    return 1
  }

  let bundle: Bundle
  try {
    const { readFile } = await import('node:fs/promises')
    bundle = JSON.parse(await readFile(resolve(path), 'utf8')) as Bundle
  } catch (e) {
    line(c.red(`无法读取诊断包：${(e as Error).message}`))
    return 1
  }

  heading('诊断包')
  const m = bundle.meta
  line(`${c.gray('生成于')} ${m.createdAt}`)
  line(`${c.gray('git')}    ${m.gitSha ?? '(无)'}  ${c.gray('node')} ${m.nodeVersion}  ${c.gray('平台')} ${m.platform}`)
  line(`${c.gray('数据库')} ${m.dbKind}  ${c.gray('schema')} ${m.schemaHash ?? '?'}`)
  line(`${c.gray('配置')}   ${m.configPath ?? '(内置默认)'}${m.configOverrides.length ? ` 覆盖 ${m.configOverrides.join(', ')}` : ''}`)

  heading('环境')
  for (const cred of bundle.environment.credentials) {
    line(`${cred.present ? ICON.ok : ICON.fail} 凭据 ${cred.ref}`)
  }
  line(`${ICON.info} ${bundle.environment.toolCount} 个工具 · agent: ${bundle.environment.agents.join(', ')}`)
  for (const s of bundle.environment.mcpServers as Array<{ id: string; transport: string }>) {
    line(`${ICON.info} MCP ${s.id} (${s.transport})`)
  }

  if (bundle.run) {
    const events = bundle.run.events as Array<{ kind: string; payload: unknown; created_at: string; run_id: string }>
    heading(`时间轴（${events.length} 条）`)
    const t0 = events[0] ? new Date(events[0].created_at).getTime() : 0
    for (const e of events) {
      const dt = new Date(e.created_at).getTime() - t0
      line(
        `${c.gray(String(dt).padStart(7) + 'ms')} ${c.gray(e.run_id.slice(0, 6))} ${e.kind.padEnd(22)} ` +
          c.gray(JSON.stringify(e.payload).slice(0, 80)),
      )
    }

    const unknown = (bundle.run.toolInvocations as Array<{ outcome: string | null; tool_name: string; side_effect_class: string }>).filter(
      (i) => i.outcome === null,
    )
    if (unknown.length) {
      heading('结果未知的工具调用')
      for (const i of unknown) {
        line(`${ICON.warn} ${i.tool_name} ${c.gray(`(${i.side_effect_class})`)}`)
      }
      line(c.gray('non_idempotent 的调用不会被自动重跑 —— 需要人工确认外部副作用是否已发生'))
    }

    const specs = bundle.run.errorSpecs as Record<string, { recovery?: string; message?: string } | null>
    if (Object.keys(specs).length) {
      heading('错误')
      for (const [code, spec] of Object.entries(specs)) {
        line(`${c.red(code)} ${c.gray(spec?.message ?? '')} ${c.gray(`[${spec?.recovery ?? '?'}]`)}`)
      }
    }
  } else if (bundle.recentFailures) {
    heading(`最近失败（${bundle.recentFailures.length}）`)
    for (const f of bundle.recentFailures as Array<{ id: string; agent_id: string; error_code: string }>) {
      line(`${c.gray(f.id.slice(0, 8))} ${f.agent_id.padEnd(14)} ${c.red(f.error_code ?? '')}`)
    }
  }
  return 0
}
