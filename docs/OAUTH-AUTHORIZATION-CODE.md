# OAuth Authorization Code Flow 实现参考

> **本文档写给 Nucleus 实现方。**
>
> 目标：让 Nucleus 支持 **OAuth 2.0 Authorization Code Flow + PKCE + 本地回调**，
> 以便对接 OpenAI（ChatGPT 订阅）和 xAI（Grok 订阅）的 OAuth 登录，
> 而不仅限于 API key。
>
> 参考资料：OpenClaw 的生产实现（已跑通 OpenAI 和 xAI 的订阅 OAuth）。

---

## 1. 为什么需要 Authorization Code Flow

### 当前状态

Nucleus 的 OAuth（`src/auth/oauth.ts`）只实现了 **Device Flow**（RFC 8628）。
Device Flow 的注册表（`src/cli/auth.ts` 的 `OAUTH_PROVIDERS`）为空。

### 四家 Provider 的实际情况

| Provider | OAuth 支持 | 适合的 Flow |
|----------|-----------|------------|
| **OpenAI** (ChatGPT 订阅) | ✅ 有 | **Authorization Code + PKCE**（不支持 Device Flow） |
| **xAI** (Grok 订阅) | ✅ 有 | **Authorization Code + PKCE** 和 **Device Flow** 均可 |
| **ZAI** (GLM) | ❌ 无公开 OAuth | 仅 API key |
| **Kimi** | ❌ 无公开 OAuth | 仅 API key |

**关键矛盾**：OpenAI 只提供 Authorization Code Flow，而 Nucleus 只实现了 Device Flow。
所以目前 Nucleus 无法通过 OAuth 接入 OpenAI。

> **xAI 补充**：xAI 同时提供 Device Flow 和 Authorization Code Flow（从 OIDC discovery
> 文档的 `device_authorization_endpoint` 和 `authorization_endpoint` 可以确认）。
> OpenClaw 对 xAI 使用的是 Authorization Code Flow。

---

## 2. Authorization Code Flow 与 Device Flow 的区别

### Device Flow（Nucleus 已有）

```
客户端 → POST /device_authorization → device_code + user_code + verification_uri
用户在浏览器打开 verification_uri，输入 user_code
客户端 → 轮询 POST /token（直到用户完成授权）→ access_token + refresh_token
```

特点：**不需要回调地址**，适合没有监听端口的场景。

### Authorization Code Flow + PKCE（本文档要加的）

```
客户端生成 PKCE verifier/challenge + state
客户端 → 打开浏览器到 authorize URL（带 code_challenge + state）
用户在浏览器登录授权
Provider → 302 重定向到 http://localhost:<port>/callback?code=xxx&state=yyy
客户端监听本地端口捕获 code
客户端 → POST /token（code + code_verifier）→ access_token + refresh_token
```

特点：**需要监听本地端口**，但用户体验更好（不需要手动输入 user_code）。

### 核心差异

| | Device Flow | Authorization Code Flow |
|---|---|---|
| 回调地址 | 不需要 | **需要本地 HTTP 服务器** |
| 用户操作 | 打开 URL + 输入 user_code | 只打开 URL（自动完成） |
| PKCE | 可选 | **必须**（公共客户端） |
| State 校验 | 可选 | **必须**（防 CSRF） |
| Provider 支持 | 少（xAI 支持，OpenAI 不支持） | 多（OpenAI + xAI 都支持） |

---

## 3. OpenClaw 的实现细节（生产验证过）

以下内容直接从 OpenClaw 源码中提取，可作为实现参考。

### 3.1 OpenAI（ChatGPT / Codex 订阅）

#### 常量

```typescript
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"  // OpenClaw 的 client_id
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const CALLBACK_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
const REDIRECT_URI = "http://localhost:1455/auth/callback"
const SCOPE = "openid profile email offline_access"
```

> 注意：`client_id` 是公开的（公共客户端没有 secret），PKCE 保证安全。
> Nucleus 可以向 OpenAI 申请自己的 `client_id`，也可以在用户配置里让它可配。

#### Authorize URL 构建

```typescript
function buildAuthorizeUrl(verifier, challenge, state, redirectUri) {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", SCOPE)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  // OpenAI 专用参数：
  url.searchParams.set("id_token_add_organizations", "true")
  url.searchParams.set("codex_cli_simplified_flow", "true")
  url.searchParams.set("originator", "openclaw")  // 或 "nucleus"
  return url.toString()
}
```

#### 本地回调服务器

