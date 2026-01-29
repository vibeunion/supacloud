# SupaCloud 多租户管理方案与 Management API 技术规范

本文档详细说明了基于 Pigsty 架构实现多项目管理的技术方案设计以及 Management API 的完整技术规范。

---

## 一、架构概述

通过共享基础设施（Pigsty PostgreSQL、Nginx 网关和 S3 存储）提供逻辑隔离的方式运行多个 Supabase 项目。

```
┌─────────────────────────────────────────────────────────────┐
│                    Management API (:9090)                    │
│              Bun + Elysia + 依赖注入                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ JwtService   │  │ DbService    │  │ S3Service    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│         │                 │                 │                │
│         ▼                 ▼                 ▼                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │jwt_manager.sh│  │db_manager.sh │  │s3_manager.sh │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    Shared Infrastructure                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │ PostgreSQL │  │   Nginx    │  │  S3 Storage│             │
│  │  (Pigsty)  │  │  (ACME)    │  │(RustFS/etc)│             │
│  └────────────┘  └────────────┘  └────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、数据隔离策略

### 2.1 数据库隔离 (PostgreSQL)

每个项目在 Pigsty 集群中拥有独立的逻辑数据库和用户。

| 资源 | 命名规范 | 示例 |
|------|----------|------|
| 项目数据库 | `supa_<project_ref>` | `supa_abc123` |
| 项目角色 | `role_<project_ref>` | `role_abc123` |
| 权限 | 角色仅能访问所属数据库 | HBA 规则强制 |

### 2.2 元数据存储

专用 `supacloud_meta` 数据库存储项目生命周期信息。

```sql
CREATE DATABASE supacloud_meta;

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    db_name VARCHAR(63) NOT NULL,
    db_user VARCHAR(63) NOT NULL,
    db_password VARCHAR(100) NOT NULL,
    jwt_secret VARCHAR(100) NOT NULL,
    anon_key TEXT NOT NULL,
    service_role_key TEXT NOT NULL,
    s3_bucket VARCHAR(63) NOT NULL,
    s3_access_key VARCHAR(100),
    s3_secret_key VARCHAR(100),
    region VARCHAR(50) DEFAULT 'local',
    status VARCHAR(20) DEFAULT 'creating',
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_projects_ref ON projects(ref);
CREATE INDEX idx_projects_status ON projects(status);
```

### 2.3 存储隔离 (S3)

- **Bucket 命名**: `supa-<project_ref>`
- **凭据**: 每项目独立的 Access Key / Secret Key
- **支持后端**: RustFS, Garage, MinIO, External S3

### 2.4 DNS 与路由隔离

使用动态 Vhost 生成，Management API 负责在 `/etc/nginx/sites-enabled/supa-tenants/` 生成配置片段。

| 域名模式 | 路由目标 |
|----------|----------|
| `api.example.com` | 共享 Kong 网关 |
| `studio.example.com` | 共享 Studio 控制台 |
| `<project>.api.example.com` | Kong + 租户 Header |

---

## 三、JWT 安全隔离

### 3.1 独立密钥

每个项目初始化时生成唯一的 `JWT_SECRET` (32+ 字符)。

### 3.2 密钥派生

```
JWT_SECRET → ANON_KEY (role: anon, exp: 10 years)
JWT_SECRET → SERVICE_ROLE_KEY (role: service_role, exp: 10 years)
```

### 3.3 Kong 配合

Kong 根据 `Host` Header 动态验证不同项目的 JWT 密钥。

---

## 四、Management API 规范

### 4.1 认证

- **Master Token**: 存储在 `/etc/supabase/master-token.env`
- **Header**: `Authorization: Bearer <MASTER_TOKEN>`

### 4.2 API 端点

#### 项目管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/v1/projects` | 获取所有项目列表 |
| POST | `/v1/projects` | 创建新项目 |
| GET | `/v1/projects/:ref` | 获取项目详情 |
| DELETE | `/v1/projects/:ref` | 删除项目 (软删除) |
| GET | `/v1/projects/:ref/settings` | 获取项目配置 |
| PUT | `/v1/projects/:ref/settings` | 更新项目配置 |
| GET | `/v1/projects/:ref/status` | 获取项目运行状态 |
| POST | `/v1/projects/:ref/restart` | 重启项目服务 |

