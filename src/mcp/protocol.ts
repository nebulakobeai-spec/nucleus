/**
 * MCP（Model Context Protocol）类型定义。
 *
 * 只覆盖 Nucleus 需要的子集：initialize / tools/list / tools/call。
 * resources 与 prompts 暂不实现 —— 工具是 agent 唯一真正需要的能力。
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18'

// ── JSON-RPC 2.0 ─────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification

// ── MCP 语义 ─────────────────────────────────────────────

export interface McpServerInfo {
  name: string
  version: string
}

export interface McpInitializeResult {
  protocolVersion: string
  capabilities: { tools?: Record<string, unknown>; resources?: unknown; prompts?: unknown }
  serverInfo: McpServerInfo
}

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpToolsListResult {
  tools: McpTool[]
  nextCursor?: string
}

/** tools/call 的返回内容块 */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name?: string; description?: string }

export interface McpToolCallResult {
  content: McpContent[]
  /** true 表示工具本身报错（区别于协议层错误） */
  isError?: boolean
  structuredContent?: unknown
}

// ── 传输层 ───────────────────────────────────────────────

export interface McpTransport {
  /** 发起请求并等待响应 */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
  /** 单向通知，不等回复 */
  notify(method: string, params?: unknown): Promise<void>
  close(): Promise<void>
  readonly alive: boolean
}

// ── 配置 ─────────────────────────────────────────────────

export interface McpServerConfig {
  id: string
  transport: 'stdio' | 'http'
  /** stdio */
  command?: string
  args?: string[]
  /** 值从凭据存储解析；config 里只写 ref */
  envRefs?: Record<string, string>
  /** 直接的环境变量（非密钥） */
  env?: Record<string, string>
  cwd?: string
  /** http */
  url?: string
  headers?: Record<string, string>
  /** 单次调用超时 */
  timeoutMs?: number
  /** 连续失败多少次后自动禁用 */
  failureThreshold?: number
  enabled?: boolean
}

/**
 * 把 MCP 工具名映射为全局唯一名。
 *
 * 多个 server 必然撞名（两个 `search`），所以一律加 server 前缀。
 * 双下划线是约定：OpenAI 的 function name 只允许 [a-zA-Z0-9_-]。
 */
export function qualifiedName(serverId: string, toolName: string): string {
  return `${sanitize(serverId)}__${sanitize(toolName)}`
}

export function parseQualifiedName(name: string): { serverId: string; toolName: string } | null {
  const i = name.indexOf('__')
  if (i < 0) return null
  return { serverId: name.slice(0, i), toolName: name.slice(i + 2) }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}
