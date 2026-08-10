# SupaCloud 部署系统使用指南

## 概述

SupaCloud 部署系统提供配置驱动的自动化部署能力，支持：
- **零停机部署** - 使用符号链接实现原子切换
- **版本管理** - 保留多个版本，支持快速回滚
- **多类型支持** - 静态站点和 SSR 服务
- **钩子机制** - 部署前后自定义操作

## 快速开始

如果你是通过命令行操作 SupaCloud，建议优先区分两个入口：

- `@supacloud/cli` / `supacloud-cli`：项目使用者
- `@supacloud/admin` / `supacloud-admin`：服务器管理员

本篇文档更偏部署流程本身；CLI 边界请参考 [CLI Guide](./cli-guide.md)。

### 服务器安装配置与 Release 信任边界

- 仓库中的 `config.env` 只提供受 Git 跟踪的只读默认值。
- 安装输入由安装器原子持久化到 `/etc/supabase/install.env`，域名、数据库密码、PG 版本和存储选择在重复运行时保持稳定。
- Management API 的运行时配置独立保存在 `/etc/supabase/management-api.env`，不得复制或覆盖安装输入文件。
- root bootstrap 与安装源码只允许从官方 GitHub HTTPS 地址直连获取；直连失败时安装会关闭失败，不会通过代理克隆、拉取或执行源码。不要用第三方代理 URL 包裹并直接执行 root `setup.sh`。
- `SUPACLOUD_GITHUB_PROXY` 只作为后续 GitHub Release/API 下载的显式 fallback，且 Release 产物仍必须通过 SHA256 与 provenance attestation；Admin 入口仅接受 HTTPS 代理。
- 网络 Release 产物必须通过同一 Release 的 SHA256 校验和 GitHub build provenance attestation。验签显式使用仓库内经 TUF 复核并固定摘要的 Sigstore Public Good trusted root，不依赖目标机实时访问 TUF 服务。`SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` 仅是紧急 break-glass，仍保留 SHA256 校验。

```bash
# 官方 root bootstrap
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash

# 仅为后续 GitHub Release/API 下载配置显式 fallback
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

### 1. 创建配置文件

在项目根目录创建 `supacloud.yml`：

```yaml
app:
  name: my-app
  tenant: my-tenant-id

deploy:
  static:
    - name: admin
      source: dist
      target: /var/www/html/admin
      url: https://example.com/admin/

  ssr:
    - name: web
      source: build
      target: /var/www/app/web
      service: my-web-service
      env:
        API_URL: https://api.example.com
        API_KEY: ${API_KEY}

  retention:
    keep_versions: 5
    auto_cleanup: true
```

### 2. 本地构建

```bash
# 安装依赖
bun install

# 构建项目
bun run build

# 打包构建产物
tar -cJf artifact.tar.xz dist build
```

### 3. 调用部署 API

```bash
# 编码 artifact
ARTIFACT_BASE64=$(base64 -w0 artifact.tar.xz)

# 读取配置
CONFIG=$(cat supacloud.yml | yq -c)

# 调用 API
curl -X POST http://localhost:9090/api/v1/deploy \
  -H "Content-Type: application/json" \
  -d "{
    \"app\": \"my-app\",
    \"tenant\": \"my-tenant-id\",
    \"artifact\": \"$ARTIFACT_BASE64\",
    \"config\": $CONFIG
  }"
```

## GitHub Actions 集成

### 完整示例

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

env:
  APP_NAME: my-app
  TENANT_ID: my-tenant-id

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Build
        run: bun run build
        env:
          API_URL: ${{ secrets.API_URL }}
          API_KEY: ${{ secrets.API_KEY }}

      - name: Create artifact
        run: tar -cJf artifact.tar.xz dist build

      - name: Deploy
        run: |
          ARTIFACT=$(base64 -w0 artifact.tar.xz)
          CONFIG=$(cat supacloud.yml | yq -c)
          
          curl -X POST ${{ secrets.SUPACLOUD_API_URL }}/api/v1/deploy \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${{ secrets.SUPACLOUD_TOKEN }}" \
            -d "{
              \"app\": \"${{ env.APP_NAME }}\",
              \"tenant\": \"${{ env.TENANT_ID }}\",
              \"artifact\": \"$ARTIFACT\",
              \"config\": $CONFIG
            }"

      - name: Verify deployment
        run: |
          curl -f ${{ secrets.SITE_URL }}/health || exit 1
```

### GitHub Secrets 配置

