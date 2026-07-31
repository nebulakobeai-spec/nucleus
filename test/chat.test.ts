import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type Nucleus } from '../src/boot.js'
import { defaultConfig } from '../src/config.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { loadEnvFile, parseEnv } from '../src/env.js'
import { runChatCommand, type ChatSession } from '../src/cli/chat.js'
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
    await runChatCommand(n, session, '/model mock:local')
    const after = n.worker.agentSpecs.get('orchestrator')!.modelChain

    // 只改 config 对已启动的 worker 无效，spec 也要跟着变
    expect(after).toEqual(['mock:local'])
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
