# pgredis Runtime

`pgredis-runtime` 是 SupaCloud 独立的 PostgreSQL 缓存数据面。它基于
`@postgresx/noredis`，按项目维护隔离的 PostgreSQL 连接池和有界 L1，本身不承担队列、
网关限流或持久业务数据。

上游 pgredis 仓库：`git@github.com:vibeunion/postgresx.git`，对应目录为
`packages/pgredis`。发布包名暂为 `@postgresx/noredis`；同步上游代码时应使用 SSH 地址。

## PostgreSQL 扩展边界

pgredis 的 KV 路径只依赖 PostgreSQL 核心能力：事务、JSONB、`UNLOGGED` 表和
`LISTEN/NOTIFY`。因此以下扩展都不是 pgredis 的启动硬依赖：

- `pg_stat_statements`：推荐，用于定位真正需要缓存或优化的 SQL；
- `pg_cron`：推荐，用于项目级物化视图刷新或其他数据库维护任务；
- `pg_ivm`：可选，仅适用于需要增量维护的物化视图，不参与 KV 读写。

pgredis-runtime 默认每 60 秒调用上游 `PgKvCache.cleanupExpired()`，每批最多 500 行；
因此没有 `pg_cron` 时缓存表仍能正常回收。可以用 `PGREDIS_RUNTIME_CLEANUP_INTERVAL_MS`
和 `PGREDIS_RUNTIME_CLEANUP_BATCH_SIZE` 调整清理节奏。健康和管理状态会公开这组扩展策略，
但不会因为推荐扩展缺失而拒绝启动。

## 架构边界

```text
Edge Worker
  -> Edge Runtime 请求级 binding + 短时 capability
  -> pgredis-runtime 私有 Edge API

Web Console
  -> Management API 会话 / 项目授权
  -> Management API 私有服务令牌
  -> pgredis-runtime 管理 API
```

- `pgredis-runtime` 不通过 Caddy 暴露，也不映射宿主机端口。
- Web Console 只调用 Management API；浏览器不会接触内部令牌、数据库 URL 或端口 `9010`。
- 跨租户复用的 Worker 模块只持有稳定 facade，不持有 PostgreSQL 连接、租户客户端或 L1。
- 租户凭据只存在于 runtime 专属目录
  `/etc/supabase/pgredis-tenants/<ref>_pgredis.env`，并要求数据库角色匹配
  `role_<ref>`。
- PGMQ 继续作为唯一队列实现；Caddy 继续负责网关级限流。

## 数据语义

Edge 和控制面均只提供已知键操作：

- `get`
- `set`，可选 `ttlMs` / 外部 API 的 `ttl_ms`
- `delete`
- `ttl`
- 原子 `getset`
- 原子 `getdel`
- 批量 `mget` / `mset`

不提供 `KEYS`、`SCAN`、键前缀枚举或 Redis 协议。缓存表使用 `UNLOGGED`，数据必须可重建，
不能作为持久业务事实。

批量操作只消耗一次 HTTP 往返：`mget` 用一条 SQL 读取整批键，`mset` 在单个 PostgreSQL
事务内写入整批键并由上游 `PgKvCache.mset` 统一发布失效通知。往返次数与延迟不随键数量线性
增长。`mset` 可携带一个作用于整批的 `ttlMs`；提交成功后逐键清理本实例 L1，其他实例由
`LISTEN/NOTIFY` 失效。单次请求的键数量默认上限为 100，可用
`PGREDIS_RUNTIME_MAX_KEYS_PER_REQUEST` 调整（外部 schema 的硬上限为 512）。

跨实例失效通过可插拔的 `InvalidationTransport` 抽象：默认实现使用共享 PostgreSQL
NOTIFY 频道发布与监听。单实例部署可设置 `PGREDIS_RUNTIME_SINGLE_INSTANCE=true`，切换到
本地传输：写路径不再发送 `pg_notify`，也不启动 LISTEN 监听，只保留提交后的本地 L1 清理。
这不是语义变更——单实例本就不需要跨实例广播——但能省掉每次写的一次 `pg_notify`。

所有写操作与失效通知在同一 PostgreSQL 事务中提交。项目命名空间清空通过
`clearNamespace()` 在同一事务内删除数据并发送 `clearNamespace` 通知；本实例 L1 仅在事务
提交成功后清空，其他实例由 `LISTEN/NOTIFY` 失效。事务失败时不会提前清空 L1 或广播已提交
失效。

## Management API

平台管理员可读取：

```http
GET /v1/cache
```

返回服务状态、活跃租户数量、租户容量、每租户连接数、L1 配置和活跃租户摘要。响应不包含
数据库凭据或连接字符串。

项目 owner/admin 可读取和操作：

```http
GET  /v1/projects/:ref/cache
POST /v1/projects/:ref/cache/operations
POST /v1/projects/:ref/cache/flush
```

精确键操作示例：

```json
{
  "op": "set",
  "key": "session:user:42",
  "value": { "role": "editor" },
  "ttl_ms": 60000
}
```

清空操作必须把路由中的项目 Ref 作为确认值再次提交：

```json
{
  "confirmation": "project-ref"
}
```

Management API 会重新构造内部请求，调用方无法通过 body 覆盖路由项目 Ref。委托访问沿用
`operations.read` 和 `operations.manage` 能力；平台状态要求平台管理员权限。

