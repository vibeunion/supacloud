# SupaCloud

[English](#english) | [中文](#chinese)

---

<a name="english"></a>
## English

**SupaCloud** is a next-generation, ultra-lightweight multi-tenant PaaS for self-hosting Supabase. Built on **Pigsty**, it enables you to run multiple isolated Supabase projects efficiently on a single server.

### Key Features

- **Multi-Tenant Architecture**: Run multiple isolated Supabase projects with shared infrastructure
- **Management API**: Full REST API (21 endpoints) for project lifecycle management
- **CLI Tool**: `supacloud` command-line tool for easy project management
- **Pigsty Powered**: Enterprise-grade PostgreSQL with built-in monitoring
- **One-Click Installation**: Fully automated setup via `install.sh`
- **Flexible Storage**: RustFS (recommended), Garage, MinIO, or external S3
- **Dual Runtime**: Deno (default) or Bun.js for Edge Functions
- **96% Test Coverage**: Production-ready with comprehensive testing

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│                   Bun + Elysia + TypeScript                  │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ JwtService │  │ DbService  │  │ S3Service  │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │jwt_manager │  │db_manager  │  │s3_manager  │            │
│  │    .sh     │  │    .sh     │  │    .sh     │            │
│  └────────────┘  └────────────┘  └────────────┘            │
├─────────────────────────────────────────────────────────────┤
│                   Shared Infrastructure                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Nginx    │  │ S3 Storage │            │
│  │  (Pigsty)  │  │  Gateway   │  │  (RustFS)  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### Quick Start

#### Requirements

| Item | Minimum | Recommended |
|------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 2GB | 4GB+ |
| Disk | 40GB | 100GB+ SSD |
| OS | Rocky/AlmaLinux 8/9, Ubuntu 22/24, Debian 12 | Rocky Linux 9 |

#### Installation

```bash
# 1. Clone repository
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. Configure (edit domains and passwords)
vim config.env

# 3. Run installation
sudo bash install.sh
```

### Management

#### CLI Tool

```bash
# List all projects
supacloud list

# Create a new project
supacloud create "My Project"

# Get project details
supacloud info <project_ref>

# Get API keys
supacloud keys <project_ref>

# Check project status
supacloud status <project_ref>

# Delete project
supacloud delete <project_ref>

# System health check
supacloud health
```

#### Management API

The REST API runs on port 9090 with Swagger documentation at `/swagger`.

```bash
# Create project
curl -X POST http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "region": "local"}'

# List projects
curl http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN"

# Get API keys
curl http://localhost:9090/v1/projects/<ref>/api-keys \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/projects` | List all projects |
| POST | `/v1/projects` | Create project |
| GET | `/v1/projects/:ref` | Get project details |
| PATCH | `/v1/projects/:ref` | Update project |
| DELETE | `/v1/projects/:ref` | Delete project (soft) |
| POST | `/v1/projects/:ref/pause` | Pause project |
| POST | `/v1/projects/:ref/restore` | Restore project |
| GET | `/v1/projects/:ref/status` | Get status |
| GET | `/v1/projects/:ref/health` | Get health |
| POST | `/v1/projects/:ref/restart` | Restart services |
| GET | `/v1/projects/:ref/settings` | Get settings |
| PUT | `/v1/projects/:ref/settings` | Update settings |
| GET | `/v1/projects/:ref/api-keys` | Get API keys |

#### Runtime Switching

```bash
# Switch Edge Functions runtime
./switch.sh runtime deno   # or: bun

# Switch storage backend
./switch.sh storage rustfs # or: minio, garage, external

# Show current configuration
./switch.sh status
```

### Project Structure

```
supacloud/
├── install.sh              # One-click deployment script
├── switch.sh               # Runtime/storage switching tool
├── supacloud               # CLI management tool
├── config.env              # Global configuration
├── packages/
│   └── management-api/     # REST API server (Bun + Elysia)
│       ├── src/            # TypeScript source
│       └── tests/          # Unit & integration tests
├── scripts/
│   └── lib/                # Shell script modules
│       ├── db_manager.sh   # Database management
│       ├── s3_manager.sh   # Storage management
│       ├── router_manager.sh # Nginx routing
│       └── jwt_manager.sh  # JWT key generation
└── docs/
    └── multi-tenant-management.md  # Technical specification
```

### Configuration

Key settings in `config.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `SUPABASE_PUBLIC_DOMAIN` | API domain | (required) |
| `SUPABASE_STUDIO_DOMAIN` | Studio domain | (optional) |
| `S3_STORAGE_TYPE` | Storage backend | `rustfs` |
| `EDGE_RUNTIME` | Functions runtime | `deno` |
| `PG_VERSION` | PostgreSQL version | `18` |

### Documentation

- [Multi-Tenant Management Technical Spec](docs/multi-tenant-management.md)
- [Pigsty Documentation](https://pigsty.cc/)
- [Supabase Self-Hosting](https://supabase.com/docs/guides/self-hosting)

---

<a name="chinese"></a>
## 中文

**SupaCloud** 是为 Supabase 私有化部署打造的下一代超轻量级多租户 PaaS 平台。基于 **Pigsty** 构建，可在单台服务器上高效运行多个隔离的 Supabase 项目。

### 核心特性

- **多租户架构**: 共享基础设施，运行多个隔离的 Supabase 项目
- **Management API**: 完整的 REST API（21 个端点）管理项目生命周期
- **CLI 工具**: `supacloud` 命令行工具，便捷管理项目
- **Pigsty 驱动**: 企业级 PostgreSQL，内置监控
- **一键部署**: 通过 `install.sh` 全自动安装
- **多存储后端**: RustFS（推荐）、Garage、MinIO 或外部 S3
- **双运行时**: Deno（默认）或 Bun.js 云函数运行时
- **96% 测试覆盖**: 生产就绪，经过全面测试

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│                   Bun + Elysia + TypeScript                  │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ JwtService │  │ DbService  │  │ S3Service  │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │jwt_manager │  │db_manager  │  │s3_manager  │            │
│  │    .sh     │  │    .sh     │  │    .sh     │            │
│  └────────────┘  └────────────┘  └────────────┘            │
├─────────────────────────────────────────────────────────────┤
│                       共享基础设施                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Nginx    │  │  S3 存储   │            │
│  │  (Pigsty)  │  │   网关     │  │  (RustFS)  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### 快速开始

#### 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2GB | 4GB+ |
| 磁盘 | 40GB | 100GB+ SSD |
| 系统 | Rocky/AlmaLinux 8/9, Ubuntu 22/24, Debian 12 | Rocky Linux 9 |

#### 安装部署

```bash
# 1. 下载代码
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. 编辑配置（设置域名和密码）
vim config.env

# 3. 运行安装脚本
sudo bash install.sh
```

### 项目管理

#### CLI 命令行工具

```bash
# 列出所有项目
supacloud list

# 创建新项目
supacloud create "我的项目"

# 查看项目详情
supacloud info <project_ref>

# 获取 API 密钥
supacloud keys <project_ref>

# 查看项目状态
supacloud status <project_ref>

# 删除项目
supacloud delete <project_ref>

# 系统健康检查
supacloud health
```

#### Management API

REST API 运行在 9090 端口，Swagger 文档地址：`/swagger`

```bash
# 创建项目
curl -X POST http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "我的项目", "region": "local"}'

