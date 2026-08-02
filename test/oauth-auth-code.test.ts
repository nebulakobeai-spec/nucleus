import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore } from '../src/auth/credentials.js'
import {
  AuthCodeClient,
  accountIdFromToken,
  decodeJwtPayload,
  isTrustedDomain,
  parseOAuthCallbackInput,
  type AuthCodeProviderConfig,
} from '../src/auth/oauth-auth-code.js'
import { OAuthRegistry, buildProvider } from '../src/auth/providers.js'

/**
 * Authorization Code Flow + PKCE + 本地回调。
 *
 * 参见 docs/OAUTH-AUTHORIZATION-CODE.md §6 的测试清单。
 */

const CFG: AuthCodeProviderConfig = {
  id: 'demo',
  clientId: 'test-client-id',
  authorizeUrl: 'https://auth.example.com/oauth/authorize',
  tokenUrl: 'https://auth.example.com/oauth/token',
  callbackPort: 34567,
  callbackPath: '/auth/callback',
  scope: ['openid', 'profile', 'offline_access'],
  usePkce: true,
  extraAuthorizeParams: { originator: 'nucleus' },
}

function json(body: unknown, status = 200): () => Response {
  return () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function scripted(makers: Array<() => Response>) {
  const calls: Array<{ url: string; body: URLSearchParams; method: string }> = []
  let i = 0
  const f = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
    })
    return makers[Math.min(i++, makers.length - 1)]!()
  }
  return Object.assign(f, { calls })
}

const base64url = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// ═══════════════════════════════════════════════════════
// PKCE 与 state
// ═══════════════════════════════════════════════════════

describe('PKCE', () => {
  it('challenge 确实是 verifier 的 S256 base64url', () => {
    const client = new AuthCodeClient(CFG)
    const { verifier, challenge, method } = client.createPkce()

    expect(method).toBe('S256')
    // 独立复算，而不是信实现自己说的
    const expected = base64url(createHash('sha256').update(verifier).digest())
    expect(challenge).toBe(expected)
  })

  it('verifier 至少 256 位熵，且是 base64url 字符集', () => {
    const { verifier } = new AuthCodeClient(CFG).createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(verifier.length).toBeGreaterThanOrEqual(43) // 32 字节 base64url
  })

  it('每次生成都不同', () => {
    const c1 = new AuthCodeClient(CFG).createPkce()
    const c2 = new AuthCodeClient(CFG).createPkce()
    expect(c1.verifier).not.toBe(c2.verifier)
  })

  it('state 是随机的且足够长', () => {
    const client = new AuthCodeClient(CFG)
    const s1 = client.createState()
    const s2 = client.createState()
    expect(s1).not.toBe(s2)
    expect(s1.length).toBeGreaterThanOrEqual(20)
  })
})

// ═══════════════════════════════════════════════════════
// clientId 是必填的 —— 不借用他人的应用标识
// ═══════════════════════════════════════════════════════

describe('clientId', () => {
  it('缺少 clientId 时构造即失败，不静默降级', () => {
    expect(() => new AuthCodeClient({ ...CFG, clientId: '' })).toThrow(/clientId/)
  })

  it('注册表跳过没有 clientId 的声明', () => {
    const reg = new OAuthRegistry({
      openai: { clientId: '' } as never,
      demo: { clientId: 'x', authorizeUrl: 'https://a/x', tokenUrl: 'https://a/t' },
    })
    expect(reg.ids()).toEqual(['demo'])
  })

  it('内置模板提供端点但不提供 clientId', () => {
    // 模板里只有公开的协议事实；应用标识必须自己申请
    const built = buildProvider('openai', { clientId: '' } as never)
    expect(built).toBeNull()

    const withId = buildProvider('openai', { clientId: 'my-own-id' })
    expect(withId?.kind).toBe('auth_code')
    expect(withId?.config.clientId).toBe('my-own-id')
    // 端点由模板补齐
    expect((withId!.config as AuthCodeProviderConfig).authorizeUrl).toContain('auth.openai.com')
  })

  it('声明里的值覆盖模板', () => {
    const built = buildProvider('openai', {
      clientId: 'x',
      callbackPort: 9999,
      scope: ['custom'],
    })
    const cfg = built!.config as AuthCodeProviderConfig
    expect(cfg.callbackPort).toBe(9999)
    expect(cfg.scope).toEqual(['custom'])
  })
})

