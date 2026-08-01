import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { envelopeJsonSchema, envelopeSizes, validateEnvelope } from './envelope.js'
import { RULE } from './rules.js'
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
  requires: ['read'],
  sideEffect: 'pure',
  precondition: (args, ctx) => {
    const p = (args as { path?: string }).path
    if (!p) return toolError('tool.denied', '缺少 path 参数')
    if (!safeJoin(ctx.workdir, p)) {
      return {
        ok: false,
        content: '路径必须是工作目录内的相对路径，不允许绝对路径或 .. 穿越。',
        rule: RULE.fsWorkdirBoundary,
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
  requires: ['write'],
  sideEffect: 'idempotent',
  precondition: (args, ctx) => {
    const p = (args as { path?: string }).path
    if (!p) return toolError('tool.denied', '缺少 path 参数')
    if (!safeJoin(ctx.workdir, p)) {
      return {
        ok: false,
        content: '路径必须是工作目录内的相对路径，不允许绝对路径或 .. 穿越。',
        rule: RULE.fsWorkdirBoundary,
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
  // artifact 而不是 write：路径由它自己拼（slug 正则把 / 和 . 都替换掉）、
  // 只写 artifacts 表不落盘，所以和「写文件」是两类效果。
  // 单独一项的用处是编排者拿不到它 —— 它该整合而非自己写报告。
  requires: ['artifact'],
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
export interface DelegateLimits {
  /** 委派链最大深度；编排者为 0 */
  maxDepth: number
  /** 一棵 run 树的总 run 数上限 */
  maxRunsPerRoot: number
}

/**
 * 委派工具。
 *
 * 两道闸门都在 precondition 里 —— 被拒的调用**从未发生**，不留意图记录，
 * 模型收到明确原因后可以改成自己做或直接 submit。这比让 run 失败更好：
 * 委派不下去不代表任务做不成。
 */
/** 可委派的目标：id 加一句「什么时候派给它」 */
export interface DelegateTarget {
  id: string
  whenToUse?: string | undefined
}

export function delegateTool(
  store: RunStore,
  targets: DelegateTarget[],
  limits: DelegateLimits,
): ToolDefinition {
  const allowedAgents = targets.map((t) => t.id)
  /**
   * 把每个专家的适用场景写进工具描述。
   *
   * 只给 id 列表时，编排者只能靠名字猜派给谁 —— 加一个 `reviewer`
   * 或两个相近的专家就会派错。选路依据必须写在模型看得见的地方。
   */
  const roster = targets
    .map((t) => `  - ${t.id}${t.whenToUse ? `：${t.whenToUse}` : ''}`)
    .join('\n')

  return {
    name: 'delegate',
    description:
      targets.length === 0
        ? '把一件事委派给专家。当前没有可委派的专家。'
        : `把一件事委派给专家。可选专家：\n${roster}`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: allowedAgents, description: '专家 id，见上方清单' },
        ...envelopeJsonSchema(),
        why: {
          type: 'string',
          description:
            '为什么选这个专家（一句话）。它不会传给专家 —— 只用于事后核对' +
            '「派得对不对」，所以写你真实的判断依据。',
        },
      },
      required: ['agent', 'goal', 'context', 'acceptance', 'why'],
    },
    requires: ['delegate'],
    sideEffect: 'idempotent',
    precondition: async (args, ctx) => {
      const a = args as { agent?: string }
      if (!a.agent || !allowedAgents.includes(a.agent)) {
        return {
          ok: false,
          content: `未知专家 ${a.agent}。可选：${allowedAgents.join(', ')}`,
          rule: RULE.delegateKnownAgent,
          errorCode: 'tool.denied',
        }
      }

      // 信封必须自足：专家看不到会话历史，这里漏了它就无从得知。
      // 挡在 precondition 而不是靠工具描述劝导 —— 被拒的调用视为从未发生，
      // 模型收到缺了哪一项后补上重来即可。
      const problems = validateEnvelope(args)
      if (problems.length) {
        return {
          ok: false,
          content:
            `任务信封不完整：\n${problems.map((p) => `- ${p.message}`).join('\n')}\n` +
            `专家看不到这段对话，信封里没写的它一概不知道。`,
          rule: RULE.delegateEnvelope,
          errorCode: 'tool.denied',
        }
      }

      const parent = await store.getRun(ctx.runId)
      const depth = (parent?.depth ?? 0) + 1
      if (depth > limits.maxDepth) {
        return {
          ok: false,
          content:
            `委派深度已达上限 ${limits.maxDepth}，不能再往下派。` +
            `请自己完成剩下的部分，或用现有信息 submit_result。`,
          rule: RULE.delegateMaxDepth,
          errorCode: 'tool.denied',
        }
      }

      // 扇出上限按整棵树算 —— 只看单轮的话，多轮累加照样会爆
      const rootId = parent?.rootRunId ?? ctx.runId
      const total = await store.countRunsInTree(rootId)
      if (total >= limits.maxRunsPerRoot) {
        return {
          ok: false,
          content:
            `这棵任务树已有 ${total} 个子任务，达到上限 ${limits.maxRunsPerRoot}。` +
            `请合并剩下的工作或直接 submit_result。`,
          rule: RULE.delegateMaxFanout,
          errorCode: 'tool.denied',
        }
      }
      return null
    },
    execute: async (args, ctx) => {
      const a = args as { agent: string; goal: string; context: string; acceptance: string; why?: string }
      const parent = await store.getRun(ctx.runId)
      const child = await store.createRun({
        agentId: a.agent,
        parentRunId: ctx.runId,
        rootRunId: parent?.rootRunId ?? ctx.runId,
        depth: (parent?.depth ?? 0) + 1,
        // 只存信封三段。why 不进 —— 它是「派给谁」的推理，
        // 对干活的专家无关，写进去还可能带偏它
        input: { goal: a.goal, context: a.context, acceptance: a.acceptance },
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

/**
 * 为什么这里**没有** web_search。
 *
 * 曾经有一个内置的 `web_search`，它永远失败并回答「本环境无网络访问」——
 * 那是开发沙箱的事实，不是运行 Nucleus 的机器的事实，把它写进产品是错的。
 *
 * 更根本的问题是：一个注册了却必然失败的工具，等于向模型宣告一个不存在的
 * 能力。实测代价不小 —— 真实 GLM-5.2 因此连续调用了 6 次搜索
 * （第一批 4 个并行，读懂失败后仍要「再确认」2 次），烧掉 12 步预算里的 3 步。
 *
 * 搜索属于 MCP 的范围（DESIGN.md：MCP 的部署与运行归用户，Nucleus 只负责连接）。
 * 配了搜索类 MCP，工具就会以 `server__tool` 的名字出现；没配就**不出现**，
 * 模型看不到也就不会去试。这才是 T3 能力边界该有的样子。
 */

export function registerBuiltins(
  registry: ToolRegistry,
  opts: { store: RunStore; delegateTargets: DelegateTarget[]; delegateLimits: DelegateLimits },
): void {
  registry.register(readFileTool)
  registry.register(writeFileTool)
  registry.register(writeReportTool)
  registry.register(delegateTool(opts.store, opts.delegateTargets, opts.delegateLimits))
}
