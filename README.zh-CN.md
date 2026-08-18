# SupaCloud

[English](README.md) | [简体中文](README.zh-CN.md) | [Español](README.es-ES.md)

---

## 中文

**SupaCloud** 是为 Supabase 私有化部署打造的下一代超轻量级多租户 PaaS 平台。基于 **Pigsty** 构建，可在单台服务器上高效运行多个隔离的 Supabase 项目。

### 核心特性

- **多租户架构**: 共享基础设施，运行多个隔离的 Supabase 项目
- **Management API**: 完整的 REST API（60+ 个端点）管理项目及周边配置生命周期
- **Web 管理面板**: 现代 SvelteKit 管理面板，内置登录认证
- **Supabase 官方 CLI 数据库工作流**: 兼容性脚本会执行 `db push`、`migration list`、`db pull` 和 `gen types` 等直连 `--db-url` 流程
- **CLI 工具**: `supacloud-cli` 面向项目使用者，`supacloud-admin` 面向服务器管理员；可选用 `supacloudctl` 作为本地统一分发入口
- **SupaCloud Pages**: 前端静态站点托管，支持 GitHub Webhook 自动部署
- **Pigsty 驱动**: 企业级 PostgreSQL，内置 Grafana 监控
- **一键部署**: 通过 `install.sh` 全自动安装
- **JuiceFS 存储**: 基于 PostgreSQL Large Objects (LO) 后端，极致轻量
- **Caddy 网关**: Automatic HTTPS、Admin API 驱动的动态路由发布、安全响应头与编程式限流
- **自动扩缩容**: 基于负载指标的垂直提升与水平副本扩展
- **Bun Edge Runtime**: 基于 Bun.js + Elysia Worker Pool，内置 Deno 兼容层以兼容旧函数代码
- **SSE 实时日志**: 基于 Server-Sent Events 的实时日志流，`journalctl --follow` 推送
- **原生异步队列**: 基于 PostgreSQL LISTEN/NOTIFY 的零依赖高并发调度底座，支持 AI 大模型任务与 MQTT 消息队列
- **WebSocket 任务通知**: 基于 Bun 原生 WebSocket 的实时任务进度推送
- **DB 优雅降级**: 指数退避重试 + 503 Service Unavailable，PostgreSQL 短暂不可用时不丢请求
- **控制平面加固**: 函数管理读接口鉴权、一次性 signed upload、防御性分页和安全的存储元数据解析
- **Edge Function 预热**: 部署后自动预导入模块，消除首次请求冷启动
- **项目级 OAuth/OIDC Provider**: 支持项目迁移到 ES256 OIDC signing keys、授权端点、JWKS 和 OAuth client 管理
- **国内 OAuth**: 内置微信、支付宝、钉钉登录集成
- **CI/CD 集成**: GitHub Webhook 自动化部署
- **完善测试**: 400+ 单元、集成和结构回归测试

### SupaCloud Lite

**SupaCloud Lite** 是 SupaCloud 的 Bun 原生单项目版本：它使用 PGlite 在进程内运行兼容 PostgreSQL 的工作负载，并实现 `@supabase/supabase-js` 所需的 REST、Auth、Storage、Realtime 与 Edge Functions 协议。它适合本地开发、小型单项目部署，以及希望获得 Supabase 兼容后端但不想引入 Docker 的应用。

Lite 的 Auth 内置在同一个 Bun 进程中，不会安装或启动 GoTrue sidecar。它默认启用；在 `supabase/config.toml` 设置 `[auth] enabled = false` 可关闭 `/auth/v1/*`。需要独立 GoTrue 运行时或完整 GoTrue 兼容性时，应使用完整平台。

需要多项目租户、Management API 或 Web 管理面板、共享 Pigsty 基础设施、平台运维或前端托管生命周期时，应使用完整的 SupaCloud 平台。Lite 有意不提供多项目控制面和 Supabase Studio；每个 Lite 进程只负责一个项目及其独立状态目录。

