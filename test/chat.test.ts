import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, isMockOnly, modelMap } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { loadEnvFile, parseEnv } from '../src/env.js'
import { runChatCommand, type ChatSession } from '../src/cli/chat.js'
import { parseArgv } from '../src/cli/ui.js'
import { loadConfig, stripJsonComments } from '../src/config-file.js'
import type { MockScript } from '../src/providers/mock.js'

// ═══════════════════════════════════════════════════════
// .env 加载
// ═══════════════════════════════════════════════════════

describe('.env 解析', () => {
  it('基本 KEY=VALUE', () => {
    expect(parseEnv('A=1\nB=2')).toEqual([
      ['A', '1'],
      ['B', '2'],
    ])
  })

  it('忽略注释与空行', () => {
    expect(parseEnv('# 注释\n\nA=1\n  # 缩进注释\nB=2')).toEqual([
      ['A', '1'],
      ['B', '2'],
    ])
  })

  it('支持 export 前缀（可直接 source 的文件）', () => {
    expect(parseEnv('export A=1')).toEqual([['A', '1']])
  })

  it('双引号内保留空格并处理转义', () => {
    expect(parseEnv('A="with spaces"')).toEqual([['A', 'with spaces']])
    expect(parseEnv('A="line1\\nline2"')).toEqual([['A', 'line1\nline2']])
    expect(parseEnv('A="say \\"hi\\""')).toEqual([['A', 'say "hi"']])
  })

  it('单引号内不做转义 —— 与 shell 一致', () => {
    expect(parseEnv("A='raw\\nvalue'")).toEqual([['A', 'raw\\nvalue']])
  })

  it('未加引号时剥掉行尾注释', () => {
    expect(parseEnv('A=value   # 说明')).toEqual([['A', 'value']])
    // 但 # 紧贴值时不算注释（可能是密钥的一部分）
    expect(parseEnv('A=val#ue')).toEqual([['A', 'val#ue']])
  })

  it('值里含 = 时只按第一个分割', () => {
    expect(parseEnv('URL=postgres://u:p@h/db?a=1&b=2')).toEqual([
      ['URL', 'postgres://u:p@h/db?a=1&b=2'],
    ])
  })

  it('跳过非法的键名与无 = 的行', () => {
    expect(parseEnv('123BAD=x\nno-equals\n=novalue\nGOOD=1')).toEqual([['GOOD', '1']])
  })
})

describe('.env 加载', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nucleus-env-'))
  })

  it('已存在的环境变量优先 —— 容器注入的值不被文件覆盖', async () => {
    await writeFile(join(dir, '.env'), 'A=from-file\nB=from-file')
    const env: NodeJS.ProcessEnv = { A: 'from-env' }

    const r = loadEnvFile(join(dir, '.env'), env)

    expect(env['A']).toBe('from-env')
    expect(env['B']).toBe('from-file')
    expect(r.skipped).toEqual(['A'])
    expect(r.loaded).toEqual(['B'])
  })

  it('文件不存在时静默返回，不抛错', () => {
    const r = loadEnvFile(join(dir, 'nonexistent'), {})
    expect(r.path).toBeNull()
    expect(r.loaded).toEqual([])
  })

  it('返回值不含 secret，只有变量名', async () => {
    await writeFile(join(dir, '.env'), 'SECRET_KEY=super-secret-value')
    const r = loadEnvFile(join(dir, '.env'), {})
    expect(JSON.stringify(r)).not.toContain('super-secret-value')
    expect(r.loaded).toContain('SECRET_KEY')
  })
})

// ═══════════════════════════════════════════════════════
// chat 斜杠命令
// ═══════════════════════════════════════════════════════

const SCRIPT: MockScript = {
  orchestrator: [{ submit: { status: 'ok', summary: '好的' } }],
}

