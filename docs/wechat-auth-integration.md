# SupaCloud 微信登录集成指南

本文档介绍如何在 SupaCloud 中配置和使用微信登录功能。

## 概述

SupaCloud 支持三种微信登录方式：

| 登录方式 | 适用场景 | 实现方案 | 是否标准 OAuth2.0 |
|---------|---------|---------|------------------|
| **微信开放平台** | 移动 APP、H5 网页 | GoTrue 自定义 Provider | ✅ 是 |
| **微信公众号** | 公众号网页授权 | Edge Function 代理 | ⚠️ OAuth2.0 变体 |
| **微信小程序** | 微信小程序一键登录 | Edge Function (code2session) | ❌ 否 |

## API 端点

### 通用端点

```
GET  /v1/projects/:ref/auth/providers              # 获取所有 OAuth Provider 状态
GET  /v1/projects/:ref/auth/providers/:provider   # 获取单个 Provider 配置
POST /v1/projects/:ref/auth/providers/:provider   # 配置新的 OAuth Provider
PATCH /v1/projects/:ref/auth/providers/:provider  # 更新现有 Provider 配置
DELETE /v1/projects/:ref/auth/providers/:provider # 删除 Provider 配置
GET  /v1/projects/:ref/auth/supported-providers   # 获取支持的 Provider 列表
```

### Studio 兼容端点

```
GET  /v1/projects/:ref/auth/studio/providers       # Studio 兼容格式获取 Provider 列表
PATCH /v1/projects/:ref/auth/studio/providers/:provider # Studio 兼容格式配置 Provider
```

### 微信专用端点

```
GET  /v1/projects/:ref/auth/wechat/providers       # 获取微信全系 Provider 状态
POST /v1/projects/:ref/auth/wechat/open            # 配置微信开放平台登录
POST /v1/projects/:ref/auth/wechat/mp              # 配置微信公众号登录
POST /v1/projects/:ref/auth/wechat/miniprogram     # 配置微信小程序登录
```

## 配置示例

### 1. 微信小程序登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/wechat/miniprogram \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "YOUR_WECHAT_APP_ID",
    "app_secret": "your-app-secret",
    "deploy_function": true
  }'
```

**响应：**
```json
{
  "provider": "wechat_miniprogram",
  "enabled": true,
  "name": "微信小程序",
  "message": "微信小程序登录配置成功，Edge Function 已部署",
  "function_slug": "wechat-login"
}
```

**客户端使用（配合 supabase-mp-js）：**

```javascript
import { createClient } from 'supabase-mp-js'

const supabase = createClient('https://your-project.supabase.co', 'anon-key')

// 微信小程序一键登录
wx.login({
  success: async (res) => {
    const { data, error } = await supabase.auth.signInWithWechat({
      code: res.code,
    })
    
    if (!error) {
      console.log('登录成功:', data.user)
    }
  }
})
```

### 2. 微信公众号登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/wechat/mp \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "YOUR_WECHAT_APP_ID",
    "app_secret": "your-app-secret",
    "redirect_uri": "https://your-domain.com/auth/callback",
    "deploy_function": true
  }'
```

**响应：**
```json
{
  "provider": "wechat_mp",
  "enabled": true,
  "name": "微信公众号",
  "message": "微信公众号登录配置成功，Edge Function 已部署",
  "function_slug": "wechat-mp-login",
  "is_standard_oauth": false
}
```

**客户端使用：**

```javascript
// 获取授权 URL
const response = await fetch('https://your-project.supabase.co/functions/v1/wechat-mp-login')
const { auth_url } = await response.json()

// 跳转到微信授权页面
window.location.href = auth_url

// 回调处理
const urlParams = new URLSearchParams(window.location.search)
const code = urlParams.get('code')

if (code) {
  const loginResponse = await fetch(`https://your-project.supabase.co/functions/v1/wechat-mp-login?code=${code}`)
  const session = await loginResponse.json()
  // 保存 session
}
```

### 3. 微信开放平台登录（标准 OAuth2.0）

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/wechat/open \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "YOUR_WECHAT_APP_ID",
    "app_secret": "your-app-secret",
    "redirect_uri": "https://your-domain.com/auth/callback"
  }'
```

**响应：**
```json
{
  "provider": "wechat",
  "enabled": true,
  "name": "微信开放平台",
  "message": "微信开放平台登录配置成功（标准 OAuth2.0）",
  "is_standard_oauth": true
}
```

**客户端使用（标准 OAuth）：**

```javascript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('https://your-project.supabase.co', 'anon-key')

// 使用标准 OAuth 登录
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'wechat',
  options: {
    redirectTo: 'https://your-domain.com/auth/callback'
  }
})
```

## Studio 兼容配置

SupaCloud 提供了与 Supabase Studio 兼容的 API 端点，可以在自定义的 Studio 前端中显示和配置微信登录。