| 需求 | 选择 |
| --- | --- |
| 无 Docker 的本地优先或单项目运行时 | SupaCloud Lite |
| 多租户平台、运维控制面或生产基础设施管理 | SupaCloud |

Lite 需要 Bun 1.3+，默认会把数据库、对象存储和生成的密钥保存在项目目录下的 `.supacloud-lite/`。可直接使用现有 Supabase CLI 项目结构启动：

```bash
bun add @supacloud/lite
bunx supacloud-lite start
bunx supacloud-lite keys
```

将输出的匿名 key 直接交给标准客户端：

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPACLOUD_LITE_ANON_KEY!)
```

CLI 命令、存储/S3 配置、兼容性边界、迁移方式和部署注意事项请参阅 [SupaCloud Lite 完整文档](./packages/supacloud-lite/README.md)。

持久化部署升级时，先更新项目锁定的 `@supacloud/lite` 依赖，再运行 `supacloud-lite upgrade`。该命令会在执行待应用 migration 前自动创建包含数据库、对象存储和密钥的可移植快照；跨机器迁移还可以直接使用 `snapshot create` 和默认拒绝覆盖的 `snapshot restore`。

### SupaCloud 与 Supabase 的区别

SupaCloud 更准确的定位是：**面向自托管场景的多租户 Supabase 控制平面**，而不是 Supabase Cloud 的镜像复刻。

简版结论：

- **SupaCloud**: 适合你在自有服务器上托管多个隔离项目，并需要内置控制台、项目生命周期 API、任务队列能力和前端托管能力。
- **Supabase Cloud**: 适合你直接购买托管平台，需要托管备份/PITR、托管日志和官方 Branching。
- **Supabase Self-Hosted**: 适合你要官方原生自托管栈，并愿意自己承担 Docker 与基础设施运维。

详细功能对比：

- [docs/supacloud-vs-supabase.md](./docs/supacloud-vs-supabase.md)

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│            Bun + Elysia + TypeScript + 自动扩缩容            │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ JwtService │  │ DbService  │  │ StorageSvc │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ GatewaySvc │  │ ScalingSvc │  │ BackupSvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ RouterSvc  │  │ FrontendSv │  │ DeploySvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
├─────────────────────────────────────────────────────────────┤
│                       共享基础设施                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Caddy    │  │  JuiceFS   │            │
│  │  (Pigsty)  │  │    网关    │  │  (PG-LO)   │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                  ┌────────────┐                             │
│                  │  Grafana   │                             │
│                  │  (监控)    │                             │
│                  └────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### 快速开始

#### 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2GB | 4GB+ |
| 磁盘 | 40GB | 100GB+ SSD |
| 系统 | CentOS 9, Ubuntu 22/24, Debian 12 | CentOS 9 |

#### 人类入口

**项目使用者 CLI**

```bash
npm install -g @supacloud/cli

supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli frontend list --ref <project-ref>
```

`supacloud-cli` 默认是项目级 CLI，会优先从当前目录 `.env` 自动绑定项目。
项目 CLI 不再提供名为 `supacloud` 的兼容别名：该名称只保留给 `/usr/local/bin/supacloud` 服务端二进制。本地统一分发入口必须明确使用 `supacloudctl`。

- `SUPABASE_URL` 或 `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` 或 `SUPACLOUD_API_TOKEN`

AI Agent 应安装 CLI 随包提供的 migration-first Skill：

```bash
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

**服务器管理员 CLI**

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh install --public_domain api.example.com --studio_domain studio.example.com
npx @supacloud/admin project create --name my-app
```

安装、升级、SSH 诊断、tenant 运维、平台级项目管理都应放在 `supacloud-admin`。

#### 安装部署

**一键安装（推荐）**

```bash
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh | sudo bash
```

Root 引导脚本始终从官方仓库获取。Release/API 下载默认先直连 GitHub，仅在明确配置时回退到可信代理：

```bash
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

