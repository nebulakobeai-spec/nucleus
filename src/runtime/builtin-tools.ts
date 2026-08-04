import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { envelopeJsonSchema, validateEnvelope } from './envelope.js'
import { RULE } from './rules.js'
import type { UserRule } from './user-rules.js'
import type { NucleusConfig } from '../config.js'
import {
  configureModelTool,
  createAgentTool,
  createRuleTool,
  type ConfigPaths,
} from './config-tools.js'
import { renderAgentMd } from '../cli/agent-propose.js'

/**
 * 复用 `agent-propose` 的渲染器 —— **不写第二份**。
 *
 * 两份渲染同一种文件的代码必然漂：加一个 frontmatter 键时要改两处，
 * 漏掉一处的症状是「工具生成的 agent 少了一半信息」，而且不报错。
 * （rule 那边就踩过一次，我把树自己那份删了。）
 */
function renderAgentMdFor(id: string, p: Record<string, unknown>): string {
  return renderAgentMd(id, {
    identity: String(p['identity'] ?? ''),
    whenToUse: String(p['whenToUse'] ?? ''),
    permissions: (p['permissions'] as string[]) ?? [],
    ...(p['requiredFields'] ? { requiredFields: p['requiredFields'] as string[] } : {}),
    ...(p['resultFields'] ? { resultFields: p['resultFields'] as never } : {}),
  } as never)
}
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
    description: `把一件事委派给专家。可选专家：\n${roster}`,
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

/**
 * 按需读一条规则的正文。
 *
 * ── 为什么必须有这个工具 ────────────────────────────────
 *
 * 真实的规则是文档，不是一两句话：实测一份规则集 18 个文件共 28k token，
 * 单个最大 7k。而末尾约束块的预算只有 ~2000 token（131k 窗口）——
 * 全塞进去会被**静默砍半**，而砍半的文档比没有更糟：前半段读起来像完整的规则，
 * 后半段（往往正是例外与反例）不见了，且不报错。
 *
 * 所以长规则在约束块里只留一行**索引 + 触发条件**（「创建文件前必读」），
 * 正文靠这个工具取。28k 压成 1k 左右的常驻成本。
 *
 * ── 为什么不需要权限 ──────────────────────────────────
 *
 * 它读的是**约束这个 agent 自己的规则**。如果索引行说了「详见 read_rule(x)」
 * 却拿不到，那条规则就等于不存在 —— 指向空处的索引比没有索引更糟。
 * 所以它是无条件可用的，和 submit_result 同一类。
 */
export function readRuleTool(rules: UserRule[]): ToolDefinition {
  const byId = new Map(rules.map((r) => [r.id, r]))
  return {
    name: 'read_rule',
    description:
      '读一条规则的完整正文。末尾约束块里只有索引行时，用它取全文。' +
      `可取的规则：${rules.map((r) => r.id).join(', ') || '（无）'}`,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          // enum 让模型不必猜。为空时上层不注册这个工具，所以这里一定非空
          enum: rules.map((r) => r.id),
          description: '规则 id（约束块里那行括号内写着）',
        },
      },
      required: ['id'],
    },
    requires: [],
    sideEffect: 'pure',
    execute: async (args) => {
      const id = String((args as { id?: unknown }).id ?? '')
      const r = byId.get(id)
      if (!r) {
        // 报错要列出可取的 —— 「没有这条规则」让模型无从下一步
        return {
          ok: false,
          content: `没有规则「${id}」。可取的：${[...byId.keys()].join(', ') || '（无）'}`,
        }
      }
      return { ok: true, content: `# 规则 ${r.id}\n\n${r.constraint ?? '（这条规则没有正文）'}` }
    },
  }
}

/**
 * 会话追加口 —— `ask_user` 只需要这一个动作。
 *
 * 用结构类型而不是 import ConversationStore：builtin-tools 已经只依赖
 * RunStore，再拉进一个具体的 store 类会让工具层和存储层缠在一起，
 * 而这里要的其实只是「能把一句话写给用户」。
 */