| Secret | 说明 |
|--------|------|
| `SUPACLOUD_API_URL` | SupaCloud API 地址 |
| `SUPACLOUD_TOKEN` | API 访问令牌 |
| `API_URL` | 应用 API 地址 |
| `API_KEY` | API 密钥 |
| `SITE_URL` | 站点 URL |

## API 参考

### POST /api/v1/deploy

部署应用。

**请求：**

```json
{
  "app": "my-app",
  "tenant": "my-tenant-id",
  "artifact": "base64-encoded-tarball",
  "config": {
    "app": "my-app",
    "tenant": "my-tenant-id",
    "static": [...],
    "ssr": [...],
    "hooks": {...},
    "retention": {...}
  }
}
```

**响应：**

```json
{
  "success": true,
  "deploymentId": "1709827200000_abc123",
  "versions": {
    "current": "20240307_120000",
    "previous": "20240306_100000"
  },
  "urls": ["https://example.com/admin/"],
  "rollbackCommand": "curl -X POST .../deploy/rollback -d '{\"app\":\"my-app\",\"version\":\"20240306_100000\"}'",
  "logs": ["[2024-03-07T12:00:00Z] Starting deployment..."]
}
```

### POST /api/v1/deploy/rollback

回滚到指定版本。

**请求：**

```json
{
  "app": "my-app",
  "version": "20240306_100000"
}
```

**响应：**

```json
{
  "success": true,
  "deploymentId": "rollback_1709827800000_xyz",
  "versions": {
    "current": "20240306_100000",
    "previous": null
  },
  "urls": [],
  "rollbackCommand": "",
  "logs": ["[2024-03-07T12:10:00Z] Rolling back to version: 20240306_100000"]
}
```

### GET /api/v1/deploy/history

获取部署历史。

**参数：**
- `app` (可选): 应用名称
- `limit` (可选): 返回数量，默认 20

**响应：**

```json
{
  "success": true,
  "history": [
    {
      "id": "1709827200000_abc123",
      "appId": "my-app",
      "tenant": "my-tenant-id",
      "version": "20240307_120000",
      "status": "success",
      "deployedAt": "2024-03-07T12:00:00.000Z",
      "triggeredBy": "github-actions"
    }
  ]
}
```

### GET /api/v1/deploy/versions

获取版本列表。

**参数：**
- `app` (必需): 应用名称

**响应：**

```json
{
  "success": true,
  "app": "my-app",
  "versions": [
    {
      "version": "20240307_120000",
      "deployedAt": "2024-03-07T12:00:00.000Z",
      "status": "success"
    }
  ]
}
```

## 配置详解

### 完整配置示例

```yaml
app:
  name: my-app          # 应用名称（必填）
  tenant: my-tenant-id  # 租户 ID（必填）

deploy:
  # 静态站点配置
  static:
    - name: admin                    # 站点名称（必填）
      source: dist                   # 构建产物路径（必填）
      target: /var/www/html/admin    # 目标路径（必填）
      url: https://example.com/admin/ # 访问 URL（可选）

    - name: docs
      source: docs/dist
      target: /var/www/html/docs
      url: https://docs.example.com/

  # SSR 服务配置
  ssr:
    - name: web                      # 服务名称（必填）
      source: build                  # 构建产物路径（必填）
      target: /var/www/app/web       # 目标路径（必填）
      service: my-web-service        # systemd 服务名（必填）
      url: https://example.com/      # 访问 URL（可选）
      env:                           # 环境变量（可选）
        NODE_ENV: production
        API_URL: https://api.example.com
        API_KEY: ${API_KEY}          # 支持环境变量替换

  # 版本保留配置
  retention:
    keep_versions: 5    # 保留版本数，默认 5
    auto_cleanup: true  # 自动清理，默认 true

  # 部署钩子
  hooks:
    pre_deploy: echo "Deploying ${APP_NAME}..."      # 部署前
    post_deploy: curl -f ${SITE_URL}/health         # 部署后
    on_failure: send-alert "Deployment failed!"     # 失败时
```

### 配置字段说明

#### app 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 应用名称，用于标识和查询 |
| `tenant` | string | 是 | 租户 ID，用于多租户隔离 |

#### deploy.static 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 站点名称 |
| `source` | string | 是 | 构建产物在 artifact 中的路径 |
| `target` | string | 是 | 服务器上的符号链接路径 |
| `url` | string | 否 | 站点访问 URL |

#### deploy.ssr 配置

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 服务名称 |
| `source` | string | 是 | 构建产物在 artifact 中的路径 |
| `target` | string | 是 | 服务器上的符号链接路径 |
| `service` | string | 是 | systemd 服务名称 |
| `url` | string | 否 | 服务访问 URL |
| `env` | object | 否 | 环境变量，写入 .env 文件 |

