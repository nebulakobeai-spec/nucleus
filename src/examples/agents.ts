import type { AgentConfig, NucleusConfig } from '../config.js'

/**
 * 示例专家 —— **不是产品默认值**。
 *
 * 单独一个模块而不是塞在 config.ts 里，因为它们是**示例内容**而不是配置：
 * 产品默认值应该只有让系统能跑起来的最小集（一个编排者），
 * 「你需要哪些专家」是使用者的领域知识。
 *
 * 留着的两个用途：
 *  - `nucleus verify` 的离线冒烟需要一个专家才能验完整的委派链路
 *  - 测试需要固定的 agent 定义，而且要快（不走磁盘）
 *
 * 编排者不在这里：它是基础设施（入口 + 委派 + 整合），不是专家。
 *
 * 这两个定义也是写法参考 —— 但**真正要照着抄的是** `nucleus agent new`
 * 生成的骨架，那里有正例反例与权限风险说明。
 */

export const EXAMPLE_AGENTS: AgentConfig[] = [
    {
      id: 'researcher',
      name: '研究员',
      whenToUse: '需要调研、查资料、核实事实、给出带来源的结论时',
      identity: `你是研究专家，负责调研与信息收集。
结论必须标注来源。`,
      // read 读资料 + artifact 出报告。没有 write/execute/network ——
      // 出网靠 MCP 提供搜索服务，加上 network 后相应工具会自动出现
      permissions: ['read', 'artifact'],
      capabilities: ['research'],
      requiredFields: ['findings[].sources'],
    },
    {
      id: 'operator',
      name: '执行者',
      whenToUse: '需要读写文件、整理数据、执行具体操作时',
      identity: `你是执行专家，负责脚本执行与文件操作。
限制输出规模，只返回关键信息。`,
      permissions: ['read', 'write', 'artifact'],
    },
]

/** defaultConfig 加上示例专家 —— verify 与测试用 */
export function withExampleAgents(cfg: NucleusConfig): NucleusConfig {
  const byId = new Map(cfg.agents.map((a) => [a.id, a]))
  // 深拷贝：EXAMPLE_AGENTS 是模块级单例，直接塞引用的话调用方改一下
  // （比如给 researcher 加个权限）就会污染其他调用方看到的定义
  for (const a of EXAMPLE_AGENTS) if (!byId.has(a.id)) byId.set(a.id, structuredClone(a))
  return { ...cfg, agents: [...byId.values()] }
}

