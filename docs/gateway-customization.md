# Gateway Customization Guide

SupaCloud 的 HTTP 网关基于 **Caddy**，但生产环境从不手改 Caddyfile。所有租户路由、TLS、CORS、限流都由 Management API 以 **Caddy JSON config** 的形式，通过 **Caddy Admin API 的 `POST /load`** 热加载注入，详见 README 的 *Caddy Gateway* 章节。

本文聚焦自定义网关能力的三个用户侧入口：

1. 自定义网关路由（`/v1/projects/:ref/gateway/routes`）
2. 网关配置：限流 tier / CORS / JWT（`/v1/projects/:ref/gateway/config`）
3. 编程式限流（`/v1/projects/:ref/gateway/rate-limit` 与 `/custom-rate-limits`）

> 所有写接口都需要 admin 鉴权（与其它 project 管理接口一致）。下文示例用 `$ADMIN_TOKEN` 指代你的 admin/service-role token，`$HOST` 指代 Management API 地址（默认 `:9090`）。

## 运行模型速览

每次写操作（创建/更新/删除路由、调整限流、设置 CORS）都会触发 `GatewayService` 的 `persistAndLoad`：

1. 将内存中的路由 / 证书 / 限流渲染成完整 Caddy JSON config；
2. `caddy validate --config <tmp>` 校验（systemd 模式有 `supacloud-caddy` 二进制时生效）；
3. `POST /load` 到 `CADDY_ADMIN_URL`（默认 `http://127.0.0.1:2019`）热加载；
4. 原子写入 `CADDY_CONFIG_PATH`（systemd 默认 `/etc/supacloud/caddy/config.json`），并写 `DO-NOT-EDIT.txt`。

**冷启动就绪（`ensureGatewayReady`）**：docker 模式下 caddy 容器晚于 management-api 启动，Management API 在 `Bun.serve` 监听 `:9090` 之前构建网关内存态路由（首次 `POST /load` 因此可能失败），HTTP server 就绪后异步触发 `ensureGatewayReady`：带退避轮询 Admin API，可达后补一次 `persistAndLoad` 让 JSON 路由接管 bootstrap Caddyfile。退避参数可由环境变量 `GATEWAY_READY_MAX_ATTEMPTS`（默认 60）和 `GATEWAY_READY_INTERVAL_MS`（默认 1000ms）调整。在那之前，caddy 的 bootstrap Caddyfile 对所有请求返回 `503`，作为明确的安全网信号而非"假路由"。


**稳态自愈（`gateway-health.worker`）**：除了冷启动注入，Management API 还运行一个周期健康 worker（默认每 60s，`GATEWAY_HEALTH_CHECK_INTERVAL_MS` 可配，首探延迟 `GATEWAY_HEALTH_CHECK_INITIAL_DELAY_MS` 默认 30s）。它轮询 Caddy Admin API 可达性，一旦检测到"从不可达恢复可达"（systemd 下 caddy 重启、docker 下 caddy 容器重启的信号），即调用 `rebuildAllTenantConfigs()` 从 DB 全量重建所有 active 租户路由并 `persistAndLoad`，确保 caddy 加载的最新 config.json 与 management-api 内存态一致。这样 systemd 模式下 caddy 重启不再仅依赖磁盘快照，docker 模式也有持续自愈。worker 在 management-api 启动时自动注册、关闭时优雅停止。

因此自定义路由的最终形态是一份 Caddy JSON route，而不是 Caddyfile 片段。下表里每个字段都会在 JSON 里对应到 Caddy 的 `match` / `handle` 结构。

## 自定义网关路由

自定义路由通过 CRUD 接口管理。实现见 `packages/management-api/src/services/gateway.service.ts` 的 `makeCustomGatewayRoute`，接口定义见 `packages/management-api/src/routes/project-config.ts`。

### 接口

| 方法 | 路径 | 语义 |
|------|------|------|
| `GET` | `/v1/projects/:ref/gateway/routes` | 列出该项目所有自定义路由 |
| `POST` | `/v1/projects/:ref/gateway/routes` | 创建或按 `id` 替换一条路由 |
| `PUT` | `/v1/projects/:ref/gateway/routes/:routeId` | 按 `:routeId` 替换一条路由 |
| `DELETE` | `/v1/projects/:ref/gateway/routes/:routeId` | 删除指定路由 |

