# SupaCloud 前端托管指南

本文档介绍如何在 SupaCloud 中部署和管理前端应用。

## 概述

SupaCloud 提供内置的前端托管服务，支持多种前端框架：

| 框架 | ID | SSR 支持 | 默认构建命令 | 默认输出目录 |
|--------|-----|----------|--------------|------------|
| 静态文件 | `static` | ❌ | - | - |
| React | `react` | ❌ | `npm run build` | `dist` |
| Vue | `vue` | ❌ | `npm run build` | `dist` |
| Svelte | `svelte` | ❌ | `npm run build` | `dist` |
| Next.js | `nextjs` | ✅ | `npm run build` | `.next` |
| Nuxt | `nuxt` | ✅ | `npm run build` | `.output` |
| SvelteKit SSR (`adapter-node`) | `sveltekit` | ✅ | `npm run build` | `build` |
| SvelteKit Static (`adapter-static`) | `sveltekit-static` | ❌ | `npm run build` | `build` |
| Astro | `astro` | ❌ | `npm run build` | `dist` |
| Remix | `remix` | ✅ | `npm run build` | `build` |

## API 端点

### 获取部署列表

```bash
GET /v1/projects/:ref/frontend/deployments
```

**响应示例：**
```json
{
  "deployments": [
    {
      "id": "abc12345",
      "project_ref": "my-project",
      "name": "my-app",
      "framework": "react",
      "domain": "abc12345.my-project.example.com",
      "custom_domains": ["www.myapp.com"],
      "build_command": "npm run build",
      "output_dir": "dist",
      "install_command": "npm install",
      "node_version": "20",
      "health_check_path": "/",
      "env_vars": {
        "VITE_API_URL": "https://my-project.supabase.co"
      },
      "status": "success",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z",
      "last_deployed_at": "2024-01-01T12:00:00Z",
      "deployment_url": "https://abc12345.my-project.example.com"
    }
  ]
}
```

### 创建部署

```bash
POST /v1/projects/:ref/frontend/deployments
```

**请求体：**
```json
{
  "name": "my-app",
  "framework": "react",
  "domain": "myapp.example.com",
  "custom_domains": ["www.myapp.com"],
  "build_command": "npm run build",
  "output_dir": "dist",
  "install_command": "npm install",
  "node_version": "20",
  "health_check_path": "/",
  "env_vars": {
    "VITE_API_URL": "https://my-project.supabase.co",
    "VITE_ANON_KEY": "your-anon-key"
  }
}
```

### 从 Git 部署

```bash
POST /v1/projects/:ref/frontend/deployments/:id/deploy/git
```

**请求体：**
```json
{
  "git_url": "https://github.com/user/repo.git",
  "branch": "main"
}
```

### 上传 ZIP 部署

```bash
POST /v1/projects/:ref/frontend/deployments/:id/deploy/upload
```

**请求体：** `multipart/form-data` 的 `file` 字段，或 `application/zip`

### 重新部署

```bash
POST /v1/projects/:ref/frontend/deployments/:id/redeploy
```

### 获取部署详情

```bash
GET /v1/projects/:ref/frontend/deployments/:id
```

### 更新部署配置

```bash
PATCH /v1/projects/:ref/frontend/deployments/:id
```

### 删除部署

```bash
DELETE /v1/projects/:ref/frontend/deployments/:id
```

### 获取构建日志

```bash
GET /v1/projects/:ref/frontend/deployments/:id/logs
```

### 设置环境变量

```bash
PUT /v1/projects/:ref/frontend/deployments/:id/env
```

**请求体：**
```json
{
  "env_vars": {
    "VITE_API_URL": "https://new-url.supabase.co",
    "VITE_ANON_KEY": "new-key"
  }
}
```

### 添加自定义域名

```bash
POST /v1/projects/:ref/frontend/deployments/:id/domains
```

**请求体：**
```json
{
  "domain": "www.myapp.com"
}
```

### 删除自定义域名

```bash
DELETE /v1/projects/:ref/frontend/deployments/:id/domains/:domain
```

### 获取支持的框架

```bash
GET /v1/projects/:ref/frontend/frameworks
```

**响应示例：**
```json
{
  "frameworks": [
    {
      "id": "react",
      "name": "React",
      "defaults": {
        "build_command": "npm run build",
        "output_dir": "dist",
        "install_command": "npm install",
        "node_version": "20",
        "health_check_path": "/",
        "is_ssr": false
      }
    },
    {
      "id": "nextjs",
      "name": "NextJS",
      "defaults": {
        "build_command": "npm run build",
        "output_dir": ".next",
        "install_command": "npm install",
        "node_version": "20",
        "is_ssr": true
      }
    }
  ]
}
```

## 部署示例

### SvelteKit 部署模式

- SSR 项目使用 `framework: "sveltekit"`，并在 `svelte.config.js` 中配置
  `@sveltejs/adapter-node`。SupaCloud 会校验 `build/index.js`，保留
  `package.json` 与已安装的生产依赖，并通过 Node 启动服务。
