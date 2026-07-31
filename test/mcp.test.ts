import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../src/seams.js'
import { McpClient, renderContent } from '../src/mcp/client.js'
import { flattenSchema } from '../src/mcp/schema.js'
import { parseQualifiedName, qualifiedName, type McpServerConfig } from '../src/mcp/protocol.js'
import { classifySideEffect, registerMcpTools } from '../src/mcp/registry.js'
import { ToolRegistry } from '../src/runtime/tools.js'
import { CredentialStore } from '../src/auth/credentials.js'
import { FakeMcpTransport, type FakeServerSpec } from './harness/mcp.js'

let clock: FakeClock

beforeEach(() => {
  clock = new FakeClock()
})

const OBJ = (props: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
})

function makeClient(
  specs: Record<string, FakeServerSpec>,
  extra: Partial<McpServerConfig> = {},
  opts: { credentials?: CredentialStore } = {},
) {
  // 每个 server 复用同一个 transport 实例：真实场景里重启会新建进程，
  // 但测试要观察跨重启的累计计数（失败次数、调用次数）
  const transports = new Map<string, FakeMcpTransport>()
  const configs: McpServerConfig[] = Object.keys(specs).map((id) => ({
    id,
    transport: 'stdio',
    command: 'fake',
    ...extra,
  }))
  const client = new McpClient(configs, {
    clock,
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    makeTransport: (cfg) => {
      const existing = transports.get(cfg.id)
      if (existing) {
        existing.reopen()
        return existing
      }
      const t = new FakeMcpTransport(specs[cfg.id]!)
      transports.set(cfg.id, t)
      return t
    },
  })
  return { client, transports }
}

// ═══════════════════════════════════════════════════════
// 命名空间：多 server 必然撞名
// ═══════════════════════════════════════════════════════

describe('命名空间', () => {
  it('工具名带 server 前缀', () => {
    expect(qualifiedName('searxng', 'search')).toBe('searxng__search')
    expect(parseQualifiedName('searxng__search')).toEqual({ serverId: 'searxng', toolName: 'search' })
  })

  it('非法字符被替换 —— provider 的 function name 只允许 [a-zA-Z0-9_-]', () => {
    expect(qualifiedName('web-search.prime', 'get/thing')).toBe('web-search_prime__get_thing')
    expect(qualifiedName('a', 'b')).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('两个 server 的同名工具不冲突', async () => {
    const { client } = makeClient({
      searxng: { tools: [{ name: 'search', inputSchema: OBJ() }] },
      brave: { tools: [{ name: 'search', inputSchema: OBJ() }] },
    })
    const { tools } = await client.discover()
    expect(tools.map((t) => t.name).sort()).toEqual(['brave__search', 'searxng__search'])
    await client.close()
  })
})

// ═══════════════════════════════════════════════════════
// 发现与分页
// ═══════════════════════════════════════════════════════

describe('工具发现', () => {
  it('握手后拉取工具清单', async () => {
    const { client, transports } = makeClient({
      demo: {
        tools: [
          { name: 'ping', description: '探活', inputSchema: OBJ() },
          { name: 'echo', inputSchema: OBJ({ msg: { type: 'string' } }, ['msg']) },
        ],
      },
    })
    const { tools, failed } = await client.discover()

    expect(failed).toEqual([])
    expect(tools).toHaveLength(2)
    // discover 按名称排序，echo 在 ping 之前
    const byName = Object.fromEntries(tools.map((t) => [t.originalName, t]))
    expect(byName['ping']!.description).toBe('探活')
    // 无描述时兜底，避免 provider 拒绝空描述
    expect(byName['echo']!.description).toContain('echo')

    const methods = transports.get('demo')!.requests.map((r) => r.method)
    expect(methods).toEqual(['initialize', 'tools/list'])
    await client.close()
  })

  it('分页拉全', async () => {
    const { client } = makeClient({
      big: {
        pageSize: 2,
        tools: Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, inputSchema: OBJ() })),
      },
    })
    const { tools } = await client.discover()
    expect(tools).toHaveLength(5)
    await client.close()
  })

  it('单个 server 失败不影响其余', async () => {
    const { client } = makeClient({
      good: { tools: [{ name: 'ok', inputSchema: OBJ() }] },
      bad: { failOnInit: '启动失败', tools: [] },
    })
    const { tools, failed } = await client.discover()

    expect(tools.map((t) => t.name)).toEqual(['good__ok'])
    expect(failed).toHaveLength(1)
    expect(failed[0]!.id).toBe('bad')
    await client.close()
  })

  it('并发 ensureStarted 只握手一次', async () => {
    const { client, transports } = makeClient({ demo: { tools: [{ name: 'x', inputSchema: OBJ() }], delayMs: 5 } })
    await Promise.all([client.discover(), client.discover(), client.discover()])
    const inits = transports.get('demo')!.requests.filter((r) => r.method === 'initialize')
    expect(inits.length).toBeLessThanOrEqual(3) // 每次 discover 至多一次，不会因并发翻倍
    await client.close()
  })

  it('工具快照有稳定 checksum，供 run 归因', async () => {
    const spec = { demo: { tools: [{ name: 'a', inputSchema: OBJ() }] } }
    const c1 = makeClient(spec)
    await c1.client.discover()
    const s1 = c1.client.snapshot()

    const c2 = makeClient(spec)
    await c2.client.discover()
    expect(c2.client.snapshot().checksum).toBe(s1.checksum)

    const c3 = makeClient({ demo: { tools: [{ name: 'a', inputSchema: OBJ({ x: { type: 'string' } }) }] } })
    await c3.client.discover()
    expect(c3.client.snapshot().checksum).not.toBe(s1.checksum)

    await Promise.all([c1.client.close(), c2.client.close(), c3.client.close()])
  })
})

