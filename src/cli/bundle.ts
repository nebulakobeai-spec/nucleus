import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { boot } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { redactText } from '../auth/credentials.js'
import { errorSpec } from '../errors.js'
import { c, heading, ICON, line, strFlag, resolveDb } from './ui.js'

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
    gitBranch: string | null
    /** 工作区有未提交改动时为 true —— gitSha 与实际运行的代码不一致 */
    gitDirty: boolean
    gitDirtyFiles: string[]
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
    /** 工具的完整目录 —— 只报数量的话看不出模型当时能调什么 */
    tools: unknown[]
    /**
     * agent 的**完整定义**，不是 id 列表。
     *
     * agent 定义决定行为：prompt 正文、权限、结果契约。只给 id 的话，
     * 「专家为什么忽略了验收标准」这类问题完全无从下手 ——
     * 而定义随时在改，事后也重建不出当时那一版。
     */
    agents: unknown[]
    /** 每个 agent 来自哪个文件 */
    agentSources: Record<string, string>
  }
  run?: {
    root: unknown
    tree: unknown[]
    attempts: unknown[]
    events: unknown[]
    toolInvocations: unknown[]
    wakes: unknown[]
    artifacts: unknown[]
    /** 模型被问了什么、答了什么 —— 「为什么那么做」唯一的证据 */
    transcripts: unknown[]
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

function gitBranch(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * 工作区是否有未提交的改动。
 *
 * 部署机允许改代码，但改动没提交时 gitSha 就对不上实际运行的代码 ——
 * 基于诊断包的分析会指向错误的地方。这里如实记录，让读包的人知道。
 */
function gitDirty(): { dirty: boolean; files: string[] } {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!out.trim()) return { dirty: false, files: [] }
    const files = out
      .split('\n')
      .filter((l) => l.length > 3)
      // porcelain 格式是 `XY<space>path`，X/Y 可能是空格 ——
      // 不能先 trim 整行，否则会连状态列一起吃掉路径首字符
      .map((l) => l.slice(3).trim())
      // 诊断包自己和本地数据不算代码漂移
      .filter((f) => f && !f.startsWith('diagnostics/') && !f.startsWith('.nucleus-data'))
    return { dirty: files.length > 0, files }
  } catch {
    return { dirty: false, files: [] }
  }
}

