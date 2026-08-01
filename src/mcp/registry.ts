import type { SideEffectClass } from '../domain.js'
import { matchGlob, toolError, type ToolDefinition, type ToolRegistry } from '../runtime/tools.js'
import { UNCLASSIFIED, type Permission } from '../runtime/permissions.js'
import type { McpClient, ResolvedMcpTool } from './client.js'
import { renderContent } from './client.js'

/**
 * MCP 工具 → Nucleus 工具注册。
 *
 * 关键问题：**MCP 协议不声明副作用等级**，但 Nucleus 的崩溃恢复完全依赖它
 * （DESIGN.md §3.2）。所以必须由配置显式声明，不能猜。
 *
 * 默认值的选择是安全侧：未声明的一律按 `non_idempotent` 处理 ——
 * 宁可在崩溃后要求人工确认，也不要自动重发一封邮件。
 */

export interface McpToolPolicy {
  /** 精确匹配 `server__tool`，或 glob 如 `searxng__*` */
  pattern: string
  sideEffect: SideEffectClass
}

export interface McpRegisterOptions {
  /** 副作用声明，按顺序匹配，先命中先用 */
  policies?: McpToolPolicy[]
  /**
   * 权限声明，按顺序匹配。
   *
   * MCP 协议不表达权限，所以必须在这里映射。**没有匹配到任何一条的工具
   * 会要求哨兵权限 `unclassified`，任何 agent 都授予不了它** ——
   * 也就是说未分类的 MCP 工具一律不可见。
   *
   * fail-closed 是刻意的：默认可见等于每接一个 server 就静默扩权一次，
   * 而 server 什么时候新增了一个会写文件的工具，你不会收到通知。
   */
  permissions?: Array<{ pattern: string; requires: Permission[] }>
  /** 未匹配任何规则时的默认值 */
  fallback?: SideEffectClass
  timeoutMs?: number
  maxOutputChars?: number
}

/**
 * 常见只读工具的命名模式。
 *
 * 这些**只是默认值**，任何有副作用的工具都应在 config 中显式声明。
 * 保守起见只覆盖名字里明确表达"读"的那些。
 */
export const READONLY_PATTERNS = [
  '*__search*',
  '*__get_*',
  '*__list_*',
  '*__read_*',
  '*__fetch*',
  '*__query*',
  '*__describe_*',
]

export function classifySideEffect(
  toolName: string,
  opts: McpRegisterOptions = {},
): { sideEffect: SideEffectClass; reason: string } {
  for (const p of opts.policies ?? []) {
    if (globMatch(p.pattern, toolName)) {
      return { sideEffect: p.sideEffect, reason: `匹配策略 ${p.pattern}` }
    }
  }
  for (const p of READONLY_PATTERNS) {
    if (globMatch(p, toolName)) {
      return { sideEffect: 'pure', reason: `名称匹配只读模式 ${p}` }
    }
  }
  // 安全侧默认：不知道就当有不可逆副作用
  return {
    sideEffect: opts.fallback ?? 'non_idempotent',
    reason: '未声明，按不可幂等处理（崩溃后需人工确认）',
  }
}

/** 按 pattern 匹配出工具需要的权限；没匹配到就要求哨兵（不可授予） */
export function classifyPermissions(name: string, opts: McpRegisterOptions): Permission[] {
  for (const p of opts.permissions ?? []) {
    if (matchGlob(p.pattern, name)) return p.requires
  }
  return UNCLASSIFIED
}

export function mcpToolDefinition(
  tool: ResolvedMcpTool,
  client: McpClient,
  opts: McpRegisterOptions = {},
): ToolDefinition {
  const { sideEffect } = classifySideEffect(tool.name, opts)

  const def: ToolDefinition = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sideEffect,
    requires: classifyPermissions(tool.name, opts),
    execute: async (args) => {
      try {
        const res = await client.call(tool.name, args, opts.timeoutMs)
        const text = renderContent(res)
        // MCP 用 isError 表达"工具自己失败了"，区别于协议层错误
        return res.isError
          ? { ok: false, content: text, errorCode: 'tool.crashed' }
          : { ok: true, content: text }
      } catch (e) {
        const err = e as { code?: string; message?: string }
        return toolError(err.code ?? 'mcp.server_unavailable', err.message ?? String(e))
      }
    },
  }

  if (opts.timeoutMs !== undefined) def.timeoutMs = opts.timeoutMs
  if (opts.maxOutputChars !== undefined) def.maxOutputChars = opts.maxOutputChars
  return def
}

export interface RegisterResult {
  registered: string[]
  skipped: Array<{ name: string; reason: string }>
  /** schema 归一化时的降级提示 */
  warnings: Array<{ tool: string; warnings: string[] }>
  /** 副作用分级明细，供 doctor 展示 */
  classification: Array<{ tool: string; sideEffect: SideEffectClass; reason: string }>
}

export function registerMcpTools(
  registry: ToolRegistry,
  tools: ResolvedMcpTool[],
  client: McpClient,
  opts: McpRegisterOptions = {},
): RegisterResult {
  const out: RegisterResult = { registered: [], skipped: [], warnings: [], classification: [] }

  for (const t of tools) {
    if (registry.get(t.name)) {
      out.skipped.push({ name: t.name, reason: '名称已被占用' })
      continue
    }
    const cls = classifySideEffect(t.name, opts)
    try {
      registry.register(mcpToolDefinition(t, client, opts))
      out.registered.push(t.name)
      out.classification.push({ tool: t.name, ...cls })
      if (t.warnings.length) out.warnings.push({ tool: t.name, warnings: t.warnings })
    } catch (e) {
      out.skipped.push({ name: t.name, reason: (e as Error).message })
    }
  }
  return out
}

function globMatch(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name
  const re = new RegExp('^' + pattern.split('*').map(esc).join('.*') + '$')
  return re.test(name)
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