```typescript
import { createServer } from "node:http"

function startLocalCallbackServer(port, host, expectedState) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`)
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end("Not found")
      return
    }
    // 1. 校验 state（防 CSRF）
    if (url.searchParams.get("state") !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html" })
      res.end("State mismatch.")
      return
    }
    // 2. 提取 code
    const code = url.searchParams.get("code")
    if (!code) {
      res.writeHead(400).end("Missing code.")
      return
    }
    // 3. 返回成功页面给浏览器
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end("<h1>✅ 授权完成，可以关闭此页面。</h1>")
    // 4. 解析 promise
    resolveCode(code)
  })

  server.listen(port, host)
  return { server, waitForCode: codePromise }
}
```

#### Token 交换

```typescript
async function exchangeCodeForToken(code, verifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,       // PKCE verifier
    redirect_uri: redirectUri,     // 必须与 authorize 时一致
  })

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })

  const json = await res.json()
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: resolveExpires(json.expires_in),
  }
}
```

#### 从 access_token 提取 accountId

OpenAI 的 access_token 是 JWT，里面有 `accountId`，用于标识订阅账户：

```typescript
function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1]
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
}

function getAccountId(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken)
  return typeof claims["accountId"] === "string" ? claims["accountId"] : null
}
```

#### Refresh 流程

```typescript
async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,     // 公共客户端没有 client_secret
  })

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })

  const json = await res.json()
  // OpenAI 每次 refresh 会返回新的 refresh_token（rotation）
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: resolveExpires(json.expires_in),
  }
}
```

> **⚠️ refresh_token rotation**：OpenAI 每次 refresh 会发新的 refresh_token 并作废旧的。
> 这要求存储层在 refresh 成功后立即写入新的 refresh_token，否则下次 refresh 会失败。
> Nucleus 的 `CredentialStore.setOAuth()` 已经支持这个语义。

### 3.2 xAI（Grok 订阅）

#### 常量

```typescript
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"
const XAI_OAUTH_ISSUER = "https://auth.x.ai"
const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration"
```

#### OIDC Discovery

xAI 支持标准的 OIDC Discovery，端点信息可以从 discovery 文档动态获取：

```typescript
async function discoverXaiEndpoints() {
  const res = await fetch("https://auth.x.ai/.well-known/openid-configuration")
  const doc = await res.json()
  return {
    authorizationEndpoint: doc.authorization_endpoint,    // https://auth.x.ai/oauth/authorize
    tokenEndpoint: doc.token_endpoint,                    // https://auth.x.ai/oauth/token
    deviceAuthorizationEndpoint: doc.device_authorization_endpoint,
  }
}
```

> **安全约束**：OpenClaw 会校验 discovery 返回的端点必须是 `x.ai` 或 `*.x.ai`，
> 防止 discovery 被篡改指向恶意端点。Nucleus 应同样校验。

#### xAI 也支持 Device Flow

如果 Nucleus 想用已有的 Device Flow 代码接入 xAI，也是可以的——
xAI 的 discovery 文档包含 `device_authorization_endpoint`。
但 OpenAI 不行，所以如果要统一接入两家，Authorization Code Flow 是必须的。

### 3.3 远程/Headless 环境的处理

OpenClaw 的关键设计：**本地回调服务器和手动粘贴互相竞争（race），先到的赢。**

```typescript
// 同时启动两条路径：
// 1. 本地回调服务器（如果有浏览器且端口可用，自动完成）
// 2. 手动粘贴输入（远程/VPS 或端口被占时）

const [callbackResult, manualResult] = await Promise.race([
  waitForLocalCallback(expectedState),
  waitForManualPaste(),
])
```

**为什么这样设计**：
- 本地有浏览器时，用户打开链接就自动完成，无需手动粘贴
- 远程 SSH/VPS 时，浏览器在用户本地但服务器无法收到回调，用户可以手动粘贴 redirect URL
- 两条路径不互斥，先完成的赢，另一条自动取消

**手动粘贴的输入解析**：用户可能粘贴整个 redirect URL（`http://localhost:1455/auth/callback?code=xxx&state=yyy`）
也可能只粘贴 code，需要两种都支持：

```typescript
function parseOAuthCallbackInput(input: string, expectedState: string): { code: string } {
  try {
    const url = new URL(input)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (state && state !== expectedState) throw new Error("State mismatch")
    if (code) return { code }
  } catch {
    // 不是 URL，当作纯 code 处理
    const trimmed = input.trim()
    if (trimmed) return { code: trimmed }
  }
  throw new Error("无法解析授权码")
}
```

---

## 4. Nucleus 需要改什么

### 4.1 新增 `src/auth/oauth-auth-code.ts`

实现 Authorization Code Flow，接口与现有 `OAuthClient`（device flow）对齐：