- SSG/SPA 项目使用 `framework: "sveltekit-static"`，并配置
  `@sveltejs/adapter-static`。产物由 Caddy 直接托管，不启动 SSR 进程。
- SSR 默认探测 `/`；可以通过 `health_check_path` 改成 `/healthz`、
  `/ready` 等应用路由。任意非 5xx 响应表示进程已经就绪。
- SvelteKit SSR service 会信任 Caddy 注入的 `x-forwarded-proto`、
  `x-forwarded-host` 和 `x-forwarded-port`，以便 form actions、重定向和
  服务端 URL 推导使用外部访问地址。

### 1. 创建并部署 React 应用

```bash
curl -X POST http://localhost:9090/v1/projects/my-project/frontend/deployments \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-react-app",
    "framework": "react",
    "domain": "myapp.example.com",
    "env_vars": {
      "VITE_API_URL": "https://my-project.supabase.co",
      "VITE_ANON_KEY": "your-anon-key"
    }
  }'
```

### 2. 从 Git 部署 Next.js 应用

```bash
curl -X POST http://localhost:9090/v1/projects/my-project/frontend/deployments/abc12345/deploy/git \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "git_url": "https://github.com/user/my-nextjs-app.git",
    "branch": "main"
  }'
```

### 3. 上传 ZIP 文件部署

```bash
curl -X POST http://localhost:9090/v1/projects/my-project/frontend/deployments/abc12345/deploy/upload \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @my-app.zip
```

### 4. 配置 Vue 应用

```bash
curl -X POST http://localhost:9090/v1/projects/my-project/frontend/deployments \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-vue-app",
    "framework": "vue",
    "build_command": "npm run build",
    "output_dir": "dist",
    "install_command": "npm install",
    "node_version": "20"
  }'
```

## 环境变量

部署时可以设置环境变量，这些变量在构建和运行时可用：

### Vite 项目

```env
VITE_API_URL=https://my-project.supabase.co
VITE_ANON_KEY=your-anon-key
VITE_SUPABASE_URL=https://my-project.supabase.co
```

### Next.js 项目

```env
NEXT_PUBLIC_API_URL=https://my-project.supabase.co
NEXT_PUBLIC_ANON_KEY=your-anon-key
NEXT_PUBLIC_SUPABASE_URL=https://my-project.supabase.co
```

### Nuxt 项目

```env
NUXT_PUBLIC_API_URL=https://my-project.supabase.co
NUXT_PUBLIC_ANON_KEY=your-anon-key
NUXT_PUBLIC_SUPABASE_URL=https://my-project.supabase.co
```

## 自定义域名

### 添加自定义域名

```bash
curl -X POST http://localhost:9090/v1/projects/my-project/frontend/deployments/abc12345/domains \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "www.myapp.com"
  }'
```

### DNS 配置

添加自定义域名后，需要在 DNS 提供商处配置 CNAME 记录：

| 类型 | 主机记录 | 记录值 |
|------|---------|---------|
| CNAME | www | abc12345.my-project.example.com |
| CNAME | @ | abc12345.my-project.example.com |

## 构建状态

| 状态 | 说明 |
|------|------|
| `pending` | 部署已创建，等待构建 |
| `building` | 正在构建中 |
| `success` | 构建成功，已部署 |
| `failed` | 构建失败 |

## Caddy 路由

系统会在部署构建成功后，通过 SupaCloud Caddy API 为默认域名和自定义域名创建托管路由。
默认域名格式为 `<部署ID>.<项目ref>.<BASE_DOMAIN>`；静态站点由 Caddy 直接提供文件服务，
SSR 站点则由 Caddy 反向代理到对应的受管进程。无需安装或维护 Nginx。

## 目录结构

```
/var/supacloud/frontends/
├── my-project/
│   ├── abc12345/
│   │   ├── deployment.json
│   │   ├── source/
│   │   │   ├── package.json
│   │   │   ├── src/
│   │   │   └── node_modules/
│   │   └── build/
│   │       ├── index.html
│   │       ├── assets/
│   │       └── ...
```

## 故障排除

### 构建失败

1. 查看构建日志：
```bash
curl http://localhost:9090/v1/projects/my-project/frontend/deployments/abc12345/logs \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

2. 检查 Node.js 版本是否正确
3. 验证 `package.json` 中的构建命令是否存在

### 自定义域名无法访问

1. 检查 DNS 配置是否正确
2. 确认域名指向正确的 CNAME
3. 检查防火墙规则是否允许 80 端口

### SSR 应用部署问题

对于 SSR 应用（Next.js、Nuxt 等）：

1. 确保应用支持静态导出
2. 检查 `output_dir` 配置是否正确
3. 验证环境变量是否正确设置

## 最佳实践

1. **使用环境变量**：敏感信息（API 密钥）通过环境变量传递，不要硬编码
2. **优化构建**：配置适当的构建命令以优化生产构建
3. **设置缓存头**：静态资源会自动配置长期缓存
4. **监控日志**：定期检查构建日志以发现潜在问题
5. **使用 CI/CD**：结合 Git 部署实现自动化部署流程