POST/PUT 的 body schema（字段语义与 `normalizeCustomGatewayRoute` 一致）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 路由 ID，`^[A-Za-z0-9_-]{1,64}$`；POST 时作为去重主键，PUT 时必须与 `:routeId` 一致 |
| `hosts` | string[] | 是 | 1-20 个主机名（自动 `normalizeCaddyHost`，去重） |
| `path` | string \| string[] | 是 | 1-20 个路径，必须以 `/` 开头，不允许含 URL 或控制字符 |
| `upstream` | string | 二选一 | 反代上游，`host:port` 或 `http(s)://host[:port]`；URL 形式不允许带 path/query/hash |
| `static_root` | string | 二选一 | 静态文件根目录，绝对路径，禁止 `..` 与 `\0` |
| `upstream_tls_insecure_skip_verify` | boolean | 否 | 上游为 `https://` 时是否跳过 TLS 校验，默认 `false` |
| `rewrite_uri` | string | 否 | 请求改写目标 URI，必须以 `/` 开头；与 `strip_prefix` 互斥；依赖 `upstream` |
| `strip_prefix` | string | 否 | 剥离指定路径前缀；与 `rewrite_uri` 互斥；依赖 `upstream` |
| `headers` | Record<string,string> | 否 | upstream 模式作为请求头注入；static 模式作为响应头 |
| `cors` | string[] | 否 | 1-50 个允许的 Origin；前缀 `~` 视为正则 |
| `priority` | number | 否 | 整数，默认 `0`，用于多路由排序 |
| `enabled` | boolean | 否 | `false` 时该路由不会被下发到 Caddy |

校验规则（来自 `normalizeCustomGatewayRoute` / `normalizeCustom*`）：

- `upstream` 与 `static_root` 必须**恰好设置一个**，否则报错。
- `rewrite_uri` 与 `strip_prefix` 不能同时设置，且只有 `upstream` 路由才允许。
- `headers` 的 name 必须匹配 `^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$`，value 不得含 `\r\n`。
- `path` 不得含 `://` 或控制字符；`static_root` 不得含路径穿越。

### upstream 模式渲染

upstream 路由会被渲染成 Caddy 的 `reverse_proxy`，并自动注入这些请求头：`Host`、`X-Project-Ref` / `x-project-ref`、`X-Forwarded-Host`、`X-Forwarded-Proto`。`headers` 字段会合并进去（同名覆盖）。若有 `rewrite_uri` 则前置一个 `rewrite` handler；`strip_prefix` 则用 `strip_path_prefix`。`cors` 非空时前置一个 CORS subroute（OPTIONS 预检 + 常规响应头）。

### static 模式渲染

static 路由会被渲染成 Caddy `file_server`，`index_names` 为 `["index.html"]`，自动开启 `br`/`zstd`/`gzip` 预压缩协商，并隐藏 `.git`、`.env`、`deployment.json`。`headers` 字段作为响应头设置（注意：static 模式没有自动注入 `X-Project-Ref`）。

### 示例：反代一个内部服务

```bash
curl -X POST "$HOST/v1/projects/$REF/gateway/routes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "billing-api",
    "hosts": ["billing.$BASE_DOMAIN"],
    "path": ["/v1/*", "/webhooks/*"],
    "upstream": "billing-svc.internal:8080",
    "strip_prefix": "/v1",
    "headers": { "X-Gateway-Source": "supacloud" },
    "cors": ["https://app.$BASE_DOMAIN"],
    "priority": 10
  }'
```

效果：`billing.$BASE_DOMAIN/v1/charges` 会被剥离 `/v1` 前缀后转发到 `billing-svc.internal:8080/charges`，附带注入的 `X-Project-Ref` 与自定义 `X-Gateway-Source`，并允许来自 `https://app.$BASE_DOMAIN` 的跨域。

### 示例：托管静态站点

```bash
curl -X POST "$HOST/v1/projects/$REF/gateway/routes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "marketing",
    "hosts": ["marketing.$BASE_DOMAIN"],
    "path": "/*",
    "static_root": "/var/www/marketing",
    "headers": { "Cache-Control": "public, max-age=3600" }
  }'
```

### 示例：指向 HTTPS 上游

```bash
curl -X POST "$HOST/v1/projects/$REF/gateway/routes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ext-webhook",
    "hosts": ["relay.$BASE_DOMAIN"],
    "path": "/hook/*",
    "upstream": "https://api.partner.example",
    "upstream_tls_insecure_skip_verify": false,
    "cors": ["~^https://.*\\.partner\\.example$"]
  }'
```

`~^https://.*\\.partner\\.example$` 是正则 Origin（`~` 前缀）。

## 网关配置（tier / CORS / JWT）

`POST /v1/projects/:ref/gateway/config` 一次性更新项目的限流 tier、CORS origins、JWT 开关。对应 `GatewayService.applyConfig`。

