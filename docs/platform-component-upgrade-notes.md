# 平台组件升级兼容说明

本说明对应 2026-09-27 的组件基线。它和版本号清单一起使用，明确区分“升级后自动生效的修复”“需要迁移或回滚准备的破坏性变化”和“仅作为可选能力保留的新功能”。本轮不在生产环境自动启用可选功能。

## 版本与影响

| 组件 | 旧版本 | 当前版本 | 破坏性/迁移关注点 | 本仓库处理 |
| --- | --- | --- | --- | --- |
| GoTrue | v2.191.0 | v2.197.0 | v2.192 增加 `custom_oauth_providers.custom_claims_allowlist` 数据库迁移；v2.193.1 关闭 refresh token 与 OAuth authorization code 重放问题；v2.194 的 admin users cursor pagination 默认关闭；v2.195 将 SCIM router 置于实验性 feature flag 之后并拒绝已封禁用户的 access token；v2.196 增加 SCIM 元数据端点和规范错误响应、identity link/unlink 审计动作，并修复 email 替换、identity unlink、未支持 JWKS 算法和遗留 email token 处理；v2.197 增加 MFA recovery codes（factor 模型、配置与 verify/regenerate/delete 端点、审计与计量）、OAuth server token 交换计量、`one_time_tokens.expires_at` 列以及 `scim_users`/`scim_tokens` 表（新增数据库迁移文件，由 GoTrue 根命令启动时执行嵌入迁移） | GoTrue 根命令启动时执行嵌入迁移；`supabase_auth_admin` 保留建表/改列权限。cursor pagination、SCIM、首次设置密码时自动创建 email identity 等实验能力保持默认关闭；现有 email/identity 流程需覆盖替换、解绑、token 撤销与 JWKS 混合算法回归 |
| PostgREST | v14.13 | v16.4 | v16.0 为跨主版本升级：v16.0 移除 PostgreSQL 13 支持（本仓库部署在 PostgreSQL 18，不受影响）；v16.0 启动时拒绝 `db-schemas` 含 `pg_catalog`/`information_schema`（本仓库使用 `public,storage,graphql_public`，不受影响）；`jwt-role-claim-key` 从 JSPath 改为 JSON Path，v16.2 为旧 JSPath 语法补回兼容并发出弃用警告（本仓库不使用该配置，角色提取由 pre-request function 在 SQL 层完成，不受影响）；ARM64 二进制资源从 `ubuntu-aarch64` 改名为 `linux-static-aarch64`；`Prefer: timezone` 不再支持 `handling=lenient`。v16.1 修复 v16.0 的 JWT 校验时间 bug；v16.3 修复偶发的 `PGRST303 JWT issued at future` 错误与长时间空闲后日志时间错误，无配置或 schema 变更 | 已同步 `tenant_runtime.sh` 的 ARM64 资源名为 `linux-static-aarch64`、更新 SHA256 pin 和默认版本；两份 Compose 和 CI workflow 镜像已统一为 v16.4；保持现有 per-tenant `.conf` 配置和健康检查；不需要改变 PostgreSQL 18 schema |
| Realtime | v2.111.4 | v2.138.1 | 2.112 恢复 pg filters；2.117-2.121 增加 inspector/status、tenant shutdown、Muster 和 fanout 可观测性；2.121.1 更新 pg-delta。v2.120.1 修订既有 `20241019105805_uuid_auto_generation.ex`，先回填 `realtime.messages.uuid` 空值，再设置 default 和 `NOT NULL`。2.130 修复容器内 pg-delta 的 `libpg-query.wasm` 运行时资产，2.132 增加 broadcast persistence，并把 tenant migration 总数提升到 82；v2.138.1 包含 86 个 tenant migrations，新增权限委派迁移和空 selected_columns 修复 | 多租户默认使用 `REGION=us-east-1`、`SEED_SELF_HOST=false`。fresh tenant 由官方 migrator 接管；已有 hybrid tenant 必须先备份，再使用镜像自带 tenant schema/profile 执行 pg-delta plan/apply，二次确认零漂移后才补齐官方 migration ledger 和 `migrations_ran`。不得用顺序迁移强行重放已存在的中间对象。升级后读回 `uuid`、default、`NOT NULL`、schema owner、migration marker、publication 和 replication slot，并完成真实 CDC/broadcast 验收 |
| Caddy | v2.10.2 | v2.11.4 | 2.11 对 HTTPS upstream 默认重写 `Host`；2.11.4 的路径、rewrite、模板和下划线 header 安全修复可能让依赖旧错误行为的配置失效 | SupaCloud JSON 路由显式设置 `Host`/`X-Forwarded-Host`，并只发送连字符 header；Caddy 自定义 rate-limit 模块已用 v2.11.4 双架构构建验证 |
| JuiceFS | 1.2.2 | 1.4.1 | 1.4 是 LTS；启用 storage tiers 时所有客户端必须先到 1.4.0；元数据备份默认清理两年以上备份；1.4 包含 SQL 元数据字段类型调整 | 本平台只使用单一 gateway 和 Postgres metadata；不启用 storage tiers。已有 `juicefs` metadata 在生产升级前必须做 `juicefs dump`/pg_dump 并保留回滚副本 |
| Docker Compose | v2.29.2 | v5.5.1 | v5 删除内部构建器，`compose build` 改走 Docker Bake，并要求 Docker Buildx >= 0.17；这是唯一需要额外运行时前置条件的主版本更新 | CI 已使用 Docker Buildx；安装器的 Podman 路径只负责 `pull/up`，不把 Compose v5 当作 Podman 的构建器。Podman 用户构建镜像应使用 Podman build/兼容的 Buildx，或先提供已构建镜像 |

