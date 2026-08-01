import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultConfig, type NucleusConfig } from './config.js'
import { GRANTABLE, isPermission } from './runtime/permissions.js'

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
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const path = explicitPath ?? findConfigFile()
  if (!path) return { config: defaultConfig, path: null, overrides: [] }

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

  const { config, overrides } = merge(defaultConfig, parsed)
  validate(config, path)
  return { config, path, overrides }
}

function findConfigFile(): string | null {
  const dir = process.env['NUCLEUS_CONFIG_DIR'] ?? process.cwd()
  if (process.env['NUCLEUS_CONFIG']) return resolve(process.env['NUCLEUS_CONFIG'])
  for (const name of CONFIG_FILENAMES) {
    const p = resolve(dir, name)
    if (existsSync(p)) return p
  }
  return null
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

  // delegate 的目标必须存在，否则编排者会在运行时才发现委派不出去
  for (const a of cfg.agents) {
    if (!(a.permissions ?? []).includes('delegate')) continue
    const targets = cfg.agents.filter((x) => x.id !== a.id)
    if (targets.length === 0) {
      errors.push(`agent ${a.id} 有 delegate 权限，但没有任何可委派的目标 agent`)
    }
  }

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
