import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, redact, redactText } from '../src/auth/credentials.js'
import { needsRefresh, OAuthClient, type OAuthProviderConfig } from '../src/auth/oauth.js'

let dir: string
let store: CredentialStore
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nucleus-cred-'))
  env = {}
  // 测试中一律不碰 keychain：会弹窗、会污染用户真实钥匙串
  store = new CredentialStore({ filePath: join(dir, 'credentials.json'), useKeychain: false, env })
})

afterEach(() => {
  /* tmpdir 由系统清理 */
})

// ═══════════════════════════════════════════════════════
// 脱敏 —— 密钥绝不出现在日志、UI、诊断包里
// ═══════════════════════════════════════════════════════

describe('脱敏', () => {
  it('只保留尾部 4 位', () => {
    expect(redact('sk-proj-abcdefghijklmnop')).toBe('************mnop')
    expect(redact('short')).toBe('****')
    expect(redact('')).toBe('(空)')
    expect(redact(null)).toBe('(空)')
  })

  it('文本中的各家密钥形态都被抹掉', () => {
    // 全部是构造的假值 —— 测试数据里不放任何真实密钥，
    // 哪怕是已经轮换过的
    const raw = [
      'OPENAI_API_KEY=sk-proj-1234567890abcdefXYZW',
      'xai key: xai-abcdefghijklmnopqrstuv',
      '{"api_key":"00000000000000000000000000000000.AAAAAAAAAAAAAAAA"}',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    ].join('\n')

    const safe = redactText(raw)
    expect(safe).not.toContain('sk-proj-1234567890abcdefXYZW')
    expect(safe).not.toContain('xai-abcdefghijklmnopqrstuv')
    expect(safe).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(safe).not.toContain('AAAAAAAAAAAAAAAA')
    // 结构保留，便于阅读
    expect(safe).toContain('OPENAI_API_KEY=')
    expect(safe).toContain('Bearer ')
  })

  /**
   * ── 「字段名 : 值」形态，引号可以是转义的 ────────────────
   *
   * 原先只认裸的双引号 `"api_key":"..."`。而**日志里最常见的形态不是它** ——
   * 一段 JSON 被当成字符串写进外层 JSON 时，引号会被转义：
   *
   *     {"body":"{\"api_key\":\"super-secret-value\"}"}
   *
   * 那正是「把请求体记进日志」的样子。给落盘日志写测试时才发现这一版整个
   * 没被抹掉 —— 而那个功能的全部意义就是「日志能交给别人看」。
   */
  it('转义引号、单引号、query、env 形态都认', () => {
    const cases = [
      JSON.stringify({ body: '{"api_key":"AAAAAAAAAAAA"}' }),
      "{'api_key': 'AAAAAAAAAAAA'}",
      'https://api.example.com/v1?api_key=AAAAAAAAAAAA&q=1',
      'MY_TOKEN=AAAAAAAAAAAA',
      '{"refresh_token":"AAAAAAAAAAAA"}',
      'authorization: AAAAAAAAAAAA',
    ]
    for (const raw of cases) {
      expect(redactText(raw), raw).not.toContain('AAAAAAAAAAAA')
    }
  })

  /**
   * **不能把正常内容也抹掉。** 日志的价值在于内容 ——
   * 一个过度脱敏的日志和没有日志差不多。
   */
  it('普通字段不受影响', () => {
    const raw = '{"goal":"查一下 2026 年的显卡价格","confidence":0.85,"status":"ok"}'
    expect(redactText(raw)).toBe(raw)
  })

  it('不误伤普通文本', () => {
    const text = '这是一段正常的说明，提到了 bearer token 的概念但没有实际值。'
    expect(redactText(text)).toBe(text)
  })
})

// ═══════════════════════════════════════════════════════
// 解析优先级：env > keychain > file
// ═══════════════════════════════════════════════════════

