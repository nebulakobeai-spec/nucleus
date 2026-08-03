import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defaultConfig, type NucleusConfig } from './config.js'
import { resolveModels } from './providers/registry.js'
import { DEFAULT_AGENTS_DIR, loadAgentFiles } from './config/agent-files.js'
import { GRANTABLE, isPermission } from './runtime/permissions.js'
import { validateResultFields } from './runtime/result-schema.js'

/**
 * 配置文件加载。
 *
 * 分层：`defaultConfig`（代码内基线）← `nucleus.config.json`（部署机可改）
 *
 * 为什么要有文件而不是只用 TS 配置：部署机的规矩是**不改代码**
 * （见 RUNBOOK）。配置写在源码里就意味着「改配置 = 改代码 = 重新构建」，
 * 那条规矩就形同虚设，两边代码也会漂移。
 */

export const CONFIG_FILENAMES = ['nucleus.config.json', 'nucleus.config.jsonc']

export interface LoadedConfig {
  config: NucleusConfig
  /** 实际使用的文件；null 表示纯用内置默认 */
  path: string | null
  /** 覆盖了哪些顶层键，doctor 展示用 */
  overrides: string[]
  /** 每个 agent 来自哪 —— 两种来源并存时，「这个 agent 哪来的」必须答得出 */
  agentSources: Record<string, string>
  /** agents/ 目录里的试题集 */
  cases: Record<string, string[]>
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const path = explicitPath ?? findConfigFile()
  if (!path) {
    // 没有配置文件也要读 agents/ —— 否则「只用 md 定义专家」这条路走不通
    const merged = mergeAgentFiles(defaultConfig, agentsDir(defaultConfig))
    validate(merged.config, '(内置默认)')
    return { config: merged.config, path: null, overrides: [], ...merged.meta }
  }

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    throw new Error(`无法读取配置文件 ${path}：${(e as Error).message}`)
  }

  let parsed: Partial<NucleusConfig>
  try {
    parsed = JSON.parse(stripJsonComments(raw)) as Partial<NucleusConfig>
  } catch (e) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${(e as Error).message}`)
  }

  // agents 只能来自 agents/*.md —— 两种来源意味着两条代码路径、
  // 两个出问题时要看的地方，而那个「来源」列本身就是歧义的补丁。
  // 拒绝而不是静默忽略：静默忽略会让人以为配置生效了。
  if (parsed.agents) {
    throw new Error(
      `配置文件 ${path} 里不能定义 agents —— 专家改用 agents/*.md，一个专家一个文件。\n` +
        `  迁移：${(parsed.agents as Array<{ id?: string }>).map((a) => a.id ?? '?').join(', ')}\n` +
        `  每个跑一次：nucleus agent new <id>，然后把 identity 正文与字段搬进去\n` +
        `  （正文即 prompt，不必再写成 \\n 转义串）`,
    )
  }
  const { config, overrides } = merge(defaultConfig, parsed)
  /**
   * `providers` + `models` → 扁平的 ModelConfig[]。
   *
   * 分层是**配置**要的（别让人把 baseUrl / apiKeyRef 抄四遍），扁平是**运行时**
   * 要的（router 拿到一个模型就该知道往哪发）。这一行就是那道边界。
   *
   * 旧写法（模型上直接写 baseUrl、没有 providers 段）照旧有效 —— resolveModels
   * 的规则是「provider 提供默认，模型上写了就覆盖」，不是二选一。
   */
  const resolved = resolveModels(
    config.providers ?? {},
    config.models as unknown as Parameters<typeof resolveModels>[1],
  )
  if (resolved.problems.length) {
    throw new Error(
      `配置文件 ${path} 的 models 有问题：\n` +
        resolved.problems.map((p) => `  ${p.key}：${p.message}`).join('\n'),
    )
  }
  config.models = resolved.models

  const merged = mergeAgentFiles(config, agentsDir(config))
  validate(merged.config, path)
  return { config: merged.config, path, overrides, ...merged.meta }
}

function agentsDir(cfg: NucleusConfig): string {
  return process.env['NUCLEUS_AGENTS_DIR'] ?? cfg.agentsDir ?? DEFAULT_AGENTS_DIR
}

