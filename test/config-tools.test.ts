import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { parseRuleFile } from '../src/runtime/user-rules.js'
import { parseAgentFile } from '../src/config/agent-files.js'

/**
 * 编排者改运行时自己：加规则、加专家、加模型。
 *
 * ── 使用者的选择：全部自动，不要批准 ────────────────────────
 *
 * 我提过的反对意见仍然成立：**有 `configure` 的 agent 可以造一个带 `execute`
 * 权限的专家，然后委派给它 —— 那等于给自己发了 execute。**
 * 使用者明确选择了「全部自动」，所以运行时不拦。
 *
 * 代价用**可见性**补：写入的完整内容回到对话里、全量进 `logs/`、每次给回退命令。
 * 而这一组测试的一半就是钉住那些「说出来」——
 * **不加闸门不等于不说话**，而「说了什么」是能测的。
 */

let n: Nucleus | null = null
let dir: string | null = null

afterEach(async () => {
  await n?.close()
  n = null
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

/** 起一个带 configure 权限的编排者，配置文件在临时目录里 */
async function withTools(script: Record<string, unknown[]>): Promise<{ conv: string; dir: string }> {
  dir = await mkdtemp(join(tmpdir(), 'nuc-cfg-'))
  const cfg = structuredClone(defaultConfig)
  cfg.defaults.modelChain = ['mock:local']
  n = await boot({
    config: cfg,
    deps: { clock: new FakeClock(), ids: new FakeIds() },
    dataDir: join(dir, 'pglite'),
    configPath: join(dir, 'nucleus.config.json'),
    mock: script as never,
  })
  const c = await n.conversations.create({ agentId: 'orchestrator' })
  return { conv: c.id, dir }
}

/**
 * 工具回给模型的正文。
 *
 * transcript 的列是 request / response —— 工具返回值出现在**下一次调用的
 * request** 里（作为 role: tool 的消息）。那才是「模型看到了什么」的证据，
 * 也是这些「说出来」的断言唯一能落到的地方。
 */
async function toolOutput(x: Nucleus): Promise<string> {
  const r = await x.db.query<{ request: unknown }>(`select request from transcripts order by id`)
  return r.rows.map((row) => JSON.stringify(row.request)).join('\n')
}

const done = { submit: { status: 'ok', summary: '配好了', artifacts: [] } }

describe('create_rule', () => {
  it('写出的文件能被加载器原样读回来', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'create_rule',
            args: {
              id: 'cite-sources',
              resultFields: {
                findings: { type: 'object[]', fields: { claim: 'string', source: 'string' } },
              },
              requiredFields: ['findings[].source'],
              constraint: '结论必须能追到出处。',
              appliesTo: ['*'],
            },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '加一条规则：结论要带来源')

    const text = await readFile(join(d, 'rules', 'cite-sources.md'), 'utf8')
    const back = parseRuleFile('rules/cite-sources.md', text)
    expect(back.problems.filter((p) => p.fatal), text).toEqual([])
    expect(back.rule!.check!.requiredFields).toEqual(['findings[].source'])
    expect(back.rule!.constraint).toBe('结论必须能追到出处。')
  })

  /**
   * **「提醒不能单独存在」这条原则由校验强制，对模型也一样。**
   *
   * 只有提醒的规则会出现在规则清单里、看起来系统在管，实际什么都没管。
   * 让模型绕过这一条，等于把「prompt 写满禁止但模型照犯」原样搬回来。
   */
  it('只有提醒 → 拒绝，并说清两条出路', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        { tool: { name: 'create_rule', args: { id: 'be-nice', constraint: '要礼貌。' } } },
        done,
      ],
    })
    await ask(n!, conv, '加一条：要礼貌')

    // 文件不该存在
    await expect(readdir(join(d, 'rules'))).rejects.toThrow()
    // 拒绝的理由要回到模型那里，而不只是一句「失败」
    const all = await toolOutput(n!)
    expect(all).toMatch(/只有 reminder|没有任何机械强制/)
  })

  it('字段名 camelCase → 拒绝', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'create_rule',
            args: { id: 'x', resultFields: { dataPoints: { type: 'object[]' } } },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '加一条')
    await expect(readdir(join(d, 'rules'))).rejects.toThrow()
  })

  it('requiredFields 引用未声明的字段 → 拒绝', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        { tool: { name: 'create_rule', args: { id: 'x', requiredFields: ['plan[].step'] } } },
        done,
      ],
    })
    await ask(n!, conv, '加一条')
    await expect(readdir(join(d, 'rules'))).rejects.toThrow()
  })

  /** 复合要求：管住能管的，没管住的写进文件 */
  it('uncoveredClauses 写进文件的 uncovered', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'create_rule',
            args: {
              id: 'plan-first',
              resultFields: { plan: { type: 'object[]', fields: { step: 'string' } } },
              requiredFields: ['plan[].step'],
              uncoveredClauses: ['计划要经用户同意后才能执行'],
            },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '加一条 plan-first')
    const text = await readFile(join(d, 'rules', 'plan-first.md'), 'utf8')
    const back = parseRuleFile('rules/plan-first.md', text)
    expect(back.rule!.uncovered).toEqual(['计划要经用户同意后才能执行'])
  })
})