**源码/开发环境手动安装（仅本地产物）**

生产服务器应使用上方经过校验的 `setup.sh` 一键安装链路。源码仓库不包含 Release 产物，因此必须先构建全部组件，并显式启用本地产物模式：

```bash
# 1. 从官方仓库下载代码
git clone https://github.com/vibeunion/supacloud.git
cd supacloud

# 2. 构建 Management API、Edge Runtime、pgredis-runtime、Caddy 与 Web Console
bun --cwd packages/management-api install
bun --cwd packages/management-api run build:linux
bun --cwd packages/edge-runtime install
bun --cwd packages/edge-runtime run build:linux
bun --cwd packages/pgredis-runtime install
bun --cwd packages/pgredis-runtime run build:linux
bun --cwd packages/web-console install --frozen-lockfile
bun --cwd packages/web-console run build
mkdir -p .local/bin dist
GOBIN="$PWD/.local/bin" go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5
PATH="$PWD/.local/bin:$PATH" OUT_DIR="$PWD/dist" bash scripts/build_supacloud_caddy.sh

# 3. 显式使用本地产物安装（参数会持久化到 /etc/supabase/install.env）
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 1.2.3.4 --domain api.example.com --s3 juicefs

# 4. 启用命令行工具
source /etc/profile.d/supacloud.sh
```

**生产环境升级**

生产环境的多组件升级应使用 Admin CLI。固定 Management 和 Edge Runtime
的精确版本后，命令会把 Management、Web Console 和外置 Edge Runtime
作为一个支持回滚的事务进行校验和启用：

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.50.31 \
  --edge_runtime_version 0.16.8 \
  --artifact_transport local \
  --github_proxy direct
```

`--artifact_transport local` 会在 Admin 所在机器直连官方 GitHub，验证精确
Release 的签名 manifest、SHA256、文件大小、来源提交和目标架构，再通过原子
SFTP staging 上传。服务器接管为 root 所有后会离线重复验证，并使用上传的目标
Management 执行同一个 Management/Edge/Web 事务；服务器无需访问 GitHub，也
不会使用第三方代理或为了升级永久安装 verifier。远端已有支持全部严格
attestation 参数的 `gh` 时直接复用；仅缺少合格 `gh` 时，才在可清理的 staging
中传入固定版本的临时 verifier。该模式只接受 `direct` 或 `none`。

升级事务运行在唯一命名的 transient systemd unit 中，使用受保护的原子状态文件
轮询，因此不会依赖一个长时间保持的 SSH channel，也不会在状态未知时强杀已经
进入 activation 的事务。服务器下载路径仍可通过 `--artifact_transport remote`
显式使用；该路径也会校验并执行目标 Management binary，不把目标版本的
helper/Web 激活逻辑交给已安装的旧版本。

该事务要求持久化配置为 `EDGE_RUNTIME_MODE=external`；embedded 模式会在
改动 Release 制品或服务前被拒绝。命令会保留 Edge Runtime 的 systemd
可执行文件路径、端口、模式和 enabled 状态，并分别使用各组件自己的
SHA256 与 GitHub attestation 做校验。Caddy 和 GoTrue 不属于该事务，
不会被替换。

只有明确只升级 Management 和 Web Console、不改 Edge Runtime 时，才省略
`--edge_runtime_version`；Admin CLI 会明确报告这个边界。

只升级 Management/Web Console 时，使用 Admin remote transport 并省略
`--edge_runtime_version`。生产服务器不需要 `git pull`，也不会让已安装的
旧 Management binary 执行新版本的 helper/Web 事务。

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.60.1 \
  --artifact_transport remote \
  --github_proxy direct
```

安装和升级下载默认先直连 GitHub。只有需要明确回退时才配置可信代理：

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.60.1 \
  --artifact_transport remote \
  --github_proxy https://your-trusted-proxy.example