## Web Console

- `/project/:ref/cache`：查看项目配置/活跃状态，执行精确键操作，并通过输入项目 Ref 和浏览器
  二次确认清空项目缓存。
- `/platform/cache`：查看数据面健康、活跃租户容量、每租户连接数、L1 参数和活跃租户摘要。

面板不提供键扫描、数据库凭据显示、runtime 重启、队列操作或第二套限流配置。

## 配置

Management API：

```dotenv
PGREDIS_RUNTIME_INTERNAL_URL=http://pgredis-runtime:9010
PGREDIS_RUNTIME_INTERNAL_TOKEN=<at-least-32-bytes>
PGREDIS_RUNTIME_INTERNAL_TIMEOUT_MS=5000
```

Runtime：

```dotenv
PGREDIS_RUNTIME_INTERNAL_TOKEN=<same-internal-token>
PGREDIS_RUNTIME_CONNECTIONS_PER_TENANT=2
PGREDIS_RUNTIME_MAX_TOTAL_CONNECTIONS=256
PGREDIS_RUNTIME_L1_MAX_ENTRIES=1000
PGREDIS_RUNTIME_L1_TTL_MS=30000
PGREDIS_RUNTIME_CLEANUP_INTERVAL_MS=60000
PGREDIS_RUNTIME_CLEANUP_BATCH_SIZE=500
PGREDIS_RUNTIME_MAX_KEYS_PER_REQUEST=100
PGREDIS_RUNTIME_SINGLE_INSTANCE=false
```

Docker 部署中，Management API、Edge Runtime 与 `pgredis-runtime` 共享私有
`edge-pgredis` 网络；只有 runtime 额外加入数据库私网。systemd 安装由 `install.sh` 生成并同步
同一内部令牌，并默认监听 `127.0.0.1:9011`，避免与宿主机 Imaginary 的 `9010` 冲突。
可用 `PGREDIS_RUNTIME_PORT` 覆盖 systemd 端口，但安装器会拒绝已由 Imaginary 占用的 `9010`。

## 连接与并发

每个租户一个 Bun SQL 连接池，`PGREDIS_RUNTIME_CONNECTIONS_PER_TENANT` 是该租户的突发上限；
Bun 按需开连接，空闲租户通常只占一条。为了避免“多租户 × 每租户上限”在突发时压垮数据库，
runtime 还有一个**进程级数据库操作预算**：

- `PGREDIS_RUNTIME_MAX_TOTAL_CONNECTIONS`（默认 `MAX_TENANTS × CONNECTIONS_PER_TENANT`，默认
  256）限制同时持有的租户数据库操作/事务数量。一个事务或一条语句占一个配额，等到可用才执行。
- 因事务回调直接使用底层事务句柄，配额不会递归获取，不会自锁。
- 因此可以“上调每租户上限（弹性突发）+ 收紧全局预算（保护数据库）”；不改预算时行为与过去
  一致（默认预算等于理论最大值）。

## 可观测性

`GET /internal/v1/admin/metrics`（需内部令牌）返回 Prometheus 文本格式（`text/plain;
version=0.0.4`），进程内累计，重启后清零：

- `supacloud_pgredis_cache_operations_total{op,outcome}`：按操作与结果的计数
- `supacloud_pgredis_cache_operation_duration_ms`：按 `op` 的耗时直方图（桶 + sum + count）
- `supacloud_pgredis_invalidation_publishes_total{op}`：跨实例失效发布次数
- `supacloud_pgredis_transaction_retries_total`：序列化失败后的重试次数
- `supacloud_pgredis_transaction_retry_exhausted_total`：重试耗尽的次数
- `supacloud_pgredis_cross_instance_invalidation`：是否启用跨实例失效（1/0）
- `supacloud_pgredis_active_tenants` / `supacloud_pgredis_tenant_capacity` / `supacloud_pgredis_l1_max_entries`
- `supacloud_pgredis_l1_hits` / `supacloud_pgredis_l1_misses` / `supacloud_pgredis_l1_hit_ratio`
- `supacloud_pgredis_database_operations_in_flight` / `supacloud_pgredis_database_operation_limit`
  （后者为 0 表示未设置显式预算）

L1 命中率来自上游 `PgKvCache.stats()`（自 `@postgresx/noredis@0.8.0` 起提供 `l1Hits`/`l1Misses`），
按当前持有的租户缓存汇总。租户 cache 被淘汰/重建时其计数会重置，因此 hits/misses 是 gauge
而非单调 counter；`hit_ratio` 在无读时为 0。

## 故障与回滚

- Management API 未配置足够长度的内部令牌时会 fail closed，返回
  `PGREDIS_RUNTIME_NOT_CONFIGURED`。
- runtime 不可达或超时时，控制面返回受控的 `502`、`503` 或 `504`，不会透传内部认证细节。
- 项目未生成租户缓存配置时，状态接口显示未配置，键操作返回
  `PGREDIS_PROJECT_NOT_CONFIGURED`。
- 回滚面板和 Management API 代理不会影响 Edge 数据面；回滚 runtime 前应保持
  `@postgresx/noredis@0.6.1` 的 L1 失效和原子交换修复，避免恢复到已知阻塞版本。
