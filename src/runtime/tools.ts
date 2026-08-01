import { createHash } from 'node:crypto'
import { NucleusError } from '../errors.js'
import { permitted, type Permission } from './permissions.js'
import type { SideEffectClass } from '../domain.js'

/**
 * 工具契约。
 *
 * 唯一硬性要求：**注册时必须显式声明 `sideEffect`，无默认值。**
 * 崩溃恢复时的分流、checker 的失败模式、是否需要审批，全部由它推导。
 */

export interface ToolContext {
  runId: string
  attemptId: string
  agentId: string
  /** 本次 run 的工作目录，fs 类工具不得越界 */
  workdir: string
  signal: AbortSignal
  /** 写 artifact；返回 ref */
  writeArtifact(input: {
    path: string
    content: string
    kind?: string
    trustLevel?: 'user' | 'agent' | 'untrusted_tool_output'
    summary?: string
  }): Promise<string>
}

export interface ToolResult {
  ok: boolean
  /** 回灌给模型的内容 */
  content: string
  /** 大输出落盘后的引用 */
  artifactRef?: string
  /** 失败时的 error_code */
  errorCode?: string
  /** 被规则拦下时，回给模型的规则原文（DESIGN.md §6 机制一） */
  rule?: string
  /**
   * 本轮执行到此为止。
   *
   * 用于委派这类「结果不在本轮产生」的工具：agent 不该空转等待，
   * 它的下一次 attempt 由 wake 触发（DESIGN.md §3.5）。
   */
  suspend?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema，转成 provider 的 function-calling 定义 */
  parameters: Record<string, unknown>
  /** 无默认值：不声明则拒绝注册 */
  sideEffect: SideEffectClass
  /**
   * 需要哪些权限才能看到并调用它。
   *
   * 与 sideEffect 正交：权限回答「允许它做吗」，副作用等级回答
   * 「出错了能重跑吗」。空数组表示纯计算、不需要授权。
   */
  requires: Permission[]
  /**
   * 前置检查。返回非 null 即拒绝执行，其内容原样回给模型。
   * 这就是「规则贴在动作旁边」—— 不是搬运，是同一份文本的另一种用途。
   */
  precondition?: (args: unknown, ctx: ToolContext) => Promise<ToolResult | null> | ToolResult | null
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolResult>
  /** 单次执行超时 */
  timeoutMs?: number
  /** 回灌内容的字符上限，超出部分落 artifact */
  maxOutputChars?: number
}

/** 工具输出上限：超出即截断并落盘，避免撑爆 context */
export const DEFAULT_MAX_OUTPUT = 8_000

export class ToolRegistry {
  #tools = new Map<string, ToolDefinition>()

  register(def: ToolDefinition): void {
    if (!def.sideEffect) {
      throw new Error(`工具 ${def.name} 未声明 sideEffect —— 这是必填项`)
    }
    if (this.#tools.has(def.name)) {
      throw new Error(`工具 ${def.name} 重复注册`)
    }
    this.#tools.set(def.name, def)
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)
  }

  /**
   * 按 agent 的能力边界过滤（DESIGN.md §6，T3）。
   *
   * 不在白名单里的工具**根本不会出现在给模型的定义中** ——
   * 模型看不到就无从调用，这比任何 prompt 约束都强。
   */
  /**
   * 某个 agent 能看到的工具。
   *
   * 三道关，顺序固定：
   *   ① **权限**（主关）—— 工具要求的权限必须全部被授予。没授权就看不见，
   *      所以「新接一个会写文件的 MCP 工具」不会静默扩权给任何人。
   *   ② `toolsAllow` 按名字**收窄**（可选）—— 用于「给了 read 权限，但只许用
   *      postgres 那个读，不许读文件」。不填表示不收窄。
   *   ③ `toolsDeny` 排除。
   *
   * 注意 ① 和 ② 是**与**关系而不是或：名字在白名单里但权限没给，依然看不到。
   * 反过来也一样。授权只会更严，不会因为写了名字而放宽。
   */
  forAgent(grants: readonly Permission[], allow?: string[], deny: string[] = []): ToolDefinition[] {
    const denied = new Set(deny)
    return [...this.#tools.values()].filter((t) => {
      if (denied.has(t.name)) return false
      if (!permitted(grants, t.requires)) return false
      if (!allow || allow.length === 0) return true
      return allow.includes('*') || allow.includes(t.name) || allow.some((p) => matchGlob(p, t.name))
    })
  }

  /** 工具因为缺哪些权限而不可见 —— 诊断用 */
  missingPermissions(grants: readonly Permission[], toolName: string): Permission[] {
    const t = this.#tools.get(toolName)
    if (!t) return []
    return t.requires.filter((r) => !grants.includes(r))
  }

  get size(): number {
    return this.#tools.size
  }
}

export function matchGlob(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$')
  return re.test(name)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 参数指纹：循环检测与幂等键都用它 */
export function hashArgs(name: string, args: unknown): string {
  return createHash('sha256').update(name).update(JSON.stringify(args ?? null)).digest('hex').slice(0, 16)
}

/** 解析模型给的参数字符串。解析失败是常态，要给模型可操作的反馈。 */
export function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (e) {
    return { ok: false, error: `参数不是合法 JSON：${(e as Error).message}` }
  }
}

/** 大输出截断：头尾保留，中间省略，全文落 artifact */
export function truncateOutput(
  text: string,
  max = DEFAULT_MAX_OUTPUT,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const head = Math.floor(max * 0.6)
  const tail = max - head - 80
  return {
    text:
      text.slice(0, head) +
      `\n\n…… [已截断 ${text.length - head - tail} 字符，全文见 artifact] ……\n\n` +
      text.slice(-tail),
    truncated: true,
  }
}

export function toolError(code: string, message: string): ToolResult {
  const e = new NucleusError(code, message)
  return { ok: false, content: e.message, errorCode: code }
}