/**
 * 把 `agents/*.md` 合并进配置。
 *
 * **文件优先于 JSON**：同 id 时以文件为准。理由是文件是更专门的表达方式，
 * 而且「我明明改了 agents/x.md 却没生效」比反过来更难排查。
 * 冲突会在 agentSources 里显示成文件路径，所以不会是无声的。
 */
function mergeAgentFiles(
  cfg: NucleusConfig,
  dir: string,
): { config: NucleusConfig; meta: { agentSources: Record<string, string>; cases: Record<string, string[]> } } {
  const sources: Record<string, string> = {}
  const cases: Record<string, string[]> = {}
  // 区分「内置默认」与「你的配置文件」—— 它们是两回事：
  // 前者编译进代码（将来会被移除，见 BACKLOG A8），后者是你写的
  // 只有两种来源了：内置兜底与 md 文件
  for (const a of cfg.agents) sources[a.id] = '(内置)'

  const { files, errors } = loadAgentFiles(dir)
  if (errors.length) {
    throw new Error(
      `agents/ 里有 ${errors.length} 个文件解析失败：\n` +
        errors.map((e) => `  · ${e.path}：${e.message}`).join('\n'),
    )
  }
  if (files.length === 0) return { config: cfg, meta: { agentSources: sources, cases } }

  const byId = new Map(cfg.agents.map((a) => [a.id, a]))
  for (const f of files) {
    byId.set(f.agent.id, f.agent)
    sources[f.agent.id] = f.path
    if (f.cases.length) cases[f.agent.id] = f.cases
  }
  return {
    config: { ...cfg, agents: [...byId.values()] },
    meta: { agentSources: sources, cases },
  }
}

/**
 * 找配置文件：**从当前目录逐级向上**，到文件系统根为止。
 *
 * 原来只看 cwd 一层。而 `nucleus` 是 npm link 到 PATH 的全局命令，
 * 所以从项目子目录、或者从 home 目录跑它是完全正常的用法 ——
 * 那时配置**静默失效**，回落到内置默认（只有 mock），然后：
 *
 *   run 失败 → provider.unreachable → 提示「检查 baseUrl 与 DNS」
 *
 * 而真正的原因是「配置文件没找到」。一个正确的报错指向错误的方向，
 * 比没有报错更费时间。git / npm / tsconfig 都是向上搜的，照做。
 */
export function findConfigFile(from = process.env['NUCLEUS_CONFIG_DIR'] ?? process.cwd()): string | null {
  if (process.env['NUCLEUS_CONFIG']) return resolve(process.env['NUCLEUS_CONFIG'])

  let dir = resolve(from)
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const p = resolve(dir, name)
      if (existsSync(p)) return p
    }
    const parent = dirname(dir)
    // dirname('/') === '/' —— 到根了
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 浅合并 + 数组整体替换。
 *
 * 数组不做深合并是有意的：`models`、`agents`、`mcp` 用「替换」语义更可预期 ——
 * 「我列了 3 个 MCP server」应该就是 3 个，而不是和默认的合并出意外结果。
 */
function merge(
  base: NucleusConfig,
  override: Partial<NucleusConfig>,
): { config: NucleusConfig; overrides: string[] } {
  const overrides: string[] = []
  const out = { ...base } as unknown as Record<string, unknown>

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    overrides.push(key)
    const existing = out[key]
    if (Array.isArray(value)) {
      out[key] = value
    } else if (typeof value === 'object' && value !== null && typeof existing === 'object' && existing !== null) {
      out[key] = { ...(existing as object), ...value }
    } else {
      out[key] = value
    }
  }
  return { config: out as unknown as NucleusConfig, overrides }
}

/**
 * 启动前校验。
 *
 * 目标是把配置错误挡在启动阶段，而不是等到某个 run 跑一半才炸 ——
 * 后者的错误信息会指向完全无关的地方。
 */