```typescript
export interface AuthCodeProviderConfig {
  id: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  callbackPort: number
  callbackPath: string
  scope: string[]
  usePkce: boolean        // 应当为 true
  redirectUri?: string    // 默认 http://localhost:{callbackPort}{callbackPath}
  /** 额外的 authorize 参数（如 OpenAI 的 originator） */
  extraAuthorizeParams?: Record<string, string>
}

export class AuthCodeClient {
  constructor(private cfg: AuthCodeProviderConfig) {}

  createPkce(): { verifier: string; challenge: string; method: "S256" }
  buildAuthorizeUrl(pkceChallenge: string, state: string): string
  startCallbackServer(state: string): { waitForCode: Promise<string>; close: () => void }
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenResponse>
  refresh(refreshToken: string): Promise<TokenResponse>
}
```

### 4.2 扩展 `OAUTH_PROVIDERS` 注册表

当前注册表只接受 `OAuthProviderConfig`（device flow），需要扩展为联合类型：

```typescript
type OAuthFlowConfig =
  | { kind: "device"; config: OAuthProviderConfig }      // 现有的
  | { kind: "auth_code"; config: AuthCodeProviderConfig } // 新增的

export const OAUTH_PROVIDERS: Record<string, OAuthFlowConfig> = {
  "openai": {
    kind: "auth_code",
    config: {
      id: "openai",
      clientId: "<Nucleus 自己的 client_id，或复用 Codex CLI 的>",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      callbackPort: 1455,          // 或自选
      callbackPath: "/auth/callback",
      scope: ["openid", "profile", "email", "offline_access"],
      usePkce: true,
      extraAuthorizeParams: {
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "nucleus",
      },
    },
  },
  "xai": {
    kind: "auth_code",
    config: {
      id: "xai",
      clientId: "<xAI 提供的 client_id>",
      authorizeUrl: "https://auth.x.ai/oauth/authorize",
      tokenUrl: "https://auth.x.ai/oauth/token",
      callbackPort: 1456,          // 与 OpenAI 分开，避免同时登录时冲突
      callbackPath: "/auth/callback",
      scope: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
      usePkce: true,
    },
  },
}
```

### 4.3 修改 `oauthLogin` 命令

`src/cli/auth.ts` 的 `oauthLogin` 函数当前只处理 device flow。
改为根据 config 的 `kind` 分派：

```typescript
async function oauthLogin(store: CredentialStore, ref: string, flags: Record<string, string | true>) {
  const providerId = typeof flags["provider"] === "string" ? flags["provider"] : ref
  const cfg = OAUTH_PROVIDERS[providerId]

  if (!cfg) { /* 现有的错误提示 */ }

  if (cfg.kind === "device") {
    return deviceFlowLogin(store, ref, cfg.config, flags)
  } else {
    return authCodeFlowLogin(store, ref, cfg.config, flags)
  }
}
```

### 4.4 authCodeFlowLogin 的流程

```
1. 生成 PKCE verifier/challenge + state
2. 构建 authorize URL
3. 打印 URL，尝试打开浏览器
4. 启动本地回调服务器（监听 callbackPort）
5. 同时启动手动粘贴 fallback（15s 后提示）
6. 等待：回调服务器收到 code 或用户手动粘贴 code（先到的赢）
7. 用 code + verifier 换 token
8. 调用 store.setOAuth(ref, { accessToken, refreshToken, expiresAt })
9. 关闭回调服务器
```

### 4.5 凭据存储不需要改

`CredentialStore`（`src/auth/credentials.ts`）已经支持 OAuth 凭据的存储和读取：
- `setOAuth()` 写入 `{ kind: "oauth", accessToken, refreshToken, expiresAt }`
- `resolve()` 返回 `secret = accessToken`
- keychain 和文件后端都已适配

`ModelRouter`（`src/providers/router.ts`）用 `secrets(ref)` 拿到的就是这个 accessToken，
直接作为 `Bearer` token 发送——对 OpenAI 和 xAI 的 HTTP API 来说和 API key 完全一样。

**唯一需要加的**：运行时的自动 refresh。当前 `makeSecretResolver`（auth.ts 底部）
检测到 token 快过期时只打印一条提示。应改为自动调用 `AuthCodeClient.refresh()` 并更新存储。

### 4.6 配置文件支持

在 `nucleus.config.json` 里允许声明 OAuth provider（不硬编码到源码）：

```json
{
  "oauthProviders": {
    "openai": {
      "kind": "auth_code",
      "clientId": "app_xxxx",
      "authorizeUrl": "https://auth.openai.com/oauth/authorize",
      "tokenUrl": "https://auth.openai.com/oauth/token",
      "callbackPort": 1455,
      "callbackPath": "/auth/callback",
      "scope": ["openid", "profile", "email", "offline_access"],
      "extraAuthorizeParams": {
        "codex_cli_simplified_flow": "true",
        "originator": "nucleus"
      }
    }
  }
}
```

这样不在源码里绑定 client_id，部署方可以自己配。

---

## 5. 安全注意事项

### 5.1 State（CSRF 防护）

- state 必须用 `crypto.randomBytes(16)` 生成
- 回调时必须校验 state 与发起时一致
- 不校验 = 允许攻击者伪造回调