// ═══════════════════════════════════════════════════════
// 配置文件加载 —— 回归：auth 命令曾用 defaultConfig 而非 loadConfig，
// 导致 nucleus.config.json 里的 oauthProviders 完全读不到
// ═══════════════════════════════════════════════════════

describe('从配置文件构建注册表', () => {
  it('oauthProviders 声明能被识别', () => {
    const reg = new OAuthRegistry({ openai: { clientId: 'from-config-file' } })
    const entry = reg.get('openai')

    expect(entry).toBeDefined()
    expect(entry!.kind).toBe('auth_code')
    expect(entry!.config.clientId).toBe('from-config-file')
    // 端点由内置模板补齐，不需要在配置里重复写
    expect((entry!.config as AuthCodeProviderConfig).authorizeUrl).toContain('auth.openai.com')
  })

  it('空配置时注册表为空 —— 不会凭空冒出 provider', () => {
    expect(new OAuthRegistry({}).ids()).toEqual([])
    expect(new OAuthRegistry().ids()).toEqual([])
  })

  it('多个 provider 各自独立', () => {
    const reg = new OAuthRegistry({
      openai: { clientId: 'id-a' },
      xai: { clientId: 'id-b' },
    })
    expect(reg.ids()).toEqual(['openai', 'xai'])
    expect(reg.get('openai')!.config.clientId).toBe('id-a')
    expect(reg.get('xai')!.config.clientId).toBe('id-b')
  })
})

// ═══════════════════════════════════════════════════════
// Authorize URL
// ═══════════════════════════════════════════════════════