function validate(cfg: NucleusConfig, path: string): void {
  const errors: string[] = []
  const modelKeys = new Set(cfg.models.map((m) => m.key))

  if (cfg.models.length === 0) errors.push('models 不能为空')

  for (const m of cfg.models) {
    // baseUrl 走到这里应该已经由 resolveModels 从 provider 补齐了。
    // 还缺就说明既没有 providers[x] 也没在模型上写 —— 那条错误更具体，
    // 已经在 resolveModels 里给出了
    if (!m.key || !m.baseUrl) errors.push(`模型 ${m.key || '(无 key)'} 缺少 key 或 baseUrl`)
  }

  // ollama:* 动态解析，不要求预先声明（见 config.ts 的 dynamicOllamaModel）
  const knownModel = (k: string) => modelKeys.has(k) || k.startsWith('ollama:')

  for (const chainKey of cfg.defaults.modelChain) {
    if (!knownModel(chainKey)) {
      errors.push(`defaults.modelChain 引用了不存在的模型 ${chainKey}`)
    }
  }

  const agentIds = new Set<string>()
  for (const a of cfg.agents) {
    if (agentIds.has(a.id)) errors.push(`agent id 重复：${a.id}`)
    agentIds.add(a.id)
    if (!a.identity?.trim()) errors.push(`agent ${a.id} 缺少 identity`)
    // permissions 是主关；toolsAllow 只是可选的收窄
    if (a.permissions !== undefined && !Array.isArray(a.permissions)) {
      errors.push(`agent ${a.id} 的 permissions 必须是数组`)
    }
    for (const p of a.permissions ?? []) {
      if (!isPermission(p)) {
        errors.push(`agent ${a.id} 声明了未知权限「${p}」（可用：${GRANTABLE.join(', ')}）`)
      }
      // 哨兵权限存在的意义就是没人能拿到它
      if (p === 'unclassified') {
        errors.push(
          `agent ${a.id} 不能授予 unclassified —— 它是未分类 MCP 工具的哨兵，` +
            `要让某个工具可见请在 mcpPolicies.permissions 里给它分类`,
        )
      }
    }
    if (a.toolsAllow !== undefined && !Array.isArray(a.toolsAllow)) {
      errors.push(`agent ${a.id} 的 toolsAllow 必须是数组`)
    }
    // 结果字段声明写错时应当启动就报 —— 否则要等某个 run 提交结果时
    // 才发现生成出来的 schema 是坏的，而那时错误信息指向的是模型
    for (const p of validateResultFields(a.resultFields)) {
      errors.push(`agent ${a.id} 的 resultFields.${p.field}：${p.message}`)
    }
    for (const chainKey of a.modelChain ?? []) {
      if (!knownModel(chainKey)) {
        errors.push(`agent ${a.id} 的 modelChain 引用了不存在的模型 ${chainKey}`)
      }
    }
  }

  // 入口 agent 必须存在。这条校验的由来是一个真实的坑：
  // `agents` 是**整体替换**语义，所以在配置里只写一个新专家会把内置的
  // orchestrator 一起删掉 —— 而配置本身完全合法、doctor 全绿，
  // 直到每个任务都以 runtime.internal 失败。错误必须在启动时就报出来。
  if (!agentIds.has(cfg.defaults.entryAgent)) {
    errors.push(
      `defaults.entryAgent 指向不存在的 agent「${cfg.defaults.entryAgent}」` +
        `（现有：${[...agentIds].join(', ') || '无'}）。` +
        `注意 agents 是整体替换而非合并 —— 在配置里列出 agents 就必须把入口 agent 一起列上`,
    )
  }

  // 「有 delegate 权限但没有目标」**不是错误** —— 全新安装还没定义专家时
  // 就是这个状态，编排者直接作答是正确行为。delegate 工具在无目标时不注册，
  // 所以模型也看不到它。doctor 会把这件事作为提示报出来。

  const mcpIds = new Set<string>()
  for (const s of cfg.mcp ?? []) {
    if (mcpIds.has(s.id)) errors.push(`MCP server id 重复：${s.id}`)
    mcpIds.add(s.id)
    if (s.transport === 'stdio' && !s.command) errors.push(`MCP ${s.id} 是 stdio 但缺少 command`)
    if (s.transport === 'http' && !s.url) errors.push(`MCP ${s.id} 是 http 但缺少 url`)
    // 密钥必须走 ref —— 直接写在 env 里会进 git
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (/key|token|secret|password/i.test(k) && v) {
        errors.push(`MCP ${s.id} 的 env.${k} 疑似明文密钥，请改用 envRefs 引用凭据`)
      }
    }
  }

  if (errors.length) {
    throw new Error(`配置文件 ${path} 校验失败：\n${errors.map((e) => `  · ${e}`).join('\n')}`)
  }
}

/** 支持 // 与 /* *\/ 注释，方便在配置里写说明 */
export function stripJsonComments(s: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const next = s[i + 1]

    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += s[++i] ?? ''
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out
}