```

Release 产物必须同时通过同一 Release 的 SHA256 和 GitHub build provenance attestation。`SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` 仅用于紧急 break-glass，仍会校验 SHA256，不应作为常规安装配置。

发布产物约定：

- `supacloud-linux-amd64` 和 `supacloud-linux-arm64` 用于生产安装和升级。
- `supacloud-macos-amd64` 和 `supacloud-macos-arm64` 仅用于本地开发、诊断和验证。

**命令行参数详解:**
| 参数 | 说明 | 示例 |
|--------|-------------|---------|
| `--ip` | 指定内网 IP | `--ip 10.0.0.5` |
| `--domain` | 指定 API 域名 | `--domain supa.com` |
| `--studio` | 指定 Studio 域名| `--studio studio.com`|
| `--s3` | 指定存储类型 | `juicefs`、`minio` 或 `external` |
| `--password`| 统一设置初始密码 | `--password mysecret` |

### 项目管理

#### 用户 CLI：`supacloud-cli`

`supacloud-cli` 默认是项目级 CLI，用于围绕单个项目的部署、日志、数据库与资源管理：

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli project tasks
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref <ref> --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref <ref> --dir supabase/migrations --dry_run
supacloud-cli auth list_providers --ref <ref>
supacloud-cli frontend list --ref <ref>
supacloud-cli edge_functions list --ref <ref>
supacloud-cli storage list_buckets --ref <ref>
```

复杂 SQL、pgvector 查询、单请求事务块建议使用 `--file`，不要依赖 shell 字符串转义。

```sql
BEGIN;
INSERT INTO audit_events(message) VALUES ('started');
INSERT INTO audit_events(message) VALUES ('finished');
COMMIT;
```

SupaCloud 支持单个 SQL 请求内的事务块，也会在 migration endpoint 内部使用事务；不建议提供 `/transaction/begin`、`/transaction/query`、`/transaction/commit` 这类长连接 HTTP 事务 API。应用侧长事务请使用 Postgres 直连 DSN 配合 `pg`、`postgres.js` 等驱动。

pgvector 示例：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX documents_embedding_hnsw_idx
ON documents
USING hnsw (embedding vector_cosine_ops);

SELECT id, content
FROM documents
ORDER BY embedding <=> '[0.1,0.2,0.3]'::vector
LIMIT 5;
```

`supacloud-cli` 有意不承载平台安装、升级、SSH 诊断、tenant runtime 管理，以及项目创建/删除/暂停这类平台级命令。

#### 管理员 CLI：`supacloud-admin`

```bash
supacloud-admin status
supacloud-admin ssh ping
supacloud-admin ssh install --public_domain api.example.com --studio_domain studio.example.com
supacloud-admin ssh diagnose
supacloud-admin project list
supacloud-admin project create --name my-app
supacloud-admin project delete --ref <ref>
supacloud-admin project pause --ref <ref>
supacloud-admin platform metrics
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

**核心 API 端点：**

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
| GET | `/v1/projects/:ref/dashboard/summary` | 获取带缓存的控制台汇总数据 |
| POST | `/v1/projects/:ref/restart` | 重启服务 |
| GET | `/v1/projects/:ref/settings` | 获取配置 |
| PUT | `/v1/projects/:ref/settings` | 更新配置 |
| GET | `/v1/projects/:ref/api-keys` | 获取 API 密钥 |
| POST | `/v1/projects/:ref/api-keys/rotate` | 轮换旧版 JWT API 密钥 |
| POST | `/v1/projects/:ref/api-keys/rotate-opaque` | 独立轮换 Publishable/Secret Key，不影响 JWT 会话 |
| GET | `/v1/projects/:ref/auth/oauth-server` | 获取项目 OAuth/OIDC 状态 |
| POST | `/v1/projects/:ref/auth/oauth-server/migrate` | 将项目迁移到 OIDC 签名密钥 |
| GET/POST/PUT/DELETE | `/v1/projects/:ref/auth/oauth-clients*` | 项目运行时的 OAuth 客户端管理 |
| GET | `/v1/projects/:ref/types/typescript` | 自动生成 TypeScript 类型 |
| PATCH | `/v1/projects/:ref/config/auth` | 自定义鉴权及三方 OAuth |
| GET | `/v1/projects/:ref/secrets` | 管理 Edge Functions Secrets |

