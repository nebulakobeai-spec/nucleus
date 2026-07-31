import { createHash, randomBytes } from 'node:crypto'
import { NucleusError } from '../errors.js'
import type { OAuthCredential } from './credentials.js'

/**
 * OAuth 2.0 客户端：device authorization flow + PKCE。
 *
 * 为什么是 device flow：Nucleus 是个人部署的 CLI/后台服务，没有可靠的
 * 回调地址。device flow 让用户在浏览器里授权、CLI 轮询取 token，
 * 不需要监听端口、不需要公网回调。
 *
 * **现状说明**：目标的四家 provider（Kimi / GLM / OpenAI / Grok）
 * 对 API 访问都只提供 API key，没有面向自用的 OAuth 流程。
 * 这里的实现是为了将来的订阅型登录与自建网关预留，机制完整可用，
 * 但默认没有 provider 配置它。
 */

export interface OAuthProviderConfig {
  id: string
  /** 凭据引用名，如 'ACME_OAUTH' */
  ref: string
  clientId: string
  /** device flow 起点 */
  deviceAuthorizationUrl: string
  tokenUrl: string
  scopes?: string[]
  /** 是否用 PKCE（公共客户端应当用） */
  usePkce?: boolean
  /** 机密客户端才有；个人部署一般没有 */
  clientSecret?: string
}

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** 部分服务提供带 code 的直达链接 */
  verificationUriComplete?: string
  expiresAt: number
  intervalMs: number
}

export interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresAt: number | null
  scope?: string
  tokenType?: string
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface OAuthClientOptions {
  fetch?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 注入随机源，便于测试 */
  random?: (bytes: number) => Buffer
}

export class OAuthClient {
  #fetch: FetchLike
  #now: () => number
  #sleep: (ms: number) => Promise<void>
  #random: (n: number) => Buffer

  constructor(
    private cfg: OAuthProviderConfig,
    opts: OAuthClientOptions = {},
  ) {
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i))
    this.#now = opts.now ?? (() => Date.now())
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.#random = opts.random ?? ((n) => randomBytes(n))
  }

  /** PKCE：verifier 与 challenge */
  createPkce(): { verifier: string; challenge: string; method: 'S256' } {
    const verifier = base64url(this.#random(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    return { verifier, challenge, method: 'S256' }
  }

  /** 第一步：申请 device code，拿到给用户看的 user_code 与验证地址 */
  async requestDeviceCode(pkceChallenge?: string): Promise<DeviceAuthorization> {
    const body = new URLSearchParams({ client_id: this.cfg.clientId })
    if (this.cfg.scopes?.length) body.set('scope', this.cfg.scopes.join(' '))
    if (pkceChallenge) {
      body.set('code_challenge', pkceChallenge)
      body.set('code_challenge_method', 'S256')
    }

    const res = await this.#fetch(this.cfg.deviceAuthorizationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    })
    if (!res.ok) {
      throw new NucleusError('provider.auth_failed', `申请 device code 失败（HTTP ${res.status}）`, {
        detail: { body: (await res.text()).slice(0, 500) },
      })
    }

    const j = (await res.json()) as {
      device_code: string
      user_code: string
      verification_uri?: string
      verification_url?: string
      verification_uri_complete?: string
      expires_in?: number
      interval?: number
    }

    const uri = j.verification_uri ?? j.verification_url
    if (!j.device_code || !j.user_code || !uri) {
      throw new NucleusError('provider.auth_failed', 'device code 响应缺少必需字段', { detail: j })
    }

    return {
      deviceCode: j.device_code,
      userCode: j.user_code,
      verificationUri: uri,
      ...(j.verification_uri_complete ? { verificationUriComplete: j.verification_uri_complete } : {}),
      expiresAt: this.#now() + (j.expires_in ?? 900) * 1000,
      intervalMs: (j.interval ?? 5) * 1000,
    }
  }

  /**
   * 第二步：轮询直到用户完成授权。
   *
   * 按 RFC 8628 处理三种"还没好"的状态：
   *   authorization_pending —— 继续等
   *   slow_down            —— 服务端要求放慢，间隔 +5s
   *   expired_token        —— 超时，需要重新开始
   */
  async pollForToken(
    auth: DeviceAuthorization,
    pkceVerifier?: string,
    onTick?: (remainingMs: number) => void,
  ): Promise<TokenResponse> {
    let interval = auth.intervalMs

    for (;;) {
      if (this.#now() >= auth.expiresAt) {
        throw new NucleusError('provider.auth_failed', '授权超时，请重新执行登录')
      }
      onTick?.(auth.expiresAt - this.#now())
      await this.#sleep(interval)
      // sleep 可能跨过截止时刻 —— 再检查一次，避免发出注定失败的请求
      if (this.#now() >= auth.expiresAt) {
        throw new NucleusError('provider.auth_failed', '授权超时，请重新执行登录')
      }

      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: auth.deviceCode,
        client_id: this.cfg.clientId,
      })
      if (pkceVerifier) body.set('code_verifier', pkceVerifier)
      if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret)

      const res = await this.#fetch(this.cfg.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      })
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>

      if (res.ok && typeof j['access_token'] === 'string') {
        return this.#toToken(j)
      }

      const err = String(j['error'] ?? `http_${res.status}`)
      if (err === 'authorization_pending') continue
      if (err === 'slow_down') {
        interval += 5_000
        continue
      }
      if (err === 'expired_token') {
        throw new NucleusError('provider.auth_failed', '设备码已过期，请重新执行登录')
      }
      if (err === 'access_denied') {
        throw new NucleusError('provider.auth_failed', '用户拒绝了授权')
      }
      throw new NucleusError('provider.auth_failed', `授权失败：${err}`, {
        detail: { error: err, description: j['error_description'] },
      })
    }
  }

  /** 用 refresh token 换新的 access token */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.cfg.clientId,
    })
    if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret)

    const res = await this.#fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    })
    if (!res.ok) {
      throw new NucleusError('provider.auth_failed', `刷新 token 失败（HTTP ${res.status}）`, {
        detail: { body: (await res.text()).slice(0, 500) },
      })
    }
    const j = (await res.json()) as Record<string, unknown>
    if (typeof j['access_token'] !== 'string') {
      throw new NucleusError('provider.auth_failed', '刷新响应缺少 access_token', { detail: j })
    }
    // 部分服务不回 refresh_token，表示沿用旧的
    const t = this.#toToken(j)
    if (!t.refreshToken) t.refreshToken = refreshToken
    return t
  }

  #toToken(j: Record<string, unknown>): TokenResponse {
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

/** 提前多久算「快过期」，避免请求发出时刚好失效 */
export const REFRESH_SKEW_MS = 60_000

export function needsRefresh(cred: OAuthCredential, now: number): boolean {
  if (cred.expiresAt === null) return false
  return now >= cred.expiresAt - REFRESH_SKEW_MS
}

function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