describe('凭据解析', () => {
  it('未配置时返回 null', async () => {
    expect(await store.resolve('MISSING_KEY')).toBeNull()
  })

  it('文件后端往返', async () => {
    const source = await store.setApiKey('ZAI_API_KEY', 'secret-value-1234')
    expect(source).toBe('file')

    const r = await store.resolve('ZAI_API_KEY')
    expect(r).toMatchObject({ kind: 'api_key', source: 'file', secret: 'secret-value-1234' })
  })

  it('环境变量优先于文件', async () => {
    await store.setApiKey('ZAI_API_KEY', 'from-file')
    env['ZAI_API_KEY'] = 'from-env'

    const r = await store.resolve('ZAI_API_KEY')
    expect(r!.secret).toBe('from-env')
    expect(r!.source).toBe('env')
  })

  it('凭据文件权限为 0600 —— 不能让同机其他用户读到', async () => {
    await store.setApiKey('K', 'v')
    const s = await stat(join(dir, 'credentials.json'))
    expect(s.mode & 0o777).toBe(0o600)
  })

  it('删除后无法解析', async () => {
    await store.setApiKey('K', 'v')
    expect(await store.delete('K')).toBe(true)
    expect(await store.resolve('K')).toBeNull()
  })

  it('多个 ref 互不干扰', async () => {
    await store.setApiKey('A', 'a-value')
    await store.setApiKey('B', 'b-value')
    expect((await store.resolve('A'))!.secret).toBe('a-value')
    expect((await store.resolve('B'))!.secret).toBe('b-value')
  })

  it('list 返回脱敏值，不含明文', async () => {
    await store.setApiKey('ZAI_API_KEY', 'super-secret-value-9999')
    const items = await store.list(['ZAI_API_KEY', 'NOT_SET'])

    const zai = items.find((i) => i.ref === 'ZAI_API_KEY')!
    expect(zai.source).toBe('file')
    expect(zai.hint).not.toContain('super-secret')
    expect(zai.hint).toContain('9999')

    expect(items.find((i) => i.ref === 'NOT_SET')!.source).toBe('none')
  })

  it('凭据文件里不出现在任何日志路径中的明文（结构检查）', async () => {
    await store.setApiKey('K', 'plaintext-secret')
    // 文件里当然是明文（0600 保护），但 list/resolve 的输出不能泄露
    const onDisk = await readFile(join(dir, 'credentials.json'), 'utf8')
    expect(onDisk).toContain('plaintext-secret')

    const listed = JSON.stringify(await store.list(['K']))
    expect(listed).not.toContain('plaintext-secret')
  })
})

// ═══════════════════════════════════════════════════════
// OAuth device flow
// ═══════════════════════════════════════════════════════

const OAUTH_CFG: OAuthProviderConfig = {
  id: 'demo',
  ref: 'DEMO_OAUTH',
  clientId: 'client-123',
  deviceAuthorizationUrl: 'https://auth.example/device',
  tokenUrl: 'https://auth.example/token',
  scopes: ['read', 'write'],
  usePkce: true,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 可控 fetch：按调用序返回预置响应，并记录请求体。
 *
 * 用工厂函数而非 Response 实例 —— Response 的 body 只能读一次，
 * 复用同一个实例会在「响应用尽后重复返回」时静默失败。
 */
function scripted(makers: Array<() => Response>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = []
  let i = 0
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) })
    return makers[Math.min(i++, makers.length - 1)]!()
  }
  return Object.assign(f, { calls })
}

