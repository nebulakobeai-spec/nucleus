import { createInterface } from 'node:readline/promises'
import { defaultConfig, type NucleusConfig } from '../config.js'
import { CredentialStore, redact } from '../auth/credentials.js'
import { needsRefresh, OAuthClient, type OAuthProviderConfig } from '../auth/oauth.js'
import { c, heading, ICON, line, table } from './ui.js'

/**
 * `nucleus auth` 命令组。
 *
 *   auth login <ref>          交互式录入 API key
 *   auth login <ref> --oauth  浏览器授权（device flow + PKCE）
 *   auth list                 列出凭据来源与状态（永不显示明文）
 *   auth test <ref>           拿真实请求验证凭据可用
 *   auth refresh <ref>        手动刷新 OAuth token
 *   auth logout <ref>         删除凭据
 */

/**
 * OAuth provider 注册表。
 *
 * 目前为空：Kimi / GLM / OpenAI / Grok 对 API 访问都只提供 API key，
 * 没有面向自用的 OAuth 流程。这里留给将来的订阅型登录或自建网关 ——
 * 填一条配置即可用，无需改代码。
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {}

interface Ctx {
  store: CredentialStore
  config: NucleusConfig
}

function ctx(flags: Record<string, string | true>): Ctx {
  return {
    store: new CredentialStore({
      ...(typeof flags['credentials'] === 'string' ? { filePath: flags['credentials'] } : {}),
      ...(flags['no-keychain'] ? { useKeychain: false } : {}),
    }),
    config: defaultConfig,
  }
}

/** config 里声明过的所有 credential ref */
function knownRefs(config: NucleusConfig): Array<{ ref: string; models: string[] }> {
  const m = new Map<string, string[]>()
  for (const model of config.models) {
    if (!model.apiKeyRef) continue
    m.set(model.apiKeyRef, [...(m.get(model.apiKeyRef) ?? []), model.key])
  }
  return [...m.entries()].map(([ref, models]) => ({ ref, models }))
}

async function prompt(question: string, opts: { silent?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (!opts.silent) return (await rl.question(question)).trim()

    // 静默输入：关掉回显，避免密钥出现在终端与 scrollback 里
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    process.stdout.write(question)
    if (stdin.isTTY) stdin.setRawMode(true)

    let value = ''
    await new Promise<void>((resolve) => {
      const onData = (buf: Buffer) => {
        const s = buf.toString('utf8')
        for (const ch of s) {
          if (ch === '\r' || ch === '\n') {
            stdin.off('data', onData)
            if (stdin.isTTY) stdin.setRawMode(wasRaw)
            process.stdout.write('\n')
            resolve()
            return
          }
          if (ch === '') {
            // Ctrl-C
            stdin.off('data', onData)
            if (stdin.isTTY) stdin.setRawMode(wasRaw)
            process.stdout.write('\n')
            process.exit(130)
          }
          if (ch === '' || ch === '\b') {
            value = value.slice(0, -1)
            continue
          }
          value += ch
        }
      }
      stdin.on('data', onData)
    })
    return value.trim()
  } finally {
    rl.close()
  }
}

// ── auth login ───────────────────────────────────────────

export async function authLogin(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { store, config } = ctx(flags)
  const ref = argv[0]

  if (!ref) {
    heading('可配置的凭据')
    const refs = knownRefs(config)
    table(
      refs.map((r) => [r.ref, c.gray(r.models.join(', '))]),
      ['REF', '用于模型'],
    )
    line()
    line(`用法：${c.bold('nucleus auth login <REF>')}          录入 API key`)
    line(`      ${c.bold('nucleus auth login <REF> --oauth')}  浏览器授权`)
    return 1
  }

  return flags['oauth'] ? oauthLogin(store, ref, flags) : apiKeyLogin(store, ref, flags)
}

/** API key：交互式静默录入，或从 --value / stdin 读取（便于脚本化） */
async function apiKeyLogin(
  store: CredentialStore,
  ref: string,
  flags: Record<string, string | true>,
): Promise<number> {
  heading(`配置 API key · ${ref}`)

  let value: string
  if (typeof flags['value'] === 'string') {
    value = flags['value']
  } else if (flags['stdin']) {
    // 管道输入：echo "$KEY" | nucleus auth login ZAI_API_KEY --stdin
    value = (await readAllStdin()).trim()
  } else {
    line(c.gray('输入不会回显；直接回车取消。'))
    value = await prompt('API key: ', { silent: true })
  }

  if (!value) {
    line(`${ICON.warn} 已取消`)
    return 1
  }

  const existing = await store.resolve(ref)
  if (existing?.source === 'env') {
    line(`${ICON.warn} 环境变量 ${ref} 已设置，它的优先级高于此处写入的值`)
    line(c.gray('  运行时会用环境变量。要用新值请先 unset 环境变量。'))
  }

  const source = await store.setApiKey(ref, value)
  line(`${ICON.ok} 已保存到 ${source === 'keychain' ? 'macOS keychain' : store.filePath}`)
  line(c.gray(`  ${ref} = ${redact(value)}`))
  line()
  line(c.gray(`验证：nucleus auth test ${ref}`))
  return 0
}