## 2026-09-27 核验补充

- 已通过官方 GitHub Releases API 核实并更新 Realtime v2.138.1、PostgREST v16.4、
  JuiceFS v1.4.1、Docker Compose v5.5.1、PGMQ v1.13.0。
- GoTrue v2.197.0、Caddy v2.11.4、xcaddy v0.4.7、VictoriaLogs v1.52.0、
  FerretDB v2.7.0、Pigsty v4.5.0、Bun v1.4.2、pgflow 0.16.0 已匹配最新稳定 release，
  不为升级而重复改写。Storage、Edge Runtime 和 pg-meta 采用仓库自身实现，
  不替换为上游同名容器；未执行任何生产部署。
- PGMQ 测试镜像统一到 v1.13.0，并更新已有 digest-pinned RPC fixture；
  PostgreSQL Supabase 兼容 fixture 更新至官方非测试版本 17.6.1.177。
  生产 PostgreSQL 扩展仍由 Pigsty 软件源管理，源码升级不等于已有数据库执行了
  `ALTER EXTENSION UPDATE`。
- PostgREST v16.4 修复 mixed-case schema 的根端点响应和数据库配置中的
  `jwt-cache-max-entries` 加载；双架构二进制 SHA256 同步官方 release assets。
- Realtime 86 个 tenant migrations 包括新增 `20260827120000`、
  `20260914120000`、`20260916120000`、`20260922120000`。空 `selected_columns`
  现在表示仅主键，NULL 表示全部列。权限迁移包含 `REVOKE GRANT OPTION ... CASCADE`，
  升级前必须备份并盘点委派授权链；回退镜像不会恢复已撤销的授权。
- pg-delta profile 排除了默认权限和授予 postgres 的 ACL。即使返回 `no_changes`，
  reconciliation 也不得代写上述三个权限迁移的账本：必须先由官方 migrator 执行，
  缺失时拒绝 ledger synchronization。已有 hybrid tenant 不可通过伪造版本号绕过。
- Realtime 镜像 index、双架构 manifest/config、源提交、源文件及补丁 SHA256 同步；
  schema tree 必须按 manifest 的 `loadOrder` 校验。镜像默认使用 nobody，需验证
  BEAM 挂载可读和 pg-delta cache 可写，不能仅用宿主 root 验证替代运行验收。

