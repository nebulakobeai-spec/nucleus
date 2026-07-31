import type { AuthCodeProviderConfig } from '../auth/oauth-auth-code.js'
import type { OAuthProviderConfig } from '../auth/oauth.js'

/**
 * OAuth provider 注册表。
 *
 * 两种 flow 并存：
 *  - `device`    —— RFC 8628，不需要回调端口
 *  - `auth_code` —— Authorization Code + PKCE + 本地回调（OpenAI 只支持这个）
 *
 * **不内置任何第三方产品的 client_id。** 那些 id 是别人向 provider 注册的
 * 应用标识，拿来用等于把自己声明成对方。所以内置模板把 clientId 留空，
 * 由部署方在 `nucleus.config.json` 里填自己申请的值。
 */

export type OAuthFlowConfig =
  | { kind: 'device'; config: OAuthProviderConfig }
  | { kind: 'auth_code'; config: AuthCodeProviderConfig }

/** 配置文件里的声明形态（扁平，便于手写 JSON） */
export interface OAuthProviderDeclaration {
  kind?: 'device' | 'auth_code'
  clientId: string
  clientSecret?: string
  /** auth_code */
  authorizeUrl?: string
  tokenUrl?: string
  callbackPort?: number
  callbackPath?: string
  extraAuthorizeParams?: Record<string, string>
  discoveryUrl?: string
  trustedDomain?: string
  /** device */
  deviceAuthorizationUrl?: string
  /** 通用 */
  scope?: string[]
  usePkce?: boolean
  redirectUri?: string
}

/**
 * 内置端点模板。
 *
 * 只提供**端点与 scope**这些公开的协议事实，不提供 clientId。
 * 部署方在配置里给出 clientId 即可启用；不给则该 provider 不可用。
 */
export const PROVIDER_TEMPLATES: Record<
  string,
  Omit<OAuthProviderDeclaration, 'clientId'> & { kind: 'device' | 'auth_code'; note?: string }
> = {
  openai: {
    kind: 'auth_code',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    callbackPort: 1455,
    callbackPath: '/auth/callback',
    scope: ['openid', 'profile', 'email', 'offline_access'],
    usePkce: true,
    extraAuthorizeParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'nucleus',
    },
    note: 'OpenAI 只支持 Authorization Code Flow，不支持 device flow',
  },
  xai: {
    kind: 'auth_code',
    authorizeUrl: 'https://auth.x.ai/oauth/authorize',
    tokenUrl: 'https://auth.x.ai/oauth/token',
    discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
    trustedDomain: 'x.ai',
    // 与 OpenAI 分开，避免同时登录时抢端口
    callbackPort: 1456,
    callbackPath: '/auth/callback',
    scope: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
    usePkce: true,
    note: 'xAI 同时支持 auth_code 与 device flow',
  },
  'xai-device': {
    kind: 'device',
    deviceAuthorizationUrl: 'https://auth.x.ai/oauth/device_code',
    tokenUrl: 'https://auth.x.ai/oauth/token',
    scope: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
    usePkce: true,
    note: 'xAI 的 device flow 变体，适合无法监听端口的环境',
  },
}

export class OAuthRegistry {
  #providers = new Map<string, OAuthFlowConfig>()

  constructor(declarations: Record<string, OAuthProviderDeclaration> = {}) {
    for (const [id, decl] of Object.entries(declarations)) {
      const built = buildProvider(id, decl)
      if (built) this.#providers.set(id, built)
    }
  }

  get(id: string): OAuthFlowConfig | undefined {
    return this.#providers.get(id)
  }

  ids(): string[] {
    return [...this.#providers.keys()].sort()
  }

  get size(): number {
    return this.#providers.size
  }

  /** 有模板但未配置 clientId 的 provider —— 用于给出可操作的提示 */
  static availableTemplates(): Array<{ id: string; kind: string; note: string }> {
    return Object.entries(PROVIDER_TEMPLATES).map(([id, t]) => ({
      id,
      kind: t.kind,
      note: t.note ?? '',
    }))
  }
}

/**
 * 声明 → 完整配置。模板补齐端点，声明里的值优先。
 */
export function buildProvider(id: string, decl: OAuthProviderDeclaration): OAuthFlowConfig | null {
  const tpl = PROVIDER_TEMPLATES[id]
  const kind = decl.kind ?? tpl?.kind ?? 'auth_code'

  const merged = {
    ...tpl,
    ...Object.fromEntries(Object.entries(decl).filter(([, v]) => v !== undefined)),
  } as OAuthProviderDeclaration & { kind?: string }

  if (!merged.clientId) return null // 没有 clientId 就不注册；调用方给提示

  if (kind === 'device') {
    if (!merged.deviceAuthorizationUrl || !merged.tokenUrl) return null
    const config: OAuthProviderConfig = {
      id,
      ref: id,
      clientId: merged.clientId,
      deviceAuthorizationUrl: merged.deviceAuthorizationUrl,
      tokenUrl: merged.tokenUrl,
      ...(merged.scope ? { scopes: merged.scope } : {}),
      ...(merged.usePkce !== undefined ? { usePkce: merged.usePkce } : {}),
      ...(merged.clientSecret ? { clientSecret: merged.clientSecret } : {}),
    }
    return { kind: 'device', config }
  }

  if (!merged.authorizeUrl || !merged.tokenUrl) return null
  const config: AuthCodeProviderConfig = {
    id,
    clientId: merged.clientId,
    authorizeUrl: merged.authorizeUrl,
    tokenUrl: merged.tokenUrl,
    callbackPort: merged.callbackPort ?? 1455,
    callbackPath: merged.callbackPath ?? '/auth/callback',
    scope: merged.scope ?? [],
    usePkce: merged.usePkce ?? true,
    ...(merged.redirectUri ? { redirectUri: merged.redirectUri } : {}),
    ...(merged.extraAuthorizeParams ? { extraAuthorizeParams: merged.extraAuthorizeParams } : {}),
    ...(merged.clientSecret ? { clientSecret: merged.clientSecret } : {}),
    ...(merged.discoveryUrl ? { discoveryUrl: merged.discoveryUrl } : {}),
    ...(merged.trustedDomain ? { trustedDomain: merged.trustedDomain } : {}),
  }
  return { kind: 'auth_code', config }
}
