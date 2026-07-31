import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import type { RunStore } from '../store/runs.js'
import { toolError, type ToolDefinition, type ToolRegistry } from './tools.js'

/**
 * 内建工具。
 *
 * 每个都显式声明 `sideEffect` —— 这决定崩溃恢复时的分流：
 * `non_idempotent` 的调用一旦结果未知，绝不自动重跑。
 */

/** 路径必须落在 workdir 内。目录穿越是最基本的一道防线（§8）。 */
function safeJoin(workdir: string, p: string): string | null {
  if (isAbsolute(p)) return null
  const full = normalize(join(workdir, p))
  const rel = relative(workdir, full)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return full
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取工作目录下的文件',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对工作目录的路径' } },
    required: ['path'],
  },
  sideEffect: 'pure',
  precondition: (args, ctx) => {
    const p = (args as { path?: string }).path
    if (!p) return toolError('tool.denied', '缺少 path 参数')
    if (!safeJoin(ctx.workdir, p)) {
      return {
        ok: false,
        content: '路径必须是工作目录内的相对路径，不允许绝对路径或 .. 穿越。',
        rule: 'fs.workdir-boundary',
        errorCode: 'tool.denied',
      }
    }
    return null
  },
  execute: async (args, ctx) => {
    const full = safeJoin(ctx.workdir, (args as { path: string }).path)!
    try {
      return { ok: true, content: await readFile(full, 'utf8') }
    } catch (e) {
      return toolError('tool.not_found', `读取失败：${(e as Error).message}`)
    }
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '写入文件到工作目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的路径' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  // 同路径同内容重写结果一致 → idempotent
  sideEffect: 'idempotent',
  precondition: (args, ctx) => {
    const p = (args as { path?: string }).path
    if (!p) return toolError('tool.denied', '缺少 path 参数')
    if (!safeJoin(ctx.workdir, p)) {
      return {
        ok: false,
        content: '路径必须是工作目录内的相对路径，不允许绝对路径或 .. 穿越。',
        rule: 'fs.workdir-boundary',
        errorCode: 'tool.denied',
      }
    }
    return null
  },
  execute: async (args, ctx) => {
    const a = args as { path: string; content: string }
    const full = safeJoin(ctx.workdir, a.path)!
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, a.content, 'utf8')
    const ref = await ctx.writeArtifact({ path: a.path, content: a.content })
    return { ok: true, content: `已写入 ${a.path}（${a.content.length} 字符），artifact: ${ref}`, artifactRef: ref }
  },
}

export const writeReportTool: ToolDefinition = {
  name: 'write_report',
  description: '写一份报告并登记为产出',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string', description: 'Markdown 正文' },
    },
    required: ['title', 'content'],
  },
  sideEffect: 'idempotent',
  execute: async (args, ctx) => {
    const a = args as { title: string; content: string }
    const slug = a.title.replace(/[^\w一-鿿-]+/g, '-').slice(0, 40)
    const ref = await ctx.writeArtifact({
      path: `reports/${slug}.md`,
      content: `# ${a.title}\n\n${a.content}`,
      summary: a.title,
    })
    return { ok: true, content: `报告已保存：${ref}`, artifactRef: ref }
  },
}

/**
 * 委派：编排者唯一的动作。
 *
 * 关键：子 run **不传 conversationId** —— 它没有对外身份，
 * 结构上不可能把结果直发给用户。
 */
export function delegateTool(store: RunStore, allowedAgents: string[]): ToolDefinition {
  return {
    name: 'delegate',
    description: `把一件事委派给专家。可选专家：${allowedAgents.join(', ')}`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: allowedAgents },
        task: { type: 'string', description: '给专家的完整任务描述，包含必要上下文与验收标准' },
      },
      required: ['agent', 'task'],
    },
    sideEffect: 'idempotent',
    precondition: (args) => {
      const a = args as { agent?: string }
      if (!a.agent || !allowedAgents.includes(a.agent)) {
        return {
          ok: false,
          content: `未知专家 ${a.agent}。可选：${allowedAgents.join(', ')}`,
          rule: 'delegate.known-agent',
          errorCode: 'tool.denied',
        }
      }
      return null
    },
    execute: async (args, ctx) => {
      const a = args as { agent: string; task: string }
      const parent = await store.getRun(ctx.runId)
      const child = await store.createRun({
        agentId: a.agent,
        parentRunId: ctx.runId,
        rootRunId: parent?.rootRunId ?? ctx.runId,
        depth: (parent?.depth ?? 0) + 1,
        input: { task: a.task },
        // 注意：没有 conversationId
      })
      await store.enqueueAttempt(child.id)
      return {
        ok: true,
        content: `已委派给 ${a.agent}（run ${child.id}）。本轮到此结束，专家完成后你会被唤醒并收到结果。`,
        // 结果不在本轮产生 —— 不要空转等待
        suspend: true,
      }
    },
  }
}

/** 演示用的搜索工具：无网络时返回占位结果 */
export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索网络',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  sideEffect: 'pure',
  execute: async (args) => {
    const q = (args as { query: string }).query
    return {
      ok: false,
      content: `本环境无网络访问，无法搜索「${q}」。请基于已有信息作答，并在 open_questions 中说明缺口。`,
      errorCode: 'tool.not_found',
    }
  },
}

export function registerBuiltins(
  registry: ToolRegistry,
  opts: { store: RunStore; delegateTargets: string[] },
): void {
  registry.register(readFileTool)
  registry.register(writeFileTool)
  registry.register(writeReportTool)
  registry.register(webSearchTool)
  registry.register(delegateTool(opts.store, opts.delegateTargets))
}