#### 密钥管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/v1/projects/:ref/api-keys` | 获取项目 API 密钥 |

### 4.3 请求/响应示例

#### POST /v1/projects

**请求**:
```json
{
  "name": "My Project",
  "region": "local"
}
```

**响应**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ref": "abc123xyz",
  "name": "My Project",
  "status": "creating",
  "created_at": "2025-01-29T12:00:00Z"
}
```

#### GET /v1/projects/:ref/api-keys

**响应**:
```json
{
  "anon_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.REDACTED_EXAMPLE",
  "service_role_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.REDACTED_EXAMPLE"
}
```

---

## 五、模块化脚本

### 5.1 脚本位置

```
/opt/supacloud/scripts/lib/
├── db_manager.sh      # 数据库管理
├── s3_manager.sh      # 存储管理
├── router_manager.sh  # Nginx 路由管理
└── jwt_manager.sh     # JWT 密钥管理
```

### 5.2 脚本接口

#### db_manager.sh

```bash
# 创建项目数据库和角色
db_manager.sh create <project_ref> <password>

# 删除项目数据库和角色
db_manager.sh delete <project_ref>

# 检查数据库状态
db_manager.sh status <project_ref>
```

#### s3_manager.sh

```bash
# 创建项目 Bucket
s3_manager.sh create <project_ref>

# 删除项目 Bucket
s3_manager.sh delete <project_ref>

# 获取凭据
s3_manager.sh credentials <project_ref>
```

#### router_manager.sh

```bash
# 添加项目路由
router_manager.sh add <project_ref> <domain>

# 删除项目路由
router_manager.sh remove <project_ref>

# 重载 Nginx
router_manager.sh reload
```

#### jwt_manager.sh

```bash
# 生成项目 JWT 密钥
jwt_manager.sh generate <project_ref>

# 输出: JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY
```

---

## 六、部署配置

### 6.1 Systemd 服务

```ini
[Unit]
Description=SupaCloud Management API
After=network.target postgresql.service

[Service]
Type=simple
User=supacloud
WorkingDirectory=/opt/supacloud/management-api
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/etc/supabase/management-api.env

[Install]
WantedBy=multi-user.target
```

### 6.2 环境变量

```bash
# /etc/supabase/management-api.env
PORT=9090
DATABASE_URL=postgresql://postgres:password@localhost:5432/supacloud_meta
MASTER_TOKEN=your-secure-master-token
SCRIPTS_PATH=/opt/supacloud/scripts/lib
```

---

## 七、监控与日志

### 7.1 Prometheus 指标

所有指标带 `project_ref` 标签：

```
supacloud_project_requests_total{project_ref="abc123"}
supacloud_project_db_connections{project_ref="abc123"}
supacloud_project_storage_bytes{project_ref="abc123"}
```

### 7.2 日志格式

```json
{
  "timestamp": "2025-01-29T12:00:00Z",
  "level": "info",
  "project_ref": "abc123",
  "message": "Project created successfully"
}
```

---

## 八、错误处理与回滚

### 8.1 项目创建流程

```
1. 生成 project_ref
2. 插入 projects 表 (status: creating)
3. 创建数据库 → 失败则回滚
4. 创建 S3 Bucket → 失败则回滚数据库
5. 生成 JWT 密钥
6. 配置 Nginx 路由
7. 更新 status: active
```

### 8.2 回滚策略

- 数据库创建失败: 仅删除 projects 记录
- S3 创建失败: 删除数据库 + projects 记录
- 路由配置失败: 删除 S3 + 数据库 + projects 记录

---

## 九、实施路径

| 阶段 | 目标 | 产出 |
|------|------|------|
| 1 | 基础 API + 数据库层 | 可运行的 CRUD API |
| 2 | Shell 脚本集成 | 完整的项目创建流程 |
| 3 | Nginx 动态路由 | 多租户域名支持 |
| 4 | 监控集成 | Grafana 多项目仪表板 |
