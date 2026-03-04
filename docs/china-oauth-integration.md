# 国内第三方登录集成指南

本文档介绍如何在 SupaCloud 中配置和使用国内第三方登录功能。

## 支持的国内登录 Provider

| Provider | ID | 说明 | OAuth 类型 |
|----------|-----|------|-----------|
| QQ | `qq` | 腾讯 QQ 登录 | 标准 OAuth2.0 |
| 微博 | `weibo` | 新浪微博登录 | 标准 OAuth2.0 |
| 支付宝 | `alipay` | 支付宝登录 | 标准 OAuth2.0 |
| 钉钉 | `dingtalk` | 钉钉登录 | 标准 OAuth2.0 |
| 抖音 | `douyin` | 抖音登录 | 标准 OAuth2.0 |
| 百度 | `baidu` | 百度账号登录 | 标准 OAuth2.0 |
| 华为 | `huawei` | 华为账号登录 | 标准 OAuth2.0 |
| 小米 | `xiaomi` | 小米账号登录 | 标准 OAuth2.0 |
| 快手 | `kuaishou` | 快手登录 | 标准 OAuth2.0 |
| 哔哩哔哩 | `bilibili` | B站账号登录 | 标准 OAuth2.0 |

## API 端点

### 获取国内 Provider 列表

```bash
GET /v1/projects/:ref/auth/china/providers
```

**响应示例：**
```json
{
  "providers": {
    "qq": {
      "enabled": true,
      "name": "QQ",
      "description": "腾讯 QQ 登录，适用于网站和移动应用",
      "is_standard_oauth": true,
      "client_id": "101234567",
      "redirect_uri": "https://your-domain.com/auth/callback"
    },
    "weibo": {
      "enabled": false,
      "name": "微博",
      "description": "新浪微博登录，适用于网站和移动应用",
      "is_standard_oauth": true,
      "client_id": null,
      "redirect_uri": null
    }
  }
}
```

### 配置国内 Provider

```bash
POST /v1/projects/:ref/auth/china/:provider
```

**请求体：**
```json
{
  "app_id": "your-app-id",
  "app_secret": "your-app-secret",
  "redirect_uri": "https://your-domain.com/auth/callback",
  "deploy_function": true
}
```

**响应示例：**
```json
{
  "provider": "qq",
  "enabled": true,
  "name": "QQ",
  "message": "QQ登录配置成功",
  "function_slug": "qq-login",
  "is_standard_oauth": true
}
```

## 配置示例

### QQ 登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/china/qq \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "101234567",
    "app_secret": "your-app-secret",
    "redirect_uri": "https://your-domain.com/auth/callback"
  }'
```

**QQ 互联平台配置：**
1. 访问 [QQ 互联平台](https://connect.qq.com/)
2. 创建应用，获取 APP ID 和 APP Key
3. 配置回调地址

### 微博登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/china/weibo \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "your-app-key",
    "app_secret": "your-app-secret",
    "redirect_uri": "https://your-domain.com/auth/callback"
  }'
```

**微博开放平台配置：**
1. 访问 [微博开放平台](https://open.weibo.com/)
2. 创建应用，获取 App Key 和 App Secret
3. 配置授权回调页

### 钉钉登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/china/dingtalk \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "your-app-key",
    "app_secret": "your-app-secret",
    "redirect_uri": "https://your-domain.com/auth/callback"
  }'
```

**钉钉开放平台配置：**
1. 访问 [钉钉开放平台](https://open.dingtalk.com/)
2. 创建应用，获取 AppKey 和 AppSecret
3. 配置回调域名

### 抖音登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/china/douyin \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "your-client-key",
    "app_secret": "your-client-secret",
    "redirect_uri": "https://your-domain.com/auth/callback"
  }'
```

**抖音开放平台配置：**
1. 访问 [抖音开放平台](https://open.douyin.com/)
2. 创建应用，获取 Client Key 和 Client Secret
3. 配置回调 URL

### 哔哩哔哩登录

```bash
curl -X POST http://localhost:9090/v1/projects/abc123/auth/china/bilibili \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "your-app-id",
    "app_secret": "your-app-secret",
    "redirect_uri": "https://your-domain.com/auth/callback"
  }'
```

## 客户端使用

### 获取授权 URL

```javascript
// 调用 Edge Function 获取授权 URL
const response = await fetch('https://your-project.supabase.co/functions/v1/qq-login')
const { auth_url } = await response.json()

// 跳转到授权页面
window.location.href = auth_url
```

### 处理回调

```javascript
// 回调页面处理
const urlParams = new URLSearchParams(window.location.search)
const code = urlParams.get('code')
const state = urlParams.get('state')

if (code) {
  // 调用 Edge Function 完成登录
  const loginResponse = await fetch(`https://your-project.supabase.co/functions/v1/qq-login?code=${code}&state=${state}`)
  const session = await loginResponse.json()
  
  if (session.access_token) {
    // 保存 session，登录成功
    console.log('登录成功:', session.user)
  }
}
```

### 使用 supabase-js

```javascript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('https://your-project.supabase.co', 'anon-key')

