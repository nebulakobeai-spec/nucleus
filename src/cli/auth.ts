import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { defaultConfig, type NucleusConfig } from '../config.js'
import { loadConfig } from '../config-file.js'
import { CredentialStore, redact } from '../auth/credentials.js'
import { needsRefresh, OAuthClient, type OAuthProviderConfig } from '../auth/oauth.js'
import {
  AuthCodeClient,
  parseOAuthCallbackInput,
  type AuthCodeProviderConfig,
} from '../auth/oauth-auth-code.js'
import { OAuthRegistry, type OAuthFlowConfig } from '../auth/providers.js'
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
 * OAuth provider 注册表，从配置构建。
 *
 * **不内置任何第三方产品的 client_id** —— 那是别人向 provider 注册的应用标识，
 * 拿来用等于把自己声明成对方。端点模板内置（那是公开的协议事实），
 * clientId 由部署方在 nucleus.config.json 的 oauthProviders 里填。
 */
export function oauthRegistry(config: NucleusConfig = defaultConfig): OAuthRegistry {
  return new OAuthRegistry(config.oauthProviders ?? {})
}

interface Ctx {
  store: CredentialStore
  config: NucleusConfig
}

async function ctx(flags: Record<string, string | true>): Promise<Ctx> {
  const { config: loaded } = await loadConfig(
    typeof flags['config'] === 'string' ? flags['config'] : undefined,
  )
  return {
    store: new CredentialStore({
      ...(typeof flags['credentials'] === 'string' ? { filePath: flags['credentials'] } : {}),
      ...(flags['no-keychain'] ? { useKeychain: false } : {}),
    }),
    config: loaded,
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
  const { store, config } = await ctx(flags)
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

  return flags['oauth'] ? oauthLogin(store, ref, flags, config) : apiKeyLogin(store, ref, flags)
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

/** OAuth 登录：按 provider 的 flow 类型分派 */
async function oauthLogin(
  store: CredentialStore,
  ref: string,
  flags: Record<string, string | true>,
  config: NucleusConfig = defaultConfig,
): Promise<number> {
  const providerId = typeof flags['provider'] === 'string' ? flags['provider'] : ref
  const registry = oauthRegistry(config)
  let entry = registry.get(providerId)

  // --method 显式覆盖 flow 类型（xAI 两种都支持）
  const method = typeof flags['method'] === 'string' ? flags['method'] : null
  if (entry && method && entry.kind !== method) {
    const alt = registry.get(method === 'device' ? `${providerId}-device` : providerId)
    if (alt?.kind === method) entry = alt
    else {
      line(`${ICON.fail} provider ${providerId} 不支持 ${method} flow`)
      return 1
    }
  }

  if (!entry) {
    printMissingProvider(providerId, ref, registry)
    return 1
  }

  return entry.kind === 'device'
    ? deviceFlowLogin(store, ref, entry.config)
    : authCodeFlowLogin(store, ref, entry.config, flags)
}

function printMissingProvider(providerId: string, ref: string, registry: OAuthRegistry): void {
  line(`${ICON.fail} 没有配置名为 ${c.bold(providerId)} 的 OAuth provider`)
  line()

  if (registry.size > 0) {
    line(c.gray(`已配置：${registry.ids().join(', ')}`))
    line()
  }

  const tpl = OAuthRegistry.availableTemplates().find((t) => t.id === providerId)
  if (tpl) {
    // 有模板但缺 clientId —— 这是最常见的情形，给出可直接抄的配置
    line(`${ICON.info} ${providerId} 有内置端点模板，但缺少 ${c.bold('clientId')}。`)
    line(c.gray(`   ${tpl.note}`))
    line()
    line('在 nucleus.config.json 里加：')
    line(
      c.gray(`  {
    "oauthProviders": {
      "${providerId}": { "clientId": "<你申请到的 client_id>" }
    }
  }`),
    )
    line()
    line(c.gray('不内置 clientId 是有意的：那是各家颁发给具体应用的标识，'))
    line(c.gray('借用别人的等于把本程序声明成对方。'))
  } else {
    const ids = OAuthRegistry.availableTemplates().map((t) => `${t.id}(${t.kind})`)
    line(c.gray(`内置端点模板：${ids.join(', ')}`))
    line(c.gray('其余 provider 需要在配置里给出完整端点。'))
    line()
    line(c.gray(`只用 API key 的话：`) + c.bold(`nucleus auth login ${ref}`))
  }
  return
}

/** Device Flow（RFC 8628）：不需要回调端口 */
async function deviceFlowLogin(
  store: CredentialStore,
  ref: string,
  cfg: OAuthProviderConfig,
): Promise<number> {
  heading(`OAuth 登录 · ${cfg.id}（device flow）`)

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
  return saveToken(store, ref, token)
}

/**
 * Authorization Code Flow + PKCE。
 *
 * 本地回调服务器与手动粘贴**同时**等待，先到的赢：
 *  - 本机有浏览器 → 打开链接后自动完成
 *  - 远程 SSH / 端口被占 → 用户把重定向后的 URL 粘回来
 *
 * 两条路径不互斥，避免在 VPS 上完全无法登录。
 */
async function authCodeFlowLogin(
  store: CredentialStore,
  ref: string,
  cfg: AuthCodeProviderConfig,
  flags: Record<string, string | true>,
): Promise<number> {
  heading(`OAuth 登录 · ${cfg.id}`)

  let client: AuthCodeClient
  try {
    client = new AuthCodeClient(cfg)
  } catch (e) {
    line(`${ICON.fail} ${(e as Error).message}`)
    return 1
  }

  // discovery（如果配了）会校验端点落在信任域内
  const endpoints = await client.resolveEndpoints()

  const pkce = cfg.usePkce !== false ? client.createPkce() : null
  const state = client.createState()
  const authorizeUrl = client.buildAuthorizeUrl(pkce?.challenge ?? null, state, endpoints.authorizeUrl)

  const server = await client.startCallbackServer(state)

  line()
  if (server.listeningOn) {
    line(c.gray(`回调服务器已启动：http://${server.listeningOn}${cfg.callbackPath}`))
  } else {
    line(`${ICON.warn} 端口 ${cfg.callbackPort} 不可用，将只能手动粘贴`)
  }
  line()
  line('在浏览器打开：')
  line(`  ${c.cyan(authorizeUrl)}`)
  line()

  if (!flags['no-browser']) void openBrowser(authorizeUrl)

  line(c.gray('授权后：'))
  if (server.listeningOn) line(c.gray('  · 本机浏览器会自动完成，无需操作'))
  line(c.gray('  · 远程环境请把重定向后的完整 URL 粘贴到这里，回车'))
  line(c.gray('  （Ctrl-C 取消）'))
  line()

  // 两条路径竞速
  const manual = promptForCallback(state)
  let code: string
  try {
    code = await Promise.race([server.waitForCode, manual.promise])
  } catch (e) {
    server.close()
    manual.cancel()
    line(`${ICON.fail} ${(e as Error).message}`)
    return 1
  } finally {
    server.close()
    manual.cancel()
  }

  line(c.gray('正在换取 token…'))
  let token
  try {
    token = await client.exchangeCode(code, pkce?.verifier ?? null, endpoints.tokenUrl)
  } catch (e) {
    line(`${ICON.fail} ${(e as Error).message}`)
    return 1
  }

  return saveToken(store, ref, token, cfg.id)
}

async function saveToken(
  store: CredentialStore,
  ref: string,
  token: { accessToken: string; refreshToken?: string; expiresAt: number | null; scope?: string; tokenType?: string },
  providerId?: string,
): Promise<number> {
  const source = await store.setOAuth(ref, {
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt,
    ...(token.scope ? { scope: token.scope } : {}),
    ...(token.tokenType ? { tokenType: token.tokenType } : {}),
    ...(providerId ? { providerId } : {}),
  })

  line()
  line(`${ICON.ok} 授权成功，已保存到 ${source === 'keychain' ? 'macOS keychain' : store.filePath}`)
  line(c.gray(`  ${ref} = ${redact(token.accessToken)}`))
  if (token.expiresAt) {
    line(c.gray(`  过期：${new Date(token.expiresAt).toLocaleString()}`))
    line(
      c.gray(
        token.refreshToken
          ? '  带 refresh token，运行时会自动续期'
          : '  无 refresh token，过期后需重新登录',
      ),
    )
  }
  return 0
}

/** 手动粘贴：可取消，避免与回调竞速时留下悬挂的 readline */
function promptForCallback(expectedState: string): { promise: Promise<string>; cancel: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let cancelled = false

  const promise = (async () => {
    for (;;) {
      const input = await rl.question('粘贴回调 URL（或直接等待）> ')
      if (cancelled) return new Promise<string>(() => {}) // 已被回调抢先，永不 resolve
      try {
        return parseOAuthCallbackInput(input, expectedState).code
      } catch (e) {
        if (cancelled) return new Promise<string>(() => {})
        line(`${ICON.warn} ${(e as Error).message}，请重试`)
      }
    }
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      rl.close()
    },
  }
}

/** 尽力打开浏览器；失败不影响流程（用户可以自己复制链接） */
async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  await new Promise<void>((resolve) => {
    execFile(cmd, [url], () => resolve())
  })
}

// ── auth list ────────────────────────────────────────────

export async function authList(_argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { store, config } = await ctx(flags)
  const refs = knownRefs(config)
  const items = await store.list(refs.map((r) => r.ref))

  heading('凭据')
  const usedBy = new Map(refs.map((r) => [r.ref, r.models.join(', ')]))
  // 未配置的 ref 无从判断类型，按命名约定猜 —— 否则会显示成 api_key，
  // 引导用户用错命令（OAuth-only 的 provider 用 auth login 是配不上的）
  const looksOAuth = (ref: string) => /_OAUTH$|_TOKEN$/i.test(ref)

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
      const kind =
        i.source === 'none' && looksOAuth(i.ref) ? 'oauth?' : i.kind === 'oauth' ? 'oauth' : 'api_key'
      return [
        i.source === 'none' ? c.gray(i.ref) : i.ref,
        kind.startsWith('oauth') ? c.magenta(kind) : kind,
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
    const oauthRefs = missing.filter((m) => looksOAuth(m.ref)).map((m) => m.ref)
    const keyRefs = missing.filter((m) => !looksOAuth(m.ref)).map((m) => m.ref)
    if (keyRefs.length) {
      line(c.gray(`未配置（API key）：${keyRefs.join(', ')}`))
      line(c.gray(`  nucleus auth login <REF>`))
    }
    if (oauthRefs.length) {
      line(c.gray(`未配置（OAuth）：${oauthRefs.join(', ')}`))
      line(c.gray(`  nucleus auth login <REF> --oauth --provider <openai|xai>`))
      line(c.gray(`  需先在 nucleus.config.json 的 oauthProviders 里配置 clientId`))
    }
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
  const { store, config } = await ctx(flags)
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
  const { store, config } = await ctx(flags)
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

  // 优先用凭据里记录的 provider —— 登录时用哪个刷新时就该用哪个
  const providerId =
    (typeof flags['provider'] === 'string' ? flags['provider'] : null) ?? cred.providerId ?? ref
  const entry = oauthRegistry(config).get(providerId)
  if (!entry) {
    line(c.red(`没有配置名为 ${providerId} 的 OAuth provider`))
    line(c.gray(`  刷新需要 clientId 与 token 端点，请在 nucleus.config.json 的 oauthProviders 里配置`))
    return 1
  }

  const token = await refreshWith(entry, cred.refreshToken)
  await store.setOAuth(ref, {
    accessToken: token.accessToken,
    // rotation：provider 可能发新的 refresh_token 并作废旧的，必须立刻覆盖
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt,
    ...(token.scope ? { scope: token.scope } : {}),
    providerId,
  })

  line(`${ICON.ok} 已刷新 ${ref}`)
  if (token.expiresAt) line(c.gray(`  新的过期时间：${new Date(token.expiresAt).toLocaleString()}`))
  return 0
}

/** 按 flow 类型刷新 */
export async function refreshWith(entry: OAuthFlowConfig, refreshToken: string) {
  if (entry.kind === 'device') {
    return new OAuthClient(entry.config).refresh(refreshToken)
  }
  const client = new AuthCodeClient(entry.config)
  const endpoints = await client.resolveEndpoints()
  return client.refresh(refreshToken, endpoints.tokenUrl)
}

// ── auth logout ──────────────────────────────────────────

export async function authLogout(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const { store } = await ctx(flags)
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

/**
 * 供运行时解析密钥，**OAuth token 快过期时自动刷新**。
 *
 * 长时间运行的前提：access token 通常只有 1 小时有效期，
 * 不自动刷新的话跑到一半就全部 401。
 *
 * 并发安全：同一 ref 的刷新只跑一次，其余调用共享同一个 promise ——
 * 否则并发的 run 会各自刷新，而 rotation 型 provider（如 OpenAI）
 * 只认最后一个 refresh_token，前面的全部作废。
 */
export function makeSecretResolver(
  store: CredentialStore,
  opts: { config?: NucleusConfig; onEvent?: (msg: string) => void } = {},
) {
  const registry = oauthRegistry(opts.config ?? defaultConfig)
  const inflight = new Map<string, Promise<string | null>>()
  const notify = opts.onEvent ?? ((m: string) => line(c.gray(m)))

  const doRefresh = async (ref: string, cred: import('../auth/credentials.js').OAuthCredential) => {
    const providerId = cred.providerId ?? ref
    const entry = registry.get(providerId)
    if (!entry) {
      notify(`${ref} 的 token 即将过期，但没有配置 provider ${providerId}，无法自动刷新`)
      return cred.accessToken
    }
    if (!cred.refreshToken) {
      notify(`${ref} 的 token 即将过期且无 refresh token，需要重新登录`)
      return cred.accessToken
    }

    try {
      const token = await refreshWith(entry, cred.refreshToken)
      await store.setOAuth(ref, {
        accessToken: token.accessToken,
        // rotation：必须立刻写新值，否则下次刷新会用作废的 token
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        expiresAt: token.expiresAt,
        ...(token.scope ? { scope: token.scope } : {}),
        providerId,
      })
      notify(`${ref} 的 token 已自动刷新`)
      return token.accessToken
    } catch (e) {
      // 刷新失败不阻断：旧 token 可能还能用一会儿，让请求自己去撞 401
      notify(`${ref} 自动刷新失败：${(e as Error).message}`)
      return cred.accessToken
    }
  }

  return async (ref: string | undefined): Promise<string | null> => {
    if (!ref) return null

    const pending = inflight.get(ref)
    if (pending) return pending

    const task = (async () => {
      const cred = await store.get(ref)
      if (cred?.kind === 'oauth' && needsRefresh(cred, Date.now())) {
        return doRefresh(ref, cred)
      }
      const resolved = await store.resolve(ref)
      return resolved?.secret ?? null
    })()

    inflight.set(ref, task)
    try {
      return await task
    } finally {
      inflight.delete(ref)
    }
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