/** OAuth：device flow + PKCE */
async function oauthLogin(
  store: CredentialStore,
  ref: string,
  flags: Record<string, string | true>,
): Promise<number> {
  const providerId = typeof flags['provider'] === 'string' ? flags['provider'] : ref
  const cfg = OAUTH_PROVIDERS[providerId]

  if (!cfg) {
    line(`${ICON.fail} 没有名为 ${c.bold(providerId)} 的 OAuth provider`)
    line()
    const ids = Object.keys(OAUTH_PROVIDERS)
    if (ids.length === 0) {
      line(c.gray('当前没有配置任何 OAuth provider。'))
      line(c.gray('Kimi / GLM / OpenAI / Grok 对 API 访问只提供 API key，'))
      line(c.gray('请改用：') + c.bold(`nucleus auth login ${ref}`))
      line()
      line(c.gray('要接入支持 OAuth 的服务，在 src/cli/auth.ts 的 OAUTH_PROVIDERS 中加一条配置。'))
    } else {
      line(c.gray(`可用：${ids.join(', ')}`))
    }
    return 1
  }

  heading(`OAuth 登录 · ${cfg.id}`)

  const client = new OAuthClient(cfg)
  const pkce = cfg.usePkce !== false ? client.createPkce() : null

  const auth = await client.requestDeviceCode(pkce?.challenge)

  line()
  line(`  1. 打开：${c.cyan(auth.verificationUriComplete ?? auth.verificationUri)}`)
  if (!auth.verificationUriComplete) {
    line(`  2. 输入验证码：${c.bold(auth.userCode)}`)
  }
  line()
  line(c.gray('等待授权中…（Ctrl-C 取消）'))

  const token = await client.pollForToken(auth, pkce?.verifier)

  const source = await store.setOAuth(ref, {
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt,
    ...(token.scope ? { scope: token.scope } : {}),
    ...(token.tokenType ? { tokenType: token.tokenType } : {}),
  })

  line()
  line(`${ICON.ok} 授权成功，已保存到 ${source === 'keychain' ? 'macOS keychain' : store.filePath}`)
  line(c.gray(`  ${ref} = ${redact(token.accessToken)}`))
  if (token.expiresAt) {
    line(c.gray(`  过期：${new Date(token.expiresAt).toLocaleString()}`))
    line(c.gray(token.refreshToken ? '  带 refresh token，将自动续期' : '  无 refresh token，过期后需重新登录'))
  }
  return 0
}

// ── auth list ────────────────────────────────────────────

export async function authList(_argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { store, config } = ctx(flags)
  const refs = knownRefs(config)
  const items = await store.list(refs.map((r) => r.ref))

  heading('凭据')
  const usedBy = new Map(refs.map((r) => [r.ref, r.models.join(', ')]))

  table(
    items.map((i) => {
      const sourceLabel =
        i.source === 'env'
          ? c.cyan('env')
          : i.source === 'keychain'
            ? c.green('keychain')
            : i.source === 'file'
              ? c.yellow('file')
              : c.gray('未设置')
      const expiry =
        i.expiresAt == null
          ? ''
          : i.expiresAt < Date.now()
            ? c.red('已过期')
            : c.gray(new Date(i.expiresAt).toLocaleString())
      return [
        i.source === 'none' ? c.gray(i.ref) : i.ref,
        i.kind === 'oauth' ? c.magenta('oauth') : 'api_key',
        sourceLabel,
        i.source === 'none' ? c.gray('—') : c.gray(i.hint),
        expiry,
        c.gray(usedBy.get(i.ref) ?? ''),
      ]
    }),
    ['REF', '类型', '来源', '值', '过期', '用于'],
  )

  line()
  line(c.gray(`解析优先级：环境变量 > keychain > ${store.filePath}`))
  const missing = items.filter((i) => i.source === 'none')
  if (missing.length) {
    line(c.gray(`未配置：${missing.map((m) => m.ref).join(', ')}`))
    line(c.gray(`配置：nucleus auth login <REF>`))
  }
  return 0
}

// ── auth test ────────────────────────────────────────────

/**
 * 用真实请求验证凭据。
 *
 * 只发一次最小请求（列模型或 1 token 的对话），不产生实际费用，
 * 但能真正区分「key 有效」「key 无效」「网络不通」三种情况 ——
 * 光看有没有设置是不够的。
 */
