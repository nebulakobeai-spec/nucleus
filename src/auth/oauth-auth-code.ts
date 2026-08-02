import { createServer, type Server } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { NucleusError } from '../errors.js'
import type { TokenResponse } from './oauth.js'

/**
 * OAuth 2.0 Authorization Code Flow + PKCE + 本地回调。
 *
 * 与 device flow（`oauth.ts`）的关键差异：需要监听本地端口接回调，
 * 但用户不必手抄 user_code。OpenAI 只支持这个 flow。
 *
 * 参见 docs/OAUTH-AUTHORIZATION-CODE.md。
 */

/** redirect_uri 只允许 loopback —— 绑到外部地址等于把授权码交给别人 */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export interface AuthCodeProviderConfig {
  id: string
  /**
   * 公共客户端 id。**必填，没有默认值。**
   *
   * 不内置任何第三方产品的 client_id —— 那会把本程序声明成对方。
   * 需要向 provider 申请，或在配置里显式指定。
   */
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  callbackPort: number
  callbackPath: string
  scope: string[]
  /** 公共客户端应当为 true（默认 true） */
  usePkce?: boolean
  /** 默认 http://localhost:{callbackPort}{callbackPath} */
  redirectUri?: string
  /** provider 专用的额外 authorize 参数 */
  extraAuthorizeParams?: Record<string, string>
  /** 机密客户端才有；个人部署一般没有 */
  clientSecret?: string
  /** OIDC discovery；给了就动态取端点 */
  discoveryUrl?: string
  /** discovery 返回的端点必须落在这个域名下，防篡改 */
  trustedDomain?: string
}

export interface CallbackServer {
  /** 收到合法回调时 resolve 出 code */
  waitForCode: Promise<string>
  /**
   * 关闭并释放端口。
   *
   * **返回 Promise：端口真正被释放是异步的。** 想 await 的可以 await，
   * 不 await 的照旧（`server.close()` 仍然是合法调用）。
   *
   * 为什么这不只是测试的方便：回调端口是**固定的**（provider 那边注册的
   * redirect_uri 写死了端口）。所以「上一次登录失败后重试」必然要重新绑同一个
   * 端口 —— 而不能 await 关闭的话，只能靠 sleep 一个猜出来的时长，
   * 在负载下就是随机的 EADDRINUSE。
   */
  close: () => Promise<void>
  /** 实际监听的地址；端口被占时为 null */
  listeningOn: string | null
}

export interface AuthCodeClientOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  random?: (bytes: number) => Buffer
}

export class AuthCodeClient {
  #fetch: (url: string, init: RequestInit) => Promise<Response>
  #now: () => number
  #random: (n: number) => Buffer
  #resolved: { authorizeUrl: string; tokenUrl: string } | null = null

