#!/usr/bin/env node
import { ask, boot, type Nucleus } from '../boot.js'
import { defaultConfig, isMockOnly, type NucleusConfig } from '../config.js'
import { withExampleAgents } from '../examples/agents.js'
import { loadEnvFile } from '../env.js'
import { chatLoop } from './chat.js'
import { printRunList, printRunTree, printTurn, runTurn } from './turn.js'
import { recoveryOf } from '../errors.js'
import type { MockScript } from '../providers/mock.js'
import { authList, authLogin, authLogout, authRefresh, authTest, credentialStatus } from './auth.js'
import { mcpCall, mcpEnable, mcpList, mcpTools } from './mcp.js'
import { agentList, agentMap, agentShow } from './agent.js'
import { agentNew } from './agent-new.js'
import { agentTry } from './agent-try.js'
import { artifactCat, artifactList } from './artifact.js'
import { providersCmd } from './providers.js'
import { rulesCmd } from './rules.js'
import { ScheduleStore } from '../store/schedules.js'
import { findStuckRuns, findUnknownToolOutcomes } from '../runtime/stuck.js'
import { convCompact, convList, convSeed, convShow, convSummary } from './conv.js'
import {
  scheduleAdd,
  scheduleHistory,
  scheduleList,
  scheduleRm,
  scheduleToggle,
} from './schedule.js'
import { bundleCmd, replayCmd } from './bundle.js'
import { findConfigFile, loadConfig } from '../config-file.js'
import { c, duration, heading, ICON, line, money, parseArgv, recoveryHint, statusColor, table, strFlag, resolveConversationId, unknownFlags } from './ui.js'

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
/**
 * 演示脚本。
 *
 * **按实际存在的专家生成**，不能写死。原来硬编码派给 `researcher` ——
 * 于是任何自定义了专家的项目里 `nucleus ask --mock` 都会被
 * `delegate.known-agent` 拦下，而那看起来像 bug 而不是脚本过期。
 *
 * 编排者第 1 次 attempt 只做委派 —— 委派后 worker 会 arm wake 并结束本轮，
 * 编排者**不保持活着**。子 run 终态时同事务唤醒，第 2 次 attempt 才整合。
 * 这正是真实模型该有的行为节奏。
 *
 * 专家那边不写脚本：mock 会照着 submit_result 的 schema 合成一份满足契约的
 * 结果，所以任何专家（包括声明了 requiredFields 的）都能跑完。
 */
function demoScript(config: NucleusConfig): MockScript {
  const expert = config.agents.find((a) => a.id !== config.defaults.entryAgent)
  const entry = config.defaults.entryAgent

  if (!expert) {
    // 没有专家时编排者直接作答 —— 这也是全新安装的正常状态
    return {
      [entry]: [{ submit: { status: 'ok', summary: '（mock）还没有专家，我直接作答。', artifacts: [] } }],
    }
  }

  // 专家有 artifact 权限时让它写一份报告 —— verify 要验「完整内容进 artifact」
  // 这条链路。没有该权限的专家就跳过，不能假定所有项目的专家都能出产物。
  const canWrite = (expert.permissions ?? []).includes('artifact')
  return {
    ...(canWrite
      ? {
          [expert.id]: [
            {
              tool: {
                name: 'write_report',
                args: {
                  title: 'mock 演示报告',
                  content: '## 结论\n（mock）可行。\n\n## 依据\n见来源。',
                },
              },
            },
            // 第二轮不写脚本 —— 走 schema 合成，任何契约都能满足
          ],
        }
      : {}),
    [entry]: [
      {
        text: '这件事需要专业判断，我委派给专家。',
        tool: {
          name: 'delegate',
          args: {
            agent: expert.id,
            goal: '按你的职责处理用户这次的请求',
            context:
              '用户只给了一句话需求，没有更多约束；本机没有配外部服务，用已有知识作答。',
            acceptance: '给出结论与依据；完整内容写成 artifact 后在 artifacts 中引用。',
            why: `${expert.id} 的职责范围覆盖这件事`,
          },
        },
      },
      // ↓ 被 wake 唤醒后的第 2 次 attempt
      {
        submit: {
          status: 'ok',
          summary: `（mock）已整合 ${expert.id} 的结果。`,
          artifacts: [],
        },
      },
    ],
  }
}

