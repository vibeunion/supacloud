# SupaCloud OAuth Provider 配置指南

> 说明：本文档讲的是“第三方登录 Provider”（Google、GitHub、微信等）的配置。
> 如果你要把某个 SupaCloud 项目本身迁移成 OAuth 2.1 / OIDC Provider，请看 [OAuth 2.1 / OIDC Provider](./oauth-oidc-provider.md)。

本文档介绍如何在 SupaCloud 中配置第三方 OAuth 登录。

## 支持的 Provider

### 标准 OAuth Provider

| Provider | ID | 环境变量前缀 |
|----------|-----|-------------|
| Google | `google` | `GOTRUE_EXTERNAL_GOOGLE_` |
| GitHub | `github` | `GOTRUE_EXTERNAL_GITHUB_` |
| GitLab | `gitlab` | `GOTRUE_EXTERNAL_GITLAB_` |
| Facebook | `facebook` | `GOTRUE_EXTERNAL_FACEBOOK_` |
| Twitter | `twitter` | `GOTRUE_EXTERNAL_TWITTER_` |
| Apple | `apple` | `GOTRUE_EXTERNAL_APPLE_` |
| Azure | `azure` | `GOTRUE_EXTERNAL_AZURE_` |
| Discord | `discord` | `GOTRUE_EXTERNAL_DISCORD_` |
| Spotify | `spotify` | `GOTRUE_EXTERNAL_SPOTIFY_` |
| Slack | `slack` | `GOTRUE_EXTERNAL_SLACK_` |
| LinkedIn | `linkedin` | `GOTRUE_EXTERNAL_LINKEDIN_` |
| Twitch | `twitch` | `GOTRUE_EXTERNAL_TWITCH_` |
| Bitbucket | `bitbucket` | `GOTRUE_EXTERNAL_BITBUCKET_` |
| Figma | `figma` | `GOTRUE_EXTERNAL_FIGMA_` |
| Kakao | `kakao` | `GOTRUE_EXTERNAL_KAKAO_` |
| Keycloak | `keycloak` | `GOTRUE_EXTERNAL_KEYCLOAK_` |
| WorkOS | `workos` | `GOTRUE_EXTERNAL_WORKOS_` |
| Notion | `notion` | `GOTRUE_EXTERNAL_NOTION_` |
| Zoom | `zoom` | `GOTRUE_EXTERNAL_ZOOM_` |

### 微信 Provider

| Provider | ID | 说明 |
|----------|-----|------|
| 微信开放平台 | `wechat` | 标准 OAuth2.0，适用于 APP/H5 |
| 微信小程序 | `wechat_miniprogram` | 通过 Edge Function 实现 |
| 微信公众号 | `wechat_mp` | 通过 Edge Function 实现 |

### 国内第三方登录 Provider

| Provider | ID | 说明 |
|----------|-----|------|
| QQ | `qq` | 腾讯 QQ 登录 |
| 微博 | `weibo` | 新浪微博登录 |
| 支付宝 | `alipay` | 支付宝登录 |
| 钉钉 | `dingtalk` | 钉钉登录 |
| 抖音 | `douyin` | 抖音登录 |
| 百度 | `baidu` | 百度账号登录 |
| 华为 | `huawei` | 华为账号登录 |
| 小米 | `xiaomi` | 小米账号登录 |
| 快手 | `kuaishou` | 快手登录 |
| 哔哩哔哩 | `bilibili` | B站账号登录 |

> 详细配置请参考 [国内第三方登录集成指南](./china-oauth-integration.md)

## API 端点

### 获取支持的 Provider 列表

```bash
GET /v1/projects/:ref/auth/supported-providers
```

**响应示例：**
```json
{
  "providers": [
    {
      "id": "google",
      "name": "Google",
      "env_mapping": {
        "clientId": "GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID",
        "clientSecret": "GOTRUE_EXTERNAL_GOOGLE_SECRET",
        "redirectUri": "GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI"
      },
      "is_wechat": false
    },
    {
      "id": "wechat_miniprogram",
      "name": "微信小程序",
      "env_mapping": {
        "clientId": "WECHAT_MINIPROGRAM_APP_ID",
        "clientSecret": "WECHAT_MINIPROGRAM_APP_SECRET"
      },
      "is_wechat": true,
      "wechat_info": {
        "name": "微信小程序",
        "description": "适用于微信小程序一键登录，通过 Edge Function 实现",
        "loginType": "miniprogram",
        "isStandardOAuth": false
      }
    }
  ]
}
```

### 获取所有 Provider 状态

```bash
GET /v1/projects/:ref/auth/providers
```

**响应示例：**
```json
{
  "providers": {
    "google": {
      "enabled": true,
      "client_id": "xxx.apps.googleusercontent.com",
      "redirect_uri": "https://your-project.supabase.co/auth/v1/callback"
    },
    "github": {
      "enabled": false
    },
    "wechat_miniprogram": {
      "enabled": true,
      "client_id": "wx1234567890",
      "redirect_uri": null
    }
  }
}
```

### 配置 Provider

```bash
POST /v1/projects/:ref/auth/providers/:provider
```

**请求体：**
```json
{
  "client_id": "your-client-id",
  "client_secret": "your-client-secret",
  "redirect_uri": "https://your-domain.com/callback"
}
```

