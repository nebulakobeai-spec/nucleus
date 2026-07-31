# OAuth Provider 参数补充：Kimi Device Flow + ZAI 现状

> **本文档补充 `docs/OAUTH-AUTHORIZATION-CODE.md` 中未覆盖的两家 provider。**
>
> 基于对 kimi-cli 源码、docs.z.ai、以及多个第三方集成项目的调研，
> 给出 Kimi 的完整 device flow 参数和 ZAI（GLM）无 OAuth 的结论。

---

## Kimi（Moonshot AI）— Device Flow

Kimi Coding Plan 支持 **标准 RFC 8628 Device Authorization Grant**。
以下参数从 kimi-cli 源码（`MoonshotAI/kimi-cli/src/kimi_cli/auth/oauth.py`）
和设计文档（`klip-14-kimi-code-oauth-login.md`）确认。

### 端点与凭据

| 字段 | 值 |
|------|-----|
| OAuth host | `https://auth.kimi.com` |
| Device authorization | `POST /api/oauth/device_authorization` |
| Token | `POST /api/oauth/token` |
| Public client_id | `17e5f671-d194-4dfb-9706-5516cb48c098` |
| Scope | 服务端返回 `kimi-code`（device_authorization 请求不传 scope） |

> **client_id 是公开的**：这是 kimi-cli 的公共客户端 id，多个社区集成
>（picassio/pi-kimi-coder、lemon07r/opencode-kimi-full、querymt/kimi-auth）
> 都在复用。公共客户端没有 secret，安全性由 device flow 的用户确认环节保证。

### 必需 Headers

Kimi 后端**强制要求**以下 headers，不带会被 401：

| Header | 说明 |
|--------|------|
| `X-Msh-Platform` | 客户端标识，如 `nucleus` |
| `X-Msh-Version` | 客户端版本号 |
| `X-Msh-Device-Name` | 设备名（ASCII） |
| `X-Msh-Device-Model` | 设备型号（ASCII） |
| `X-Msh-Os-Version` | 操作系统版本（ASCII） |
| `X-Msh-Device-Id` | **稳定 UUID**，必须持久化到磁盘（每次请求用同一个值） |

> `X-Msh-Device-Id` 必须是首次运行时生成的随机 UUID，之后持久化。
> 每次换一个值会导致后端认为是新设备。

### Token 生命周期

| | 有效期 |
|---|---|
| access_token | ~15 分钟 |
| refresh_token | ~30 天 |

推荐刷新时机：剩余寿命的 50% 或 300 秒，取较大值（与 kimi-cli 一致）。

### Token API

拿到 access_token 后，API 调用走 `https://api.kimi.com/coding/v1`（Bearer token），
协议是 **anthropic-messages**（不是 OpenAI 兼容）。

### Device Flow 流程

```
客户端 → POST https://auth.kimi.com/api/oauth/device_authorization
         Headers: X-Msh-Platform, X-Msh-Version, X-Msh-Device-Id, ...
         Body: client_id=17e5f671-d194-4dfb-9706-5516cb48c098
       ← device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval

用户在浏览器打开 verification_uri_complete → 登录 Kimi 账户 → 确认授权

客户端 → 轮询 POST https://auth.kimi.com/api/oauth/token
         Body: grant_type=urn:ietf:params:oauth:grant-type:device_code
               device_code=***
               client_id=17e5f671-d194-4dfb-9706-5516cb48c098
       ← access_token, refresh_token, expires_in
```

### 与 Nucleus 的对接

Nucleus 已有 device flow 实现（`src/auth/oauth.ts` 的 `OAuthClient`）。
需要做的是：

1. 在 `PROVIDER_TEMPLATES` 里加 `kimi` 的 device flow 模板
2. `OAuthProviderConfig` 支持自定义 headers（`X-Msh-*`）
3. `OAuthClient.requestDeviceCode()` 和 `pollForToken()` 发请求时带上这些 headers
4. `X-Msh-Device-Id` 需要持久化：首次生成 UUID → 存入 CredentialStore 或单独的 state 文件

### Nucleus 配置示例