| 字段 | 类型 | 说明 |
|------|------|------|
| `rate_limit_tier` | `"free" \| "pro" \| "enterprise"` | tier 预设，见下表 |
| `cors_origins` | string | 逗号分隔的 Origin 列表 |
| `jwt_enabled` | boolean | 是否在网关层强制 JWT 校验 |
| `jwt_secret` | string | 可选，JWT 校验密钥 |

tier 对应的速率（`getRateLimitConfig`）：

| Tier | per second | per minute | per hour |
|------|-----------|-----------|---------|
| `free`（默认） | 10 | 100 | 1,000 |
| `pro` | 100 | 2,000 | 50,000 |
| `enterprise` | 1,000 | 50,000 | 1,000,000 |

```bash
curl -X POST "$HOST/v1/projects/$REF/gateway/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rate_limit_tier": "pro",
    "cors_origins": "https://app.$BASE_DOMAIN,https://admin.$BASE_DOMAIN",
    "jwt_enabled": true
  }'
```

## 编程式限流

除了 tier 预设，还可以精确设置数值或对单条路径单独限流。

### 整体速率

`GET /v1/projects/:ref/gateway/rate-limit` 查询，`PUT` 更新。PUT body 可二选一：

```bash
# 用 tier 预设
curl -X PUT "$HOST/v1/projects/$REF/gateway/rate-limit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "tier": "pro" }'

# 或自定义数值
curl -X PUT "$HOST/v1/projects/$REF/gateway/rate-limit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "second": 20, "minute": 500, "hour": 10000 }'
```

### 单路径自定义限流

`PUT /v1/projects/:ref/gateway/custom-rate-limits` 对单条路径单独限流，每个项目最多 20 条路径规则。命中时会在对应系统路由（`/rest/v1`、`/auth/v1`、`/functions/v1` 等）前克隆出一条带速率策略的子路由。

```bash
curl -X PUT "$HOST/v1/projects/$REF/gateway/custom-rate-limits" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/rest/v1/expensive_endpoint",
    "second": 2,
    "minute": 30,
    "hour": 500
  }'
```

`custom-rate-limits` 仅对系统路由前缀（rest / graphql / auth / functions / storage / realtime）下的子路径生效；其它前缀会被忽略。

## 与多域名 / CORS 的组合

SupaCloud 会自动为每个项目生成多个域名：API 主域（`<ref>.<base_domain>`）、Auth 域、Studio 域，并为这些域名构建租户级 CORS origins（`buildTenantCorsOrigins`）。自定义路由与这套自动 CORS 体系是**正交**的：

- 自定义路由的 `cors` 字段只作用于该路由本身，不会影响系统路由的 CORS。
- `gateway/config` 的 `cors_origins` 会更新该项目所有系统路由的 CORS。
- `addCorsOriginsForHosts`（内部接口）会把自定义域名并入租户 CORS 计算，用于绑定自定义前端域名时。

因此推荐做法：

1. 业务 API 仍走系统路由（`/rest/v1`、`/functions/v1` 等），用 `gateway/config` 统一管理 CORS 与 tier；
2. 需要接入 SupaCloud 之外的服务或静态站点时，用自定义 `gateway/routes`，并在该路由上用 `cors` 字段精确放行来源；
3. 不要尝试用自定义路由"重写"系统路由的 `/rest/v1` / `/auth/v1`，那会与系统路由争抢同一 `path` 前缀，排序由 `priority` 决定，容易产生不可预期的覆盖。

## 排查

- 自定义路由不生效：先 `GET /gateway/routes` 确认 `enabled` 不是 `false`；再确认 `upstream` / `static_root` 二选一、`hosts` 命中实际请求的 Host 头。
- upsteam TLS 上游报证书错误：临时把 `upstream_tls_insecure_skip_verify` 设为 `true` 验证链路，再排查上游证书；生产环境避免长期开启。
- 路由被系统路由覆盖：提高该路由的 `priority`，或避开系统路由前缀。
- 校验失败导致 `/load` 拒绝：`persistAndLoad` 会抛 `Caddy config validation failed` 或 `Caddy /load failed with <status>`，错误信息会包含 Caddy 返回的具体原因。配置不会落盘，上一次成功的 JSON 仍然在 Caddy 内生效。
- 多 origin 正则不匹配：`cors` 中 `~` 开头的值会被当作正则；注意转义，且正则匹配的是整个 Origin 字符串。

## 参考

- README 的 *Caddy Gateway* 章节：运行模型与三大部署模式的启动来源。
- `docs/multi-tenant-management.md` 第 3.4 节：Caddy 多租户路由整体设计。
- `packages/management-api/src/services/gateway.service.ts`：JSON 渲染、Admin API `/load`、校验与落盘实现。
- `packages/management-api/src/routes/project-config.ts`：`gateway/routes`、`gateway/config`、`gateway/rate-limit` 的接口定义与 body schema。