**响应示例：**
```json
{
  "provider": "google",
  "enabled": true,
  "client_id": "your-client-id",
  "redirect_uri": "https://your-domain.com/callback",
  "message": "OAuth provider google configured successfully"
}
```

### 更新 Provider

```bash
PATCH /v1/projects/:ref/auth/providers/:provider
```

**请求体：**
```json
{
  "client_id": "new-client-id"
}
```

### 删除 Provider

```bash
DELETE /v1/projects/:ref/auth/providers/:provider
```

**响应示例：**
```json
{
  "provider": "google",
  "enabled": false,
  "message": "OAuth provider google removed successfully"
}
```

## 配置示例

### 配置 Google 登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/providers/google \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "xxx.apps.googleusercontent.com",
    "client_secret": "GOCSPX-xxx",
    "redirect_uri": "https://your-project.supabase.co/auth/v1/callback"
  }'
```

### 配置 GitHub 登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/providers/github \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "Ov23lixxx",
    "client_secret": "xxx"
  }'
```

## Studio 兼容 API

### 获取 Provider 列表（Studio 格式）

```bash
GET /v1/projects/:ref/auth/studio/providers
```

**响应示例：**
```json
{
  "providers": {
    "google": {
      "enabled": true,
      "client_id": "xxx.apps.googleusercontent.com",
      "redirect_uri": "https://your-project.supabase.co/auth/v1/callback",
      "display_name": "Google",
      "is_custom": false
    },
    "wechat_miniprogram": {
      "enabled": true,
      "client_id": "wx1234567890",
      "redirect_uri": null,
      "display_name": "微信小程序",
      "is_custom": true,
      "custom_type": "miniprogram"
    }
  },
  "enabled_providers": ["google", "wechat_miniprogram"]
}
```

### 配置 Provider（Studio 格式）

```bash
PATCH /v1/projects/:ref/auth/studio/providers/:provider
```

**请求体：**
```json
{
  "enabled": true,
  "client_id": "your-client-id",
  "client_secret": "your-client-secret",
  "redirect_uri": "https://your-domain.com/callback"
}
```

**禁用 Provider：**
```json
{
  "enabled": false
}
```

## Auth 配置端点

### 获取 Auth 配置

```bash
GET /v1/projects/:ref/config/auth
```

**响应示例：**
```json
{
  "site_url": "https://your-project.supabase.co",
  "jwt_exp": 3600,
  "external": {
    "google": {
      "client_id": "xxx.apps.googleusercontent.com",
      "redirect_uri": "https://your-project.supabase.co/auth/v1/callback"
    },
    "wechat_miniprogram": {
      "client_id": "wx1234567890"
    }
  },
  "external_providers": "google,wechat_miniprogram"
}
```

### 更新 Auth 配置

```bash
PATCH /v1/projects/:ref/config/auth
```

**请求体：**
```json
{
  "site_url": "https://new-domain.com",
  "jwt_exp": 7200
}
```

## 客户端使用

### JavaScript/TypeScript

```javascript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('https://your-project.supabase.co', 'anon-key')

// OAuth 登录
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: 'https://your-domain.com/auth/callback'
  }
})

// 获取当前用户
const { data: { user } } = await supabase.auth.getUser()

// 登出
await supabase.auth.signOut()
```

### 微信小程序（使用 supabase-mp-js）

```javascript
import { createClient } from 'supabase-mp-js'

const supabase = createClient('https://your-project.supabase.co', 'anon-key')

// 微信一键登录
wx.login({
  success: async (res) => {
    const { data, error } = await supabase.auth.signInWithWechat({
      code: res.code
    })
    
    if (!error) {
      console.log('登录成功:', data.user)
    }
  }
})
```

## 环境变量参考

配置会自动同步到 GoTrue 环境变量文件 (`/etc/supabase/tenants/{ref}_gotrue.env`)：

```env
# Google
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOTRUE_EXTERNAL_GOOGLE_SECRET=GOCSPX-xxx
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=https://your-project.supabase.co/auth/v1/callback

# GitHub
GOTRUE_EXTERNAL_GITHUB_CLIENT_ID=Ov23lixxx
GOTRUE_EXTERNAL_GITHUB_SECRET=xxx

# 微信小程序
WECHAT_MINIPROGRAM_APP_ID=wx1234567890
WECHAT_MINIPROGRAM_APP_SECRET=xxx

# 微信公众号
WECHAT_MP_APP_ID=wx1234567890
WECHAT_MP_APP_SECRET=xxx
WECHAT_MP_REDIRECT_URI=https://your-domain.com/auth/callback
```

## 故障排除

### Provider 未生效

1. 检查配置是否正确保存：
```bash
GET /v1/projects/:ref/auth/providers/:provider
```

2. 检查 GoTrue 服务状态：
```bash
systemctl status supacloud-gotrue@{ref}
```

3. 查看 GoTrue 日志：
```bash
journalctl -u supacloud-gotrue@{ref} -f
```

### 微信登录失败

1. 确认 Edge Function 已部署：
```bash
GET /v1/projects/:ref/functions
```

2. 检查 Edge Function 日志：
```bash
docker logs supacloud-global-edge-runtime
```

3. 验证微信 AppID 和 AppSecret 是否正确。

### 回调 URL 问题

确保回调 URL 与 OAuth Provider 配置中的一致：

- 标准 OAuth: `{API_URL}/auth/v1/callback`
- 微信公众号: 自定义配置的 `redirect_uri`