`/v1/projects/:ref/functions*` 下的函数管理读取接口需要 project service role 或 admin 鉴权。公开函数调用仍走 `/functions/v1/*`，继续使用标准 Supabase 函数鉴权模型。

**扩展 API 端点：**

| 分类 | 端点 | 说明 |
|------|------|------|
| 数据库 | `/v1/projects/:ref/database/*` | SQL 查询、Schema 检查、数据迁移、防御性分页 |
| 鉴权 | `/v1/projects/:ref/config/auth`, `/v1/projects/:ref/auth/*` | OAuth 登录、OAuth/OIDC Provider 迁移、微信/支付宝/钉钉 |
| 前端托管 | `/v1/projects/:ref/frontend/*` | Pages 托管、自动部署、自定义域名 |
| Webhook | `/v1/webhooks/github` | GitHub Webhook CI/CD 自动部署 |
| 存储 | `/v1/storage/*` | Bucket 管理、文件上传、一次性 signed upload、S3 迁移 |
| 扩展 | `/v1/extensions/*` | PostgreSQL 扩展市场 |
| 扩缩容 | `/v1/projects/:ref/scaling/*` | 垂直升级与水平副本 |
| 备份 | `/v1/projects/:ref/backups/*` | 数据库备份与恢复 |
| 监控 | `/v1/monitor/*` | 数据库监控与健康检查 |
| 安全 | `/v1/security/*` | 防火墙规则与 SSL 证书 |
| 部署 | `/v1/deploy/*` | Edge Function 部署 |
| 任务 | `/v1/projects/:ref/tasks/*` | 后台 AI/通用异步任务生命周期观测与监控，支持 `summary=true` 轻量列表 |
| **日志 SSE** | `GET /v1/projects/:ref/logs/stream` | **实时日志流（Server-Sent Events）** |
| **限流** | `GET/PUT /v1/projects/:ref/gateway/rate-limit` 及 `custom-rate-limits` | **编程式架构与客户端路由自定限流（Caddy 路由策略）** |
| **网关路由** | `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` | **受控自定义 Caddy 路由（反代、静态、重定向、请求头、CORS、优先级）** |
| **WebSocket** | `ws://host/ws/tasks` | **实时任务进度推送** |

#### 运行时切换

```bash
# 切换 Edge Runtime 部署模式
./switch.sh runtime embedded   # 由 supacloud.service 管理
./switch.sh runtime external   # 独立 supacloud-edge-runtime.service

# 切换存储后端
./switch.sh storage juicefs    # 或: minio, external

# 查看当前配置
./switch.sh status
```

**Edge Runtime 架构 (Bun 模式):**

```
SupaCloud (:9090)          Edge Runtime（EDGE_RUNTIME_PORT，默认 :9005）
├── Management API    ←──  默认由 supacloud.service 管理
├── Web Console            ├── Elysia Server
├── SSE 日志流              ├── Worker 线程池 (4 线程，固定)
├── WebSocket /ws/tasks    ├── Deno 兼容层
└── 静态资源 (ETag/304)    ├── URL Import 插件
                           └── /preheat (零冷启动预热)

Edge Runtime 父进程 ── 内部 capability ──► pgredis-runtime (:9010)
                                         ├── 每租户 PostgreSQL 连接池
                                         └── 有界 L1 + LISTEN/NOTIFY

Caddy 网关 (Admin API 驱动):
  Automatic HTTPS、动态路由 JSON 发布、安全响应头、限流、CORS
  /api/*        → :9090 (管理 API)
  /functions/*  → :9090 (sdk-proxy，异步入队 + 同步转发)
```