新增官方记录：
[Realtime v2.138.1](https://github.com/supabase/realtime/releases/tag/v2.138.1)、
[PostgREST v16.4](https://github.com/PostgREST/postgrest/releases/tag/v16.4)、
[PGMQ v1.13.0](https://github.com/pgmq/pgmq/releases/tag/v1.13.0)、
[JuiceFS v1.4.1](https://github.com/juicedata/juicefs/releases/tag/v1.4.1)、
[Compose v5.5.1](https://github.com/docker/compose/releases/tag/v5.5.1)。

## Caddy 构建工具链

Caddy 保持 v2.11.4，xcaddy 从 v0.4.5 升级至 v0.4.7，Go 编译器统一固定为
1.27.1。源码脚本和 Docker builder 显式使用 `GOTOOLCHAIN=go1.27.1`，发布与 CI
通过 `GO_VERSION` 选择相同版本，不再使用浮动的 `stable`。Docker 基础镜像摘要与
限流插件提交保持不变；源码安装器始终安装指定 xcaddy，避免复用主机旧版本。

Go 1.21 或更高版本可自动下载该工具链，离线构建需要提前缓存。源码构建可通过
`GO_VERSION` 显式选择回滚版本；Docker 和发布回滚仍应使用已验证的旧产物，
不要仅根据 Caddy 的版本字符串判断编译器是否升级，应读取 `go version -m <binary>`。

Docker 构建默认使用官方 Go 模块代理；网络受限时可通过 `--build-arg GOPROXY=...`
显式指定可信代理，不关闭 Go 模块校验。

## PostgreSQL 18 边界

SupaCloud 的实际部署、Dockerfile 和 self-host Compose 继续使用 `postgres:18-bookworm`。CI 中的 `supabase/postgres:17.6.1.177` 只是上游 Supabase 兼容 fixture，用于验证 Supabase schema/Realtime 迁移，不表示部署回退到 PostgreSQL 17。跨 PostgreSQL 大版本升级仍然是独立的备份、迁移和回滚任务，本轮没有执行。

## 升级顺序与回滚

1. 先保存当前 GoTrue/PostgREST 二进制、Realtime 镜像、Caddy 二进制和 Caddy JSON 状态；JuiceFS 额外保存 metadata dump。
2. 先更新一台非关键节点或本地 Compose，再检查 GoTrue migration 日志、PostgREST `/`、Realtime `/api/tenants` 和 Caddy `config/`。
3. 生产滚动更新时一次只重启一个组件；如果 GoTrue 数据库迁移已执行，二进制可以回滚，但数据库迁移不能假设存在自动 down migration，必须按 GoTrue 上游迁移策略处理。
4. Caddy/Realtime/PostgREST/GoTrue 的二进制或镜像回滚必须保留旧 digest；JuiceFS 回滚前先停止 gateway 并确认 metadata dump 可读；Compose v5 构建失败时回退到预构建镜像，不删除数据库卷。

## 官方变更记录

- [GoTrue v2.192.0](https://github.com/supabase/auth/releases/tag/v2.192.0)、[v2.193.1](https://github.com/supabase/auth/releases/tag/v2.193.1)、[v2.194.0](https://github.com/supabase/auth/releases/tag/v2.194.0)、[v2.195.0](https://github.com/supabase/auth/releases/tag/v2.195.0)、[v2.196.0](https://github.com/supabase/auth/releases/tag/v2.196.0)、[v2.197.0](https://github.com/supabase/auth/releases/tag/v2.197.0) / [v2.196.0...v2.197.0](https://github.com/supabase/auth/compare/v2.196.0...v2.197.0)
- [PostgREST v16.4](https://github.com/PostgREST/postgrest/releases/tag/v16.4) / [v16.3...v16.4](https://github.com/PostgREST/postgrest/compare/v16.3...v16.4)
- [Realtime v2.138.1](https://github.com/supabase/realtime/releases/tag/v2.138.1) / [v2.133.0...v2.138.1](https://github.com/supabase/realtime/compare/v2.133.0...v2.138.1)
- [Caddy v2.11.1](https://github.com/caddyserver/caddy/releases/tag/v2.11.1) / [v2.11.4](https://github.com/caddyserver/caddy/releases/tag/v2.11.4)
- [JuiceFS v1.4.1](https://github.com/juicedata/juicefs/releases/tag/v1.4.1)
- [Docker Compose v5.5.1](https://github.com/docker/compose/releases/tag/v5.5.1)