```json
{
  "oauthProviders": {
    "kimi": {
      "kind": "device",
      "clientId": "17e5f671-d194-4dfb-9706-5516cb48c098",
      "deviceAuthorizationUrl": "https://auth.kimi.com/api/oauth/device_authorization",
      "tokenUrl": "https://auth.kimi.com/api/oauth/token",
      "scope": [],
      "usePkce": false,
      "extraHeaders": {
        "X-Msh-Platform": "nucleus",
        "X-Msh-Version": "1.0.0",
        "X-Msh-Device-Name": "nucleus",
        "X-Msh-Device-Model": "server",
        "X-Msh-Os-Version": "linux"
      }
    }
  }
}
```

> `X-Msh-Device-Id` 不写死在配置里——它在运行时生成并持久化。
> 部署方只需提供 clientId（上面的值已公开可查）。

---

## ZAI（GLM Coding Plan）— 无 OAuth

### 结论

**Z.AI 没有 OAuth endpoints，没有 client_id，没有 device flow。**
认证方式仅限 API key。

### 验证依据

以下来源在 2026-04-21 独立确认了这一结论：

- [docs.z.ai/api-reference/introduction](https://docs.z.ai/api-reference/introduction)
- [docs.z.ai/devpack/tool/opencode](https://docs.z.ai/devpack/tool/opencode)
- [docs.z.ai/devpack/tool/claude](https://docs.z.ai/devpack/tool/claude)
- `@z_ai/coding-helper` npm 包
- [zai-org/zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins)
- [gsd-build/gsd-2 #4642](https://github.com/gsd-build/gsd-2/issues/4642) — 详细调研记录

### "browser OAuth" 的误解

OpenClaw 文档将 "Z.AI / GLM Coding Plan" 列在订阅型选项中，
但那只是说明 GLM Coding Plan 是订阅制产品（月费），**认证方式仍然是 API key**。

第三方项目（oh-my-pi #6384）在尝试给 ZAI 加 browser OAuth，
但走的是 `chat.z.ai` 网页登录 → 后端 mint 一个 API key 的非标准曲线方案，
不是 OAuth 2.0。

### 对 Nucleus 的影响

ZAI 的四家订阅模型里，只有 GLM 无法走 OAuth。
部署时 GLM 必须用 `auth login ZAI_API_KEY` 配置 API key。

---

## 四家 OAuth 总览（更新）

| Provider | OAuth 支持 | Flow | client_id | Nucleus 状态 |
|----------|-----------|------|-----------|-------------|
| **OpenAI** | ✅ | Authorization Code + PKCE | `app_EMoamEEZ73f0CkXaXp7hrann` | 端点模板已内置，需配 clientId |
| **xAI (Grok)** | ✅ | Auth Code + Device Flow | `b1a00492-073a-47ea-816f-4c329264a828` | 端点模板已内置，需配 clientId |
| **Kimi** | ✅ | **Device Flow**（RFC 8628） | `17e5f671-d194-4dfb-9706-5516cb48c098` | **需要实现**：加模板 + 自定义 headers + device_id 持久化 |
| **ZAI (GLM)** | ❌ | — | — | 仅 API key，无法走 OAuth |

---

## 实现建议

### 优先级

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **现在** | OpenAI + xAI 的 OAuth（auth_code flow，已实现） | 只需在配置里填 clientId |
| **P1** | Kimi 的 OAuth（device flow + X-Msh headers + device_id） | 需要扩展 OAuthProviderConfig 支持自定义 headers |
| **不做** | ZAI 的 OAuth | 没有 OAuth 可对接 |

### Kimi 实现要点

1. **`OAuthProviderConfig` 加 `extraHeaders` 字段**
   - Device flow 的 `requestDeviceCode()` 和 `pollForToken()` 都需要带 `X-Msh-*` headers
   - 这些 headers 是固定的，可以放在 provider 配置里

2. **`X-Msh-Device-Id` 的持久化**
   - 首次登录时生成随机 UUID
   - 存入 `~/.nucleus/device-id` 或 CredentialStore
   - 后续所有请求（包括 refresh）都复用同一个值
   - 换设备 = 重新登录

3. **scope 留空**
   - Kimi 的 device_authorization 不接受 scope 参数
   - 服务端自动返回 `kimi-code` scope
