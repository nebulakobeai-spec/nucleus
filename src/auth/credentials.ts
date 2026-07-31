import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * 凭据存储（DESIGN.md §7 / §8）。
 *
 * 铁律：**secrets 不进 config、不进 git**。config 里只有 `credential_ref`，
 * 值从这里解析。
 *
 * 解析优先级（前者覆盖后者）：
 *   1. 环境变量        —— CI / 容器注入，只读
 *   2. OS keychain     —— macOS，最安全
 *   3. 文件            —— ~/.nucleus/credentials.json，0600
 */

export type CredentialKind = 'api_key' | 'oauth'

export interface ApiKeyCredential {
  kind: 'api_key'
  ref: string
  value: string
  createdAt: string
}

export interface OAuthCredential {
  kind: 'oauth'
  ref: string
  accessToken: string
  refreshToken?: string
  /** epoch ms；null 表示不过期 */
  expiresAt: number | null
  scope?: string
  tokenType?: string
  /** 用哪个 provider 登录的 —— 刷新时要用同一个 clientId 与端点 */
  providerId?: string
  createdAt: string
}

export type Credential = ApiKeyCredential | OAuthCredential

export type CredentialSource = 'env' | 'keychain' | 'file' | 'none'

export interface ResolvedCredential {
  ref: string
  kind: CredentialKind
  source: CredentialSource
  /** 用于 Authorization header 的值 */
  secret: string
  expiresAt?: number | null
}

const KEYCHAIN_SERVICE = 'nucleus'

export interface CredentialStoreOptions {
  /** 文件后端路径；默认 ~/.nucleus/credentials.json */
  filePath?: string
  /** 是否尝试 keychain；非 macOS 或测试中关掉 */
  useKeychain?: boolean
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export class CredentialStore {
  #filePath: string
  #useKeychain: boolean
  #env: NodeJS.ProcessEnv
  #now: () => number

  constructor(opts: CredentialStoreOptions = {}) {
    this.#filePath = opts.filePath ?? join(homedir(), '.nucleus', 'credentials.json')
    this.#useKeychain = opts.useKeychain ?? process.platform === 'darwin'
    this.#env = opts.env ?? process.env
    this.#now = opts.now ?? (() => Date.now())
  }

  // ── 解析 ────────────────────────────────────────────

  /**
   * 按优先级解析一个 ref。
   *
   * 注意：**不在这里做 OAuth 刷新** —— 刷新需要网络，属于 OAuthClient 的职责。
   * 这里只如实返回（包括已过期的），由调用方决定是否刷新。
   */
  async resolve(ref: string): Promise<ResolvedCredential | null> {
    const fromEnv = this.#env[ref]
    if (fromEnv) {
      return { ref, kind: 'api_key', source: 'env', secret: fromEnv }
    }

    if (this.#useKeychain) {
      const raw = await this.#keychainGet(ref)
      if (raw) return this.#toResolved(ref, raw, 'keychain')
    }

    const all = await this.#readFileStore()
    const cred = all[ref]
    if (cred) return this.#toResolved(ref, cred, 'file')

    return null
  }

  #toResolved(ref: string, cred: Credential, source: CredentialSource): ResolvedCredential {
    if (cred.kind === 'api_key') {
      return { ref, kind: 'api_key', source, secret: cred.value }
    }
    return {
      ref,
      kind: 'oauth',
      source,
      secret: cred.accessToken,
      expiresAt: cred.expiresAt,
    }
  }

  /** 取完整凭据（含 refresh token），刷新流程用 */
  async get(ref: string): Promise<Credential | null> {
    if (this.#useKeychain) {
      const raw = await this.#keychainGet(ref)
      if (raw) return raw
    }
    const all = await this.#readFileStore()
    return all[ref] ?? null
  }

  // ── 写入 ────────────────────────────────────────────

