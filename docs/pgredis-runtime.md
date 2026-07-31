# pgredis Runtime

`pgredis-runtime` 是 SupaCloud 独立的 PostgreSQL 缓存数据面。它基于
`@postgresx/noredis`，按项目维护隔离的 PostgreSQL 连接池和有界 L1，本身不承担队列、
网关限流或持久业务数据。

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

不提供 `KEYS`、`SCAN`、键前缀枚举或 Redis 协议。缓存表使用 `UNLOGGED`，数据必须可重建，
不能作为持久业务事实。

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
PGREDIS_RUNTIME_L1_MAX_ENTRIES=1000
PGREDIS_RUNTIME_L1_TTL_MS=30000
```

Docker 部署中，Management API、Edge Runtime 与 `pgredis-runtime` 共享私有
`edge-pgredis` 网络；只有 runtime 额外加入数据库私网。systemd 安装由 `install.sh` 生成并同步
同一内部令牌，并默认监听 `127.0.0.1:9011`，避免与宿主机 Imaginary 的 `9010` 冲突。
可用 `PGREDIS_RUNTIME_PORT` 覆盖 systemd 端口，但安装器会拒绝已由 Imaginary 占用的 `9010`。

## 故障与回滚

- Management API 未配置足够长度的内部令牌时会 fail closed，返回
  `PGREDIS_RUNTIME_NOT_CONFIGURED`。
- runtime 不可达或超时时，控制面返回受控的 `502`、`503` 或 `504`，不会透传内部认证细节。
- 项目未生成租户缓存配置时，状态接口显示未配置，键操作返回
  `PGREDIS_PROJECT_NOT_CONFIGURED`。
- 回滚面板和 Management API 代理不会影响 Edge 数据面；回滚 runtime 前应保持
  `@postgresx/noredis@0.6.1` 的 L1 失效和原子交换修复，避免恢复到已知阻塞版本。