生产环境从不手改 Caddyfile。Management API 将完整的 Caddy 配置以 JSON 形式保存在内存中（`GatewayService`），每次路由 / 限流 / 证书变更都会：
1. 渲染出完整的 Caddy JSON 配置；
2. 用 `caddy validate --config <tmp>` 校验；
3. 通过 Caddy Admin API 的 `POST /load`（`CADDY_ADMIN_URL`，默认 `http://127.0.0.1:2019`）热加载；
4. 将已应用的 JSON 原子写入 `CADDY_CONFIG_PATH`，用于重启后 hydrate 恢复，并在同目录写入 `DO-NOT-EDIT.txt`。

打包的 Caddyfile 只负责开启 Admin API 监听和最小 catch-all 引导；租户路由、TLS、CORS 与限流全部由注入的 JSON 接管。`GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` 和 `POST /v1/projects/:ref/gateway/config` 就是驱动这些 JSON 更新的用户侧接口。

启动来源因部署模式而异：systemd 安装用 `supacloud-caddy run --config /etc/supacloud/caddy/config.json`（纯 JSON，无 Caddyfile，初始 JSON 由 `install.sh` 预置）；docker 的 `self-host` 和 `dev` 栈以官方 `caddy` 镜像 + 纯引导 Caddyfile（`admin 0.0.0.0:2019` + `auto_https off` + `503` 占位）启动，Management API 健康（监听 `:9090`）后通过 `POST /load` 发布完整 JSON 配置，并带退避重试直到 Caddy 可达。无论哪种模式，真正生效的路由配置都是经 Admin API 注入的 JSON。

此外，Management API 运行周期性 `gateway-health.worker` 轮询 Caddy Admin API；一旦检测到"从不可达恢复可达"（如 systemd 下 caddy 重启或 docker 下容器重启），即触发 `rebuildAllTenantConfigs()` 重新发布完整路由 JSON，保持生效配置与内存态一致，两种部署模式都具备自愈能力。

完整字段说明、curl 示例（反代、静态托管、HTTPS 上游）、限流 tier、单路径自定义限流，以及自定义路由与租户 CORS 的组合行为，见 [docs/gateway-customization.md](docs/gateway-customization.md)。

默认安装使用 `EDGE_RUNTIME_MODE=embedded`，也就是由 `supacloud.service` 直接拉起 Bun Edge Runtime 子进程。`EDGE_RUNTIME_MODE=external` 时可以改用独立的 `supacloud-edge-runtime.service`，但两种模式不能同时运行，否则会争抢 `EDGE_RUNTIME_PORT`（默认 `9005`）。

`pgredis-runtime` 是独立、仅内部可达的数据面服务。Edge 父进程为每次请求签发短时、项目级 capability；被模块缓存的 Worker 代码只看到稳定的 `globalThis.SupaCloud.pgredis` facade，不会拿到 PostgreSQL 凭据、连接池、L1 状态或 runtime 签名密钥。该服务不经过 Caddy，也不映射宿主机/容器端口；Edge v1 只提供 KV/TTL。已认证运维人员通过 Web Console 或 Management API 代理查看有界运行状态、执行精确键操作及二次确认后的项目命名空间清空，浏览器不会直连 `9010`。平台队列仍唯一使用 PGMQ，网关限流仍唯一由 Caddy 负责。

| 特性 | 当前 Bun Runtime |
|------|------------------|
| 内存 (200 函数) | **~140MB** |
| 冷启动 | **< 10ms (预热后: 0ms)** |
| 预热延迟 | <1ms |
| Deno 代码兼容 | ✅ 兼容层 |
| 隔离级别 | Worker 线程 |
| 用户函数改动 | **零改动** |

### 后台函数路由

公开 Edge Function 流量先进入 Management API：

- `/functions/v1/*` 路由到 `:9090`
- `sdk-proxy` 根据函数配置决定异步入队并返回 `202 Accepted`，或同步转发到 Bun Edge Runtime
- 浏览器和 `supabase-js` 调用方继续使用标准 `functions.invoke()`