### 获取 Provider 列表（Studio 格式）

```bash
curl http://localhost:9090/v1/projects/abc123/auth/studio/providers \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**响应：**
```json
{
  "providers": {
    "google": {
      "enabled": false,
      "client_id": null,
      "redirect_uri": null,
      "display_name": "Google",
      "is_custom": false
    },
    "wechat": {
      "enabled": true,
      "client_id": "YOUR_WECHAT_APP_ID",
      "redirect_uri": "https://your-domain.com/auth/callback",
      "display_name": "微信开放平台",
      "is_custom": true,
      "custom_type": "open"
    },
    "wechat_miniprogram": {
      "enabled": true,
      "client_id": "YOUR_WECHAT_APP_ID",
      "redirect_uri": null,
      "display_name": "微信小程序",
      "is_custom": true,
      "custom_type": "miniprogram"
    },
    "wechat_mp": {
      "enabled": true,
      "client_id": "YOUR_WECHAT_APP_ID",
      "redirect_uri": "https://your-domain.com/auth/callback",
      "display_name": "微信公众号",
      "is_custom": true,
      "custom_type": "mp"
    }
  },
  "enabled_providers": ["wechat", "wechat_miniprogram", "wechat_mp"]
}
```

### 配置 Provider（Studio 格式）

```bash
curl -X PATCH http://localhost:9090/v1/projects/abc123/auth/studio/providers/wechat_miniprogram \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "client_id": "YOUR_WECHAT_APP_ID",
    "client_secret": "your-app-secret"
  }'
```

## 环境变量

微信登录相关的环境变量会自动注入到 GoTrue 和 Edge Runtime：

### 微信小程序

```env
WECHAT_MINIPROGRAM_APP_ID=YOUR_WECHAT_APP_ID
WECHAT_MINIPROGRAM_APP_SECRET=your-app-secret
```

### 微信公众号

```env
WECHAT_MP_APP_ID=YOUR_WECHAT_APP_ID
WECHAT_MP_APP_SECRET=your-app-secret
WECHAT_MP_REDIRECT_URI=https://your-domain.com/auth/callback
```

### 微信开放平台

```env
WECHAT_OPEN_APP_ID=YOUR_WECHAT_APP_ID
WECHAT_OPEN_APP_SECRET=your-app-secret
WECHAT_OPEN_REDIRECT_URI=https://your-domain.com/auth/callback
```

## Edge Function 模板

配置微信登录时，系统会自动部署对应的 Edge Function：

| 登录方式 | Function Slug | 功能 |
|---------|--------------|------|
| 微信小程序 | `wechat-login` | 处理 code2session，返回 Session |
| 微信公众号 | `wechat-mp-login` | 生成授权 URL，处理回调 |

### 手动部署 Edge Function

如果需要自定义 Edge Function，可以手动部署：

```bash
# 使用 function_manager.sh
/opt/supacloud/scripts/lib/function_manager.sh deploy <project_ref> wechat-login "<function_code>"
```

## 支持的 OAuth Provider 列表

SupaCloud 支持以下 OAuth Provider：

- **标准 Provider**: Google, GitHub, GitLab, Facebook, Twitter, Apple, Azure, Discord, Spotify, Slack, LinkedIn, Twitch, Bitbucket, Figma, Kakao, Keycloak, WorkOS, Notion, Zoom
- **微信 Provider**: 微信开放平台 (wechat), 微信小程序 (wechat_miniprogram), 微信公众号 (wechat_mp)

## 常见问题

### Q: 微信小程序登录为什么需要 Edge Function？

A: 微信小程序登录使用 `code2session` API，这不是标准的 OAuth2.0 流程。GoTrue 不原生支持这种方式，因此需要通过 Edge Function 代理实现。

### Q: 如何在 Studio 中显示微信登录配置？

A: 使用 `/v1/projects/:ref/auth/studio/providers` 端点获取 Studio 兼容格式的配置，然后在前端展示。

### Q: 微信开放平台登录和微信公众号登录有什么区别？

A: 
- **微信开放平台**: 适用于移动 APP 和 H5 网页，使用标准 OAuth2.0
- **微信公众号**: 仅适用于微信内嵌网页，使用 OAuth2.0 变体（snsapi_userinfo/snsapi_base）

### Q: 如何获取 UnionID？

A: 需要在微信开放平台绑定小程序或公众号，登录时会自动返回 UnionID。

## 相关链接

- [supabase-mp-js](https://github.com/zuohuadong/supabase-mp-js) - 微信小程序 Supabase 客户端
- [微信开放平台文档](https://open.weixin.qq.com/cgi-bin/showdocument?action=dir_list&t=resource/res_list&verify=1&id=open1419316505)
- [微信小程序登录文档](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)
- [微信公众号网页授权文档](https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/Wechat_webpage_authorization.html)
