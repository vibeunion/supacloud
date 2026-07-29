# 平台组件升级兼容说明

本说明对应 2026-07-29 的组件基线。它和版本号清单一起使用，明确区分“升级后自动生效的修复”“需要迁移或回滚准备的破坏性变化”和“仅作为可选能力保留的新功能”。本轮不在生产环境自动启用可选功能。

## 版本与影响

| 组件 | 旧版本 | 当前版本 | 破坏性/迁移关注点 | 本仓库处理 |
| --- | --- | --- | --- | --- |
| GoTrue | v2.191.0 | v2.194.0 | v2.192 增加 `custom_oauth_providers.custom_claims_allowlist` 数据库迁移；v2.193.1 不再错误接受应撤销的旧 refresh token，并关闭 OAuth authorization code 重放竞态；v2.194 的 admin users cursor pagination 默认关闭，启用后响应增加 `pagination`/`Link` 且不再返回 `X-Total-Count` | GoTrue 根命令启动时执行嵌入迁移；`supabase_auth_admin` 保留建表/改列权限。cursor pagination、custom claims 和 linking domains 均不默认打开；依赖 token/code 重放的错误客户端必须修复，不能放宽服务端校验 |
| PostgREST | v14.13 | v14.16 | v14.14-v14.16 均为 admin server 错误处理与崩溃恢复修复，没有新增配置、数据库迁移或运行时前置要求 | 保持现有 per-tenant `.conf` 配置和健康检查；不需要改变 PostgreSQL 18 schema |
| Realtime | v2.111.4 | v2.121.0 | 2.112 恢复 pg filters；2.117-2.121 增加 inspector/status、tenant shutdown、Muster 和 fanout 可观测性。v2.120.1 修订既有 `20241019105805_uuid_auto_generation.ex`：先回填 `realtime.messages.uuid` 空值，再设置 default 和 `NOT NULL`；已记录成功的同名迁移不会自动重跑 | 多租户默认使用 `REGION=us-east-1`、`SEED_SELF_HOST=false`，fresh tenant 先按注册契约将 `realtime` schema owner 设为 `supabase_admin`，并向 `supabase_admin`/`supabase_realtime_admin` 授予 `USAGE, CREATE`，再由官方 Realtime migrator 接管对象；PG18 没有 self-host dump 时必须走顺序迁移。只有单租户演示场景才显式设置 `REALTIME_SEED_SELF_HOST=true`。升级前备份 tenant Realtime schema，并读回 `uuid`、default、`NOT NULL`、schema owner 与 migration marker；不默认启用新管理能力或 feature flag |
| Caddy | v2.10.2 | v2.11.4 | 2.11 对 HTTPS upstream 默认重写 `Host`；2.11.4 的路径、rewrite、模板和下划线 header 安全修复可能让依赖旧错误行为的配置失效 | SupaCloud JSON 路由显式设置 `Host`/`X-Forwarded-Host`，并只发送连字符 header；Caddy 自定义 rate-limit 模块已用 v2.11.4 双架构构建验证 |
| JuiceFS | 1.2.2 | 1.4.0 | 1.4 是 LTS；启用 storage tiers 时所有客户端必须先到 1.4.0；元数据备份默认清理两年以上备份；1.4 包含 SQL 元数据字段类型调整 | 本平台只使用单一 gateway 和 Postgres metadata；不启用 storage tiers。已有 `juicefs` metadata 在生产升级前必须做 `juicefs dump`/pg_dump 并保留回滚副本 |
| Docker Compose | v2.29.2 | v5.3.1 | v5 删除内部构建器，`compose build` 改走 Docker Bake，并要求 Docker Buildx >= 0.17；这是唯一需要额外运行时前置条件的主版本更新 | CI 已使用 Docker Buildx；安装器的 Podman 路径只负责 `pull/up`，不把 Compose v5 当作 Podman 的构建器。Podman 用户构建镜像应使用 Podman build/兼容的 Buildx，或先提供已构建镜像 |

## PostgreSQL 18 边界

SupaCloud 的实际部署、Dockerfile 和 self-host Compose 继续使用 `postgres:18-bookworm`。CI 中的 `supabase/postgres:17.6.1.143` 只是上游 Supabase 兼容 fixture，用于验证 Supabase schema/Realtime 迁移，不表示部署回退到 PostgreSQL 17。跨 PostgreSQL 大版本升级仍然是独立的备份、迁移和回滚任务，本轮没有执行。

## 升级顺序与回滚

1. 先保存当前 GoTrue/PostgREST 二进制、Realtime 镜像、Caddy 二进制和 Caddy JSON 状态；JuiceFS 额外保存 metadata dump。
2. 先更新一台非关键节点或本地 Compose，再检查 GoTrue migration 日志、PostgREST `/`、Realtime `/api/tenants` 和 Caddy `config/`。
3. 生产滚动更新时一次只重启一个组件；如果 GoTrue 数据库迁移已执行，二进制可以回滚，但数据库迁移不能假设存在自动 down migration，必须按 GoTrue 上游迁移策略处理。
4. Caddy/Realtime/PostgREST/GoTrue 的二进制或镜像回滚必须保留旧 digest；JuiceFS 回滚前先停止 gateway 并确认 metadata dump 可读；Compose v5 构建失败时回退到预构建镜像，不删除数据库卷。

## 官方变更记录

- [GoTrue v2.192.0](https://github.com/supabase/auth/releases/tag/v2.192.0)、[v2.193.1](https://github.com/supabase/auth/releases/tag/v2.193.1)、[v2.194.0](https://github.com/supabase/auth/releases/tag/v2.194.0) / [v2.193.0...v2.194.0](https://github.com/supabase/auth/compare/v2.193.0...v2.194.0)
- [PostgREST v14.14](https://github.com/PostgREST/postgrest/releases/tag/v14.14)、[v14.15](https://github.com/PostgREST/postgrest/releases/tag/v14.15)、[v14.16](https://github.com/PostgREST/postgrest/releases/tag/v14.16) / [v14.15...v14.16](https://github.com/PostgREST/postgrest/compare/v14.15...v14.16)
- [Realtime v2.112.0](https://github.com/supabase/realtime/releases/tag/v2.112.0)、[v2.116.1](https://github.com/supabase/realtime/releases/tag/v2.116.1)、[v2.117.0](https://github.com/supabase/realtime/releases/tag/v2.117.0)、[v2.119.0](https://github.com/supabase/realtime/releases/tag/v2.119.0)、[v2.120.0](https://github.com/supabase/realtime/releases/tag/v2.120.0)、[v2.120.1](https://github.com/supabase/realtime/releases/tag/v2.120.1)、[v2.121.0](https://github.com/supabase/realtime/releases/tag/v2.121.0) / [v2.116.1...v2.121.0](https://github.com/supabase/realtime/compare/v2.116.1...v2.121.0)
- [Caddy v2.11.1](https://github.com/caddyserver/caddy/releases/tag/v2.11.1) / [v2.11.4](https://github.com/caddyserver/caddy/releases/tag/v2.11.4)
- [JuiceFS v1.4.0](https://github.com/juicedata/juicefs/releases/tag/v1.4.0)
- [Docker Compose v5.0.0](https://github.com/docker/compose/releases/tag/v5.0.0) / [v5.3.1](https://github.com/docker/compose/releases/tag/v5.3.1)