  async setApiKey(ref: string, value: string): Promise<CredentialSource> {
    const cred: ApiKeyCredential = {
      kind: 'api_key',
      ref,
      value,
      createdAt: new Date(this.#now()).toISOString(),
    }
    return this.#write(ref, cred)
  }

  async setOAuth(ref: string, token: Omit<OAuthCredential, 'kind' | 'ref' | 'createdAt'>): Promise<CredentialSource> {
    const cred: OAuthCredential = {
      kind: 'oauth',
      ref,
      createdAt: new Date(this.#now()).toISOString(),
      ...token,
    }
    return this.#write(ref, cred)
  }

  async #write(ref: string, cred: Credential): Promise<CredentialSource> {
    if (this.#useKeychain) {
      const ok = await this.#keychainSet(ref, cred)
      if (ok) return 'keychain'
    }
    const all = await this.#readFileStore()
    all[ref] = cred
    await this.#writeFileStore(all)
    return 'file'
  }

  async delete(ref: string): Promise<boolean> {
    let removed = false
    if (this.#useKeychain) removed = (await this.#keychainDelete(ref)) || removed
    const all = await this.#readFileStore()
    if (all[ref]) {
      delete all[ref]
      await this.#writeFileStore(all)
      removed = true
    }
    return removed
  }

  /** 列出所有已知 ref 及来源。**不返回 secret 值。** */
  async list(knownRefs: string[] = []): Promise<
    Array<{ ref: string; kind: CredentialKind; source: CredentialSource; hint: string; expiresAt?: number | null }>
  > {
    const refs = new Set<string>(knownRefs)
    for (const r of Object.keys(await this.#readFileStore())) refs.add(r)
    for (const k of Object.keys(this.#env)) {
      if (/_API_KEY$|_TOKEN$/.test(k)) refs.add(k)
    }

    const out = []
    for (const ref of [...refs].sort()) {
      const r = await this.resolve(ref)
      out.push(
        r
          ? {
              ref,
              kind: r.kind,
              source: r.source,
              hint: redact(r.secret),
              ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
            }
          : { ref, kind: 'api_key' as const, source: 'none' as const, hint: '未设置' },
      )
    }
    return out
  }

  // ── keychain（macOS）────────────────────────────────

  async #keychainGet(ref: string): Promise<Credential | null> {
    try {
      const { stdout } = await exec('security', [
        'find-generic-password',
        '-a',
        ref,
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ])
      return JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')) as Credential
    } catch {
      return null
    }
  }

  async #keychainSet(ref: string, cred: Credential): Promise<boolean> {
    try {
      // base64 避免特殊字符在命令行里出问题
      const payload = Buffer.from(JSON.stringify(cred), 'utf8').toString('base64')
      await exec('security', [
        'add-generic-password',
        '-a',
        ref,
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
        payload,
        '-U', // 存在则更新
      ])
      return true
    } catch {
      return false
    }
  }

  async #keychainDelete(ref: string): Promise<boolean> {
    try {
      await exec('security', ['delete-generic-password', '-a', ref, '-s', KEYCHAIN_SERVICE])
      return true
    } catch {
      return false
    }
  }

  // ── 文件后端 ────────────────────────────────────────

  async #readFileStore(): Promise<Record<string, Credential>> {
    try {
      return JSON.parse(await readFile(this.#filePath, 'utf8')) as Record<string, Credential>
    } catch {
      return {}
    }
  }

  async #writeFileStore(all: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 })
    await writeFile(this.#filePath, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    // mkdir 的 mode 受 umask 影响，显式再设一次
    await chmod(this.#filePath, 0o600).catch(() => {})
  }

  get filePath(): string {
    return this.#filePath
  }
}

/**
 * 脱敏：只留尾部 4 位。
 *
 * 全系统统一走这个函数 —— 日志、UI、诊断包都不能出现完整密钥。
 */
export function redact(secret: string | null | undefined): string {
  if (!secret) return '(空)'
  if (secret.length <= 8) return '****'
  return `${'*'.repeat(Math.min(12, secret.length - 4))}${secret.slice(-4)}`
}

/** 从任意文本里抹掉常见密钥形态，诊断包落盘前必过。 */
export function redactText(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, (m) => redact(m))
    .replace(/\b(xai-[A-Za-z0-9_-]{8,})/g, (m) => redact(m))
    .replace(/\b([A-Fa-f0-9]{32}\.[A-Za-z0-9]{16})\b/g, (m) => redact(m)) // z.ai 形态
    .replace(/(Bearer\s+)([A-Za-z0-9._-]{12,})/gi, (_, p: string, s: string) => p + redact(s))
    .replace(/("(?:api_?key|token|secret|password)"\s*:\s*")([^"]{6,})(")/gi, (_, a: string, s: string, b: string) => a + redact(s) + b)
}
