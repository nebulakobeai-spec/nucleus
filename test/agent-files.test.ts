import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadAgentFiles,
  parseAgentFile,
  parseCases,
  parseFrontmatter,
} from '../src/config/agent-files.js'
import { loadConfig } from '../src/config-file.js'
import { agentSpec, buildSystemPrompt } from '../src/config.js'
import { assemble, DEFAULT_BUDGET } from '../src/context/assemble.js'

/**
 * `agents/*.md` —— 一个专家一个文件。
 *
 * 为什么不继续用 JSON 数组：那个数组是**整体替换**语义，所以「加一个专家」
 * 要把已有的全抄一遍；而 prompt 在 JSON 里是转义串，偏偏 prompt 是改得
 * 最勤的东西。
 *
 * 试题集刻意放在另一个文件，并且**永不进 prompt** —— 这条由下面的
 * 强断言守着，因为它很容易被破坏（图省事把 frontmatter 整个塞进 prompt，
 * 或者哪天有人觉得把试题当 few-shot 例子挺好）。
 */

const MD = `---
name: 分析师
whenToUse: 需要带出处的量化结论时
permissions: [read, artifact]
requiredFields: [metrics[].source]
maxSteps: 8
resultFields:
  verdict:
    type: string
    description: 一句话结论
  metrics:
    type: object[]
    fields:
      name: string
      value: number
      source: string
---
你是金融数据分析专家。

所有数字必须能追溯到数据源。
`

// ═══════════════════════════════════════════════════════
// frontmatter 解析
// ═══════════════════════════════════════════════════════

describe('parseFrontmatter', () => {
  it('标量、行内数组、嵌套映射都认', () => {
    const { data, body, errors } = parseFrontmatter(MD)
    expect(errors).toEqual([])
    expect(data['name']).toBe('分析师')
    expect(data['permissions']).toEqual(['read', 'artifact'])
    expect(data['maxSteps']).toBe(8)
    expect(data['resultFields']).toMatchObject({
      verdict: { type: 'string', description: '一句话结论' },
      metrics: { type: 'object[]', fields: { name: 'string', value: 'number', source: 'string' } },
    })
    expect(body).toContain('金融数据分析专家')
  })

  it('缺 frontmatter 时报错，不静默当成纯正文', () => {
    expect(parseFrontmatter('只有正文').errors.length).toBe(1)
  })

  it('数字与布尔被转成对应类型', () => {
    const { data } = parseFrontmatter('---\na: 3\nb: 1.5\nc: true\nd: false\n---\nx')
    expect(data).toMatchObject({ a: 3, b: 1.5, c: true, d: false })
  })

  it('引号被剥掉，注释与空行被忽略', () => {
    const { data } = parseFrontmatter('---\n# 注释\na: "带引号"\n\nb: \'单引号\'\n---\nx')
    expect(data).toMatchObject({ a: '带引号', b: '单引号' })
  })

  it('解析不了的行报出来，不吞掉', () => {
    expect(parseFrontmatter('---\n这行没有冒号\n---\nx').errors.length).toBe(1)
  })
})

describe('parseAgentFile', () => {
  it('id 取自文件名，正文即 identity', () => {
    const { agent, errors } = parseAgentFile('/x/agents/analyst.md', MD)
    expect(errors).toEqual([])
    expect(agent!.id).toBe('analyst')
    expect(agent!.identity).toContain('金融数据分析专家')
    expect(agent!.permissions).toEqual(['read', 'artifact'])
    expect(agent!.maxSteps).toBe(8)
  })

  it('未知的 frontmatter 键报错 —— 拼错了要知道，不能静默忽略', () => {
    const { errors } = parseAgentFile('/x/a.md', '---\nname: x\npermision: [read]\n---\n正文')
    expect(errors.some((e) => e.includes('permision'))).toBe(true)
  })

  it('正文为空时报错 —— 正文就是这个 agent 的 prompt', () => {
    const { agent, errors } = parseAgentFile('/x/a.md', '---\nname: x\n---\n')
    expect(agent).toBeUndefined()
    expect(errors.some((e) => e.includes('正文为空'))).toBe(true)
  })

  it('文件名不合法时报错', () => {
    expect(parseAgentFile('/x/Analyst.md', MD).errors.length).toBeGreaterThan(0)
    expect(parseAgentFile('/x/an_alyst.md', MD).errors.length).toBeGreaterThan(0)
  })

  it('model 支持单数写法，省得一个模型也要写成数组', () => {
    const a = parseAgentFile('/x/a.md', '---\nmodel: kimi:k3\n---\n正文').agent!
    expect(a.modelChain).toEqual(['kimi:k3'])
    const b = parseAgentFile('/x/b.md', '---\nmodel: [a, b]\n---\n正文').agent!
    expect(b.modelChain).toEqual(['a', 'b'])
  })

  it('name 不写就用 id', () => {
    expect(parseAgentFile('/x/solo.md', '---\nwhenToUse: x\n---\n正文').agent!.name).toBe('solo')
  })
})