后台执行通过服务端函数配置 `background_routes` 开启。对 `/generate/crop`、`/generate/matting`、`/generate/video` 这类耗时路径，推荐使用 `background_routes`，避免依赖浏览器自定义请求头。

### Realtime 路由与恢复

Realtime 流量也先进入 Management API：

- `/realtime/v1/websocket` 路由到 `:9090`
- Management API 负责 websocket upgrade 并代理到上游 Realtime
- Caddy 不应把浏览器 websocket 流量直接指向 Elixir Realtime 容器

安装或迁移后如果 Realtime 订阅异常，可以运行：

```bash
cd packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

### PostgREST 运行时生命周期

每个项目仍然使用独立的 PostgREST 进程，但 Management API 现在把它当成受控运行时组件管理，支持显式 desired state：

- `GET /v1/projects/:ref/services/postgrest/status`
- `POST /v1/projects/:ref/services/postgrest/start|stop|restart|pause|resume`

desired state 保存在项目专用元数据列里（`postgrest_desired`、`postgrest_actual`、`postgrest_health` 及相关时间戳），runtime reconcile worker 会把实际 systemd 状态对齐到它。这里是显式生命周期管理，不做空闲自动收缩，所以请求路径性能不变。

#### CLI 入口

面向真人操作者的命令行现已拆分为：

- `@supacloud/cli` / `supacloud-cli`：项目使用者 CLI，默认从当前目录 `.env` 自动绑定项目
- `supacloudctl cli ...`：统一本地入口，普通分发默认离线且不访问 npm；需要时显式运行 `supacloudctl check-update cli`
- `@supacloud/admin` / `supacloud-admin`：服务器管理员 CLI，处理 SSH、安装、升级、租户运维
- `supacloudctl admin ...`：统一本地入口，同样默认离线；需要时显式运行 `supacloudctl check-update admin`
- Management、Web Console 与外置 Edge Runtime 的受校验事务使用 `npx @supacloud/admin ssh upgrade --version <management-version> --edge_runtime_version <edge-version>`
- `/usr/local/bin/supacloud` 仍是活动服务端二进制，但所有受支持的升级都必须通过 Admin。受保护的离线升级使用 Admin 已验证的本地产物传输，并由它执行认证后的目标 runner；不能手工执行 bundle runner，也不能让已安装的旧版本执行目标版本事务


### 项目结构

```
supacloud/
├── install.sh                  # 一键部署脚本
├── setup.sh                    # 远程安装引导
├── switch.sh                   # 运行时/存储切换工具
├── supacloud                   # CLI 管理工具 (Shell 入口)
├── config.env                  # 只读、受 Git 跟踪的默认模板
├── packages/
│   ├── management-api/         # REST API 服务 (Bun + Elysia)
│   │   ├── src/
│   │   │   ├── routes/         # 20 个路由模块 (projects, auth, frontend, webhook, ws, logs 等)
│   │   │   ├── services/       # 20 个服务模块
│   │   │   ├── cli/            # CLI 子命令 (lifecycle, project)
│   │   │   ├── db/             # 数据库层、迁移、withRetry 优雅降级
│   │   │   ├── middleware/     # 认证中间件
│   │   │   ├── infra/          # 健康检查器
│   │   │   ├── install.ts      # 交互式安装器
│   │   │   ├── upgrade.ts      # 升级向导
│   │   │   └── doctor.ts       # 系统诊断
│   │   └── tests/              # 单元测试 (17) & 集成测试
│   ├── cli/                    # 项目使用者 CLI
│   │   └── src/
│   ├── admin/                  # 服务器管理员 CLI
│   │   └── src/
│   ├── supacloud-lite/          # Bun + PGlite 单项目 Supabase 兼容运行时
│   │   └── README.md            # Lite 使用、迁移与兼容性说明
│   ├── edge-runtime/           # Bun 云函数运行时
│   │   ├── server.ts           # Elysia 服务（EDGE_RUNTIME_PORT，默认 :9005）+ /preheat 预热端点
│   │   ├── worker-pool.ts      # 固定大小 Worker 线程池 + preheat()
│   │   ├── worker-executor.ts  # 函数加载器 + LRU 缓存 + 预热消息
│   │   ├── deno-compat.ts      # Deno API 兼容层
│   │   ├── url-import-plugin.ts# Bun Plugin: URL import 拦截
│   │   └── shims/              # Deno 标准库替代实现
│   └── web-console/            # SvelteKit 管理面板
│       └── src/                # 组件, 路由, 资源
├── scripts/
│   └── lib/                    # Shell 脚本模块
│       ├── db_manager.sh       # 数据库生命周期
│       ├── gateway provider    # Caddy 路由发布由 management-api 内部管理
│       ├── tenant_runtime.sh   # 租户 PostgREST & GoTrue 运行时
│       ├── function_manager.sh # 云函数管理
│       ├── s3_manager.sh       # 存储后端管理
│       ├── jwt_manager.sh      # JWT 密钥生成
│       ├── backup_manager.sh   # 备份操作
│       ├── ha_manager.sh       # 高可用
│       ├── security_manager.sh # 防火墙 & SSL
│       ├── storage_manager.sh  # 存储操作
│       ├── extension_manager.sh# PostgreSQL 扩展
│       ├── global_router.ts    # 全局路由逻辑
│       └── worker_runner.ts    # 后台 Worker
├── infra/
│   ├── os/                     # 操作系统配置
│   └── postgres/               # PostgreSQL 配置
├── docs/                       # 15 篇技术文档
│   ├── deploy-guide.md         # 部署指南
│   ├── architecture-multi-tenant.md  # 架构设计
│   ├── china-oauth-integration.md    # 国内 OAuth 集成
│   └── ...                     # 详见 docs/README.md 完整索引
└── .github/
    └── workflows/              # CI/CD (build-studio, management-api, release)