describe('authorize URL', () => {
  it('包含全部必需参数', () => {
    const client = new AuthCodeClient(CFG)
    const url = new URL(client.buildAuthorizeUrl('CHAL', 'STATE'))

    expect(url.origin + url.pathname).toBe('https://auth.example.com/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:34567/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid profile offline_access')
    expect(url.searchParams.get('state')).toBe('STATE')
    expect(url.searchParams.get('code_challenge')).toBe('CHAL')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('带上 provider 专用参数', () => {
    const url = new URL(new AuthCodeClient(CFG).buildAuthorizeUrl('C', 'S'))
    expect(url.searchParams.get('originator')).toBe('nucleus')
  })

  it('不用 PKCE 时不带 challenge 参数', () => {
    const url = new URL(new AuthCodeClient(CFG).buildAuthorizeUrl(null, 'S'))
    expect(url.searchParams.has('code_challenge')).toBe(false)
  })

  it('自定义 redirectUri 生效', () => {
    const client = new AuthCodeClient({ ...CFG, redirectUri: 'http://127.0.0.1:8080/cb' })
    expect(client.redirectUri).toBe('http://127.0.0.1:8080/cb')
    expect(new URL(client.buildAuthorizeUrl('C', 'S')).searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:8080/cb',
    )
  })
})

// ═══════════════════════════════════════════════════════
// 回调 URL 解析与 state 校验
// ═══════════════════════════════════════════════════════

describe('回调解析', () => {
  it('从完整 URL 提取 code', () => {
    const r = parseOAuthCallbackInput(
      'http://localhost:1455/auth/callback?code=THE_CODE&state=ST',
      'ST',
    )
    expect(r.code).toBe('THE_CODE')
  })

  it('接受纯 code（用户只粘了授权码）', () => {
    expect(parseOAuthCallbackInput('  RAW_CODE  ', 'ST').code).toBe('RAW_CODE')
  })

  it('state 不匹配一律拒绝 —— 这是 CSRF 防线', () => {
    expect(() =>
      parseOAuthCallbackInput('http://localhost/cb?code=X&state=WRONG', 'EXPECTED'),
    ).toThrow(/state/)
  })

  it('provider 返回 error 时如实报出', () => {
    expect(() =>
      parseOAuthCallbackInput('http://localhost/cb?error=access_denied', 'ST'),
    ).toThrow(/access_denied/)
  })

  it('URL 里没有 code 时报错', () => {
    expect(() => parseOAuthCallbackInput('http://localhost/cb?state=ST', 'ST')).toThrow(/code/)
  })

  it('空输入与含空白的输入被拒', () => {
    expect(() => parseOAuthCallbackInput('   ', 'ST')).toThrow()
    expect(() => parseOAuthCallbackInput('not a code', 'ST')).toThrow()
  })
})

// ═══════════════════════════════════════════════════════
// 本地回调服务器
// ═══════════════════════════════════════════════════════

/**
 * 回调服务器需要监听本地端口。
 *
 * 开发机的安全策略禁止 Node 进程监听（`listen EPERM`，与 tsx IPC 被挡同源），
 * 所以这组在本地自动跳过 —— **不是代码问题**。
 * 部署机上会正常执行；`canListen` 探测的就是这个能力。
 */
const canListen = await (async () => {
  const { createServer } = await import('node:http')
  return new Promise<boolean>((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => {
      s.close()
      resolve(true)
    })
    try {
      s.listen(0, '127.0.0.1')
    } catch {
      resolve(false)
    }
  })
})()

describe.skipIf(!canListen)('回调服务器（需要监听端口）', () => {
  let servers: Array<{ close: () => void }> = []

  afterEach(async () => {
    // await：否则下一个测试可能在端口还没释放时就去绑
    await Promise.all(servers.map((s) => s.close()))
    servers = []
  })

  /** 用随机高位端口，避免与开发机上其它服务冲突 */
  function cfgWithPort(port: number): AuthCodeProviderConfig {
    return { ...CFG, callbackPort: port }
  }

  it('收到合法回调后 resolve 出 code', async () => {
    const port = 39001
    const client = new AuthCodeClient(cfgWithPort(port))
    const server = await client.startCallbackServer('STATE-1')
    servers.push(server)

    expect(server.listeningOn).not.toBeNull()

    const res = await fetch(`http://localhost:${port}/auth/callback?code=ABC&state=STATE-1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('授权完成')
    expect(await server.waitForCode).toBe('ABC')
  })

  it('state 不匹配时返回 400 并拒绝', async () => {
    const port = 39002
    const client = new AuthCodeClient(cfgWithPort(port))
    const server = await client.startCallbackServer('EXPECTED')
    servers.push(server)

    const res = await fetch(`http://localhost:${port}/auth/callback?code=ABC&state=FORGED`)
    expect(res.status).toBe(400)
    await expect(server.waitForCode).rejects.toThrow(/state/)
  })

  it('provider 回调带 error 时如实传递', async () => {
    const port = 39003
    const client = new AuthCodeClient(cfgWithPort(port))
    const server = await client.startCallbackServer('S')
    servers.push(server)

    await fetch(`http://localhost:${port}/auth/callback?error=access_denied&state=S`)
    await expect(server.waitForCode).rejects.toThrow(/access_denied/)
  })

  it('其它路径返回 404，不影响等待', async () => {
    const port = 39004
    const client = new AuthCodeClient(cfgWithPort(port))
    const server = await client.startCallbackServer('S')
    servers.push(server)

    expect((await fetch(`http://localhost:${port}/other`)).status).toBe(404)

    await fetch(`http://localhost:${port}/auth/callback?code=OK&state=S`)
    expect(await server.waitForCode).toBe('OK')
  })

  it('端口被占时降级而非崩溃 —— 远程环境靠手动粘贴', async () => {
    const port = 39005
    const first = await new AuthCodeClient(cfgWithPort(port)).startCallbackServer('S')
    servers.push(first)
    expect(first.listeningOn).not.toBeNull()

    const second = await new AuthCodeClient(cfgWithPort(port)).startCallbackServer('S')
    servers.push(second)
    expect(second.listeningOn).toBeNull() // 降级，不抛错
  })

  it('拒绝非 loopback 的 redirect_uri', async () => {
    const client = new AuthCodeClient({ ...CFG, redirectUri: 'http://192.168.1.5:1455/cb' })
    await expect(client.startCallbackServer('S')).rejects.toThrow(/loopback/)
  })

  /**
   * 回调端口是**固定的**（provider 那边注册的 redirect_uri 写死了端口），
   * 所以「登录失败后重试」必然要重新绑同一个端口。close 必须可 await ——
   * 原来这里是 `close()` 然后 sleep 50ms，在负载下就是随机的 EADDRINUSE，
   * 而这一组平时被跳过（本机 listen 是 EPERM），所以那次随机失败很难被抓到。
   */
  it('close 之后端口立刻可以重新绑定（不靠 sleep 猜）', async () => {
    const port = 39006
    const server = await new AuthCodeClient(cfgWithPort(port)).startCallbackServer('S')
    expect(server.listeningOn).not.toBeNull()
    await server.close()

    const again = await new AuthCodeClient(cfgWithPort(port)).startCallbackServer('S')
    servers.push(again)
    expect(again.listeningOn).not.toBeNull()
  })

  it('重复 close 不抛', async () => {
    const port = 39007
    const server = await new AuthCodeClient(cfgWithPort(port)).startCallbackServer('S')
    await server.close()
    await expect(server.close()).resolves.toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════
// Token 交换与刷新
// ═══════════════════════════════════════════════════════

describe('token 交换', () => {
  it('请求体包含 grant_type / code / verifier / redirect_uri', async () => {
    const f = scripted([json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })])
    const client = new AuthCodeClient(CFG, { fetch: f, now: () => 1_000_000 })

    const token = await client.exchangeCode('THE_CODE', 'THE_VERIFIER')

    const body = f.calls[0]!.body
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('test-client-id')
    expect(body.get('code')).toBe('THE_CODE')
    expect(body.get('code_verifier')).toBe('THE_VERIFIER')
    // redirect_uri 必须与 authorize 时一致，否则 provider 拒绝
    expect(body.get('redirect_uri')).toBe('http://localhost:34567/auth/callback')

    expect(token.accessToken).toBe('AT')
    expect(token.refreshToken).toBe('RT')
    expect(token.expiresAt).toBe(1_000_000 + 3_600_000)
  })

  it('expires_in 缺失时 expiresAt 为 null（不过期）', async () => {
    const f = scripted([json({ access_token: 'AT' })])
    const t = await new AuthCodeClient(CFG, { fetch: f }).exchangeCode('C', 'V')
    expect(t.expiresAt).toBeNull()
  })

  it('provider 返回 error 时给出可读信息', async () => {
    const f = scripted([
      json({ error: 'invalid_grant', error_description: 'code 已使用' }, 400),
    ])
    await expect(new AuthCodeClient(CFG, { fetch: f }).exchangeCode('C', 'V')).rejects.toThrow(
      /invalid_grant.*code 已使用/,
    )
  })

  it('响应不是 JSON 时报错但不崩溃', async () => {
    const f = scripted([() => new Response('<html>502</html>', { status: 502 })])
    await expect(new AuthCodeClient(CFG, { fetch: f }).exchangeCode('C', 'V')).rejects.toThrow(
      /不是 JSON/,
    )
  })

  it('HTTP 200 但缺 access_token 也算失败', async () => {
    const f = scripted([json({ token_type: 'Bearer' })])
    await expect(new AuthCodeClient(CFG, { fetch: f }).exchangeCode('C', 'V')).rejects.toThrow()
  })
})

describe('token 刷新', () => {
  it('rotation：返回新 refresh_token 时使用新的', async () => {
    const f = scripted([json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })])
    const t = await new AuthCodeClient(CFG, { fetch: f }).refresh('RT1')
    expect(t.accessToken).toBe('AT2')
    expect(t.refreshToken).toBe('RT2')
  })

  it('provider 不回 refresh_token 时沿用旧的', async () => {
    const f = scripted([json({ access_token: 'AT2', expires_in: 3600 })])
    const t = await new AuthCodeClient(CFG, { fetch: f }).refresh('RT1')
    expect(t.refreshToken).toBe('RT1')
  })

  it('refresh 请求体正确', async () => {
    const f = scripted([json({ access_token: 'AT' })])
    await new AuthCodeClient(CFG, { fetch: f }).refresh('RT1')
    const body = f.calls[0]!.body
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT1')
    expect(body.get('client_id')).toBe('test-client-id')
  })
})

// ═══════════════════════════════════════════════════════
// OIDC Discovery 与端点信任
// ═══════════════════════════════════════════════════════

describe('OIDC discovery', () => {
  const DISCO: AuthCodeProviderConfig = {
    ...CFG,
    discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
    trustedDomain: 'x.ai',
  }

  it('动态取端点', async () => {
    const f = scripted([
      json({
        authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
        token_endpoint: 'https://auth.x.ai/oauth/token',
      }),
    ])
    const e = await new AuthCodeClient(DISCO, { fetch: f }).resolveEndpoints()
    expect(e.authorizeUrl).toBe('https://auth.x.ai/oauth/authorize')
    expect(e.tokenUrl).toBe('https://auth.x.ai/oauth/token')
  })

  it('结果被缓存，不重复请求', async () => {
    const f = scripted([
      json({
        authorization_endpoint: 'https://auth.x.ai/a',
        token_endpoint: 'https://auth.x.ai/t',
      }),
    ])
    const client = new AuthCodeClient(DISCO, { fetch: f })
    await client.resolveEndpoints()
    await client.resolveEndpoints()
    expect(f.calls).toHaveLength(1)
  })

  it('端点被篡改指向外部域名时拒绝 —— 否则整个授权流程被劫持', async () => {
    const f = scripted([
      json({
        authorization_endpoint: 'https://evil.example.com/authorize',
        token_endpoint: 'https://auth.x.ai/token',
      }),
    ])
    await expect(new AuthCodeClient(DISCO, { fetch: f }).resolveEndpoints()).rejects.toThrow(
      /信任域/,
    )
  })

  it('token 端点被篡改同样拒绝', async () => {
    const f = scripted([
      json({
        authorization_endpoint: 'https://auth.x.ai/authorize',
        token_endpoint: 'https://evil.example.com/token',
      }),
    ])
    await expect(new AuthCodeClient(DISCO, { fetch: f }).resolveEndpoints()).rejects.toThrow(
      /信任域/,
    )
  })

  it('discovery 缺字段时报错', async () => {
    const f = scripted([json({ issuer: 'https://auth.x.ai' })])
    await expect(new AuthCodeClient(DISCO, { fetch: f }).resolveEndpoints()).rejects.toThrow(
      /缺少/,
    )
  })

  it('域名匹配：精确与子域通过，相似域名不通过', () => {
    expect(isTrustedDomain('https://x.ai/a', 'x.ai')).toBe(true)
    expect(isTrustedDomain('https://auth.x.ai/a', 'x.ai')).toBe(true)
    // 后缀相似但不是子域 —— 经典的域名混淆攻击
    expect(isTrustedDomain('https://evilx.ai/a', 'x.ai')).toBe(false)
    expect(isTrustedDomain('https://x.ai.evil.com/a', 'x.ai')).toBe(false)
    expect(isTrustedDomain('not-a-url', 'x.ai')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// JWT 解析（OpenAI 的 accountId）
// ═══════════════════════════════════════════════════════

describe('JWT', () => {
  const makeJwt = (payload: unknown) =>
    `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

  it('提取 accountId', () => {
    expect(accountIdFromToken(makeJwt({ accountId: 'acc_123' }))).toBe('acc_123')
    expect(accountIdFromToken(makeJwt({ account_id: 'acc_456' }))).toBe('acc_456')
  })

  it('非 JWT 或缺字段时返回 null，不抛错', () => {
    expect(accountIdFromToken('not-a-jwt')).toBeNull()
    expect(accountIdFromToken(makeJwt({ sub: 'x' }))).toBeNull()
    expect(decodeJwtPayload('a.!!!.c')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// 凭据存储：记住用哪个 provider 登录的
// ═══════════════════════════════════════════════════════

describe('OAuth 凭据', () => {
  let dir: string
  let store: CredentialStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nucleus-oauth-'))
    store = new CredentialStore({
      filePath: join(dir, 'credentials.json'),
      useKeychain: false,
      env: {},
    })
  })

  it('providerId 被持久化 —— 刷新时要用同一个 clientId 与端点', async () => {
    await store.setOAuth('OPENAI_OAUTH', {
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: Date.now() + 3600_000,
      providerId: 'openai',
    })
    const cred = await store.get('OPENAI_OAUTH')
    expect(cred).toMatchObject({ kind: 'oauth', providerId: 'openai', refreshToken: 'RT' })
  })

  it('resolve 返回 accessToken 作为 secret，router 直接当 Bearer 用', async () => {
    await store.setOAuth('X', { accessToken: 'AT', expiresAt: null })
    const r = await store.resolve('X')
    expect(r?.secret).toBe('AT')
    expect(r?.kind).toBe('oauth')
  })

  it('list 不泄露 accessToken', async () => {
    await store.setOAuth('X', { accessToken: 'super-secret-token-value', expiresAt: null })
    const listed = JSON.stringify(await store.list(['X']))
    expect(listed).not.toContain('super-secret-token-value')
  })
})