export interface ConversationAppender {
  append(input: {
    conversationId: string
    // 只需要 assistant —— 这个工具就是「agent 对用户说话」
    role: 'assistant'
    content: string
    runId?: string | null
    meta?: Record<string, unknown>
  }): Promise<unknown>
}

/**
 * `ask_user` —— 编排者反问用户。
 *
 * ── 为什么之前没有这个工具 ────────────────────────────
 *
 * `user` 权限（「直接向用户提问」）从一开始就声明了，而**没有任何工具用它** ——
 * 又一处「声明了但没接线」。后果是需求含糊时编排者只能猜，而猜错要跑完整条
 * 委派链才看得出来。
 *
 * ── 与 delegate 同构 ────────────────────────────────
 *
 * 工具只做两件事：把问题写进会话、记一条 waiting 的 wake。
 * **run 状态不在这里改** —— 工具是在 attempt 执行中调用的，此刻改状态会与
 * attempt 的生命周期打架。挂起由 worker 在收尾时做（`#suspendIfWaiting`），
 * 和「委派了子 run 就挂起等它们」走同一条路径。
 *
 * 于是 attempt 正常终结、逻辑 run 转 `waiting_user`、**不占进程不占 context**。
 * 等人回答可能要几小时，让一个进程挂着等是不可接受的。
 *
 * ── 只有对外入口能用 ────────────────────────────────
 *
 * `requires: ['user']`，而默认只有 entryAgent 有这个权限。子 run 没有
 * conversation（只有 root run 有对外身份），所以专家问出来的话根本没有
 * 收件人 —— 那种调用要在这里挡掉，而不是让它静默消失。
 */
export function askUserTool(store: RunStore, conversations: ConversationAppender): ToolDefinition {
  return {
    name: 'ask_user',
    description:
      '向用户提一个问题，等他回答之后再继续。\n' +
      '**需求含糊时先问，别猜** —— 猜错要等整条委派链跑完才看得出来。\n' +
      '一次只问一件事；问完这一轮就结束，用户回答后你会带着答案继续。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            '要问的那一件事，用用户的语言问。问具体的歧义（「你说的 X 指的是 A 还是 B？」），' +
            '不要问「你想怎么做」—— 那是把你的活推回去。',
        },
        why: {
          type: 'string',
          description: '为什么这一点影响你接下来怎么做。一句话，让用户知道值不值得回答。',
        },
      },
      required: ['question'],
    },
    requires: ['user'],
    // 幂等：同一个问题重复问一次不会改变外部世界（唯一索引会挡住第二条记录）
    sideEffect: 'idempotent',
    precondition: async (args, ctx) => {
      const q = String((args as { question?: unknown }).question ?? '').trim()
      if (!q) {
        return {
          ok: false,
          content: 'question 不能为空。没有要问的就不要调这个工具。',
          errorCode: 'tool.denied',
        }
      }
      const run = await store.getRun(ctx.runId)
      if (!run?.conversationId) {
        /**
         * 子 run 没有 conversation —— 问出来没有收件人。
         *
         * 挡在这里而不是让它静默成功：一个「问了但没人看见」的提问会让
         * run 永远停在 waiting_user，而日志里看起来一切正常。
         */
        return {
          ok: false,
          content:
            '你不是对外入口，问出来的话没有收件人（只有 root run 关联会话）。\n' +
            '需求不清时把它写进 open_questions 交回上级，由它决定要不要问用户。',
          errorCode: 'tool.denied',
        }
      }
      if (await store.pendingQuestion(ctx.runId)) {
        // 一个 run 只能有一条待答的提问；用户的下一句只能回答一个
        return {
          ok: false,
          content: '你已经有一个问题在等回答了。一次只问一件事。',
          errorCode: 'tool.denied',
        }
      }
      return null
    },
    execute: async (args, ctx) => {
      const a = args as { question?: string; why?: string }
      const question = String(a.question ?? '').trim()
      const why = a.why?.trim()
      const run = await store.getRun(ctx.runId)
      const conversationId = run!.conversationId!

      // 先写会话：这条 assistant 消息是用户真正看到的东西
      await conversations.append({
        conversationId,
        role: 'assistant',
        content: why ? `${question}
（${why}）` : question,
        runId: ctx.runId,
        meta: { askUser: true },
      })
      await store.armUserWake({
        runId: ctx.runId,
        agentId: ctx.agentId,
        conversationId,
        question,
      })
      return {
        ok: true,
        /**
         * **`suspend` 才是让本轮停下的东西，不是下面那句话。**
         *
         * 我第一版只返回了那段文本（「这一轮到此结束，不要再调用其它工具」）——
         * 而实测 gemma4 照样接着调了两次模型，最后以
         * `contract.postcondition_failed` 收尾。
         *
         * 那正是这个项目要修的第一个毛病，被我犯在自己的代码里：
         * **机制就在手边（delegate 一直用着 `suspend: true`），而我写了一句劝告。**
         * 提醒是三层里最弱的一层 —— 对模型如此，对我自己写的工具也一样。
         *
         * 文本留着，但它现在只是解释「为什么停了」，不再负责让它停。
         */
        suspend: true,
        content:
          '已经问了用户。这一轮到此结束 —— 用户回答之后你会带着答案重新开始。',
      }
    },
  }
}