export async function authTest(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { store, config } = ctx(flags)
  const target = argv[0]
  const refs = knownRefs(config).filter((r) => !target || r.ref === target)

  if (refs.length === 0) {
    line(c.red(target ? `config 中没有引用 ${target} 的模型` : 'config 中没有需要凭据的模型'))
    return 1
  }

  heading('验证凭据')
  let failed = 0

  for (const { ref, models } of refs) {
    const cred = await store.resolve(ref)
    if (!cred) {
      line(`${ICON.fail} ${ref.padEnd(20)} ${c.gray('未配置')}`)
      failed++
      continue
    }

    const model = config.models.find((m) => m.apiKeyRef === ref)!
    const base = model.baseUrl.replace(/\/$/, '')
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${cred.secret}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        line(`${ICON.ok} ${ref.padEnd(20)} ${c.gray(`${cred.source} · ${models.join(', ')}`)}`)
      } else if (res.status === 401 || res.status === 403) {
        line(`${ICON.fail} ${ref.padEnd(20)} ${c.red('凭据被拒绝')} ${c.gray(`HTTP ${res.status}`)}`)
        failed++
      } else {
        line(`${ICON.warn} ${ref.padEnd(20)} ${c.yellow(`HTTP ${res.status}`)} ${c.gray('凭据可能有效，但端点异常')}`)
      }
    } catch (e) {
      const msg = (e as Error).message
      line(`${ICON.warn} ${ref.padEnd(20)} ${c.yellow('无法连接')} ${c.gray(msg.slice(0, 60))}`)
      line(c.gray(`     ${base} —— 网络不可达时无法判断凭据是否有效`))
    }
  }

  line()
  line(failed === 0 ? c.green('全部可用') : c.red(`${failed} 项不可用`))
  return failed === 0 ? 0 : 1
}

// ── auth refresh ─────────────────────────────────────────

export async function authRefresh(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { store } = ctx(flags)
  const ref = argv[0]
  if (!ref) {
    line(c.red('用法：nucleus auth refresh <REF>'))
    return 1
  }

  const cred = await store.get(ref)
  if (!cred) {
    line(c.red(`未找到凭据 ${ref}`))
    return 1
  }
  if (cred.kind !== 'oauth') {
    line(`${ICON.warn} ${ref} 是 API key，不需要刷新`)
    return 1
  }
  if (!cred.refreshToken) {
    line(`${ICON.fail} ${ref} 没有 refresh token，请重新登录：nucleus auth login ${ref} --oauth`)
    return 1
  }

  const providerId = typeof flags['provider'] === 'string' ? flags['provider'] : ref
  const cfg = OAUTH_PROVIDERS[providerId]
  if (!cfg) {
    line(c.red(`没有名为 ${providerId} 的 OAuth provider 配置`))
    return 1
  }

  const token = await new OAuthClient(cfg).refresh(cred.refreshToken)
  await store.setOAuth(ref, {
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt,
    ...(token.scope ? { scope: token.scope } : {}),
  })

  line(`${ICON.ok} 已刷新 ${ref}`)
  if (token.expiresAt) line(c.gray(`  新的过期时间：${new Date(token.expiresAt).toLocaleString()}`))
  return 0
}

// ── auth logout ──────────────────────────────────────────

export async function authLogout(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { store } = ctx(flags)
  const ref = argv[0]
  if (!ref) {
    line(c.red('用法：nucleus auth logout <REF>'))
    return 1
  }

  const removed = await store.delete(ref)
  if (!removed) {
    line(`${ICON.warn} ${ref} 未找到（或只存在于环境变量中）`)
    return 1
  }
  line(`${ICON.ok} 已删除 ${ref}`)

  if (process.env[ref]) {
    line(`${ICON.warn} 环境变量 ${ref} 仍然存在，运行时会继续使用它`)
  }
  return 0
}

// ── 状态检查（供 doctor 复用）────────────────────────────

export async function credentialStatus(
  config: NucleusConfig,
  store = new CredentialStore(),
): Promise<Array<{ ref: string; ok: boolean; detail: string }>> {
  const out: Array<{ ref: string; ok: boolean; detail: string }> = []
  for (const { ref, models } of knownRefs(config)) {
    const cred = await store.resolve(ref)
    if (!cred) {
      out.push({ ref, ok: false, detail: `未配置（${models.join(', ')} 不可用）` })
      continue
    }
    if (cred.kind === 'oauth' && cred.expiresAt != null) {
      const expired = cred.expiresAt < Date.now()
      out.push({
        ref,
        ok: !expired,
        detail: expired ? `已过期（${cred.source}）` : `${cred.source} · 有效至 ${new Date(cred.expiresAt).toLocaleString()}`,
      })
      continue
    }
    out.push({ ref, ok: true, detail: cred.source })
  }
  return out
}

/** 供运行时解析密钥：处理 OAuth 过期提示 */
export function makeSecretResolver(store: CredentialStore) {
  const cache = new Map<string, string>()
  return async (ref: string | undefined): Promise<string | null> => {
    if (!ref) return null
    const hit = cache.get(ref)
    if (hit) return hit

    const cred = await store.get(ref)
    if (cred?.kind === 'oauth' && needsRefresh(cred, Date.now())) {
      // 刷新需要 provider 配置与网络；这里只提示，由 auth refresh 处理
      line(c.yellow(`${ICON.warn} ${ref} 的 token 即将过期，运行 nucleus auth refresh ${ref}`))
    }

    const resolved = await store.resolve(ref)
    if (!resolved) return null
    cache.set(ref, resolved.secret)
    return resolved.secret
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