# 列出项目
curl http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN"

# 获取 API 密钥
curl http://localhost:9090/v1/projects/<ref>/api-keys \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**API 端点：**

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/v1/projects` | 获取项目列表 |
| POST | `/v1/projects` | 创建项目 |
| GET | `/v1/projects/:ref` | 获取项目详情 |
| PATCH | `/v1/projects/:ref` | 更新项目 |
| DELETE | `/v1/projects/:ref` | 删除项目（软删除） |
| POST | `/v1/projects/:ref/pause` | 暂停项目 |
| POST | `/v1/projects/:ref/restore` | 恢复项目 |
| GET | `/v1/projects/:ref/status` | 获取状态 |
| GET | `/v1/projects/:ref/health` | 获取健康状态 |
| POST | `/v1/projects/:ref/restart` | 重启服务 |
| GET | `/v1/projects/:ref/settings` | 获取配置 |
| PUT | `/v1/projects/:ref/settings` | 更新配置 |
| GET | `/v1/projects/:ref/api-keys` | 获取 API 密钥 |

#### 运行时切换

```bash
# 切换云函数运行时
./switch.sh runtime deno   # 或: bun

# 切换存储后端
./switch.sh storage rustfs # 或: minio, garage, external

# 查看当前配置
./switch.sh status
```

### 项目结构

```
supacloud/
├── install.sh              # 一键部署脚本
├── switch.sh               # 运行时/存储切换工具
├── supacloud               # CLI 管理工具
├── config.env              # 全局配置文件
├── packages/
│   └── management-api/     # REST API 服务 (Bun + Elysia)
│       ├── src/            # TypeScript 源码
│       └── tests/          # 单元测试和集成测试
├── scripts/
│   └── lib/                # Shell 脚本模块
│       ├── db_manager.sh   # 数据库管理
│       ├── s3_manager.sh   # 存储管理
│       ├── router_manager.sh # Nginx 路由
│       └── jwt_manager.sh  # JWT 密钥生成
└── docs/
    └── multi-tenant-management.md  # 技术规范文档
```

### 配置说明

`config.env` 关键配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SUPABASE_PUBLIC_DOMAIN` | API 域名 | （必填） |
| `SUPABASE_STUDIO_DOMAIN` | Studio 域名 | （可选） |
| `S3_STORAGE_TYPE` | 存储后端 | `rustfs` |
| `EDGE_RUNTIME` | 云函数运行时 | `deno` |
| `PG_VERSION` | PostgreSQL 版本 | `18` |

### 参考文档

- [多租户管理技术规范](docs/multi-tenant-management.md)
- [Pigsty 官方文档](https://pigsty.cc/)
- [Supabase 自托管文档](https://supabase.com/docs/guides/self-hosting)

## License

MIT