// 由于国内登录通过 Edge Function 实现，需要手动调用
async function loginWithQQ() {
  const response = await fetch('https://your-project.supabase.co/functions/v1/qq-login')
  const { auth_url } = await response.json()
  window.location.href = auth_url
}

// 回调处理
async function handleCallback(code) {
  const response = await fetch(`https://your-project.supabase.co/functions/v1/qq-login?code=${code}`)
  const session = await response.json()
  
  // 使用 supabase 设置 session
  await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
}
```

## 环境变量

配置国内登录后，环境变量会自动注入到 Edge Runtime：

```env
# QQ
QQ_APP_ID=101234567
QQ_APP_KEY=your-app-secret
QQ_REDIRECT_URI=https://your-domain.com/auth/callback

# 微博
WEIBO_APP_KEY=your-app-key
WEIBO_APP_SECRET=your-app-secret
WEIBO_REDIRECT_URI=https://your-domain.com/auth/callback

# 钉钉
DINGTALK_APP_KEY=your-app-key
DINGTALK_APP_SECRET=your-app-secret
DINGTALK_REDIRECT_URI=https://your-domain.com/auth/callback

# 抖音
DOUYIN_CLIENT_KEY=your-client-key
DOUYIN_CLIENT_SECRET=your-client-secret
DOUYIN_REDIRECT_URI=https://your-domain.com/auth/callback

# 哔哩哔哩
BILIBILI_APP_ID=your-app-id
BILIBILI_APP_SECRET=your-app-secret
BILIBILI_REDIRECT_URI=https://your-domain.com/auth/callback
```

## Studio 兼容

国内登录 Provider 在 Studio 中会被标记为 `is_china: true`：

```bash
GET /v1/projects/:ref/auth/studio/providers
```

**响应示例：**
```json
{
  "providers": {
    "qq": {
      "enabled": true,
      "client_id": "101234567",
      "redirect_uri": "https://your-domain.com/auth/callback",
      "display_name": "QQ",
      "is_custom": true,
      "custom_type": "china_oauth",
      "is_china": true
    }
  },
  "enabled_providers": ["qq"]
}
```

## 各平台申请链接

| 平台 | 开放平台地址 | 审核周期 |
|------|------------|---------|
| QQ | https://connect.qq.com/ | 1-3 个工作日 |
| 微博 | https://open.weibo.com/ | 1-3 个工作日 |
| 支付宝 | https://open.alipay.com/ | 1-3 个工作日 |
| 钉钉 | https://open.dingtalk.com/ | 即时 |
| 抖音 | https://open.douyin.com/ | 1-3 个工作日 |
| 百度 | https://developer.baidu.com/ | 1-3 个工作日 |
| 华为 | https://developer.huawei.com/ | 1-3 个工作日 |
| 小米 | https://dev.mi.com/ | 1-3 个工作日 |
| 快手 | https://open.kuaishou.com/ | 1-3 个工作日 |
| 哔哩哔哩 | https://openhome.bilibili.com/ | 需申请 |

## 注意事项

1. **企业认证**：部分平台需要企业认证才能使用登录功能
2. **域名备案**：回调域名通常需要完成 ICP 备案
3. **审核时间**：各平台审核时间不同，建议提前申请
4. **UnionID**：如需打通多个应用的用户体系，需申请 UnionID 权限
5. **隐私政策**：应用需提供隐私政策链接

## 常见问题

### Q: 为什么国内登录需要 Edge Function？

A: 国内各平台的 OAuth 实现细节略有差异，通过 Edge Function 可以统一处理这些差异，同时保护敏感信息（如 AppSecret）。

### Q: 如何获取用户头像和昵称？

A: 在 Edge Function 中获取 access_token 后，调用各平台的用户信息接口即可获取。

### Q: 如何实现多端统一账号？

A: 使用 UnionID 机制。在微信开放平台、QQ 互联平台等绑定应用后，同一用户在不同应用中会返回相同的 UnionID。

### Q: 支付宝登录有什么特殊要求？

A: 支付宝登录需要使用 RSA 私钥签名，`app_secret` 字段需要传入私钥内容。
