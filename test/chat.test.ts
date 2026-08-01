import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, isMockOnly, modelMap, withExampleAgents } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { loadEnvFile, parseEnv } from '../src/env.js'
import { runChatCommand, type ChatSession } from '../src/cli/chat.js'
import { parseArgv, strFlag } from '../src/cli/ui.js'
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
      config: withExampleAgents(structuredClone(defaultConfig)),
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
    const cfg = withExampleAgents(structuredClone(defaultConfig))
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
      config: withExampleAgents(structuredClone(defaultConfig)),
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
      config: withExampleAgents(structuredClone(defaultConfig)),
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

describe('agents 只能来自 md', () => {
  async function withConfig(json: unknown): Promise<ReturnType<typeof loadConfig>> {
    const dir = await mkdtemp(join(tmpdir(), 'nuc-cfg-'))
    const p = join(dir, 'nucleus.config.json')
    await writeFile(p, JSON.stringify(json))
    return loadConfig(p)
  }

  it('JSON 里定义 agents 被拒绝，而不是静默忽略', async () => {
    // 静默忽略会让人以为配置生效了。而两种来源意味着两条代码路径、
    // 两个出问题时要看的地方 —— 那个「来源」列本身就是歧义的补丁
    await expect(
      withConfig({
        agents: [{ id: 'reviewer', name: '审核员', identity: '你是审核员。', permissions: ['read'] }],
      }),
    ).rejects.toThrow(/不能定义 agents/)
  })

  it('拒绝时给出迁移路径与要迁的 id', async () => {
    const err = await withConfig({
      agents: [{ id: 'reviewer' }, { id: 'analyst' }],
    }).catch((e: Error) => e)
    const msg = (err as Error).message
    expect(msg).toContain('agents/*.md')
    expect(msg).toContain('nucleus agent new')
    // 要迁哪些必须列出来，否则得自己去数
    expect(msg).toContain('reviewer, analyst')
  })

  it('不写 agents 时沿用内置的 orchestrator', async () => {
    const { config } = await withConfig({ defaults: { maxSteps: 5 } })
    expect(config.agents.map((a) => a.id)).toEqual(['orchestrator'])
    expect(config.defaults.maxSteps).toBe(5)
  })

  it('entryAgent 指向不存在的 agent 仍然在启动时报错', async () => {
    // 这条校验还有用：md 文件可以定义任何 id，entryAgent 可能指向没有的那个
    await expect(withConfig({ defaults: { entryAgent: 'nobody' } })).rejects.toThrow(
      /entryAgent 指向不存在的 agent/,
    )
  })
})

describe('strFlag', () => {
  it('写了名字没给值时当作「没给」，不是布尔 true 当字符串用', () => {
    // 真实撞过的坑：nucleus ask "..." --conv 会一路流到 .slice() 才炸成
    // 「convId.slice is not a function」，错误信息完全指不到参数上
    const { flags } = parseArgv(['ask', '问题', '--conv'])
    expect(flags['conv']).toBe(true)
    expect(strFlag(flags, 'conv')).toBeUndefined()
  })

  it('正常给值时原样返回', () => {
    const { flags } = parseArgv(['--conv', 'abc123'])
    expect(strFlag(flags, 'conv')).toBe('abc123')
  })

  it('没出现过的参数是 undefined', () => {
    expect(strFlag(parseArgv([]).flags, 'conv')).toBeUndefined()
  })
})

describe('--mock 的诚实性', () => {
  it('--mock 会把模型链也换成 mock —— 显示与事实必须一致', async () => {
    // 曾经只换 HTTP 拦截：配置里写 ollama:gemma4:31b，屏幕上也显示它服务了
    // 这一轮，而实际答话的是 mock，且「回答是假的」的警告不触发
    // （那个判断看的是模型链）。显示与事实不符比没有显示更糟。
    const dir = await mkdtemp(join(tmpdir(), 'nuc-mock-'))
    const p = join(dir, 'nucleus.config.json')
    await writeFile(
      p,
      JSON.stringify({
        models: [
          {
            key: 'ollama:gemma4:31b',
            provider: 'ollama',
            model: 'gemma4:31b',
            baseUrl: 'http://localhost:11434/v1',
            contextWindow: 262144,
          },
        ],
        defaults: { modelChain: ['ollama:gemma4:31b'] },
      }),
    )
    const { config } = await loadConfig(p)
    expect(isMockOnly(config)).toBe(false)

    // 模拟 open() 里 --mock 的处理
    const withMock = {
      ...config,
      defaults: { ...config.defaults, modelChain: ['mock:local'] },
    }
    expect(isMockOnly(withMock)).toBe(true)
  })
})