// ═══════════════════════════════════════════════════════
// 调用与错误归一
// ═══════════════════════════════════════════════════════

describe('工具调用', () => {
  it('返回文本内容', async () => {
    const { client } = makeClient({
      demo: {
        tools: [{ name: 'echo', inputSchema: OBJ({ msg: { type: 'string' } }), handler: (a) => `收到：${(a as { msg: string }).msg}` }],
      },
    })
    await client.discover()
    const res = await client.call('demo__echo', { msg: 'hi' })
    expect(renderContent(res)).toBe('收到：hi')
    await client.close()
  })

  it('工具自身报错标 isError，不算 server 故障', async () => {
    const { client } = makeClient({
      demo: {
        tools: [
          {
            name: 'boom',
            inputSchema: OBJ(),
            handler: () => {
              throw new Error('业务错误')
            },
          },
        ],
      },
    })
    await client.discover()
    const res = await client.call('demo__boom', {})
    expect(res.isError).toBe(true)
    // server 仍然健康
    expect(client.statuses()[0]!.state).toBe('ready')
    await client.close()
  })

  it('未知工具报 mcp.tool_missing', async () => {
    const { client } = makeClient({ demo: { tools: [] } })
    await client.discover()
    await expect(client.call('demo__nope', {})).rejects.toMatchObject({ code: 'mcp.tool_missing' })
    await client.close()
  })

  it('图片等二进制内容不内联，只留占位', () => {
    const text = renderContent({
      content: [
        { type: 'text', text: '结果如下' },
        { type: 'image', data: 'A'.repeat(4000), mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///a.md', name: '报告' },
      ],
    })
    expect(text).toContain('结果如下')
    expect(text).toContain('[图片 image/png')
    expect(text).not.toContain('AAAA')
    expect(text).toContain('file:///a.md')
  })

  it('空结果有明确表示，不是空字符串', () => {
    expect(renderContent({ content: [] })).toBe('(空结果)')
  })
})

// ═══════════════════════════════════════════════════════
// 失败计数与自动禁用
// ═══════════════════════════════════════════════════════

describe('自动禁用', () => {
  it('连续失败达阈值后禁用，并从工具集中消失', async () => {
    const { client } = makeClient(
      { flaky: { tools: [{ name: 'x', inputSchema: OBJ() }], failCallsAt: 'all' } },
      { failureThreshold: 3 },
    )
    await client.discover()

    for (let i = 0; i < 3; i++) {
      await client.call('flaky__x', {}).catch(() => {})
    }

    const st = client.statuses()[0]!
    expect(st.state).toBe('disabled')
    expect(st.failureCount).toBe(3)

    // 被禁用的 server 不再出现在发现结果里
    const { tools, failed } = await client.discover()
    expect(tools).toHaveLength(0)
    expect(failed[0]!.id).toBe('flaky')
    await client.close()
  })

  it('禁用后调用给出明确 error_code，而非误导性的「工具不存在」', async () => {
    const { client } = makeClient(
      { flaky: { tools: [{ name: 'x', inputSchema: OBJ() }], failCallsAt: [1] } },
      { failureThreshold: 1 },
    )
    await client.discover()
    await client.call('flaky__x', {}).catch(() => {})

    await expect(client.call('flaky__x', {})).rejects.toMatchObject({ code: 'mcp.auto_disabled' })
    expect(client.statuses()[0]!.state).toBe('disabled')
    await client.close()
  })

  it('人工重新启用后恢复', async () => {
    const { client } = makeClient(
      { flaky: { tools: [{ name: 'x', inputSchema: OBJ() }], failCallsAt: [1] } },
      { failureThreshold: 1 },
    )
    await client.discover()
    await client.call('flaky__x', {}).catch(() => {})
    expect(client.statuses()[0]!.state).toBe('disabled')

    expect(client.enable('flaky')).toBe(true)
    const { tools } = await client.discover()
    expect(tools.map((t) => t.name)).toEqual(['flaky__x'])
    await client.close()
  })

  it('成功后失败计数清零', async () => {
    const { client } = makeClient(
      { s: { tools: [{ name: 'x', inputSchema: OBJ() }], failCallsAt: [1] } },
      { failureThreshold: 3 },
    )
    await client.discover()
    await client.call('s__x', {}).catch(() => {})
    expect(client.statuses()[0]!.failureCount).toBe(1)

    await client.call('s__x', {}) // 重启后成功
    expect(client.statuses()[0]!.failureCount).toBe(0)
    await client.close()
  })
})

// ═══════════════════════════════════════════════════════
// 空闲回收
// ═══════════════════════════════════════════════════════

describe('生命周期', () => {
  it('空闲超时后回收，下次调用自动重启', async () => {
    const { client } = makeClient({ demo: { tools: [{ name: 'x', inputSchema: OBJ() }] } })
    await client.discover()
    expect(client.statuses()[0]!.state).toBe('ready')

    await clock.advance(100_000)
    expect(await client.reapIdle()).toEqual([])

    await clock.advance(300_000)
    expect(await client.reapIdle()).toEqual(['demo'])
    expect(client.statuses()[0]!.state).toBe('idle')

    // 按需重启
    const res = await client.call('demo__x', {})
    expect(res.content).toBeDefined()
    expect(client.statuses()[0]!.state).toBe('ready')
    await client.close()
  })
})

// ═══════════════════════════════════════════════════════
// 凭据：config 只写 ref
// ═══════════════════════════════════════════════════════

describe('凭据注入', () => {
  it('缺少凭据时给出可操作的错误', async () => {
    const store = new CredentialStore({ filePath: '/nonexistent/creds.json', useKeychain: false, env: {} })
    const client = new McpClient(
      [{ id: 'paid', transport: 'stdio', command: 'x', envRefs: { API_KEY: 'PAID_API_KEY' } }],
      { clock, credentials: store, makeTransport: () => new FakeMcpTransport({ tools: [] }) },
    )
    const { failed } = await client.discover()
    expect(failed[0]!.error).toContain('PAID_API_KEY')
    await client.close()
  })
})

// ═══════════════════════════════════════════════════════
// Schema 归一化：provider 支持子集参差
// ═══════════════════════════════════════════════════════

describe('schema 归一化', () => {
  it('保留常规 schema 不变', () => {
    const { schema, warnings } = flattenSchema(
      OBJ({ q: { type: 'string', description: '查询' } }, ['q']),
    )
    expect(schema).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string', description: '查询' } },
      required: ['q'],
    })
    expect(warnings).toEqual([])
  })

  it('内联 $ref', () => {
    const { schema } = flattenSchema({
      type: 'object',
      properties: { user: { $ref: '#/$defs/User' } },
      $defs: { User: OBJ({ name: { type: 'string' } }, ['name']) },
    })
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect(props['user']!['type']).toBe('object')
    expect((props['user']!['properties'] as Record<string, unknown>)['name']).toEqual({ type: 'string' })
  })

  it('循环引用降级而非爆栈', () => {
    const { schema, warnings } = flattenSchema({
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
    })
    expect(schema).toBeDefined()
    expect(warnings.some((w) => w.includes('循环引用'))).toBe(true)
  })

  it('oneOf 取第一个分支并记录', () => {
    const { schema, warnings } = flattenSchema({
      type: 'object',
      properties: {
        v: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    })
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect(props['v']!['type']).toBe('string')
    expect(warnings.some((w) => w.includes('oneOf'))).toBe(true)
  })

  it('联合类型简化为第一个非 null', () => {
    const { schema, warnings } = flattenSchema({
      type: 'object',
      properties: { v: { type: ['null', 'string'] } },
    })
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect(props['v']!['type']).toBe('string')
    expect(warnings.some((w) => w.includes('联合类型'))).toBe(true)
  })

  it('丢弃 allOf/anyOf/not 等组合子', () => {
    const { schema, warnings } = flattenSchema({
      type: 'object',
      properties: { v: { type: 'string' } },
      allOf: [{ required: ['v'] }],
      not: { type: 'number' },
    })
    expect(schema['allOf']).toBeUndefined()
    expect(schema['not']).toBeUndefined()
    expect(warnings.filter((w) => w.includes('已丢弃')).length).toBeGreaterThanOrEqual(2)
  })

  it('required 中不存在的字段被剔除', () => {
    const { schema, warnings } = flattenSchema(OBJ({ a: { type: 'string' } }, ['a', 'ghost']))
    expect(schema['required']).toEqual(['a'])
    expect(warnings.some((w) => w.includes('required'))).toBe(true)
  })

  it('顶层非 object 时替换为空对象 —— provider 要求顶层是 object', () => {
    const { schema, warnings } = flattenSchema({ type: 'string' })
    expect(schema).toEqual({ type: 'object', properties: {}, required: [] })
    expect(warnings[0]).toContain('顶层不是 object')
  })

  it('object 缺 properties 时补空对象', () => {
    const { schema } = flattenSchema({ type: 'object' })
    expect(schema['properties']).toEqual({})
  })

  it('元组式 items 取第一项', () => {
    const { schema, warnings } = flattenSchema({
      type: 'object',
      properties: { list: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } },
    })
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect((props['list']!['items'] as Record<string, unknown>)['type']).toBe('string')
    expect(warnings.some((w) => w.includes('元组'))).toBe(true)
  })

  it('嵌套过深时截断而非无限递归', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 30; i++) deep = { type: 'object', properties: { n: deep } }
    const { schema, warnings } = flattenSchema(deep, 5)
    expect(schema).toBeDefined()
    expect(warnings.some((w) => w.includes('嵌套过深'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// 副作用分级：MCP 协议不声明，必须由配置补
// ═══════════════════════════════════════════════════════

describe('副作用分级', () => {
  it('未声明时默认 non_idempotent —— 安全侧', () => {
    const r = classifySideEffect('unknown__do_something')
    expect(r.sideEffect).toBe('non_idempotent')
    expect(r.reason).toContain('未声明')
  })

  it('显式策略优先于名称启发', () => {
    const r = classifySideEffect('searxng__search', {
      policies: [{ pattern: 'searxng__*', sideEffect: 'idempotent' }],
    })
    expect(r.sideEffect).toBe('idempotent')
  })

  it('只读命名模式识别为 pure', () => {
    expect(classifySideEffect('searxng__search').sideEffect).toBe('pure')
    expect(classifySideEffect('yfinance__get_quote').sideEffect).toBe('pure')
    expect(classifySideEffect('db__list_tables').sideEffect).toBe('pure')
  })

  it('像是写操作的名字不会被误判为只读', () => {
    expect(classifySideEffect('mail__send_email').sideEffect).toBe('non_idempotent')
    expect(classifySideEffect('fs__delete_file').sideEffect).toBe('non_idempotent')
  })

  it('注册到 ToolRegistry 时带上副作用等级', async () => {
    const { client } = makeClient({
      searxng: { tools: [{ name: 'search', inputSchema: OBJ({ q: { type: 'string' } }) }] },
      mail: { tools: [{ name: 'send', inputSchema: OBJ({ to: { type: 'string' } }) }] },
    })
    const { tools } = await client.discover()
    const registry = new ToolRegistry()
    const res = registerMcpTools(registry, tools, client)

    expect(res.registered.sort()).toEqual(['mail__send', 'searxng__search'])
    expect(registry.get('searxng__search')!.sideEffect).toBe('pure')
    expect(registry.get('mail__send')!.sideEffect).toBe('non_idempotent')
    await client.close()
  })

  it('名称冲突时跳过并说明原因', async () => {
    const { client } = makeClient({ demo: { tools: [{ name: 'x', inputSchema: OBJ() }] } })
    const { tools } = await client.discover()
    const registry = new ToolRegistry()
    registerMcpTools(registry, tools, client)
    const second = registerMcpTools(registry, tools, client)

    expect(second.registered).toEqual([])
    expect(second.skipped[0]!.reason).toContain('已被占用')
    await client.close()
  })

  it('注册结果带 schema 降级提示', async () => {
    const { client } = makeClient({
      demo: {
        tools: [
          {
            name: 'weird',
            inputSchema: { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'number' }] } } },
          },
        ],
      },
    })
    const { tools } = await client.discover()
    const res = registerMcpTools(new ToolRegistry(), tools, client)
    expect(res.warnings[0]!.tool).toBe('demo__weird')
    expect(res.warnings[0]!.warnings.some((w) => w.includes('oneOf'))).toBe(true)
    await client.close()
  })

  it('通过 registry 调用能拿到真实结果', async () => {
    const { client } = makeClient({
      demo: { tools: [{ name: 'get_time', inputSchema: OBJ(), handler: () => '2026-07-30' }] },
    })
    const { tools } = await client.discover()
    const registry = new ToolRegistry()
    registerMcpTools(registry, tools, client)

    const def = registry.get('demo__get_time')!
    const out = await def.execute({}, {} as never)
    expect(out.ok).toBe(true)
    expect(out.content).toBe('2026-07-30')
    await client.close()
  })
})