  constructor(
    private cfg: AuthCodeProviderConfig,
    opts: AuthCodeClientOptions = {},
  ) {
    if (!cfg.clientId) {
      throw new NucleusError(
        'provider.auth_failed',
        `OAuth provider ${cfg.id} 缺少 clientId —— 需要在配置中显式指定`,
        { detail: { hint: '在 nucleus.config.json 的 oauthProviders 里填 clientId' } },
      )
    }
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i))
    this.#now = opts.now ?? (() => Date.now())
    this.#random = opts.random ?? ((n) => randomBytes(n))
  }

  get redirectUri(): string {
    return this.cfg.redirectUri ?? `http://localhost:${this.cfg.callbackPort}${this.cfg.callbackPath}`
  }

  // ── PKCE 与 state ───────────────────────────────────

  /** verifier 256 位随机；challenge = base64url(SHA256(verifier)) */
  createPkce(): { verifier: string; challenge: string; method: 'S256' } {
    const verifier = base64url(this.#random(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    return { verifier, challenge, method: 'S256' }
  }

  /** CSRF 防护：128 位随机，回调时逐字节比对 */
  createState(): string {
    return base64url(this.#random(16))
  }

  // ── 端点解析（可选 OIDC discovery）──────────────────

  /**
   * 解析 authorize / token 端点。
   *
   * 配置了 discoveryUrl 就动态取，并**校验返回的端点落在 trustedDomain 下** ——
   * discovery 文档被篡改就等于把授权流程整体劫持。
   */
  async resolveEndpoints(): Promise<{ authorizeUrl: string; tokenUrl: string }> {
    if (this.#resolved) return this.#resolved
    if (!this.cfg.discoveryUrl) {
      this.#resolved = { authorizeUrl: this.cfg.authorizeUrl, tokenUrl: this.cfg.tokenUrl }
      return this.#resolved
    }

    let doc: Record<string, unknown>
    try {
      const res = await this.#fetch(this.cfg.discoveryUrl, { method: 'GET' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      doc = (await res.json()) as Record<string, unknown>
    } catch (e) {
      throw new NucleusError('provider.auth_failed', `OIDC discovery 失败：${(e as Error).message}`, {
        cause: e,
      })
    }

    const authorizeUrl = String(doc['authorization_endpoint'] ?? '')
    const tokenUrl = String(doc['token_endpoint'] ?? '')
    if (!authorizeUrl || !tokenUrl) {
      throw new NucleusError('provider.auth_failed', 'discovery 文档缺少 authorization_endpoint 或 token_endpoint')
    }

    if (this.cfg.trustedDomain) {
      for (const [name, url] of [
        ['authorization_endpoint', authorizeUrl],
        ['token_endpoint', tokenUrl],
      ] as const) {
        if (!isTrustedDomain(url, this.cfg.trustedDomain)) {
          throw new NucleusError(
            'provider.auth_failed',
            `discovery 返回的 ${name} 不在信任域 ${this.cfg.trustedDomain} 下：${url}`,
            { detail: { endpoint: url, trustedDomain: this.cfg.trustedDomain } },
          )
        }
      }
    }

    this.#resolved = { authorizeUrl, tokenUrl }
    return this.#resolved
  }

  // ── Authorize URL ───────────────────────────────────

  buildAuthorizeUrl(challenge: string | null, state: string, endpoint?: string): string {
    const url = new URL(endpoint ?? this.cfg.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.cfg.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    if (this.cfg.scope.length) url.searchParams.set('scope', this.cfg.scope.join(' '))
    url.searchParams.set('state', state)
    if (challenge) {
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
    }
    for (const [k, v] of Object.entries(this.cfg.extraAuthorizeParams ?? {})) {
      url.searchParams.set(k, v)
    }
    return url.toString()
  }

  // ── 本地回调服务器 ──────────────────────────────────

  /**
   * 启动回调服务器。
   *
   * 端口被占用时不抛错，而是返回 `listeningOn: null` —— 调用方降级为
   * 只用手动粘贴。远程 SSH / 端口冲突是常见情形，不该让整个登录失败。
   */
  async startCallbackServer(expectedState: string): Promise<CallbackServer> {
    const host = new URL(this.redirectUri).hostname
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new NucleusError('provider.auth_failed', `redirect_uri 必须绑定 loopback，收到 ${host}`, {
        detail: { redirectUri: this.redirectUri, allowed: [...LOOPBACK_HOSTS] },
      })
    }

    let resolveCode: (c: string) => void
    let rejectCode: (e: unknown) => void
    const waitForCode = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (url.pathname !== this.cfg.callbackPath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Not found')
        return
      }

      const err = url.searchParams.get('error')
      if (err) {
        const desc = url.searchParams.get('error_description') ?? ''
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page('授权失败', `${err}${desc ? `：${desc}` : ''}`))
        rejectCode(new NucleusError('provider.auth_failed', `provider 返回错误：${err} ${desc}`))
        return
      }

      // state 不匹配是攻击信号，不是用户错误
      const got = url.searchParams.get('state') ?? ''
      if (!safeEqual(got, expectedState)) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page('state 校验失败', '这个回调不是本次登录发起的，已拒绝。'))
        rejectCode(new NucleusError('provider.auth_failed', 'state 校验失败，可能是 CSRF 或并发登录'))
        return
      }

      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page('缺少授权码', '回调里没有 code 参数。'))
        rejectCode(new NucleusError('provider.auth_failed', '回调缺少 code'))
        return
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page('授权完成', '可以关闭此页面，回到终端继续。'))
      resolveCode(code)
    })

    const listeningOn = await new Promise<string | null>((resolve) => {
      const onError = (e: NodeJS.ErrnoException) => {
        // 端口被占：降级为手动粘贴，不中断登录
        server.removeAllListeners('listening')
        resolve(null)
        if (e.code !== 'EADDRINUSE') {
          rejectCode(new NucleusError('provider.auth_failed', `回调服务器启动失败：${e.message}`))
        }
      }
      server.once('error', onError)
      server.once('listening', () => {
        server.removeListener('error', onError)
        server.on('error', () => {
          /* 运行期错误不影响已建立的等待 */
        })
        resolve(`${host}:${this.cfg.callbackPort}`)
      })
      server.listen(this.cfg.callbackPort, host === '::1' ? '::1' : host)
    })

    // 未挂起的 rejection 会让进程崩；这里兜住，真实错误由 waitForCode 的消费者处理
    waitForCode.catch(() => {})

    return {
      waitForCode,
      listeningOn,
      close: () =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve()
          // 先强制断掉存活连接再等 close —— 顺序反了的话 keep-alive 连接
          // 会把 close 拖到超时，端口迟迟不释放
          server.closeAllConnections?.()
          server.close(() => resolve())
        }),
    }
  }

  // ── Token 交换与刷新 ────────────────────────────────

  async exchangeCode(code: string, verifier: string | null, tokenUrl?: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.cfg.clientId,
      code,
      // 必须与 authorize 时完全一致，否则 provider 拒绝
      redirect_uri: this.redirectUri,
    })
    if (verifier) body.set('code_verifier', verifier)
    if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret)

    return this.#postToken(tokenUrl ?? this.cfg.tokenUrl, body, '换取 token')
  }

  async refresh(refreshToken: string, tokenUrl?: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.cfg.clientId,
    })
    if (this.cfg.scope.length) body.set('scope', this.cfg.scope.join(' '))
    if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret)

    const t = await this.#postToken(tokenUrl ?? this.cfg.tokenUrl, body, '刷新 token')
    // 部分 provider 不回新的 refresh_token，表示沿用旧的；
    // 会 rotation 的（如 OpenAI）必须立刻存新值，否则下次刷新失败
    if (!t.refreshToken) t.refreshToken = refreshToken
    return t
  }

  async #postToken(url: string, body: URLSearchParams, what: string): Promise<TokenResponse> {
    let res: Response
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      })
    } catch (e) {
      throw new NucleusError('provider.auth_failed', `${what}请求失败：${(e as Error).message}`, { cause: e })
    }

    const text = await res.text()
    let j: Record<string, unknown>
    try {
      j = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new NucleusError('provider.auth_failed', `${what}失败：响应不是 JSON（HTTP ${res.status}）`, {
        detail: { body: text.slice(0, 500) },
      })
    }

    if (!res.ok || typeof j['access_token'] !== 'string') {
      const err = String(j['error'] ?? `http_${res.status}`)
      const desc = j['error_description'] ? `：${String(j['error_description'])}` : ''
      throw new NucleusError('provider.auth_failed', `${what}失败：${err}${desc}`, {
        detail: { status: res.status, error: err, description: j['error_description'] },
      })
    }

    const expiresIn = typeof j['expires_in'] === 'number' ? j['expires_in'] : null
    return {
      accessToken: String(j['access_token']),
      ...(typeof j['refresh_token'] === 'string' ? { refreshToken: j['refresh_token'] } : {}),
      expiresAt: expiresIn === null ? null : this.#now() + expiresIn * 1000,
      ...(typeof j['scope'] === 'string' ? { scope: j['scope'] } : {}),
      ...(typeof j['token_type'] === 'string' ? { tokenType: j['token_type'] } : {}),
    }
  }
}