#### deploy.retention 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `keep_versions` | number | 5 | 保留的历史版本数 |
| `auto_cleanup` | boolean | true | 是否自动清理旧版本 |

#### deploy.hooks 配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `pre_deploy` | string | 部署前执行的 shell 命令 |
| `post_deploy` | string | 部署成功后执行的 shell 命令 |
| `on_failure` | string | 部署失败时执行的 shell 命令 |

## 部署原理

### 目录结构

```
/var/www/html/
├── admin -> /var/www/html/admin_20240307_120000  ← 符号链接
├── admin_20240305_100000/  ← 旧版本（将被清理）
├── admin_20240306_110000/  ← 旧版本
├── admin_20240307_120000/  ← 当前版本
└── admin_20240307_130000/  ← 新版本（准备切换）
```

### 部署流程

```
┌─────────────────────────────────────────────────────────┐
│ 1. 接收 artifact (base64 tarball)                       │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 2. 解压到临时目录 /tmp/deploy_{id}/                      │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 3. 执行 pre_deploy 钩子                                  │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 4. 复制文件到带时间戳的新目录                             │
│    /var/www/html/admin_20240307_130000/                 │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 5. 原子切换符号链接                                       │
│    ln -sfn admin_20240307_130000 admin                  │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 6. 重启 SSR 服务 (如有)                                  │
│    systemctl restart my-web-service                     │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 7. 执行 post_deploy 钩子                                 │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 8. 清理旧版本 (保留 keep_versions 个)                    │
└─────────────────────────────────────────────────────────┘
```

### 回滚流程

```
┌─────────────────────────────────────────────────────────┐
│ 1. 查找指定版本的部署记录                                 │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 2. 切换符号链接到旧版本目录                               │
│    ln -sfn admin_20240306_110000 admin                  │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 3. 重启 SSR 服务 (如有)                                  │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 4. 记录回滚操作到历史                                     │
└─────────────────────────────────────────────────────────┘
```

## 最佳实践

### 1. 环境变量管理

使用环境变量占位符，避免在配置文件中硬编码敏感信息：

```yaml
env:
  API_KEY: ${API_KEY}           # 从 CI/CD 环境变量读取
  DATABASE_URL: ${DATABASE_URL}
```

### 2. 健康检查

在 post_deploy 钩子中添加健康检查：

```yaml
hooks:
  post_deploy: |
    curl -f https://example.com/health || exit 1
    echo "Health check passed!"
```

### 3. 失败通知

在 on_failure 钩子中发送通知：

```yaml
hooks:
  on_failure: |
    curl -X POST $WEBHOOK_URL \
      -H "Content-Type: application/json" \
      -d '{"text": "Deployment failed for ${APP_NAME}!"}'
```

### 4. 版本保留策略

根据发布频率调整保留版本数：

| 发布频率 | 建议保留版本数 |
|----------|----------------|
| 每天多次 | 10 |
| 每天一次 | 7 |
| 每周一次 | 5 |
| 每月一次 | 3 |

### 5. 构建优化

在 CI 中并行构建多个应用：

```yaml
- name: Build
  run: |
    bun run build:admin &
    bun run build:web &
    wait
```

## 故障排查

### 部署失败

1. 检查日志：`GET /api/v1/deploy/history`
2. 检查磁盘空间：`df -h /var/www`
3. 检查文件权限：`ls -la /var/www/html`

### 回滚失败

1. 确认版本存在：`GET /api/v1/deploy/versions?app=my-app`
2. 检查版本目录：`ls -la /var/www/html/admin_*`

### 服务未重启

1. 检查服务状态：`systemctl status my-service`
2. 检查服务日志：`journalctl -u my-service -f`

## 常见问题

**Q: 部署后页面没有更新？**

A: 清除浏览器缓存或使用强制刷新（Ctrl+Shift+R）。

**Q: 如何查看当前运行的版本？**

A: 查看符号链接指向：`ls -la /var/www/html/admin`

**Q: 如何手动回滚？**

A: 
```bash
# 查看可用版本
ls -la /var/www/html/admin_*

# 切换到指定版本
ln -sfn /var/www/html/admin_20240306_110000 /var/www/html/admin

# 重启服务（如需要）
systemctl restart my-service
```

**Q: 如何清理旧版本？**

A: 
```bash
# 手动删除旧版本目录
rm -rf /var/www/html/admin_20240305_*
```
