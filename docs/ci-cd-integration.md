# SupaCloud CI/CD 集成指南

本文档介绍如何将 SupaCloud 前端托管与 GitHub CI/CD 集成，实现自动部署。

## 概述

SupaCloud 提供三种 CI/CD 集成方式：

| 方式 | 触发方式 | 适用场景 |
|------|---------|---------|
| **Deploy Token** | GitHub Actions 调用 API | 灵活控制部署时机 |
| **GitHub Webhook** | Push 事件自动触发 | 简单配置，自动部署 |
| **回调通知** | 部署完成通知 GitHub | 状态同步 |

## 方式一：Deploy Token + GitHub Actions

### 1. 创建部署令牌

```bash
# 创建部署
curl -X POST http://localhost:9090/v1/projects/my-project/frontend/deployments \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "framework": "react",
    "git_url": "https://github.com/user/repo.git",
    "git_branch": "main"
  }'

# 创建部署令牌
curl -X POST http://localhost:9090/v1/projects/my-project/frontend/deployments/abc123/tokens \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GitHub Actions"
  }'

# 响应
{
  "id": "token_abc",
  "token": "supa_deploy_xxxxxxxxxxxxxxxx"
}
```

### 2. 配置 GitHub Secrets

在 GitHub 仓库设置中添加 Secrets：

- `SUPACLOUD_DEPLOY_TOKEN`: 部署令牌
- `SUPACLOUD_PROJECT_REF`: 项目引用 ID
- `SUPACLOUD_DEPLOYMENT_ID`: 部署 ID

### 3. 创建 GitHub Actions 工作流

**文件：`.github/workflows/deploy.yml`**

```yaml
name: Deploy to SupaCloud

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to SupaCloud
        run: |
          curl -X POST https://api.your-domain.com/v1/webhooks/deploy \
            -H "Authorization: Bearer ${{ secrets.SUPACLOUD_DEPLOY_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "deployment_id": "${{ secrets.SUPACLOUD_DEPLOYMENT_ID }}",
              "project_ref": "${{ secrets.SUPACLOUD_PROJECT_REF }}",
              "commit_sha": "${{ github.sha }}",
              "commit_message": "${{ github.event.head_commit.message }}"
            }'

      - name: Check deployment status
        run: |
          sleep 30
          curl -s "https://api.your-domain.com/v1/projects/${{ secrets.SUPACLOUD_PROJECT_REF }}/frontend/deployments/${{ secrets.SUPACLOUD_DEPLOYMENT_ID }}" \
            -H "Authorization: Bearer ${{ secrets.SUPACLOUD_DEPLOY_TOKEN }}" | jq '.status'
```

## 方式二：GitHub Webhook 自动部署

### 1. 配置 Git 仓库

```bash
# 设置 Git 仓库配置
curl -X PUT http://localhost:9090/v1/projects/my-project/frontend/deployments/abc123/git \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "git_url": "https://github.com/user/repo.git",
    "branch": "main"
  }'
```

### 2. 在 GitHub 添加 Webhook

1. 进入 GitHub 仓库 → Settings → Webhooks
2. 添加 Webhook：
   - **Payload URL**: `https://api.your-domain.com/v1/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: (可选，用于签名验证)
   - **Events**: 选择 `Push events`

### 3. 自动部署流程

```
GitHub Push Event
       │
       ▼
┌──────────────────────┐
│  SupaCloud Webhook   │
│  /v1/webhooks/github │
└──────────────────────┘
       │
       ▼
┌──────────────────────┐
│  匹配 Git URL + 分支  │
│  (支持多项目)         │
└──────────────────────┘
       │
       ▼
┌──────────────────────┐
│  创建部署记录         │
│  拉取代码 → 构建 → 部署│
└──────────────────────┘
       │
       ▼
┌──────────────────────┐
│  更新部署状态         │
│  记录构建日志         │
└──────────────────────┘
```

## 多项目支持

SupaCloud 支持同一 Git 仓库部署到多个项目：

```bash
# 项目 A
curl -X POST http://localhost:9090/v1/projects/project-a/frontend/deployments \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -d '{
    "name": "app-production",
    "framework": "react",
    "git_url": "https://github.com/user/repo.git",
    "git_branch": "main",
    "domain": "app.example.com"
  }'