describe('OAuth device flow', () => {
  let now = 1_700_000_000_000
  const clock = () => now
  const sleep = async (ms: number) => {
    now += ms
  }

  beforeEach(() => {
    now = 1_700_000_000_000
  })

  it('PKCE challenge 是 verifier 的 S256 base64url', () => {
    const client = new OAuthClient(OAUTH_CFG, { random: (n) => Buffer.alloc(n, 7) })
    const p = client.createPkce()
    expect(p.method).toBe('S256')
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(p.challenge).not.toBe(p.verifier)
    // 确定性：同样的随机源产出同样的 challenge
    const p2 = new OAuthClient(OAUTH_CFG, { random: (n) => Buffer.alloc(n, 7) }).createPkce()
    expect(p2.challenge).toBe(p.challenge)
  })

  it('申请 device code 并带上 PKCE 参数', async () => {
    const f = scripted([
      () => json({
        device_code: 'dev-1',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://auth.example/activate',
        expires_in: 600,
        interval: 5,
      }),
    ])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    const auth = await client.requestDeviceCode('challenge-abc')

    expect(auth.userCode).toBe('WXYZ-1234')
    expect(auth.intervalMs).toBe(5000)
    expect(auth.expiresAt).toBe(now + 600_000)

    expect(f.calls[0]!.body.get('client_id')).toBe('client-123')
    expect(f.calls[0]!.body.get('code_challenge')).toBe('challenge-abc')
    expect(f.calls[0]!.body.get('code_challenge_method')).toBe('S256')
    expect(f.calls[0]!.body.get('scope')).toBe('read write')
  })

  it('authorization_pending 时继续轮询直到成功', async () => {
    const f = scripted([
      () => json({ error: 'authorization_pending' }, 400),
      () => json({ error: 'authorization_pending' }, 400),
      () => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' }),
    ])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    const token = await client.pollForToken(
      { deviceCode: 'dev-1', userCode: 'X', verificationUri: 'u', expiresAt: now + 600_000, intervalMs: 1000 },
      'verifier-abc',
    )

    expect(token.accessToken).toBe('at-1')
    expect(token.refreshToken).toBe('rt-1')
    expect(token.expiresAt).toBe(now + 3_600_000)
    expect(f.calls).toHaveLength(3)
    expect(f.calls[0]!.body.get('code_verifier')).toBe('verifier-abc')
    expect(f.calls[0]!.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
  })

  it('slow_down 时加大轮询间隔', async () => {
    const f = scripted([() => json({ error: 'slow_down' }, 400), () => json({ access_token: 'at' })])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    const t0 = now
    await client.pollForToken(
      { deviceCode: 'd', userCode: 'X', verificationUri: 'u', expiresAt: now + 600_000, intervalMs: 1000 },
    )
    // 第一次等 1s，slow_down 后等 6s
    expect(now - t0).toBe(7000)
  })

  it('access_denied 立即失败', async () => {
    const f = scripted([() => json({ error: 'access_denied' }, 400)])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    await expect(
      client.pollForToken({
        deviceCode: 'd',
        userCode: 'X',
        verificationUri: 'u',
        expiresAt: now + 600_000,
        intervalMs: 100,
      }),
    ).rejects.toThrow(/拒绝/)
  })

  it('超过 expiresAt 后停止轮询，不无限等待', async () => {
    const f = scripted([() => json({ error: 'authorization_pending' }, 400)])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    const deadline = now + 2_500

    await expect(
      client.pollForToken({
        deviceCode: 'd',
        userCode: 'X',
        verificationUri: 'u',
        expiresAt: deadline,
        intervalMs: 1000,
      }),
    ).rejects.toThrow(/超时/)

    // 到点即停：不会在截止之后继续发请求
    expect(now).toBeGreaterThanOrEqual(deadline)
    expect(f.calls.length).toBeLessThanOrEqual(3)
  })

  it('已过期的 device code 不发任何请求', async () => {
    const f = scripted([() => json({ access_token: 'should-not-be-reached' })])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    await expect(
      client.pollForToken({
        deviceCode: 'd',
        userCode: 'X',
        verificationUri: 'u',
        expiresAt: now - 1,
        intervalMs: 1000,
      }),
    ).rejects.toThrow(/超时/)
    expect(f.calls).toHaveLength(0)
  })

  it('刷新时服务端不回 refresh_token 则沿用旧的', async () => {
    const f = scripted([() => json({ access_token: 'at-2', expires_in: 3600 })])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    const t = await client.refresh('rt-old')
    expect(t.accessToken).toBe('at-2')
    expect(t.refreshToken).toBe('rt-old')
  })

  it('device code 响应缺字段时明确报错', async () => {
    const f = scripted([() => json({ user_code: 'X' })])
    const client = new OAuthClient(OAUTH_CFG, { fetch: f, now: clock, sleep })
    await expect(client.requestDeviceCode()).rejects.toThrow(/缺少必需字段/)
  })
})

describe('OAuth 凭据存储', () => {
  it('保存并解析 OAuth token', async () => {
    const expiresAt = Date.now() + 3_600_000
    await store.setOAuth('DEMO_OAUTH', {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt,
      scope: 'read',
    })

    const r = await store.resolve('DEMO_OAUTH')
    expect(r).toMatchObject({ kind: 'oauth', secret: 'at-1', expiresAt })

    // get 返回完整凭据（含 refresh token），供刷新流程用
    const full = await store.get('DEMO_OAUTH')
    expect(full).toMatchObject({ kind: 'oauth', refreshToken: 'rt-1' })
  })

  it('过期判定带提前量，避免请求发出时刚好失效', () => {
    const now = 1_700_000_000_000
    const base = { kind: 'oauth' as const, ref: 'X', accessToken: 'a', createdAt: '' }

    expect(needsRefresh({ ...base, expiresAt: now + 300_000 }, now)).toBe(false)
    expect(needsRefresh({ ...base, expiresAt: now + 30_000 }, now)).toBe(true) // 30s < 60s 提前量
    expect(needsRefresh({ ...base, expiresAt: now - 1 }, now)).toBe(true)
    expect(needsRefresh({ ...base, expiresAt: null }, now)).toBe(false) // 不过期
  })

  it('list 显示 oauth 类型与过期时间', async () => {
    const expiresAt = Date.now() + 1000
    await store.setOAuth('DEMO_OAUTH', { accessToken: 'at', expiresAt })
    const item = (await store.list(['DEMO_OAUTH']))[0]!
    expect(item.kind).toBe('oauth')
    expect(item.expiresAt).toBe(expiresAt)
    expect(item.hint).not.toContain('at')
  })
})