describe('parseCases', () => {
  it('每个 - 开头的段落是一道题，可跨行', () => {
    const cases = parseCases(`# 试题集
说明文字不算题目。

- 第一道题
  它有第二行
- 第二道题
`)
    expect(cases).toHaveLength(2)
    expect(cases[0]).toContain('第二行')
  })

  it('空文件返回空数组', () => {
    expect(parseCases('')).toEqual([])
    expect(parseCases('# 只有标题')).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════
// 目录加载与配置合并
// ═══════════════════════════════════════════════════════

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nuc-af-'))
  await mkdir(join(dir, 'agents'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

const BASE_CONFIG = JSON.stringify({
  models: [{ key: 'mock:local', provider: 'mock', model: 'mock', baseUrl: 'http://mock.invalid/v1' }],
  defaults: { modelChain: ['mock:local'], entryAgent: 'orchestrator' },
})

describe('loadAgentFiles', () => {
  it('目录不存在时返回空，不报错 —— 不用 md 定义专家是合法的', () => {
    expect(loadAgentFiles('/绝对不存在的目录')).toEqual({ files: [], errors: [] })
  })

  it('.cases.md 不会被当成 agent 定义', async () => {
    const dir = await fixture({
      'agents/analyst.md': MD,
      'agents/analyst.cases.md': '- 第一题\n- 第二题\n',
    })
    const r = loadAgentFiles(join(dir, 'agents'))
    expect(r.files.map((f) => f.agent.id)).toEqual(['analyst'])
    expect(r.files[0]!.cases).toHaveLength(2)
  })

  it('一个文件坏了会报出来，不静默跳过', async () => {
    const dir = await fixture({ 'agents/bad.md': '没有 frontmatter' })
    expect(loadAgentFiles(join(dir, 'agents')).errors.length).toBeGreaterThan(0)
  })
})

describe('与 nucleus.config.json 并存', () => {
  it('md 定义的专家被加进来，来源可查', async () => {
    const dir = await fixture({
      'nucleus.config.json': BASE_CONFIG,
      'agents/analyst.md': MD,
    })
    process.env['NUCLEUS_AGENTS_DIR'] = join(dir, 'agents')
    try {
      const { config, agentSources, cases } = await loadConfig(join(dir, 'nucleus.config.json'))
      expect(config.agents.map((a) => a.id)).toContain('analyst')
      expect(agentSources['analyst']).toContain('analyst.md')
      // 内置只剩 orchestrator（基础设施），专家由你定义
      expect(agentSources['orchestrator']).toBe('(内置)')
      expect(cases['analyst']).toBeUndefined()
    } finally {
      delete process.env['NUCLEUS_AGENTS_DIR']
    }
  })

  it('试题集被读出来但不进 agent 定义', async () => {
    const dir = await fixture({
      'nucleus.config.json': BASE_CONFIG,
      'agents/analyst.md': MD,
      'agents/analyst.cases.md': '- 第一题\n- 第二题\n',
    })
    process.env['NUCLEUS_AGENTS_DIR'] = join(dir, 'agents')
    try {
      const { config, cases } = await loadConfig(join(dir, 'nucleus.config.json'))
      expect(cases['analyst']).toHaveLength(2)
      // 关键：试题在 LoadedConfig.cases 里，**不在** AgentConfig 上
      const a = config.agents.find((x) => x.id === 'analyst')!
      expect(a).not.toHaveProperty('cases')
      expect(JSON.stringify(a)).not.toContain('第一题')
    } finally {
      delete process.env['NUCLEUS_AGENTS_DIR']
    }
  })

  it('md 文件顶掉同名的内置 agent', async () => {
    const dir = await fixture({
      'nucleus.config.json': BASE_CONFIG,
      // 用内置的 id：md 应当赢
      'agents/orchestrator.md': '---\nname: 我的编排者\npermissions: [delegate]\n---\n我自己写的编排者正文',
    })
    process.env['NUCLEUS_AGENTS_DIR'] = join(dir, 'agents')
    try {
      const { config, agentSources } = await loadConfig(join(dir, 'nucleus.config.json'))
      const a = config.agents.find((x) => x.id === 'orchestrator')!
      expect(a.name).toBe('我的编排者')
      expect(a.identity).toContain('我自己写的')
      expect(agentSources['orchestrator']).toContain('orchestrator.md')
    } finally {
      delete process.env['NUCLEUS_AGENTS_DIR']
    }
  })

  it('md 里的声明错误在加载期就报', async () => {
    const dir = await fixture({
      'nucleus.config.json': BASE_CONFIG,
      'agents/bad.md': '---\nresultFields:\n  summary:\n    type: string\n---\n正文',
    })
    process.env['NUCLEUS_AGENTS_DIR'] = join(dir, 'agents')
    try {
      await expect(loadConfig(join(dir, 'nucleus.config.json'))).rejects.toThrow(/核心字段/)
    } finally {
      delete process.env['NUCLEUS_AGENTS_DIR']
    }
  })
})

// ═══════════════════════════════════════════════════════
// 强断言：试题永不进 prompt
// ═══════════════════════════════════════════════════════

describe('试题不进 context', () => {
  const CASE_TEXT = '这道试题的独特字符串-XYZZY'

  it('prompt 里不含试题文本', () => {
    const { agent } = parseAgentFile('/x/analyst.md', MD)
    const prompt = buildSystemPrompt(agent!)
    expect(prompt).not.toContain(CASE_TEXT)
    // 也不含 frontmatter 的元数据 —— 只有契约 + identity + policy
    expect(prompt).not.toContain('permissions')
    expect(prompt).not.toContain('requiredFields')
    expect(prompt).not.toContain('metrics[].source')
  })

  it('装配出的完整上下文里也不含试题 —— 这条很容易被破坏', () => {
    const { agent } = parseAgentFile('/x/analyst.md', MD)
    const spec = agentSpec(agent!, {
      modelChain: ['mock:local'],
      maxSteps: 8,
      maxCostUsd: 1,
      entryAgent: 'analyst',
      assumedContextWindow: 32_768,
      maxDelegationDepth: 3,
      maxRunsPerRoot: 32,
    })
    const r = assemble({
      contract: spec.systemPrompt,
      identity: '',
      policy: '',
      history: [],
      input: [{ role: 'user', content: '真正的任务' }],
      budget: DEFAULT_BUDGET,
    })
    const all = r.messages.map((m) => m.content).join('\n')
    expect(all).not.toContain(CASE_TEXT)
    expect(all).toContain('真正的任务')
  })

  it('agent 定义里根本没有 cases 字段 —— 结构上进不去', () => {
    const { agent } = parseAgentFile('/x/analyst.md', `---\nname: x\ncases: [不该被接受]\n---\n正文`)
    // cases 不在 KNOWN_KEYS 里，写在定义文件里会被报成未知键
    expect(agent).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════
// agent new 的骨架
// ═══════════════════════════════════════════════════════

describe('scaffold', () => {
  it('生成的骨架能直接被解析，不需要先改', async () => {
    const { scaffold } = await import('../src/cli/agent-new.js')
    const { agent, errors } = parseAgentFile('/x/reviewer.md', scaffold('reviewer', []))
    expect(errors).toEqual([])
    expect(agent!.id).toBe('reviewer')
    expect(agent!.permissions).toEqual(['read'])
  })

  it('**说明不进 prompt** —— 第一版把它们写在正文里，prompt 涨到 1504 字符', async () => {
    const { scaffold } = await import('../src/cli/agent-new.js')
    const { agent } = parseAgentFile('/x/reviewer.md', scaffold('reviewer', ['analyst：做分析']))
    const prompt = buildSystemPrompt(agent!)

    // markdown 正文里没有注释 —— `#` 是标题，而正文整段就是 identity。
    // 所以说明必须放在 frontmatter 的 # 行里（解析器会跳过）
    for (const marker of [
      'whenToUse 怎么写',
      '可授予的权限',
      '你的专家会收到什么',
      '现有专家',
      '同义反复',
      'analyst：做分析',
    ]) {
      expect(prompt, marker).not.toContain(marker)
    }
    // 正文本身还在
    expect(prompt).toContain('这段正文就是模型收到的 system prompt')
    // 骨架的 prompt 应当很短 —— 长了说明又漏了说明文本进去
    expect(prompt.length).toBeLessThan(500)
  })

  it('骨架里带上现有专家，提醒不要语义重叠', async () => {
    const { scaffold } = await import('../src/cli/agent-new.js')
    const text = scaffold('reviewer', ['analyst：做分析'])
    // 在文件里（给人看）
    expect(text).toContain('analyst：做分析')
    // 但在 frontmatter 的注释区，所以解析不出来
    const { data } = parseFrontmatter(text)
    expect(JSON.stringify(data)).not.toContain('analyst：做分析')
  })

  it('权限说明里连风险一起列 —— LLM 或人顺手给个 execute 是真会发生的', async () => {
    const { scaffold } = await import('../src/cli/agent-new.js')
    const text = scaffold('x', [])
    expect(text).toContain('execute')
    expect(text).toContain('基本等于拿到本机权限')
  })
})

describe('来源标签', () => {
  it('只有两种来源：内置兜底与 md 文件', async () => {
    const dir = await fixture({
      'nucleus.config.json': BASE_CONFIG,
      'agents/analyst.md': MD,
    })
    process.env['NUCLEUS_AGENTS_DIR'] = join(dir, 'agents')
    try {
      const { agentSources } = await loadConfig(join(dir, 'nucleus.config.json'))
      // 内置只剩 orchestrator —— 专家由你定义
      expect(agentSources['orchestrator']).toBe('(内置)')
      expect(agentSources['analyst']).toContain('analyst.md')
      expect(agentSources['researcher']).toBeUndefined()
    } finally {
      delete process.env['NUCLEUS_AGENTS_DIR']
    }
  })
})