export function registerBuiltins(
  registry: ToolRegistry,
  opts: {
    store: RunStore
    delegateTargets: DelegateTarget[]
    delegateLimits: DelegateLimits
    /** 正文按需加载的规则。为空时**不注册** read_rule —— 宣告一个空能力没有意义 */
    indexedRules?: UserRule[]
    /** 会话追加口 —— ask_user 要用它把问题写给用户。没有就不注册那个工具 */
    conversations?: ConversationAppender
    /**
     * 改配置的三个工具往哪写。没给就不注册它们 ——
     * 给一个必然写错位置的工具，比不给更糟。
     */
    configPaths?: ConfigPaths
    /** 校验要拿**当前**配置，不是 boot 时的快照 —— 期间可能已经加过 agent */
    currentConfig?: () => NucleusConfig
  },
): void {
  registry.register(readFileTool)
  registry.register(writeFileTool)
  registry.register(writeReportTool)
  // 没有按需规则时不注册 —— 与 delegate 同一个理由：给一个必然空手而回的工具
  // 等于宣告一个不存在的能力
  if (opts.indexedRules?.length) registry.register(readRuleTool(opts.indexedRules))
  // 没有可委派目标时**不注册** delegate。
  // 两个理由：`enum: []` 不是有意义的 JSON Schema（部分 provider 会拒）；
  // 而全新安装还没定义专家时，编排者直接作答才是正确行为 ——
  // 给它一个必然失败的工具等于宣告一个不存在的能力（和当初那个假
  // web_search 同一个错）。
  // 只有拿到会话入口时才注册 —— 没有它这个工具无处投递
  if (opts.conversations) registry.register(askUserTool(opts.store, opts.conversations))
  /**
   * 改配置的三个工具。都要 `configure` 权限，而默认只有入口 agent 有 ——
   * 所以专家看不到它们（工具不出现在它看到的定义里，那是边界层）。
   */
  if (opts.configPaths && opts.currentConfig) {
    registry.register(createRuleTool(opts.configPaths, opts.currentConfig))
    registry.register(createAgentTool(opts.configPaths, opts.currentConfig, renderAgentMdFor))
    registry.register(configureModelTool(opts.configPaths))
  }
  if (opts.delegateTargets.length > 0) {
    registry.register(delegateTool(opts.store, opts.delegateTargets, opts.delegateLimits))
  }
}


/**
 * 内置工具名 —— 供**配置加载期**的校验用。
 *
 * 为什么不在运行时用完整注册表校验：MCP 工具要连上 server 才知道名字，
 * 而规则校验必须在启动就做完（一条引用了拼错工具名的规则**不会报错**，
 * 只会让那层 T3 形同虚设）。MCP 工具名带 `__`，用 `server__*` 通配符写
 * 就绕过校验 —— 那是刻意留的口子。
 */
export const BUILTIN_TOOL_NAMES = [
  'read_file',
  'write_file',
  'write_report',
  'delegate',
  'read_rule',
]
