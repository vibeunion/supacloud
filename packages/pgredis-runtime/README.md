# SupaCloud pgredis-runtime

`pgredis-runtime` 是 SupaCloud 的私有缓存数据面。它按项目加载独立 PostgreSQL
连接池，并只向 Edge Runtime 暴露经过内部认证的 KV/TTL API。

边界：

- Edge Worker 只持有请求级 HTTP binding，不创建 PostgreSQL 连接或 L1。
- v1 只提供 `get`、`set`、`delete`、`ttl`、原子 `getset` 和原子
  `getdel`；不提供队列、限流或 Redis 协议。
- Management API 可通过独立内部令牌访问有界管理接口，提供平台/项目状态、
  精确键操作，以及必须匹配项目 Ref 的命名空间清空。Web Console 不直连本服务。
- PGMQ 仍是 SupaCloud 唯一队列实现，Caddy 仍负责网关限流。
- 当前固定使用包含 L1 失效与原子交换修复的 `@postgresx/noredis@0.6.1`。
  L1 仅存在于每租户 runtime client，并通过 PostgreSQL `LISTEN/NOTIFY`
  跨实例失效；断线重连会清空该租户 L1。
- `set`、`delete`、`getset`、`getdel` 的数据变更与失效通知在同一事务中提交；
  `getset` 使用可重试的 `SERIALIZABLE` 事务，避免交换结果与通知分离。
- 缓存表为 `UNLOGGED`，只适合可重建缓存，不承担持久业务事实。

每个租户由 Management API 生成只供本服务读取的
`/etc/supabase/pgredis-tenants/<ref>_pgredis.env`，其中数据库角色必须是
`role_<ref>`。该凭据目录不挂载到 Edge Runtime，服务也不接受调用方传入数据库 URL。

Edge 父进程持有内部签名密钥，并为每个函数请求签发短时 capability。Worker
只得到请求作用域 capability；请求结束后，未注册的 detached Promise 无法继续使用
binding，避免模块缓存或异步任务继承下一租户上下文。

## 内部接口

- `POST /internal/v1/cache`：Edge Runtime 使用请求级 capability 调用。
- `GET /internal/v1/admin/status`：返回活跃租户、租户容量、每租户连接数与 L1 配置。
- `GET /internal/v1/admin/projects/:ref/status`：返回项目是否配置、是否活跃、租约与最后使用时间。
- `POST /internal/v1/admin/cache`：Management API 使用内部令牌代理精确键操作；`flush` 必须同时提交匹配的 `confirmProjectRef`。

管理接口只监听私有网络，不通过 Caddy 路由，也不返回租户数据库 URL、凭据或配置指纹。
完整操作说明见 [`../../docs/pgredis-runtime.md`](../../docs/pgredis-runtime.md)。
