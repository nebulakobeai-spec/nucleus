/**
 * 规则注册表。
 *
 * 为什么需要它：规则 id 原本是散落在各个 precondition 里的字符串字面量，
 * 于是「这个系统有哪些规则」这个问题**答不出来** —— 只能靠触发一次才知道
 * 某条规则存在。写不出清单，也就谈不上讨论要不要加、要不要改。
 *
 * 这里只做两件事：给每条规则一个可枚举的声明，以及让引用处不再手写字符串
 * （拼错会静默变成一条谁也不认识的规则）。
 *
 * 分层对应 DESIGN.md 的规则层级：
 *  - `capability`：T3 能力边界。不在白名单里的工具模型根本看不到 ——
 *    最强的一层，因为它不依赖模型配合。
 *  - `precondition`：调用前拒绝。模型能看到工具，但参数不合规就被拦下，
 *    并收到明确原因（被拒的调用视为**从未发生**，不留意图记录）。
 *  - `postcondition`：结果契约。提交的结果缺字段就退回让它重写。
 *
 * 三层的共同点是**都由运行时强制**，不靠模型「记得」。写在 prompt 里的
 * 软规则不在这里 —— 那种规则无法验证，也就无法统计遵守率。
 */

export type RuleScope = 'capability' | 'precondition' | 'postcondition'

export interface RuleSpec {
  id: string
  scope: RuleScope
  /** 一句话说清它禁止什么 */
  what: string
  /** 谁在强制它 —— 出问题时直接知道去哪看 */
  enforcedBy: string
  /** 是否可由配置调整 */
  configurable: string | null
}

/** 引用处用这些常量而不是手写字符串 */
export const RULE = {
  fsWorkdirBoundary: 'fs.workdir-boundary',
  delegateKnownAgent: 'delegate.known-agent',
  delegateMaxDepth: 'delegate.max-depth',
  delegateMaxFanout: 'delegate.max-fanout',
} as const

export const RULES: readonly RuleSpec[] = [
  {
    id: RULE.fsWorkdirBoundary,
    scope: 'precondition',
    what: '文件路径必须是工作目录内的相对路径，拒绝绝对路径与 .. 穿越',
    enforcedBy: 'read_file / write_file 的 precondition',
    configurable: null,
  },
  {
    id: RULE.delegateKnownAgent,
    scope: 'precondition',
    what: '只能委派给配置里存在的 agent',
    enforcedBy: 'delegate 的 precondition',
    configurable: 'agents',
  },
  {
    id: RULE.delegateMaxDepth,
    scope: 'precondition',
    what: '委派链深度到顶后不再往下派，改为自己完成或直接提交',
    enforcedBy: 'delegate 的 precondition',
    configurable: 'defaults.maxDelegationDepth',
  },
  {
    id: RULE.delegateMaxFanout,
    scope: 'precondition',
    what: '一棵任务树的 run 总数到顶后不再派新任务',
    enforcedBy: 'delegate 的 precondition',
    configurable: 'defaults.maxRunsPerRoot',
  },
]

const BY_ID = new Map(RULES.map((r) => [r.id, r]))

export function ruleSpec(id: string): RuleSpec | null {
  return BY_ID.get(id) ?? null
}