export async function bundleCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const runPrefix = strFlag(flags, 'run') ?? argv[0]
  const { config, path: configPath, overrides, agentSources } = await loadConfig(
    typeof flags['config'] === 'string' ? flags['config'] : undefined,
  )
  const dirty = gitDirty()

  const n = await boot({
    config,
    ...resolveDb(flags),
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
        gitBranch: gitBranch(),
        gitDirty: dirty.dirty,
        gitDirtyFiles: dirty.files,
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
        tools: n.tools.all().map((t) => ({
          name: t.name,
          requires: t.requires,
          sideEffect: t.sideEffect,
          description: t.description.split('\n')[0],
        })),
        agents: config.agents,
        agentSources,
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
        // 按 (attempt, seq) 排序而不是 intent_at —— 同一毫秒内的多次调用
        // 用时间戳排序不稳定，而诊断包的价值全在于重建正确的执行顺序。
        // seq 有 unique(run_attempt_id, seq) 约束，是可靠的序。
        `select i.* from tool_invocations i
           join run_attempts a on a.id = i.run_attempt_id
           join runs r on r.id = a.run_id
          where r.root_run_id = $1
          order by a.created_at, a.attempt_no, i.seq`,
        [rootId],
      )
      const wakes = await n.db.query(
        `select w.* from wake_records w join runs r on r.id = w.parent_run_id
          where r.root_run_id = $1`,
        [rootId],
      )
      // 带上内容。只给元数据的话，「专家产出对不对」根本没法判 ——
      // 而那常常是唯一能看出问题的地方。单条上限 64KB，避免包大到没法传
      const artifacts = await n.db.query(
        `select a.ref, a.path, a.kind, a.bytes, a.sha256, a.trust_level, a.summary, a.created_at,
                left(a.content, 65536) as content,
                (length(a.content) > 65536) as content_truncated
           from artifacts a join runs r on r.id = a.run_id where r.root_run_id = $1`,
        [rootId],
      )

      const transcripts = await n.db.query(
        `select t.* from transcripts t
           join run_attempts a on a.id = t.run_attempt_id
           join runs r on r.id = a.run_id
          where r.root_run_id = $1
          -- depth 作为 tiebreak：同一毫秒内的记录靠时间戳排不稳定，
          -- 而诊断包的价值全在于重建正确的先后
          order by a.created_at, r.depth, a.attempt_no, t.step`,
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
        transcripts: transcripts.rows,
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
    line(
      c.gray(
        `  ${(json.length / 1024).toFixed(1)} KB · git ${bundle.meta.gitSha ?? '?'}` +
          `${bundle.meta.gitBranch ? `@${bundle.meta.gitBranch}` : ''} · ${bundle.meta.dbKind}`,
      ),
    )
    if (dirty.dirty) {
      line()
      line(`${ICON.warn} 工作区有 ${dirty.files.length} 个未提交的改动`)
      line(c.gray(`  ${dirty.files.slice(0, 5).join(', ')}${dirty.files.length > 5 ? ' …' : ''}`))
      line(c.gray('  诊断包里的 git sha 对应的不是实际运行的代码。'))
      line(c.gray('  一并附上 diff 才能让分析可信：git diff > diagnostics/local-changes.patch'))
    }
    if (bundle.run) {
      const r = bundle.run
      line(
        c.gray(
          `  ${r.tree.length} run · ${r.attempts.length} attempt · ${r.events.length} 事件 · ` +
            `${r.toolInvocations.length} 工具调用 · ${r.transcripts.length} 条 transcript · ` +
            `${r.artifacts.length} 个产出`,
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
  line(
    `${c.gray('git')}    ${m.gitSha ?? '(无)'}${m.gitBranch ? `@${m.gitBranch}` : ''}` +
      `  ${c.gray('node')} ${m.nodeVersion}  ${c.gray('平台')} ${m.platform}`,
  )
  if (m.gitDirty) {
    line(
      `${ICON.warn} ${c.yellow('工作区有未提交改动')} ${c.gray(`(${m.gitDirtyFiles?.length ?? 0} 个文件)`)}`,
    )
    line(c.gray(`  ${(m.gitDirtyFiles ?? []).slice(0, 8).join(', ')}`))
    line(c.gray('  上面的 git sha 与实际运行的代码不一致，需要对方提供 diff'))
  }
  line(`${c.gray('数据库')} ${m.dbKind}  ${c.gray('schema')} ${m.schemaHash ?? '?'}`)
  line(`${c.gray('配置')}   ${m.configPath ?? '(内置默认)'}${m.configOverrides.length ? ` 覆盖 ${m.configOverrides.join(', ')}` : ''}`)

  heading('环境')
  for (const cred of bundle.environment.credentials) {
    line(`${cred.present ? ICON.ok : ICON.fail} 凭据 ${cred.ref}`)
  }
  const ags = bundle.environment.agents as Array<{ id: string }>
  line(
    `${ICON.info} ${bundle.environment.tools.length} 个工具 · ` +
      `${ags.length} 个 agent：${ags.map((a) => a.id).join(', ')}`,
  )
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

    // transcript：模型被问了什么、答了什么。
    // 「为什么派给了这个专家」「为什么忽略了验收标准」只有这里答得出
    const ts = (bundle.run.transcripts ?? []) as Array<{
      step: number
      truncated: boolean
      request: { messages?: Array<{ role: string; content: string }>; tools?: string[] }
      response: {
        content?: string
        reasoningChars?: number
        toolCalls?: Array<{ name: string; arguments: string }>
        finishReason?: string
        model?: string
      }
    }>
    if (ts.length) {
      heading(`模型往返（${ts.length} 次）`)
      for (const t of ts) {
        const msgs = t.request.messages ?? []
        line(
          `${c.bold(`step ${t.step}`)} ${c.gray(`${t.response.model ?? '?'} · ${msgs.length} 条消息 · 可用工具 ${(t.request.tools ?? []).join(', ') || '无'}`)}` +
            (t.truncated ? ` ${c.yellow('（已截断）')}` : ''),
        )
        // 最后一条用户消息通常是任务信封或工具结果 —— 最能说明它当时看到了什么
        const last = [...msgs].reverse().find((m) => m.role === 'user' || m.role === 'tool')
        if (last) {
          line(c.gray(`  ← ${last.role}: ${last.content.replace(/\n/g, ' ⏎ ').slice(0, 160)}`))
        }
        if (t.response.content) {
          line(c.gray(`  → ${t.response.content.replace(/\n/g, ' ⏎ ').slice(0, 160)}`))
        }
        if (t.response.reasoningChars) line(c.gray(`  → 思考 ${t.response.reasoningChars} 字`))
        for (const tc of t.response.toolCalls ?? []) {
          line(`  → ${c.cyan(tc.name)}(${c.gray(tc.arguments.replace(/\n/g, ' ').slice(0, 200))})`)
        }
      }
      line()
      line(c.gray('完整内容在包里的 run.transcripts —— 上面只是摘要'))
    }

    // 工具实参：委派信封写得好不好、路径为什么被拦，都要看它
    const invs = bundle.run.toolInvocations as Array<{
      tool_name: string
      args_json?: unknown
      result_text?: string | null
      outcome: string | null
      error_code?: string | null
    }>
    if (invs.some((i) => i.args_json)) {
      heading('工具实参与返回')
      for (const i of invs) {
        line(
          `${i.outcome === 'ok' ? ICON.ok : ICON.fail} ${c.cyan(i.tool_name)}` +
            (i.error_code ? ` ${c.red(i.error_code)}` : ''),
        )
        if (i.args_json) line(c.gray(`  ← ${JSON.stringify(i.args_json).slice(0, 220)}`))
        if (i.result_text) line(c.gray(`  → ${i.result_text.replace(/\n/g, ' ⏎ ').slice(0, 220)}`))
      }
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