async function open(flags: Record<string, string | true>): Promise<Nucleus> {
  const dbUrl = strFlag(flags, 'db') ?? process.env['NUCLEUS_DATABASE_URL'] ?? null
  const dataDir = strFlag(flags, 'data') ?? process.env['NUCLEUS_PGLITE_DIR'] ?? null
  const useMock = flags['mock'] === true || !!flags['mock'] || process.env['NUCLEUS_MOCK'] === '1'

  const { config: loaded, path: configPath } = await loadConfig(
    typeof flags['config'] === 'string' ? flags['config'] : undefined,
  )
  const config = { ...loaded }

  /**
   * 没找到配置文件时**必须说出来**。
   *
   * `nucleus` 是全局命令，从项目外的目录跑它是完全正常的用法 —— 那时配置
   * 静默失效，回落到内置默认（只有 mock）。原来的症状链是：
   *
   *   run 失败 → provider.unreachable → 「检查 baseUrl 与 DNS」
   *
   * 而真正的原因是「你不在项目目录里」。现在配置发现会逐级向上找，
   * 但真的找不到时也要在第一行就讲清楚，而不是让人去查 DNS。
   */
  if (!configPath && !useMock) {
    line(
      `${ICON.warn} ${c.yellow('没找到 nucleus.config.json')}` +
        c.gray(`（从 ${process.cwd()} 逐级向上找过）`),
    )
    line(c.gray('  正在用内置默认配置 —— 里面**只有 mock 模型**，跑不出真实结果。'))
    line(c.gray('  在项目目录里跑，或者用 --config <路径> / NUCLEUS_CONFIG 指定。'))
    line()
  }
  if (flags['model']) {
    const chain = String(flags['model']).split(',')
    config.defaults = { ...config.defaults, modelChain: chain }
  }
  if (useMock) {
    // --mock 必须同时改模型链，不能只换 HTTP 拦截。
    // 否则配置里写的是 ollama:gemma4:31b，屏幕上也显示它服务了这一轮，
    // 而实际答话的是 mock —— 且「回答是假的」的警告不会触发，
    // 因为那个判断看的是模型链。显示与事实不符比没有显示更糟。
    const MOCK = 'mock:local'
    config.defaults = { ...config.defaults, modelChain: [MOCK] }
    if (!config.models.some((m) => m.key === MOCK)) {
      config.models = [
        ...config.models,
        {
          key: MOCK,
          provider: 'mock',
          model: 'mock',
          baseUrl: 'http://mock.invalid/v1',
          billing: 'usage',
          costPerMTokIn: 0,
          costPerMTokOut: 0,
        },
      ]
    }
  }

  return boot({
    config,
    databaseUrl: dbUrl,
    dataDir: dbUrl ? null : (dataDir ?? '.nucleus-data/pglite'),
    ...(useMock ? { mock: demoScript(config) } : {}),
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
    const { config, tools } = n

    /**
     * **配置文件的实际路径。** 这条要排在前面。
     *
     * 「配了但没被读到」是最省时间的一条自检：nucleus 是全局命令，从项目外
     * 的目录跑它会静默回落到内置默认（只有 mock），而症状是 run 报
     * provider.unreachable + 「检查 DNS」—— 指向完全错误的方向。
     */
    const found = findConfigFile()
    checks.push({
      name: '配置文件',
      ok: found !== null,
      detail:
        found ??
        `没找到（从 ${process.cwd()} 逐级向上找过）—— 正在用内置默认，只有 mock 模型`,
    })

    // 模型链：没配真实模型时会静默落到 mock，回答是假的
    checks.push({
      name: '模型链',
      ok: !isMockOnly(config),
      detail: isMockOnly(config)
        ? `只有 mock（回答是假的）—— cp nucleus.config.example.json nucleus.config.json`
        : config.defaults.modelChain.join(' → '),
    })

    // 还没有专家时提示一句 —— 不是错误，但值得知道编排者现在会自己作答
    const experts = config.agents.filter((a) => a.id !== config.defaults.entryAgent)
    if (experts.length === 0) {
      checks.push({
        name: '专家 agent',
        ok: true,
        detail: '还没有 —— 编排者会直接作答。加一个：nucleus agent new <id>',
      })
    } else {
      checks.push({ name: '专家 agent', ok: true, detail: experts.map((a) => a.id).join(', ') })
    }

    // toolsAllow 引用了不存在的工具时，模型只是「看不到」它，没有任何报错 ——
    // 拼错工具名或 MCP 没连上都会这样，必须显式报出来
    for (const a of config.agents) {
      const missing = (a.toolsAllow ?? []).filter((t) => !t.includes('*') && !tools.get(t))
      if (missing.length) {
        checks.push({
          name: `agent ${a.id} 的工具`,
          ok: false,
          detail: `toolsAllow 里有未注册的工具：${missing.join(', ')}（MCP 工具名形如 server__tool）`,
        })
      }
    }
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

    /**
     * 定时任务。
     *
     * 指向已删掉的 agent 的计划会每天产出一个 `config.agent_not_found` 的
     * failed run —— 有痕迹，但**没人会去看**：定时任务没有人在旁边等结果，
     * 症状只是「产出不再出现」。所以它必须出现在自检里，而不是等人想起来翻。
     */
    try {
      const scheds = await new ScheduleStore(n.db, n.deps).list()
      const known = new Set(n.config.agents.map((a) => a.id))
      const orphans = scheds.filter((x) => !known.has(x.agentId))
      if (orphans.length) {
        checks.push({
          name: '定时任务的 agent',
          ok: false,
          detail:
            orphans.map((o) => `${o.name} → 不存在的「${o.agentId}」`).join('；') +
            '（每次触发都会产出 config.agent_not_found 的失败 run）',
        })
      }
      const enabled = scheds.filter((x) => x.enabled)
      if (scheds.length) {
        const next = enabled
          .map((x) => x.nextFireAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime())[0]
        checks.push({
          name: '定时任务',
          ok: true,
          detail:
            `${enabled.length}/${scheds.length} 启用` +
            (next ? ` · 最近一次 ${next.toISOString().slice(0, 16).replace('T', ' ')}Z` : '') +
            // 最常见的困惑：加了计划但什么都没发生
            ' · 需要有 worker 在跑才会执行',
        })
      }
    } catch {
      // schedules 表还没 migrate —— migrate 那条检查会说
    }

    /**
     * **有 run 挂住了吗。** 这条是这个项目存在的理由本身。
     *
     * 判据不是「队列必须空」—— `waiting_retry` 的 run 队列里本来就该有一条
     * 未来才可执行的记录。真正的故障形状是：非终态，但既没有排队、
     * 也没有在等还活着的子 run。
     */
    const stuck = await findStuckRuns(n.db)
    checks.push({
      name: '悬挂的 run',
      ok: stuck.length === 0,
      detail:
        stuck.length === 0
          ? '没有'
          : stuck
              .map(
                (s) =>
                  `${s.id.slice(0, 8)} ${s.agentId}(${s.status})` +
                  `${s.lastErrorCode ? ` ${s.lastErrorCode}` : ''}`,
              )
              .join('；') + ' —— 既没排队也没在等子 run，不会自己恢复',
    })

    // non_idempotent 的未知结果是「绝不能自动重跑」的那一类，必须人来定
    const unknownTools = await findUnknownToolOutcomes(n.db)
    if (unknownTools.length) {
      const risky = unknownTools.filter((x) => x.sideEffectClass === 'non_idempotent')
      checks.push({
        name: '结果未知的工具调用',
        ok: false,
        detail:
          `${unknownTools.length} 条（${risky.length} 条 non_idempotent）：` +
          unknownTools.slice(0, 3).map((x) => `${x.toolName} in ${x.runId.slice(0, 8)}`).join('、') +
          (risky.length ? ' —— non_idempotent 的绝不会自动重跑，需要你确认是否已生效' : ''),
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

async function chatCmd(flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    const requested = strFlag(flags, 'conv')
    let conversationId: string | null = null
    if (requested) {
      const r = await resolveConversationId(n.db, requested)
      if ('error' in r) {
        line(c.red(r.error))
        return 1
      }
      conversationId = r.id
    }
    return await chatLoop(n, {
      conversationId,
      modelChain:
        typeof flags['model'] === 'string' ? String(flags['model']).split(',').map((x) => x.trim()) : null,
    })
  } finally {
    await n.close()
  }
}

async function askCmd(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const text = argv.join(' ')
  if (!text) {
    line(c.red('用法：nucleus ask "你的问题" [--mock] [--conv <id>]'))
    line(c.gray('  连续对话用 nucleus chat'))
    return 1
  }

  const n = await open(flags)
  try {
    const requested = strFlag(flags, 'conv')
    let resolved: string | null = null
    if (requested) {
      const r = await resolveConversationId(n.db, requested)
      if ('error' in r) {
        line(c.red(r.error))
        return 1
      }
      resolved = r.id
    }
    const convId =
      resolved ??
      (await n.conversations.create({
        // 与 chat 同一个来源 —— 过去这里硬编码 orchestrator、chat 取 agents[0]，
        // 同一份配置两条命令的入口 agent 不同
        agentId: n.config.defaults.entryAgent,
        title: text.slice(0, 40),
      })).id

    // 与 chat 的提示符一致：一眼能认出「这是我问的那句」
    line()
    line(`${c.cyan(ICON.prompt)} ${text}`)
    line(c.gray(`  会话 ${convId.slice(0, 8)}`))
    if (isMockOnly(n.config)) {
      line(`  ${ICON.warn} ${c.yellow('mock 模型，回答是假的')} ${c.gray('· 配置真实模型见 nucleus.config.example.json')}`)
    }
    line()

    // 与 chat 共用同一套渲染，避免两条命令的输出漂移
    const result = await runTurn(n, convId, text)
    const tree = await n.runs.tree(result.runId)
    printTurn(result, { runCount: tree.length })

    line(c.gray(`详情：nucleus runs ${result.runId.slice(0, 8)}`))
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
      await printRunList(n)
      return 0
    }
    if (!(await printRunTree(n, prefix))) {
      line(c.red(`未找到 run ${prefix}`))
      return 1
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
  // verify 是离线冒烟，需要一个专家才能验完整的委派链路。
  // 示例专家不在 defaultConfig 里 —— 专家由用户定义
  const cfg = withExampleAgents(defaultConfig)
  const n = await boot({ config: cfg, mock: demoScript(cfg) })
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
  chat                交互式 REPL，连续对话（推荐）
  ask <文本>          一次性对话，脚本友好
  runs [id 前缀]      列出 run / 查看 run 树
  events <id 前缀>    查看 timeline

${c.bold('agent 与规则')}
  agent list                  列出 agent：模型链、工具数、必填字段
  agent show <id>             看模型实际收到的 system prompt 与结果契约
  agent map                   能力边界矩阵：谁能用哪些工具
  agent new <id>              生成专家定义骨架（含写法说明）
  agent try <id> [任务]        只跑这一个专家：--n 重复、--compare 与旧版并排
  rules                       规则遵守率：谁不听哪条规则
  conv list                   会话列表：消息数与压缩代数
  conv show <id>              摘要内容 + 压缩历史（丢了什么只有人能判）
  conv compact <id>           现在就压一次（--dry-run 只判定）
  conv seed --turns 15        造一段合成历史用来测 compact（埋好已知约束）
  schedule list               定时任务：下次什么时候跑
  schedule add <名称>          加一个：--cron "30 8 * * *" --agent <id> --goal "…"
  schedule history <名称>      每次触发的结果，含被跳过的那些与原因
  providers [log]             provider 层：熔断、失败、跳过原因、用量
  artifact list [run]         产出清单
  artifact cat <路径>         读产出内容

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
  nucleus chat
  nucleus chat --model zai:glm-5.2
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

  /**
   * 认不出的参数要报出来。
   *
   * 不致命（脚本里可能带着无害的多余参数），但**必须可见** ——
   * 打错的参数静默生效过一次：`nucleus runs --bundle <id>` 里 `--bundle`
   * 把 id 吃掉当了自己的值，于是列出了全部 run，看起来像「这个 run 不见了」。
   * 解析已经改成未知参数不吃值，这里再补一句提醒。
   */
  const unknown = unknownFlags(flags)
  if (unknown.length) {
    line(
      `${ICON.warn} ${c.yellow(`未知参数：${unknown.map((f) => '--' + f).join(' ')}`)}` +
        c.gray('（已忽略）'),
    )
    // 最常见的成因是把子命令写成了参数
    for (const f of unknown) {
      if (['bundle', 'replay', 'events', 'schedule', 'artifact'].includes(f)) {
        line(c.gray(`  ${f} 是子命令不是参数：nucleus ${f} …`))
      }
    }
  }

  switch (cmd) {
    case 'ask':
      return askCmd(rest, flags)
    case 'chat':
      return chatCmd(flags)
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
    case 'agent': {
      const sub = rest[0]
      const args = rest.slice(1)
      switch (sub) {
        case 'list':
        case 'ls':
        case undefined:
          return agentList(args, flags)
        case 'show':
          return agentShow(args, flags)
        case 'map':
          return agentMap(args, flags)
        case 'new':
          return agentNew(args, flags)
        case 'try':
          return agentTry(args, flags)
        default:
          // 省一步：nucleus agent researcher 等价于 agent show researcher
          return agentShow(rest, flags)
      }
    }
    case 'artifact':
    case 'artifacts': {
      const sub = rest[0]
      const args = rest.slice(1)
      switch (sub) {
        case 'cat':
        case 'show':
          return artifactCat(args, flags)
        case 'list':
        case 'ls':
        case undefined:
          return artifactList(args, flags)
        default:
          // nucleus artifact <路径片段> 等价于 cat
          return artifactCat(rest, flags)
      }
    }
    case 'conv':
    case 'convs':
    case 'conversation': {
      const sub = rest[0]
      const args = rest.slice(1)
      switch (sub) {
        case 'list':
        case 'ls':
        case undefined:
          return convList(args, flags)
        case 'show':
          return convShow(args, flags)
        case 'compact':
          return convCompact(args, flags)
        case 'seed':
          return convSeed(args, flags)
        case 'summary':
          return convSummary(args, flags)
        default:
          // nucleus conv <id 前缀> 等价于 show
          return convShow(rest, flags)
      }
    }
    case 'schedule':
    case 'schedules':
    case 'cron': {
      const sub = rest[0]
      const args = rest.slice(1)
      switch (sub) {
        case 'list':
        case 'ls':
        case undefined:
          return scheduleList(args, flags)
        case 'add':
        case 'new':
          return scheduleAdd(args, flags)
        case 'rm':
        case 'remove':
        case 'del':
          return scheduleRm(args, flags)
        case 'enable':
          return scheduleToggle(args, flags, true)
        case 'disable':
          return scheduleToggle(args, flags, false)
        case 'history':
        case 'log':
          return scheduleHistory(args, flags)
        default:
          // nucleus schedule <名称> 等价于 history
          return scheduleHistory(rest, flags)
      }
    }
    case 'providers':
    case 'provider':
      return providersCmd(rest, flags)
    case 'rules':
      return rulesCmd(rest, flags)
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

// 启动即加载 .env —— 部署时不必每次 source。
// 已存在的环境变量优先，容器注入的值不会被文件覆盖。
loadEnvFile()

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
