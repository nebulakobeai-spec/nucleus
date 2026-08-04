/**
 * 权限（能力）。
 *
 * 与工具是**两件正交的事**：
 *
 *   工具  = 具体能调的东西（`read_file`、`postgres__query`、`searxng__search`）
 *   权限  = 允许做哪一类事（读、写、执行、出网、派活）
 *
 * 为什么要分开，而不是继续用工具名白名单：
 *
 * 1. **工具主要来自 MCP，名字不由我们决定。** 接一个 20 个工具的 server，
 *    按名字授权就要在每个 agent 里列 20 行；用 `server__*` 通配则等于
 *    “这个 server 以后新增的任何工具都自动授予”——包括写和执行。
 * 2. **按名字授权会静默扩权。** 新增一个会写文件的工具，只要名字匹配了
 *    某条通配，所有匹配到的 agent 立刻获得写能力，配置里看不出任何变化。
 * 3. **意图表达在错误的层次。** 你想说的是「这个 agent 不许写任何东西」，
 *    而不是「这个 agent 不许用 write_file、write_report、fs__write、
 *    postgres__insert…」——后者永远列不全。
 *
 * 所以：**工具声明自己需要什么权限，agent 授予权限。** 新工具接进来时，
 * 没有相应权限的 agent 自动看不到它，配置一个字都不用改。
 *
 * 与 `side_effect_class` 也是正交的，两者回答不同问题：
 *   权限     ——「允许它做吗？」（授权）
 *   副作用等级 ——「出错了能重跑吗？」（恢复）
 * 一个工具可以是 `read` 权限但 `non_idempotent`（比如一次性消费的读取），
 * 也可以是 `write` 权限但 `idempotent`（按主键覆盖写）。
 */
export const PERMISSIONS = [
  'read',
  'write',
  /**
   * 登记产出（artifact）。
   *
   * 与 write 分开是因为它是**另一类效果**：只写 artifacts 表，不碰文件系统，
   * 路径由工具自己构造，逃不出这次 run。
   *
   * 分开的实际用处是编排者：它该整合而不该自己写报告。若把产出算成
   * 「不需要权限」，编排者就会看到 write_report，那句「你自己不执行具体
   * 工作、一律委派」就只剩 prompt 在支撑了。
   */
  'artifact',
  'execute',
  'network',
  'delegate',
  'user',
  /**
   * 改配置：写 `rules/*.md`、`agents/*.md`、往 `nucleus.config.json` 加模型。
   *
   * ── 为什么单独一个权限，不复用 `write` ──────────────────
   *
   * `write` 是「在这次 run 的工作目录里写文件」—— 路径由工具构造，逃不出去。
   * 而改配置是**改运行时自己**：加一条规则会改变所有 agent 的结果契约，
   * 加一个 agent 会多一个委派目标。两者的影响范围差一个数量级，
   * 混成一个权限就意味着「能写临时文件」等于「能改运行时」。
   *
   * ── 它绕不过去的地方，说清楚 ────────────────────────
   *
   * 有了它的 agent 可以**造一个带 execute 权限的 agent，然后委派给它** ——
   * 那等于给自己发了 execute。这个模型是**刻意接受**的（使用者明确选择
   * 「全部自动，不要批准」），代价用可见性补：每次写入都在对话里显示完整内容、
   * 全量进 `logs/`、并给出回退命令。
   *
   * 所以这个权限只该给对外的入口 agent —— 与 `user` 同样的理由，
   * 而且更要紧。
   */
  'configure',
  /**
   * 哨兵：未分类的 MCP 工具要求它。
   *
   * **任何 agent 都不允许授予它**（配置校验会拒绝），所以未分类的工具一定
   * 不可见。写成一个正常权限（而不是「不需要权限」）是刻意的：默认可见
   * 等于每接一个 MCP server 就静默扩权一次。
   */
  'unclassified',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export interface PermissionSpec {
  id: Permission
  what: string
  /** 授予它意味着接受什么风险 */
  risk: string
}

export const PERMISSION_SPECS: readonly PermissionSpec[] = [
  {
    id: 'read',
    what: '读取本地数据：工作目录内的文件、数据库查询',
    risk: '能看到工作目录内的一切，包括别的步骤写下的中间产物',
  },
  {
    id: 'write',
    what: '写入工作目录内的文件',
    risk: '能覆盖同一 run 内其它步骤写下的文件',
  },
  {
    id: 'artifact',
    what: '登记产出（write_report）：只进 artifacts 表，不碰文件系统',
    risk: '低。路径由工具构造，逃不出本次 run。但编排者不该有 —— 它该整合而非动手',
  },
  {
    id: 'execute',
    what: '执行代码或命令',
    risk: '最强的一项。拿到它基本等于拿到本机权限，其它权限都可被绕过',
  },
  {
    id: 'network',
    what: '主动出网：搜索、抓取、调用外部 API',
    risk: '数据可能外流；返回内容一律按 untrusted 处理',
  },
  {
    id: 'delegate',
    what: '把任务派给其它 agent',
    risk: '每多一个能派活的 agent，就多一条成环的路（靠 maxDelegationDepth 兜底）',
  },
  {
    id: 'user',
    what: '直接向用户提问',
    risk: '会打断用户；只应授予对外的入口 agent',
  },
  {
    id: 'configure',
    what: '改运行时自己：加规则、加专家、加模型',
    risk:
      '**能提权** —— 造一个带 execute 权限的专家再委派给它，等于给自己发了 execute。' +
      '只应授予对外的入口 agent',
  },
  {
    id: 'unclassified',
    what: '未在 mcpPolicies 里分类的 MCP 工具要求它',
    risk: '不可授予。看到工具要求它，说明该去 mcpPolicies 里补一条分类',
  },
]

const BY_ID = new Map(PERMISSION_SPECS.map((p) => [p.id, p]))

export function isPermission(s: string): s is Permission {
  return BY_ID.has(s as Permission)
}

/** 未分类的 MCP 工具要求的权限集合 —— 永远不可能被满足 */
export const UNCLASSIFIED: Permission[] = ['unclassified']

/** 可以授予给 agent 的权限（不含哨兵） */
export const GRANTABLE: readonly Permission[] = PERMISSIONS.filter((p) => p !== 'unclassified')

/** agent 的授予是否覆盖了工具的全部要求 */
export function permitted(granted: readonly Permission[], required: readonly Permission[]): boolean {
  return required.every((r) => granted.includes(r))
}