describe('chat 命令', () => {
  let n: Nucleus
  let session: ChatSession

  beforeEach(async () => {
    n = await boot({
      config: structuredClone(defaultConfig),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
    })
    session = { conversationId: null, modelChain: null }
  })

  afterEach(async () => {
    await n.close()
  })

  it('/exit 返回 true 表示退出', async () => {
    expect(await runChatCommand(n, session, '/exit')).toBe(true)
    expect(await runChatCommand(n, session, '/quit')).toBe(true)
    expect(await runChatCommand(n, session, '/q')).toBe(true)
  })

  it('其它命令返回 false，REPL 继续', async () => {
    expect(await runChatCommand(n, session, '/help')).toBe(false)
    expect(await runChatCommand(n, session, '/runs')).toBe(false)
  })

  it('/new 清空会话 id，下一轮重新创建', async () => {
    session.conversationId = 'existing-id'
    await runChatCommand(n, session, '/new')
    expect(session.conversationId).toBeNull()
  })

  it('/model 切换模型链', async () => {
    await runChatCommand(n, session, '/model mock:local')
    expect(session.modelChain).toEqual(['mock:local'])
    expect(n.config.defaults.modelChain).toEqual(['mock:local'])
  })

  it('/model 支持逗号分隔的 fallback 链', async () => {
    await runChatCommand(n, session, '/model mock:local, ollama:llama')
    expect(session.modelChain).toEqual(['mock:local', 'ollama:llama'])
  })

  it('/model 校验模型名，写错时不生效', async () => {
    await runChatCommand(n, session, '/model does-not-exist')
    // 先校验再生效 —— 否则要等下一轮才炸，且错误信息指向别处
    expect(session.modelChain).toBeNull()
  })

  it('/model 同时更新已生效的 agent spec', async () => {
    const before = n.worker.agentSpecs.get('orchestrator')!.modelChain
    expect(before).toEqual(['mock:local'])

    // 切到别的模型才能证明 spec 真的跟着变了 ——
    // 内置链本身就是 mock，切成 mock 看不出区别
    await runChatCommand(n, session, '/model ollama:gemma3')
    const after = n.worker.agentSpecs.get('orchestrator')!.modelChain

    // 只改 config 对已启动的 worker 无效，spec 也要跟着变
    expect(after).toEqual(['ollama:gemma3'])
    expect(after).not.toEqual(before)
  })

  it('/model 不覆盖显式声明了模型链的 agent', async () => {
    // researcher 若在 config 里显式指定过链，切换默认链不应影响它
    const cfg = structuredClone(defaultConfig)
    cfg.agents = cfg.agents.map((a) =>
      a.id === 'researcher' ? { ...a, modelChain: ['ollama:llama'] } : a,
    )
    await n.close()
    n = await boot({
      config: cfg,
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
    })

    await runChatCommand(n, session, '/model mock:local')

    expect(n.worker.agentSpecs.get('orchestrator')!.modelChain).toEqual(['mock:local'])
    expect(n.worker.agentSpecs.get('researcher')!.modelChain).toEqual(['ollama:llama'])
  })

  it('/model 无参数时只显示，不改动', async () => {
    const before = [...n.config.defaults.modelChain]
    await runChatCommand(n, session, '/model')
    expect(n.config.defaults.modelChain).toEqual(before)
    expect(session.modelChain).toBeNull()
  })

  it('未知命令不退出 REPL', async () => {
    expect(await runChatCommand(n, session, '/nonsense')).toBe(false)
  })

  it('/runs 带未知前缀时不抛错', async () => {
    expect(await runChatCommand(n, session, '/runs deadbeef')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// 会话延续：chat 的核心价值
// ═══════════════════════════════════════════════════════

describe('会话延续', () => {
  let n: Nucleus

  beforeEach(async () => {
    n = await boot({
      config: structuredClone(defaultConfig),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: {
        orchestrator: [
          { submit: { status: 'ok', summary: '第一轮回答' } },
          { submit: { status: 'ok', summary: '第二轮回答' } },
        ],
      },
    })
  })

  afterEach(async () => {
    await n.close()
  })

  it('同一会话内多轮对话，历史累积', async () => {
    const { ask } = await import('../src/boot.js')
    const conv = await n.conversations.create({ agentId: 'orchestrator' })

    await ask(n, conv.id, '第一个问题')
    await ask(n, conv.id, '第二个问题')

    const msgs = await n.conversations.recent(conv.id, 20)
    const roles = msgs.map((m) => m.role)

    // user / assistant 交替，两轮共四条
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(msgs[1]!.content).toBe('第一轮回答')
    expect(msgs[3]!.content).toBe('第二轮回答')
  })

  it('第二轮能看到第一轮的历史 —— 这是延续对话的前提', async () => {
    const { ask } = await import('../src/boot.js')
    const conv = await n.conversations.create({ agentId: 'orchestrator' })

    await ask(n, conv.id, '记住数字 42')
    await ask(n, conv.id, '刚才的数字是多少')

    // worker 构造 prompt 时会带上会话历史；这里验证历史确实在库里
    const msgs = await n.conversations.recent(conv.id, 20)
    expect(msgs.map((m) => m.content)).toContain('记住数字 42')
  })
})

// ═══════════════════════════════════════════════════════
// 本地模型动态解析
// ═══════════════════════════════════════════════════════

describe('ollama 模型动态解析', () => {
  let n: Nucleus

  beforeEach(async () => {
    n = await boot({
      config: structuredClone(defaultConfig),
      deps: { clock: new FakeClock(), ids: new FakeIds() },
      mock: SCRIPT,
    })
  })

  afterEach(async () => {
    await n.close()
  })

  it('未声明的 ollama:* 也能解析 —— 本地模型换得勤，不该每个都写配置', async () => {
    const { modelMap } = await import('../src/config.js')
    const models = modelMap(n.config)

    const gemma = models.get('ollama:gemma3')
    expect(gemma).toBeDefined()
    expect(gemma!.model).toBe('gemma3')
    expect(gemma!.provider).toBe('ollama')
    expect(gemma!.baseUrl).toContain('11434')
  })

  it('模型名里的冒号被保留（ollama 的 tag 语法）', async () => {
    const { modelMap } = await import('../src/config.js')
    const m = modelMap(n.config).get('ollama:deepseek-r1:7b')
    expect(m!.model).toBe('deepseek-r1:7b')
  })

  it('非 ollama 的未知模型仍然拒绝 —— 云端拼错会变成真实付费调用', async () => {
    const { modelMap } = await import('../src/config.js')
    expect(modelMap(n.config).get('openai:typo-model')).toBeUndefined()
    expect(modelMap(n.config).get('nonsense')).toBeUndefined()
  })

  it('/model 接受未声明的 ollama 模型', async () => {
    const session: ChatSession = { conversationId: null, modelChain: null }
    await runChatCommand(n, session, '/model ollama:gemma3')
    expect(session.modelChain).toEqual(['ollama:gemma3'])
  })

  it('/model 仍然拒绝拼错的云端模型', async () => {
    const session: ChatSession = { conversationId: null, modelChain: null }
    await runChatCommand(n, session, '/model openai:gpt-typo')
    expect(session.modelChain).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════

describe('parseArgv', () => {
  it('开关放在位置参数前面不会把它吃掉', () => {
    // 这是真实踩过的坑：--mock 曾把后面的问题当成自己的值，
    // 于是 `nucleus ask --mock "问题"` 报「缺少参数」
    const { positional, flags } = parseArgv(['--mock', '帮我调研向量数据库'])
    expect(flags['mock']).toBe(true)
    expect(positional).toEqual(['帮我调研向量数据库'])
  })

  it('带值的 flag 照常吃下一个参数', () => {
    const { positional, flags } = parseArgv(['问题', '--model', 'zai:glm-5.2'])
    expect(flags['model']).toBe('zai:glm-5.2')
    expect(positional).toEqual(['问题'])
  })

  it('--key=value 无歧义写法', () => {
    const { flags } = parseArgv(['--model=zai:glm-5.2', '--conv=abc'])
    expect(flags['model']).toBe('zai:glm-5.2')
    expect(flags['conv']).toBe('abc')
  })

  it('值本身含冒号或等号不被截断', () => {
    expect(parseArgv(['--model=ollama:gemma4:31b']).flags['model']).toBe('ollama:gemma4:31b')
    expect(parseArgv(['--value=a=b']).flags['value']).toBe('a=b')
  })

  it('带值的 flag 在末尾时退化为 true，不越界', () => {
    expect(parseArgv(['--model']).flags['model']).toBe(true)
  })

  it('两个开关连着写都能识别', () => {
    const { flags, positional } = parseArgv(['ask', '--mock', '--no-browser', 'x'])
    expect(flags['mock']).toBe(true)
    expect(flags['no-browser']).toBe(true)
    expect(positional).toEqual(['ask', 'x'])
  })
})

// ═══════════════════════════════════════════════════════
// 配置校验：把错误挡在启动阶段
// ═══════════════════════════════════════════════════════

describe('agents 整体替换的坑', () => {
  async function withConfig(json: unknown): Promise<ReturnType<typeof loadConfig>> {
    const dir = await mkdtemp(join(tmpdir(), 'nuc-cfg-'))
    const p = join(dir, 'nucleus.config.json')
    await writeFile(p, JSON.stringify(json))
    return loadConfig(p)
  }

  it('只加一个专家会删掉入口 agent —— 必须在启动时报错，而不是每个任务都失败', async () => {
    // 这是真实踩过的坑：配置合法、doctor 全绿，然后所有任务都以
    // runtime.internal 失败，错误信息完全指不到配置上
    await expect(
      withConfig({
        agents: [
          { id: 'reviewer', name: '审核员', identity: '你是审核员。', toolsAllow: ['read_file'] },
        ],
      }),
    ).rejects.toThrow(/entryAgent 指向不存在的 agent/)
  })

  it('报错要说清「整体替换而非合并」—— 否则看不出该怎么改', async () => {
    const err = await withConfig({
      agents: [{ id: 'reviewer', name: '审核员', identity: 'x', toolsAllow: [] }],
    }).catch((e: Error) => e)
    expect((err as Error).message).toContain('整体替换')
    // 还要列出现有的 agent，省得再去翻配置
    expect((err as Error).message).toContain('reviewer')
  })

  it('把入口 agent 一起列上就正常', async () => {
    const { config } = await withConfig({
      agents: [
        { id: 'orchestrator', name: '编排者', identity: '你是编排者。', toolsAllow: ['delegate'] },
        { id: 'reviewer', name: '审核员', identity: '你是审核员。', toolsAllow: ['read_file'] },
      ],
    })
    expect(config.agents.map((a) => a.id)).toEqual(['orchestrator', 'reviewer'])
    expect(config.defaults.entryAgent).toBe('orchestrator')
  })

  it('也可以改 entryAgent 指向新 agent，不必保留 orchestrator', async () => {
    const { config } = await withConfig({
      agents: [{ id: 'reviewer', name: '审核员', identity: '你是审核员。', toolsAllow: [] }],
      defaults: { entryAgent: 'reviewer' },
    })
    expect(config.defaults.entryAgent).toBe('reviewer')
  })

  it('有 delegate 权限但没有可委派目标时报错', async () => {
    await expect(
      withConfig({
        agents: [{ id: 'solo', name: '独行', identity: 'x', toolsAllow: ['delegate'] }],
        defaults: { entryAgent: 'solo' },
      }),
    ).rejects.toThrow(/没有任何可委派的目标/)
  })
})

// ═══════════════════════════════════════════════════════
// 没有内置的真实模型
// ═══════════════════════════════════════════════════════

describe('模型必须自己配', () => {
  it('代码里只有 mock —— 不内置任何真实模型', () => {
    // 把某几个云端模型写进产品等于把作者的订阅强加给所有人，
    // 而 provider / 单价 / 计费方式 / 端点都会变
    expect(defaultConfig.models.map((m) => m.key)).toEqual(['mock:local'])
  })

  it('没有任何需要凭据的内置模型', () => {
    expect(defaultConfig.models.filter((m) => m.apiKeyRef)).toEqual([])
  })

  it('默认链只有 mock，且能被识别成「假模型」', () => {
    expect(defaultConfig.defaults.modelChain).toEqual(['mock:local'])
    expect(isMockOnly(defaultConfig)).toBe(true)
  })

  it('配了真实模型后不再判为假', () => {
    const c = structuredClone(defaultConfig)
    c.defaults.modelChain = ['zai:glm-5.2', 'mock:local']
    expect(isMockOnly(c)).toBe(false)
  })

  it('空链也算「没配」—— 不能当成已就绪', () => {
    const c = structuredClone(defaultConfig)
    c.defaults.modelChain = []
    expect(isMockOnly(c)).toBe(true)
  })

  it('本地 ollama 模型不需要声明，动态解析', () => {
    const m = modelMap(defaultConfig)
    expect(m.has('ollama:gemma4:31b')).toBe(true)
    expect(m.get('ollama:gemma4:31b')?.model).toBe('gemma4:31b')
    // 云端 provider 不给这个待遇 —— 拼错模型名会变成一次真实的付费调用
    expect(m.has('zai:typo')).toBe(false)
  })

  it('模板文件是合法 JSON 且带真实模型示例', async () => {
    const raw = await readFile(join(process.cwd(), 'nucleus.config.example.json'), 'utf8')
    const parsed = JSON.parse(stripJsonComments(raw)) as { models: Array<{ key: string; apiKeyRef?: string }> }
    expect(parsed.models.length).toBeGreaterThan(1)
    // 模板里绝不能出现密钥本身，只能有 ref
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{10,}/)
    for (const m of parsed.models) {
      if (m.apiKeyRef) expect(m.apiKeyRef).toMatch(/^[A-Z0-9_]+$/)
    }
  })

  it('内置工具里没有 web_search —— 注册一个必然失败的工具等于宣告不存在的能力', () => {
    const names = defaultConfig.agents.flatMap((a) => a.toolsAllow)
    expect(names).not.toContain('web_search')
  })
})