// ── 手动粘贴解析（远程 / headless）────────────────────

/**
 * 解析用户粘贴的内容。
 *
 * 远程 SSH 时浏览器在用户本地，服务器收不到回调 —— 用户可以把重定向后的
 * 整个 URL 粘回来，也可能只粘 code，两种都要支持。
 */
export function parseOAuthCallbackInput(
  input: string,
  expectedState: string,
): { code: string } {
  const trimmed = input.trim()
  if (!trimmed) throw new NucleusError('provider.auth_failed', '输入为空')

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new NucleusError('provider.auth_failed', '无法解析这个 URL')
    }
    const err = url.searchParams.get('error')
    if (err) {
      throw new NucleusError('provider.auth_failed', `provider 返回错误：${err}`)
    }
    const state = url.searchParams.get('state')
    if (state && !safeEqual(state, expectedState)) {
      throw new NucleusError('provider.auth_failed', 'state 校验失败，这个链接不是本次登录产生的')
    }
    const code = url.searchParams.get('code')
    if (!code) throw new NucleusError('provider.auth_failed', 'URL 里没有 code 参数')
    return { code }
  }

  // 纯 code：粘贴整段 URL 之外的另一种常见形态
  if (/\s/.test(trimmed)) {
    throw new NucleusError('provider.auth_failed', '输入含空白字符，既不是 URL 也不像授权码')
  }
  return { code: trimmed }
}

// ── 辅助 ─────────────────────────────────────────────

export function isTrustedDomain(url: string, trustedSuffix: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return hostname === trustedSuffix || hostname.endsWith(`.${trustedSuffix}`)
}

/** 定长比较，避免通过响应时间侧信道推断 state */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;color:#111}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;margin:0}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`
}

/** JWT payload 解码。OpenAI 的 access_token 里带 accountId。 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function accountIdFromToken(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken)
  const id = claims?.['accountId'] ?? claims?.['account_id']
  return typeof id === 'string' ? id : null
}