### 5.2 PKCE

- verifier 用 `crypto.randomBytes(32)` → base64url 编码（最少 256 位）
- challenge = `SHA256(verifier)` → base64url
- challenge_method 固定 `S256`（不用 `plain`）
- token 交换时必须发 verifier，provider 校验 `SHA256(verifier) == challenge`

### 5.3 回调地址绑定 loopback

- redirect_uri 只允许 `http://localhost:<port>/<path>` 或 `http://127.0.0.1:<port>/<path>`
- 不允许 `0.0.0.0`、局域网 IP 或 HTTPS（本地不需要 TLS）
- OpenClaw 的约束：`LOOPBACK_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])`

### 5.4 refresh_token 存储

- refresh_token 与 access_token 一起存在 CredentialStore（keychain 或 0600 文件）
- **不进日志、不进诊断包**（`redactText()` 已覆盖）
- refresh 成功后立即写入新的 refresh_token（rotation 场景）

### 5.5 Discovery 端点校验

如果用 OIDC Discovery（xAI 支持），校验返回的端点域名：

```typescript
function isTrustedDomain(url: string, trustedSuffix: string): boolean {
  const hostname = new URL(url).hostname
  return hostname === trustedSuffix || hostname.endsWith("." + trustedSuffix)
}

// xAI: trustedSuffix = "x.ai"
// 返回的 authorization_endpoint / token_endpoint 必须在 x.ai 或 *.x.ai 下
```

---

## 6. 测试策略

### 离线测试（不依赖网络）

| 测试 | 验证 |
|------|------|
| PKCE verifier/challenge 正确性 | `SHA256(verifier) == challenge` |
| Authorize URL 构建 | 参数完整、顺序正确 |
| Callback URL 解析 | code + state 提取正确 |
| State mismatch 拒绝 | 不一致的 state 被拒 |
| 回调服务器启动/关闭 | 端口绑定、正常关闭 |
| Token 交换请求体 | grant_type / code / verifier / redirect_uri 正确 |
| Token 响应解析 | access / refresh / expires_at 正确提取 |
| 过期 token 触发 refresh | refresh 被调用、新 token 被存储 |
| Refresh response 缺少 refresh_token | 沿用旧的（provider 不回新的） |

### 真实环境测试（tier 3）

用真 OpenAI / xAI 账户跑一次完整登录 → ask → 长时间后 refresh。

---

## 7. 与 Device Flow 的共存

两种 flow 不互斥：

```
nucleus auth login OPENAI_API_KEY --oauth --provider openai
  → 走 Authorization Code Flow（有回调服务器）

nucleus auth login XAI_API_KEY --oauth --provider xai --method device
  → 走 Device Flow（无回调服务器，适合 xAI 的备选路径）

nucleus auth login ZAI_API_KEY
  → 走 API key（不变）
```

`--method` 参数（可选）让用户显式选择，默认根据 provider config 的 `kind` 自动判断。

---

## 8. 实现优先级建议

| 阶段 | 内容 | 价值 |
|------|------|------|
| **P0** | Authorization Code Flow 核心实现（PKCE + 回调服务器 + token 交换） | 接入 OpenAI 的前提 |
| **P0** | OpenAI provider 注册（client_id + 端点） | 核心需求 |
| **P1** | 运行时自动 refresh | 长时间运行的必要条件 |
| **P1** | 手动粘贴 fallback（远程/headless） | VPS 部署场景 |
| **P2** | xAI provider 注册（auth code flow） | xAI 也可用 device flow，优先级低 |
| **P2** | 配置文件声明 OAuth provider | 不硬编码 client_id |
| **P3** | OIDC Discovery 支持 | 动态获取端点 |

---

## 附录 A：OpenAI 的 OAuth 端点

| 端点 | URL |
|------|-----|
| Authorize | `https://auth.openai.com/oauth/authorize` |
| Token | `https://auth.openai.com/oauth/token` |
| Scope | `openid profile email offline_access` |
| Client ID | 需向 OpenAI 申请，或复用 Codex CLI 的公共 client_id |
| Redirect URI | `http://localhost:<port>/auth/callback`（loopback only） |

## 附录 B：xAI 的 OAuth 端点

| 端点 | URL |
|------|-----|
| OIDC Discovery | `https://auth.x.ai/.well-known/openid-configuration` |
| Authorize | `https://auth.x.ai/oauth/authorize`（从 discovery 获取） |
| Token | `https://auth.x.ai/oauth/token`（从 discovery 获取） |
| Device Authorization | `https://auth.x.ai/oauth/device_code`（从 discovery 获取） |
| Scope | `openid profile email offline_access grok-cli:access api:access` |
| Client ID | 需向 xAI 申请 |
| Redirect URI | `http://localhost:<port>/auth/callback`（loopback only） |