```

### 配置说明

`config.env` 仅是只读默认模板。安装输入持久化在 `/etc/supabase/install.env`，Management API 运行时配置独立保存在 `/etc/supabase/management-api.env`；禁止用运行时配置覆盖安装输入。

关键安装配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SUPABASE_PUBLIC_DOMAIN` | 全局 API 网关域名 | 生产必填；安装器可自动生成 |
| `SUPABASE_STUDIO_DOMAIN` | 全局控制台域名 | 可留空，默认从 API 域名派生 |
| `S3_STORAGE_TYPE` | 存储后端 | `juicefs` |
| `TUS_MAX_SIZE` | 断点续传上传最大大小 | `524288000` (500 MiB) |
| `TUS_MAX_CHUNK_SIZE` | 断点续传分片最大大小 | `16777216` (16 MiB) |
| `EDGE_RUNTIME` | 云函数运行时 | `bun` |
| `PG_VERSION` | PostgreSQL 版本 | `18` |
| `PIGSTY_VERSION` | Pigsty 版本 | `v4.5.0` |
| `SUPACLOUD_LOGS_ENABLED` | 内置采集器 + VictoriaLogs 项目日志（不使用 Logflare） | `true` |
| `SUPACLOUD_PIPELINES_ENABLED` | 用于 BigQuery CDC Pipelines 的固定版本 Supabase ETL 运行时 | `true` |

### 参考文档

- [文档索引](docs/README.md)
- [部署指南](docs/deploy-guide.md)
- [多租户架构设计](docs/architecture-multi-tenant.md)
- [OAuth 2.1 / OIDC Provider](docs/oauth-oidc-provider.md)
- [国内 OAuth 集成](docs/china-oauth-integration.md)
- [Pigsty 官方文档](https://pigsty.cc/)
- [Supabase 自托管文档](https://supabase.com/docs/guides/self-hosting)

## License

MIT