describe('create_agent', () => {
  it('写出的文件能被加载器原样读回来', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'create_agent',
            args: {
              id: 'analyst',
              identity: '你是财报分析专家。只看已公开的财报数据。',
              whenToUse: '需要读财报、算财务比率、比较同业时',
              permissions: ['read', 'artifact'],
            },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '加一个财报分析专家')

    const text = await readFile(join(d, 'agents', 'analyst.md'), 'utf8')
    const back = parseAgentFile('agents/analyst.md', text)
    expect(back.errors, text).toEqual([])
    expect(back.agent!.permissions).toEqual(['read', 'artifact'])
    expect(back.agent!.whenToUse).toMatch(/财报/)
  })

  /**
   * **提权那件事必须被说出来。**
   *
   * 不加闸门是使用者的决定，而「不拦」和「不说」是两回事。授了 execute / write /
   * network 时要单独点出来，不能混在一串 id 里一带而过。
   */
  it('授了危险权限时，回给模型的内容里点明这是提权', async () => {
    const { conv } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'create_agent',
            args: {
              id: 'runner',
              identity: '你负责执行脚本。',
              whenToUse: '需要跑命令时',
              permissions: ['execute'],
            },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '加一个能跑脚本的专家')

    // 工具返回的正文出现在**下一次调用的 request** 里 —— 那是「模型看到了什么」
    const all = await toolOutput(n!)
    expect(all, '没有把提权这件事说出来').toMatch(/execute/)
    expect(all).toMatch(/扩大了你能做的事|提权|能改变外部世界/)
  })

  it('重名 → 拒绝，而不是悄悄覆盖别人的专家', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'create_agent',
            args: {
              id: 'orchestrator',
              identity: '你是我',
              whenToUse: '随时',
              permissions: [],
            },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '造一个跟编排者同名的')
    await expect(readdir(join(d, 'agents'))).rejects.toThrow()
  })

  /**
   * `unclassified` 是哨兵：**任何 agent 都不允许授予它**，否则未分类的 MCP 工具
   * 会静默可见 —— 而那等于每接一个 MCP server 就扩权一次。
   */
  it('不可授予的权限 → 拒绝', async () => {
    const { conv, dir: d } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'create_agent',
            args: {
              id: 'sneaky',
              identity: 'x',
              whenToUse: 'y',
              permissions: ['unclassified'],
            },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '造一个')
    await expect(readdir(join(d, 'agents'))).rejects.toThrow()
  })
})

describe('configure_model', () => {
  /**
   * **窗口大小是模型的事实，不能猜。**
   *
   * 猜大了会直接溢出，而 ollama 的默认 num_ctx 常常只有 4096。
   * 这个项目的规矩是宁可不填也不编造数字。
   */
  it('contextWindow 缺了或非正数 → 拒绝，并告诉它去问', async () => {
    const { conv } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'configure_model',
            args: { key: 'ollama:kimi-k3', provider: 'ollama', model: 'kimi-k3', contextWindow: 0 },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '加一个模型')
    const all = await toolOutput(n!)
    expect(all).toMatch(/不要猜|providers probe/)
  })

  /**
   * **密钥不能进配置。** 挡在工具里而不是靠描述劝导 —— 一旦写进去，
   * 那个文件就成了一份明文凭据，而它还可能被提交。
   */
  it('传了真实密钥形态 → 拒绝', async () => {
    const { conv } = await withTools({
      orchestrator: [
        {
          tool: {
            name: 'configure_model',
            args: {
              key: 'openai:gpt',
              provider: 'openai',
              model: 'gpt',
              contextWindow: 128000,
              apiKeyRef: 'sk-proj-REALLOOKINGKEY123',
            },
          },
        },
        done,
      ],
    })
    await ask(n!, conv, '加一个模型')
    expect(await toolOutput(n!)).toMatch(/只放引用名|只放 apiKeyRef/)
  })

  it('没有配置文件时说清楚，而不是往一个猜的位置写', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nuc-cfg-'))
    const cfg = structuredClone(defaultConfig)
    cfg.defaults.modelChain = ['mock:local']
    n = await boot({
      config: cfg,
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      dataDir: join(dir, 'pglite'),
      // 刻意不给 configPath
      mock: {
        orchestrator: [
          {
            tool: {
              name: 'configure_model',
              args: { key: 'a:b', provider: 'a', model: 'b', contextWindow: 8192 },
            },
          },
          done,
        ],
      } as never,
    })
    const c = await n.conversations.create({ agentId: 'orchestrator' })
    await ask(n, c.id, '加一个模型')
    expect(await toolOutput(n)).toMatch(/找不到配置文件/)
  })
})