# 项目 B (同一仓库，不同分支)
curl -X POST http://localhost:9090/v1/projects/project-b/frontend/deployments \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -d '{
    "name": "app-staging",
    "framework": "react",
    "git_url": "https://github.com/user/repo.git",
    "git_branch": "develop",
    "domain": "staging.example.com"
  }'
```

当 Webhook 收到 Push 事件时，会自动匹配所有符合条件的部署：

| 项目 | Git URL | 分支 | 触发条件 |
|------|---------|------|---------|
| project-a | github.com/user/repo | main | push to main |
| project-b | github.com/user/repo | develop | push to develop |

## API 端点

### 部署令牌管理

```bash
# 创建令牌
POST /v1/projects/:ref/frontend/deployments/:id/tokens
{
  "name": "CI Token"
}

# 列出令牌
GET /v1/projects/:ref/frontend/deployments/:id/tokens

# 删除令牌
DELETE /v1/projects/:ref/frontend/deployments/:id/tokens/:tokenId
```

### Git 配置

```bash
# 设置 Git 配置
PUT /v1/projects/:ref/frontend/deployments/:id/git
{
  "git_url": "https://github.com/user/repo.git",
  "branch": "main"
}
```

### 部署记录

```bash
# 列出部署记录
GET /v1/projects/:ref/frontend/deployments/:id/records

# 获取单条记录
GET /v1/projects/:ref/frontend/deployments/:id/records/:recordId
```

### Webhook 端点

```bash
# GitHub Webhook
POST /v1/webhooks/github
# 由 GitHub 自动调用

# 手动触发部署
POST /v1/webhooks/deploy
Authorization: Bearer supa_deploy_xxx
{
  "deployment_id": "abc123",
  "project_ref": "my-project",
  "commit_sha": "abc123...",
  "commit_message": "feat: new feature"
}

# 部署状态回调
POST /v1/webhooks/callback
Authorization: Bearer supa_deploy_xxx
{
  "deployment_id": "abc123",
  "project_ref": "my-project",
  "record_id": "record_123",
  "status": "success",
  "build_log": "..."
}
```

## 部署记录结构

```json
{
  "id": "record_123",
  "deployment_id": "abc123",
  "project_ref": "my-project",
  "status": "success",
  "commit_sha": "abc123def456",
  "commit_message": "feat: add new feature",
  "branch": "main",
  "triggered_by": "webhook",
  "build_log": "...",
  "started_at": "2024-01-01T00:00:00Z",
  "finished_at": "2024-01-01T00:05:00Z",
  "duration": 300000
}
```

## 最佳实践

### 1. 使用 Deploy Token

- 为不同环境创建不同的令牌
- 定期轮换令牌
- 限制令牌权限范围

### 2. 分支策略

- `main` → 生产环境
- `develop` → 测试环境
- `feature/*` → 预览环境

### 3. 部署通知

```yaml
# GitHub Actions 部署完成后通知
- name: Notify deployment status
  if: always()
  run: |
    curl -X POST ${{ secrets.SLACK_WEBHOOK }} \
      -d '{"text": "Deployment ${{ job.status }}: ${{ github.sha }}"}'
```

### 4. 回滚机制

```bash
# 查看历史部署记录
GET /v1/projects/:ref/frontend/deployments/:id/records

# 重新部署指定版本
POST /v1/projects/:ref/frontend/deployments/:id/redeploy
```

## 故障排除

### Webhook 未触发

1. 检查 Webhook URL 是否正确
2. 验证 Git URL 和分支配置
3. 查看 GitHub Webhook 日志

### 部署失败

1. 查看部署记录日志
2. 检查构建命令是否正确
3. 验证环境变量配置

### Token 无效

1. 确认 Token 未被删除
2. 检查 Authorization Header 格式
3. 验证 Token 权限范围
