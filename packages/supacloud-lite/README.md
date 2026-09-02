# SupaCloud Lite

[中文](#中文) | [English](#english)

---

## 中文

SupaCloud Lite 是一个面向单项目部署的 Bun 原生 Supabase 兼容后端。它使用 PGlite 在进程内运行 PostgreSQL，并实现 Supabase 客户端依赖的 REST、Auth、Storage、Realtime 和 Edge Functions 协议。

V1 的目标不是复刻完整 Supabase 平台控制面，而是让现有应用在尽量少改代码的前提下，使用官方 `@supabase/supabase-js` 连接一个轻量、本地、无 Docker 的后端。

### 状态

- 运行时：npm 包需要 Bun 1.3+；单二进制发行版已内嵌 Bun 和 PGlite 资源
- 数据库：PGlite 0.5.4
- 项目模型：单进程、单项目，内部 project ref 固定为 `local`
- 客户端：直接使用官方 `@supabase/supabase-js`
- 数据目录：`.supacloud-lite/db`
- 对象存储：默认使用 `.supacloud-lite/storage`，也可切换为内存或远端 S3
- 密钥文件：`.supacloud-lite/secrets.json`，权限为 `0600`

### 快速开始

```bash
bun add @supacloud/lite
bunx supacloud-lite start
```

也可以从 GitHub Release 下载当前平台的 `supacloud-lite-*` 单二进制。该文件不需要预装 Bun、Node、npm 或 Docker：

```bash
chmod +x ./supacloud-lite-linux-x64
./supacloud-lite-linux-x64 start --project-dir /path/to/project
```

单二进制仍读取项目的 `supabase/` 目录，并在项目外部写入 `.supacloud-lite/` 持久化状态；它不包含 Web 控制台或 Supabase Studio。Linux x64/arm64、macOS x64/arm64 和 Windows x64 分别使用独立产物，不能跨操作系统或 CPU 架构混用。

获取匿名 key：

```bash
bunx supacloud-lite keys
```

仅在服务端确实需要绕过 RLS 时打印 `service_role` key：

```bash
bunx supacloud-lite keys --service-role
```

客户端代码无需切换到专有 SDK：

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPACLOUD_LITE_ANON_KEY!)

const { data, error } = await supabase.from('todos').select('*')
```

### 项目约定

SupaCloud Lite 直接读取现有 Supabase CLI 目录：

```text
supabase/
  config.toml
  migrations/*.sql
  seed.sql
  functions/<name>/index.ts
  functions/.env
  webhooks.json
```

`config.toml` 当前支持 Auth、API schema/max rows、Storage bucket/size limit、seed 和 function entrypoint 等常用配置。

#### Function 框架契约（Elysia / Hono）

Function 默认导出除 fetch 函数与 `Deno.serve()` 外，也支持框架路由器对象——Elysia 实例（`handle()`）与 Hono 应用（`fetch()`），与 SupaCloud Edge Runtime 的契约一致：

```ts
// functions/api/index.ts
import { Elysia } from 'elysia'

export default new Elysia()
  .get('/', () => ({ ok: true }))
  .get('/cases/:id', ({ params }) => params)
```

框架路由器按 function-local 路径接收请求（`/functions/v1/api/cases/42` → `/cases/42`），与生产 Edge Runtime 的 `toFunctionLocalUrl` 行为一致；普通 fetch 函数与不带 `routes` 的 `{ fetch }` 对象保持原有完整 URL 不变。也可在 `config.toml` 显式声明：

```toml
[functions.api]
framework = "elysia"   # fetch（默认）| elysia | hono
```

注意：浏览器预检（OPTIONS）会转发给框架应用，框架函数应自行挂载 CORS（如 `@elysiajs/cors`），与生产 Edge Runtime 行为一致。

#### Auth 运行方式

Lite 不下载、安装或启动独立的 GoTrue 进程。`/auth/v1/*` 由同一个 Bun 进程中的内置 Auth 实现处理，并与该 Lite 项目的 PGlite `auth` schema 共享生命周期；这避免了 sidecar 的配置、端口和会话一致性负担。

Auth 默认启用。如项目不需要客户端登录接口，可在 `supabase/config.toml` 中关闭该路由：

```toml
[auth]
enabled = false
```

关闭后 `/auth/v1/*` 返回 `404`，但不会把 Lite 变成完整 GoTrue 运行时，也不会自动移除已有的 `auth` schema 或 API key。需要完整 GoTrue 行为、多项目鉴权或独立鉴权进程时，应使用完整 SupaCloud 平台。

在 loopback 地址启动时，Lite 会启用兼容 `signInWithOtp({ phone })` / `verifyOtp({ type: 'sms' })` 的本地短信收件箱，可在 `/sms-inbox` 查看验证码。短信收件箱与邮件收件箱独立、内存有界，绑定到非 loopback 地址时绝不会挂载。网络暴露的嵌入式用法必须显式注入 `BackendConfig.smsSender`；Lite 没有会把验证码写入控制台的生产 fallback。

手机号必须是 E.164 格式。短信验证码在数据库中保存为域分离的 keyed-HMAC，单次兑换、最多五次错误、按可信连接 IP/手机号指纹限流，并默认对同一手机号执行 60 秒持久化发送冷却。自定义 sender 的异常只返回净化错误，不记录手机号、验证码、短信正文或供应商响应。

### CLI

```text
supacloud-lite start
supacloud-lite migrate
supacloud-lite status
supacloud-lite keys [--service-role]
supacloud-lite gen types [-o database.types.ts]
supacloud-lite db reset
supacloud-lite db diff [-f migration_name]
supacloud-lite db pull [migration_name]
supacloud-lite snapshot create [-o backup.tar.gz]
supacloud-lite snapshot restore <backup.tar.gz> [--force]
supacloud-lite upgrade [-o pre-upgrade.tar.gz]
supacloud-lite inspect
supacloud-lite doctor [--json]
supacloud-lite version
```

首次初始化或 state 目录不存在/为空时，先运行 `supacloud-lite migrate`。`db reset` 只接受已经初始化且保留有效 `secrets.json` 标记的 state；它不会为 reset 创建或覆盖项目 secrets。

通用参数：

- `--project-dir`：包含 `supabase/` 的项目目录
- `--host` / `--port`：监听地址和端口
- `--api-url`：对外 API URL，用于 Auth issuer、OAuth callback、邮件链接和 Functions 环境
- `--site-url`：前端站点 URL，用作 Auth 默认跳转目标
- `--state-dir`：Lite 状态根目录
- `--data-dir`：PGlite 数据目录
- `--storage-dir`：对象存储目录
- `--storage-backend`：`fs`、`memory` 或 `s3`
- `--s3-prefix`：远端 S3 对象 key 前缀
- `--memory`：使用内存数据库

环境变量：

- `SUPACLOUD_LITE_HOST`
- `SUPACLOUD_LITE_PORT`
- `SUPACLOUD_LITE_API_URL`
- `SUPACLOUD_LITE_SITE_URL`
- `SUPACLOUD_LITE_STATE_DIR`
- `SUPACLOUD_LITE_DATA_DIR`
- `SUPACLOUD_LITE_STORAGE_DIR`
- `SUPACLOUD_LITE_STORAGE_BACKEND`：`fs`（默认）、`memory` 或 `s3`
- `SUPACLOUD_LITE_S3_PREFIX`：S3 对象 key 前缀，可被 `--s3-prefix` 覆盖
- `SUPACLOUD_LITE_POSTGRES_MIRROR`：native 引擎下载 PostgreSQL 发布包时使用的 HTTPS 镜像前缀，例如 `https://ghproxy.net/`
- `SUPACLOUD_LITE_ENGINE`：`pglite`（默认）或 `native`
- `SUPACLOUD_LITE_REPLICATION_PROFILE`：仅支持显式值 `powersync`，且仅用于 native 引擎
- `SUPACLOUD_LITE_REPLICATION_HOST` / `SUPACLOUD_LITE_REPLICATION_PORT`：PowerSync 数据库监听地址和端口，默认 `127.0.0.1:54322`
- `SUPACLOUD_LITE_REPLICATION_ALLOW_CIDRS`：逗号分隔的 PowerSync 客户端 CIDR allowlist
- `SUPACLOUD_LITE_POWERSYNC_TABLES`：逗号分隔、带 schema 的 publication 表 allowlist
- `SUPACLOUD_LITE_POWERSYNC_PASSWORD`：独立 replication role 密码，至少 32 字符；不支持 CLI 密码参数
- `SUPACLOUD_LITE_REPLICATION_TLS_CERT_FILE` / `SUPACLOUD_LITE_REPLICATION_TLS_KEY_FILE`：非 loopback 监听必需
- `SUPACLOUD_LITE_JWT_SECRET`
- `SUPACLOUD_LITE_VAULT_KEY`

native 引擎首次运行会下载约 12 MB 的 Theseus PostgreSQL 发布包并缓存在 `~/.cache/supacloud-lite`。网络无法直连 GitHub 时，可设置镜像前缀；Lite 会把完整上游 URL 追加到该前缀，并在解压执行前继续校验固定或上游发布的 SHA-256。镜像不能包含 URL 凭据、query 或 fragment；除 loopback 测试地址外必须使用 HTTPS。

```bash
SUPACLOUD_LITE_POSTGRES_MIRROR=https://ghproxy.net/ supacloud-lite migrate --engine native
```

使用远端 S3 时，启动前设置 `SUPACLOUD_LITE_STORAGE_BACKEND=s3`，并按 Bun S3 约定提供 `S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_ENDPOINT`、`S3_REGION` 等变量；也支持对应的 `AWS_*` 变量。CLI 不接受密钥参数，避免凭据出现在进程列表中。

S3 模式下 `db reset` 会被拒绝，因为 Lite 不能把数据库元数据清理与远端对象删除做成原子操作；需要先明确处理远端 bucket/prefix，再切回本地或内存存储执行重置。

网络暴露时必须提供足够强的 JWT secret 和独立 vault key。默认生成的密钥适合单机项目；不要把 `.supacloud-lite/secrets.json` 提交到版本库。

### Windows 内嵌终端排障

Lite 需要 Bun 读取已安装的 `dist/cli.js`、项目配置和 PGlite WASM 文件。若在 TRAE 等 IDE 内嵌 PowerShell 中出现 `EPERM reading`，先在同一终端运行最小文件读取测试：

```powershell
Set-Content .\bun-read-test.js 'console.log("ok")'
bun .\bun-read-test.js
```

如果这个不含 Lite 的命令也返回 `EPERM`，故障发生在 Bun 启动应用之前，Lite 无法在应用代码内绕过宿主终端的文件访问限制。请切换到系统 PowerShell 或 Windows Terminal；随后升级到当前稳定版 Bun，并检查 IDE 沙箱、终端隔离和安全软件策略。`node` 能读取同一文件不代表 Bun 进程获得了相同的宿主权限。修复环境后再运行 `npx supacloud-lite --help` 验证。

若最小测试成功而 Lite 仍失败，请保留完整错误、`bun --version`、终端类型和项目路径，再提交 Lite 问题。不要为绕过 `EPERM` 放宽项目目录的全局 ACL。

### 升级、快照与恢复

生产或持久化环境升级时，必须先停止当前 Lite 进程。npm 安装先更新项目锁定的依赖，再运行受控升级命令：

```bash
# 明确指定目标版本；不要在生产启动命令中隐式使用 @latest
bun add @supacloud/lite@0.2.0

# 自动创建升级前快照，然后执行尚未应用的 supabase/migrations
bunx supacloud-lite upgrade
```

单二进制安装需要先下载并校验候选文件，再由候选二进制迁移现有项目：

```bash
./supacloud-lite-new version
./supacloud-lite-new upgrade --project-dir /path/to/project
./supacloud-lite-new start --project-dir /path/to/project
```

替换程序文件与数据库迁移是两个独立动作。`upgrade` 不会联网、自我替换二进制或修改 `package.json`；它默认先把升级前快照写入 `.supacloud-lite/backups/pre-upgrade-<timestamp>.tar.gz`，快照成功后才执行尚未记录的 migrations 和 seed。升级失败时快照会保留，并打印恢复命令。需要回滚时，停止候选进程，用升级前快照恢复状态，再重新启动上一个已验证版本。

旧版 Lite 曾在 `public` schema 中直接给 `anon`、`authenticated` 和 `service_role` 授予函数执行权。已有持久化项目可能仍保留这些 ACL 和默认 ACL。升级不会自动批量撤销，因为 PostgreSQL 不能可靠区分旧版 Lite 注入的权限与项目显式授权。升级后应先创建快照，再审计 `pg_proc.proacl` 和 `pg_default_acl`。如果确认三个角色的默认函数权限不是项目意图，请先在新 migration 中撤销它们，再为需要收紧的每个已有函数增加带完整签名的显式 `REVOKE` / `GRANT`。不要对整个 schema 的已有函数执行无差别 `REVOKE`。可丢弃的本地项目可以使用 `supacloud-lite db reset` 在新的默认权限上重放 migrations；仅重启旧状态不会清理历史 ACL。

```sql
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname, pg_get_function_identity_arguments(p.oid);

select defaclrole, defaclnamespace, defaclobjtype, defaclacl
from pg_default_acl;

alter default privileges in schema public
  revoke execute on functions from anon, authenticated, service_role;
```

也可以单独创建可移植快照：

```bash
# 使用默认文件名和目录
bunx supacloud-lite snapshot create

# 指定输出位置
bunx supacloud-lite snapshot create -o ./backups/project-a.tar.gz
```

快照是一个 gzip 压缩的 tar 文件，包含：

- PGlite 数据目录；
- `fs` 模式的对象文件；
- `secrets.json`，用于保持 JWT、会话和 Vault 解密兼容；
- 快照格式、Lite 版本和 Storage backend 清单。

快照包含敏感密钥，输出文件在 Unix 系统上会设置为 `0600`；仍应按数据库备份级别加密、限制访问并设置保留周期。创建快照前必须停止 Lite。若检测到数据目录锁，命令会拒绝继续；只有确认进程已退出后才能人工删除陈旧锁。

恢复到新项目或空状态目录：

```bash
bunx supacloud-lite snapshot restore ./backups/project-a.tar.gz
```

目标状态目录非空时默认拒绝覆盖。确认要替换现有状态时显式使用：

```bash
bunx supacloud-lite snapshot restore ./backups/project-a.tar.gz --force
```

`--force` 不会直接删除旧数据，而是把旧状态目录重命名为 `.supacloud-lite.restore-<id>` 形式的回滚副本，并在输出中打印完整路径。验证新状态后再由运维人员清理该目录。

使用自定义 `--state-dir`、`--data-dir` 或 `--storage-dir` 时，创建和恢复必须传入相同参数。数据库与 Storage 目录不得重叠，也不能指向文件系统根目录或符号链接。

S3 模式的快照只包含数据库中的 Storage 元数据和密钥，不复制远端对象，也不会读取或保存 S3 凭据。恢复时必须传入 `--storage-backend s3`，并重新提供原 bucket/prefix 的环境变量；跨 bucket 迁移仍需使用对象存储自身的复制工具。

内存数据库没有可持久化的数据，因此 `snapshot` 和 `upgrade` 会拒绝 `--memory`。

### 兼容范围

| 能力 | V1 状态 | 说明 |
| --- | --- | --- |
| `supabase.from()` | 已验证核心 | 自动测试覆盖 CRUD、过滤、RLS；嵌套关系、RPC 和高级 PostgREST 语法属于实验性兼容 |
| `supabase.auth` | 已验证核心 | 由内置 Auth 实现而非独立 GoTrue 进程提供；自动测试覆盖邮箱密码、会话和 bcrypt；OTP/Magic Link、匿名用户、OAuth、MFA 属于实验性兼容 |
| `supabase.storage` | 已验证核心 | 覆盖上传下载、列表、删除、TUS/RLS、远端 S3 驱动，以及 Bun.Image 的 `contain`/`fill`、格式和质量变换子集；`cover` 明确不支持 |
| `supabase.channel()` | 已验证核心 | 自动测试覆盖 `postgres_changes`、DELETE RLS 隔离和事件快照校验；Broadcast、Presence 属于实验性兼容 |
| `supabase.functions.invoke()` | 已验证核心 | 自动测试覆盖 Bun.build、`Deno.serve()`、公开函数和同进程重启 |
| Supabase Queues / PGMQ | 已验证核心 | 提供 `pgmq_public` 的 `send`、`send_batch`、`read`、`pop`、`archive`、`delete` RPC；队列数据持久化在项目数据库（PGlite 或 native PostgreSQL）中 |
| Edge Functions `SupaCloud.pgredis` | 已验证核心 | 提供单项目持久 KV、TTL、原子 `getset`/`getdel`；绑定只在当前函数请求内可用 |
| Supabase migrations | 支持 | 按文件名排序，记录到 `supabase_migrations` |
| PostgreSQL RLS | 支持 | 使用 `anon`、`authenticated`、`service_role` 数据库角色执行 |
| Maker-Checker SQL | 支持 | 参考 migration 在 PGlite/native 自动测试中覆盖角色分离、行版本、幂等、非法跃迁和只增审计 |
| Commands / Artifacts | 支持 | 与完整 SupaCloud 使用相同 SQL contract；PGlite/native 均通过 `@supacloud/js` 端到端测试 |
| Logical Replication / PowerSync source | 有条件支持 | PGlite 不支持；native 仅在显式 `powersync` profile 下支持，默认关闭 |
| PostgREST 完整线协议 | 部分支持 | 目标是常用 `supabase-js` 行为，不承诺所有 PostgREST 边角行为 |
| PostgreSQL 扩展 | 部分支持 | 仅支持 PGlite 内置或 Lite 模拟的扩展能力 |
| Supabase Studio | 不支持 | V1 不提供管理 UI |
| 多项目控制面 | 不支持 | V1 每个进程只运行一个项目，可通过多个进程部署多个项目 |

RLS 表的 Realtime DELETE 无法在行删除后安全重放 SELECT policy，因此 V1 只向 `service_role` 订阅者发送这类 DELETE 事件。普通用户仍可收到通过逐行 RLS 校验的 INSERT/UPDATE 事件。

### Capability doctor 与 PowerSync profile

`doctor` 输出 Lite 自己的稳定能力契约，不复制完整 Management API：

```bash
supacloud-lite doctor --json
```

默认 PGlite 输出会明确包含：

```json
{
  "engine": "pglite",
  "state_machine_sql": "supported",
  "durable_workflows": "supported",
  "commands": "supported",
  "artifacts": "supported",
  "postgrest_schema_config": "static",
  "logical_replication": "unsupported",
  "powersync_source": "unsupported"
}
```

PGlite 永远不伪造 WAL、publication 或 replication slot。单机现场 ELN 可以直接把 Lite 当作本地服务器；多设备离线同步应使用中央 SupaCloud + PowerSync，或由应用 outbox 把本地 Lite 数据推送到中央 SupaCloud。PowerSync 客户端本地数据库是 SQLite，与 Lite/PGlite 不是同一层能力。

Native Lite 默认仍使用 `wal_level=minimal`、关闭 WAL sender 并且不监听数据库 TCP。只有显式启用 profile 才配置有界 Logical Replication：

```bash
export SUPACLOUD_LITE_POWERSYNC_PASSWORD='<secret-store-value-at-least-32-characters>'
supacloud-lite migrate \
  --engine native \
  --replication-profile powersync \
  --powersync-tables public.eln_entries,public.eln_observations

supacloud-lite doctor --json \
  --engine native \
  --replication-profile powersync \
  --powersync-tables public.eln_entries,public.eln_observations
```

该 profile 使用独立 `supacloud_powersync` 登录角色、显式 `powersync` publication、`wal_level=logical`、4 个 sender、4 个 slot 和 `max_slot_wal_keep_size=1024MB`。默认只允许 loopback 上的 SCRAM 连接；非 loopback 监听必须同时提供 TLS 证书、权限受限的私钥和显式 CIDR allowlist。POSIX 平台要求私钥 mode 不向 group/other 开放；Windows 部署应通过文件 ACL 达到同等限制。

Lite 会创建或更新 replication role 与 publication allowlist，但**不会创建、删除或猜测 replication slot**。slot 由固定版本的 PowerSync 服务和运维流程持有。`doctor` 只读检查 WAL、sender/slot 容量、角色、publication、replica identity 和现有 slot 的滞留/失效状态。

### 从 Supabase 迁移

应用代码、SQL migrations、RLS policy、Storage 调用和 Realtime 订阅可以保持原来的 Supabase 形状。迁移时仍需验证以下边界：

1. 把现有 `supabase/migrations`、`config.toml`、Functions 和 seed 文件带到 Lite 项目。
2. 先用 `supacloud-lite migrate` 初始化空 state 并重放 schema；只有在已初始化的可丢弃 state 上需要再次重放时才使用 `supacloud-lite db reset`，然后导入业务数据。
3. 对使用 PGlite 未提供扩展或 PostgREST 高级语法的 SQL/API 做替代处理。
4. 通过真实 `@supabase/supabase-js` 集成测试验证关键查询、RLS、Storage 和 Realtime。

Lite 使用 Bun 原生 bcrypt，并兼容验证常见 GoTrue bcrypt 密码散列，因此经过映射的 `auth.users` 用户可保留密码。Auth 表结构、identity、refresh token 和 provider metadata 仍需通过受控迁移脚本转换；不要直接覆盖整个 `auth` schema。迁移后必须抽样验证登录，并为无法识别的散列准备密码重置流程。

### 队列与 Edge 缓存

Lite 在项目数据库（PGlite 或 native PostgreSQL）中提供 Supabase Queues 的公开 RPC façade。应用可以直接使用官方客户端的
`supabase.schema('pgmq_public').rpc(...)`，无需额外的队列进程：

```sql
-- 队列创建属于管理操作，应放在项目 migration 中，而不是匿名请求路径。
select pgmq.create('emails');
```

```ts
const queues = supabase.schema('pgmq_public')
const { data: ids } = await queues.rpc('send_batch', {
  queue_name: 'emails',
  messages: [{ to: 'user@example.com' }],
  sleep_seconds: 0,
})
const { data: messages } = await queues.rpc('read', {
  queue_name: 'emails',
  sleep_seconds: 60,
  n: 10,
})
```

Lite 的 `pgmq` 模拟层还提供 `set_vt`，支持直接 SQL 调整可见性超时。消息按 PGMQ 语义至少投递一次；`pop` 会立即删除消息，`archive` 是确认路径。`sleep_seconds` 和 visibility timeout 只控制消息何时可再次领取，不是消息 TTL；Lite/PGMQ 不提供逐消息到期删除语义。队列创建、指标、purge、设置和管理 API 不属于 Lite 的公开 RPC façade，仍需由项目 SQL 或完整 SupaCloud 控制面处理。
队列名遵循标准版的 1-128 位小写字母、数字、下划线和短横线规则，并且必须以字母或数字开头；Lite 会安全映射超出 PostgreSQL 63-byte 标识符上限的名称，避免截断后串队。默认 Data API 暴露 `public` 和 `pgmq_public`；如果显式设置 `dbSchemas`，Lite 会严格使用该列表，需要队列 RPC 时应把 `pgmq_public` 明确加入。
Durable workflow 的 run、step、event 和内部队列也保存在同一项目数据库中，可跨进程重启恢复；内部 workflow 队列不会通过 `pgmq_public` 暴露给 Data API 角色。Workflow 提供重试、取消和 dead-letter 失败原语，但不会自动执行 Saga 补偿；补偿步骤及其幂等性仍由应用工作流显式定义。

Edge Function 内可使用 `globalThis.SupaCloud.pgredis`：

```ts
const cache = globalThis.SupaCloud.pgredis
await cache.set('welcome:user:42', { rendered: true }, 60_000)
const value = await cache.get<{ rendered: boolean }>('welcome:user:42')
```

缓存实现使用项目自己的 PGlite 表，支持 `get`、`set`、`delete`、`ttl`、原子 `getset` 和原子 `getdel`。这里的 TTL 只作用于 pgredis 缓存键，不会改变消息队列的生命周期。默认边界与标准版一致：key 最长 512 个字符、JSON 值最大 1,048,576 bytes、TTL 最大 31,536,000,000ms。有 TTL 的值在读取时会惰性清理，Lite 的 retention sweeper 还会周期性删除过期行；文件数据库会跨重启保留缓存，`--memory` 数据库则随进程退出丢失。绑定按函数请求和项目隔离，函数返回后启动的 detached Promise 不能继续访问它；Lite 不提供跨项目共享、Redis 协议、队列或限流能力。
Lite 的缓存调用是进程内数据库操作，不具备标准版跨进程 HTTP binding 的超时和请求中止传播；不要在同一 JavaScript 进程中混合加载 Lite 与标准 Edge Runtime，两者都拥有全局 `SupaCloud` binding，Lite 检测到已有其他实现时会拒绝启动。

### 多项目

V1 不在一个进程内复用多个 PGlite 项目。需要多个项目时，为每个项目配置独立的工作目录、端口和 `.supacloud-lite` 状态目录，并用进程管理器分别启动。这样可保持数据库、JWT、Storage 和 Realtime 的故障域隔离。

### 资源边界

PGlite 是 WebAssembly PostgreSQL，不是 SQLite。它换来了 PostgreSQL SQL、角色、RLS 和 Supabase 迁移兼容性，但内存占用通常高于 PocketBase/SQLite。生产部署前应按真实 schema、并发和 Realtime 负载做容量测试。

npm 包继续通过依赖目录加载 PGlite。GitHub Release 的平台单二进制则内嵌 Bun、PGlite JS、核心 WASM/data 和 Lite 使用的 contrib 扩展；启动时会把扩展压缩包释放到受限的临时目录，PGlite 初始化完成后立即清理。项目配置、Functions、数据库、对象存储和密钥仍保持外置。

### API

```ts
import { createProjectBackend, startProjectServer } from '@supacloud/lite'

const running = await startProjectServer({
  projectDir: process.cwd(),
  host: '127.0.0.1',
  port: 54321,
  storageBackend: 's3',
})

await running.close()
```

图片变换目前提供 Bun.Image 的兼容子集：`width`、`height`、`resize=fill|contain`，以及 `format=origin|jpeg|png|webp` 和 JPEG/WebP `quality`。`resize=cover` 需要裁剪能力，当前 Bun 运行时没有对应 API，因此会明确返回不支持错误，不会错误地把图片拉伸成 `cover`。

也可以使用 `createLiteBackend()` 直接创建内存或自定义目录的嵌入式后端，并把它的 `fetch` 传给自定义宿主。

### 来源与许可

协议实现派生并精简自一个采用 MIT 许可的上游协议实现；PGlite 使用 Apache-2.0。完整说明见 `THIRD_PARTY_NOTICES.md` 和 `LICENSES/`。

---

## English

SupaCloud Lite is a Bun-native, Supabase-compatible backend designed for single-project deployments. It runs PostgreSQL in-process using PGlite and implements the REST, Auth, Storage, Realtime, and Edge Functions protocols that the Supabase client relies on.

The goal of V1 is not to replicate the full Supabase platform control plane, but to let existing applications connect to a lightweight, local, Docker-free backend using the official `@supabase/supabase-js` with minimal code changes.

### Status

- Runtime: the npm package requires Bun 1.3+; the single-binary release embeds Bun and PGlite assets
- Database: PGlite 0.5.4
- Project model: single process, single project, with an internal project ref fixed as `local`
- Client: uses the official `@supabase/supabase-js` directly
- Data directory: `.supacloud-lite/db`
- Object storage: defaults to `.supacloud-lite/storage`, can also be switched to memory or remote S3
- Secrets file: `.supacloud-lite/secrets.json`, with permissions `0600`

### Quick Start

```bash
bun add @supacloud/lite
bunx supacloud-lite start
```

You can also download the `supacloud-lite-*` single binary for your current platform from the GitHub Release. This file does not require Bun, Node, npm, or Docker to be pre-installed:

```bash
chmod +x ./supacloud-lite-linux-x64
./supacloud-lite-linux-x64 start --project-dir /path/to/project
```

The single binary still reads the project's `supabase/` directory and writes `.supacloud-lite/` persistent state outside the project; it does not include a web console or Supabase Studio. Linux x64/arm64, macOS x64/arm64, and Windows x64 use separate artifacts and cannot be mixed across operating systems or CPU architectures.

Get the anon key:

```bash
bunx supacloud-lite keys
```

Print the `service_role` key only when the server side genuinely needs to bypass RLS:

```bash
bunx supacloud-lite keys --service-role
```

Client code does not need to switch to a proprietary SDK:

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPACLOUD_LITE_ANON_KEY!)

const { data, error } = await supabase.from('todos').select('*')
```

### Project Conventions

SupaCloud Lite reads the existing Supabase CLI directory directly:

```text
supabase/
  config.toml
  migrations/*.sql
  seed.sql
  functions/<name>/index.ts
  functions/.env
  webhooks.json
```

`config.toml` currently supports common configuration such as Auth, API schema/max rows, Storage bucket/size limit, seed, and function entrypoint.

#### How Auth Works

Lite does not download, install, or start a standalone GoTrue process. `/auth/v1/*` is handled by a built-in Auth implementation in the same Bun process, sharing its lifecycle with that Lite project's PGlite `auth` schema; this avoids the configuration, port, and session-consistency burden of a sidecar.

Auth is enabled by default. If your project does not need a client login interface, you can disable this route in `supabase/config.toml`:

```toml
[auth]
enabled = false
```

When disabled, `/auth/v1/*` returns `404`, but this does not turn Lite into a full GoTrue runtime, nor does it automatically remove the existing `auth` schema or API keys. When you need full GoTrue behavior, multi-project authentication, or a standalone authentication process, use the full SupaCloud platform.

When bound to loopback, Lite enables a local SMS inbox compatible with `signInWithOtp({ phone })` / `verifyOtp({ type: 'sms' })`; open `/sms-inbox` to inspect codes. The SMS inbox is independent from email, memory-bounded, and never mounted on a network-exposed bind. Embedded network deployments must inject `BackendConfig.smsSender`; there is no production console fallback for OTP bodies.

Phone numbers must use E.164. SMS codes are stored as domain-separated keyed HMACs, are single-use, burn after five wrong attempts, and are limited by trusted connection IP plus a keyed phone fingerprint, with a persistent 60-second per-phone send cooldown by default. Provider failures are sanitized and never log the phone, code, SMS body, or raw provider response.

### CLI

```text
supacloud-lite start
supacloud-lite migrate
supacloud-lite status
supacloud-lite keys [--service-role]
supacloud-lite gen types [-o database.types.ts]
supacloud-lite db reset
supacloud-lite db diff [-f migration_name]
supacloud-lite db pull [migration_name]
supacloud-lite snapshot create [-o backup.tar.gz]
supacloud-lite snapshot restore <backup.tar.gz> [--force]
supacloud-lite upgrade [-o pre-upgrade.tar.gz]
supacloud-lite inspect
supacloud-lite doctor [--json]
supacloud-lite version
```

Run `supacloud-lite migrate` first when initializing a project or when the state directory is missing or empty. `db reset` only accepts initialized state with a valid `secrets.json` marker; it never creates or replaces project secrets for a reset.

Common flags:

- `--project-dir`: the project directory containing `supabase/`
- `--host` / `--port`: listen address and port
- `--api-url`: public API URL, used for Auth issuer, OAuth callback, email links, and Functions environment
- `--site-url`: frontend site URL, used as the default Auth redirect target
- `--state-dir`: Lite state root directory
- `--data-dir`: PGlite data directory
- `--storage-dir`: object storage directory
- `--storage-backend`: `fs`, `memory`, or `s3`
- `--s3-prefix`: remote S3 object key prefix
- `--memory`: use an in-memory database

Environment variables:

- `SUPACLOUD_LITE_HOST`
- `SUPACLOUD_LITE_PORT`
- `SUPACLOUD_LITE_API_URL`
- `SUPACLOUD_LITE_SITE_URL`
- `SUPACLOUD_LITE_STATE_DIR`
- `SUPACLOUD_LITE_DATA_DIR`
- `SUPACLOUD_LITE_STORAGE_DIR`
- `SUPACLOUD_LITE_STORAGE_BACKEND`: `fs` (default), `memory`, or `s3`
- `SUPACLOUD_LITE_S3_PREFIX`: S3 object key prefix, can be overridden by `--s3-prefix`
- `SUPACLOUD_LITE_POSTGRES_MIRROR`: HTTPS prefix used to proxy native-engine PostgreSQL release downloads, for example `https://ghproxy.net/`
- `SUPACLOUD_LITE_ENGINE`: `pglite` (default) or `native`
- `SUPACLOUD_LITE_REPLICATION_PROFILE`: explicit `powersync` opt-in for the native engine only
- `SUPACLOUD_LITE_REPLICATION_HOST` / `SUPACLOUD_LITE_REPLICATION_PORT`: PowerSync database listener, default `127.0.0.1:54322`
- `SUPACLOUD_LITE_REPLICATION_ALLOW_CIDRS`: comma-separated PowerSync client CIDR allowlist
- `SUPACLOUD_LITE_POWERSYNC_TABLES`: comma-separated schema-qualified publication table allowlist
- `SUPACLOUD_LITE_POWERSYNC_PASSWORD`: dedicated replication-role password of at least 32 characters; no CLI password flag is provided
- `SUPACLOUD_LITE_REPLICATION_TLS_CERT_FILE` / `SUPACLOUD_LITE_REPLICATION_TLS_KEY_FILE`: required for non-loopback listeners
- `SUPACLOUD_LITE_JWT_SECRET`
- `SUPACLOUD_LITE_VAULT_KEY`

On its first run, the native engine downloads an approximately 12 MB Theseus PostgreSQL release into `~/.cache/supacloud-lite`. If GitHub is not directly reachable, set a mirror prefix; Lite appends the complete upstream URL and still verifies the pinned or published SHA-256 before extracting or executing the archive. The mirror must not contain URL credentials, a query, or a fragment, and must use HTTPS except for loopback test endpoints.

```bash
SUPACLOUD_LITE_POSTGRES_MIRROR=https://ghproxy.net/ supacloud-lite migrate --engine native
```

When using remote S3, set `SUPACLOUD_LITE_STORAGE_BACKEND=s3` before starting, and provide variables such as `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, and `S3_REGION` according to Bun S3 conventions; the corresponding `AWS_*` variables are also supported. The CLI does not accept secret parameters to avoid credentials appearing in the process list.

In S3 mode, `db reset` is rejected because Lite cannot make database metadata cleanup and remote object deletion an atomic operation; you must explicitly handle the remote bucket/prefix first, then switch back to local or memory storage to perform the reset.

When exposed to the network, you must provide a sufficiently strong JWT secret and an independent vault key. The default generated keys are suitable for single-machine projects; do not commit `.supacloud-lite/secrets.json` to version control.

### Windows Embedded Terminal Troubleshooting

Lite requires Bun to read the installed `dist/cli.js`, project configuration, and PGlite WASM files. If you encounter `EPERM reading` in an IDE-embedded PowerShell such as TRAE, first run a minimal file read test in the same terminal:

```powershell
Set-Content .\bun-read-test.js 'console.log("ok")'
bun .\bun-read-test.js
```

If this command, which does not involve Lite, also returns `EPERM`, the failure occurs before Bun starts the application, and Lite cannot work around the host terminal's file access restrictions within application code. Switch to the system PowerShell or Windows Terminal; then upgrade to the current stable version of Bun, and check the IDE sandbox, terminal isolation, and security software policies. The fact that `node` can read the same file does not mean the Bun process has the same host permissions. After fixing the environment, run `npx supacloud-lite --help` to verify.

If the minimal test succeeds but Lite still fails, keep the full error, `bun --version`, terminal type, and project path, then submit a Lite issue. Do not loosen the global ACL of the project directory to work around `EPERM`.

### Upgrade, Snapshot, and Restore

When upgrading a production or persistent environment, you must stop the current Lite process first. For npm installs, update the project's locked dependency first, then run the controlled upgrade command:

```bash
# Specify the target version explicitly; do not implicitly use @latest in production startup commands
bun add @supacloud/lite@0.2.0

# Automatically create a pre-upgrade snapshot, then apply any pending supabase/migrations
bunx supacloud-lite upgrade
```

For single-binary installs, download and verify the candidate file first, then have the candidate binary migrate the existing project:

```bash
./supacloud-lite-new version
./supacloud-lite-new upgrade --project-dir /path/to/project
./supacloud-lite-new start --project-dir /path/to/project
```

Replacing the program file and migrating the database are two separate actions. `upgrade` does not go online, self-replace the binary, or modify `package.json`; it first writes a pre-upgrade snapshot to `.supacloud-lite/backups/pre-upgrade-<timestamp>.tar.gz` by default, and only after the snapshot succeeds does it apply the unrecorded migrations and seed. If the upgrade fails, the snapshot is retained and a restore command is printed. To roll back, stop the candidate process, restore state from the pre-upgrade snapshot, and restart the last verified version.

Older Lite versions directly granted function execution in the `public` schema to `anon`, `authenticated`, and `service_role`. Existing persistent projects may retain those ACLs and default ACLs. Upgrades do not revoke them in bulk because PostgreSQL cannot reliably distinguish an old Lite-injected grant from an intentional project grant. After taking a snapshot, audit `pg_proc.proacl` and `pg_default_acl`. If the three roles' default function privileges are not project intent, revoke them in a new migration, then add an explicit `REVOKE` / `GRANT` with the complete signature for each existing function that needs tighter access. Do not issue an indiscriminate schema-wide `REVOKE` against existing functions. Disposable local projects can use `supacloud-lite db reset` to replay migrations on the corrected defaults; merely restarting an old state does not remove historical ACLs.

```sql
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname, pg_get_function_identity_arguments(p.oid);

select defaclrole, defaclnamespace, defaclobjtype, defaclacl
from pg_default_acl;

alter default privileges in schema public
  revoke execute on functions from anon, authenticated, service_role;
```

You can also create a portable snapshot separately:

```bash
# Use the default filename and directory
bunx supacloud-lite snapshot create

# Specify the output location
bunx supacloud-lite snapshot create -o ./backups/project-a.tar.gz
```

A snapshot is a gzip-compressed tar file containing:

- the PGlite data directory;
- object files in `fs` mode;
- `secrets.json`, to keep JWT, session, and Vault decryption compatible;
- a manifest of the snapshot format, Lite version, and Storage backend.

Snapshots contain sensitive secrets; the output file is set to `0600` on Unix systems. You should still encrypt, restrict access to, and set a retention period for it at the database backup level. Lite must be stopped before creating a snapshot. If a data directory lock is detected, the command refuses to proceed; a stale lock can only be deleted manually after confirming the process has exited.

Restore to a new project or an empty state directory:

```bash
bunx supacloud-lite snapshot restore ./backups/project-a.tar.gz
```

When the target state directory is non-empty, overwriting is rejected by default. To explicitly replace the existing state, use:

```bash
bunx supacloud-lite snapshot restore ./backups/project-a.tar.gz --force
```

`--force` does not directly delete old data; instead, it renames the old state directory to a rollback copy in the form `.supacloud-lite.restore-<id>` and prints the full path in the output. Operators should clean up that directory only after verifying the new state.

When using custom `--state-dir`, `--data-dir`, or `--storage-dir`, the same arguments must be passed for both create and restore. The database and Storage directories must not overlap, nor can they point to the filesystem root or symbolic links.

Snapshots in S3 mode only contain the Storage metadata and secrets in the database; they do not copy remote objects, nor do they read or save S3 credentials. When restoring, you must pass `--storage-backend s3` and re-provide the environment variables for the original bucket/prefix; cross-bucket migration still requires the object storage's own replication tool.

In-memory databases have no persistable data, so `snapshot` and `upgrade` reject `--memory`.

### Compatibility Scope

| Capability | V1 Status | Notes |
| --- | --- | --- |
| `supabase.from()` | Verified core | Automated tests cover CRUD, filtering, and RLS; nested relations, RPC, and advanced PostgREST syntax are experimentally compatible |
| `supabase.auth` | Verified core | Provided by the built-in Auth implementation rather than a standalone GoTrue process; automated tests cover email/password, sessions, and bcrypt; OTP/Magic Link, anonymous users, OAuth, and MFA are experimentally compatible |
| `supabase.storage` | Verified core | Covers upload/download, list, delete, TUS/RLS, remote S3 driver, and a subset of Bun.Image `contain`/`fill`, format, and quality transforms; `cover` is explicitly unsupported |
| `supabase.channel()` | Verified core | Automated tests cover `postgres_changes`, DELETE RLS isolation, and event snapshot validation; Broadcast and Presence are experimentally compatible |
| `supabase.functions.invoke()` | Verified core | Automated tests cover Bun.build, `Deno.serve()`, public functions, and in-process restart |
| Supabase Queues / PGMQ | Verified core | Provides `send`, `send_batch`, `read`, `pop`, `archive`, and `delete` RPCs for `pgmq_public`; queue data is persisted in the project database (PGlite or native PostgreSQL) |
| Edge Functions `SupaCloud.pgredis` | Verified core | Provides single-project persistent KV, TTL, and atomic `getset`/`getdel`; the binding is only available within the current function request |
| Supabase migrations | Supported | Sorted by filename, recorded in `supabase_migrations` |
| PostgreSQL RLS | Supported | Executed using the `anon`, `authenticated`, and `service_role` database roles |
| Maker-Checker SQL | Supported | The reference migration is tested on PGlite/native for role separation, row versions, idempotency, illegal transitions, and append-only audit |
| Commands / Artifacts | Supported | Uses the same SQL contract as full SupaCloud; PGlite/native are both exercised end-to-end through `@supacloud/js` |
| Logical Replication / PowerSync source | Conditional | PGlite is unsupported; native requires the explicit `powersync` profile and remains disabled by default |
| Full PostgREST wire protocol | Partial | Targets common `supabase-js` behavior; does not promise all PostgREST edge-case behavior |
| PostgreSQL extensions | Partial | Only supports extensions built into PGlite or emulated by Lite |
| Supabase Studio | Not supported | V1 does not provide an admin UI |
| Multi-project control plane | Not supported | V1 runs only one project per process; multiple projects can be deployed via multiple processes |

Realtime DELETE on RLS tables cannot safely replay SELECT policies after a row is deleted, so V1 only sends such DELETE events to `service_role` subscribers. Regular users can still receive INSERT/UPDATE events that pass row-by-row RLS validation.

### Capability doctor and PowerSync profile

`supacloud-lite doctor --json` reports a stable Lite capability contract without copying the full Management API. PGlite explicitly reports Logical Replication and PowerSync source support as `unsupported`; it never emulates WAL, publications, or slots. Multi-device offline deployments should use central SupaCloud + PowerSync, while a single field workstation can use Lite as a local project server or upload through an application-owned outbox.

Native Lite keeps `wal_level=minimal`, WAL senders, and database TCP disabled by default. The explicit profile enables bounded Logical Replication:

```bash
export SUPACLOUD_LITE_POWERSYNC_PASSWORD='<secret-store-value-at-least-32-characters>'
supacloud-lite migrate --engine native --replication-profile powersync \
  --powersync-tables public.eln_entries,public.eln_observations
supacloud-lite doctor --json --engine native --replication-profile powersync \
  --powersync-tables public.eln_entries,public.eln_observations
```

The profile manages the dedicated `supacloud_powersync` login role and explicit `powersync` publication, with four WAL senders, four slots, and `max_slot_wal_keep_size=1024MB`. It uses loopback SCRAM by default; non-loopback listeners require TLS files and explicit CIDRs. POSIX systems reject group/other-readable private keys; Windows deployments must enforce the equivalent file ACL. Lite never creates or deletes a replication slot. PowerSync and the operator remain responsible for the exact slot lifecycle.

### Migrating from Supabase

Application code, SQL migrations, RLS policies, Storage calls, and Realtime subscriptions can keep their original Supabase shape. When migrating, you still need to validate the following boundaries:

1. Bring the existing `supabase/migrations`, `config.toml`, Functions, and seed files into the Lite project.
2. Use `supacloud-lite migrate` to initialize empty state and replay the schema. Use `supacloud-lite db reset` only when replaying an already initialized disposable state, then import business data.
3. Provide alternatives for SQL/API that use extensions not offered by PGlite or advanced PostgREST syntax.
4. Verify key queries, RLS, Storage, and Realtime through real `@supabase/supabase-js` integration tests.

Lite uses Bun's native bcrypt and is compatible with validating common GoTrue bcrypt password hashes, so mapped `auth.users` users can keep their passwords. Auth table structure, identity, refresh tokens, and provider metadata still need to be converted via a controlled migration script; do not directly overwrite the entire `auth` schema. After migration, you must sample-verify logins and prepare a password reset flow for unrecognized hashes.

### Queues and Edge Cache

Lite provides a public RPC façade for Supabase Queues in the project database (PGlite or native PostgreSQL). Applications can directly use the official client's
`supabase.schema('pgmq_public').rpc(...)` without an additional queue process:

```sql
-- Queue creation is an administrative operation and should be placed in a project migration, not in the anonymous request path.
select pgmq.create('emails');
```

```ts
const queues = supabase.schema('pgmq_public')
const { data: ids } = await queues.rpc('send_batch', {
  queue_name: 'emails',
  messages: [{ to: 'user@example.com' }],
  sleep_seconds: 0,
})
const { data: messages } = await queues.rpc('read', {
  queue_name: 'emails',
  sleep_seconds: 60,
  n: 10,
})
```

Lite's `pgmq` emulation layer also provides `set_vt`, allowing direct SQL adjustment of visibility timeouts. Messages are delivered at least once according to PGMQ semantics; `pop` deletes the message immediately, and `archive` is the acknowledgment path. `sleep_seconds` and visibility timeouts only control when a message can be claimed again; they are not message TTLs, and Lite/PGMQ does not provide per-message expiry deletion semantics. Queue creation, metrics, purge, settings, and management APIs are not part of Lite's public RPC façade and must still be handled by project SQL or the full SupaCloud control plane.
Queue names follow the standard 1-128 character lowercase letter, digit, underscore, and hyphen rule, and must start with a letter or digit; Lite safely maps names that exceed PostgreSQL's 63-byte identifier limit to avoid cross-queue collisions after truncation. The default Data API exposes `public` and `pgmq_public`; if `dbSchemas` is set explicitly, Lite uses that list strictly, and `pgmq_public` should be explicitly included when queue RPCs are needed.
Durable workflow runs, steps, events, and the internal queue are stored in the same project database and survive process restarts. Data API roles cannot access the internal workflow queue through `pgmq_public`. Workflow retry, cancellation, and dead-letter operations are failure primitives, not automatic Saga compensation; applications must define compensation steps and their idempotency explicitly.

Within an Edge Function, you can use `globalThis.SupaCloud.pgredis`:

```ts
const cache = globalThis.SupaCloud.pgredis
await cache.set('welcome:user:42', { rendered: true }, 60_000)
const value = await cache.get<{ rendered: boolean }>('welcome:user:42')
```

The cache implementation uses the project's own PGlite tables and supports `get`, `set`, `delete`, `ttl`, atomic `getset`, and atomic `getdel`. This TTL applies only to pgredis cache keys and does not change queue message lifecycles. The default boundaries are consistent with the standard version: keys up to 512 characters, JSON values up to 1,048,576 bytes, and TTLs up to 31,536,000,000ms. Values with a TTL are lazily cleaned up on read, and Lite's retention sweeper periodically deletes expired rows; the file database retains the cache across restarts, while the `--memory` database loses it when the process exits. The binding is isolated by function request and by project; detached Promises started after the function returns cannot continue to access it; Lite does not provide cross-project sharing, a Redis protocol, queues, or rate-limiting capabilities.
Lite's cache calls are in-process database operations and do not have the timeout and request-abort propagation of the standard version's cross-process HTTP binding; do not mix loading Lite and the standard Edge Runtime in the same JavaScript process, as both own the global `SupaCloud` binding, and Lite will refuse to start if it detects that another implementation is already present.

### Multiple Projects

V1 does not multiplex multiple PGlite projects within a single process. When multiple projects are needed, configure an independent working directory, port, and `.supacloud-lite` state directory for each project, and start them separately with a process manager. This keeps the database, JWT, Storage, and Realtime failure domains isolated.

### Resource Boundaries

PGlite is WebAssembly PostgreSQL, not SQLite. It trades off for PostgreSQL SQL, roles, RLS, and Supabase migration compatibility, but its memory footprint is typically higher than PocketBase/SQLite. Before production deployment, you should perform capacity testing against the real schema, concurrency, and Realtime load.

The npm package continues to load PGlite through the dependency directory. The platform single binary from the GitHub Release embeds Bun, PGlite JS, core WASM/data, and the contrib extensions used by Lite; on startup, it extracts the extension archives to a restricted temporary directory and cleans them up immediately after PGlite initialization. Project configuration, Functions, database, object storage, and secrets remain external.

### API

```ts
import { createProjectBackend, startProjectServer } from '@supacloud/lite'

const running = await startProjectServer({
  projectDir: process.cwd(),
  host: '127.0.0.1',
  port: 54321,
  storageBackend: 's3',
})

await running.close()
```

Image transforms currently provide a compatible subset of Bun.Image: `width`, `height`, `resize=fill|contain`, as well as `format=origin|jpeg|png|webp` and JPEG/WebP `quality`. `resize=cover` requires cropping capability, which the current Bun runtime does not have a corresponding API for, so it explicitly returns an unsupported error instead of incorrectly stretching the image to `cover`.

You can also use `createLiteBackend()` to directly create an embedded backend with an in-memory or custom directory, and pass its `fetch` to a custom host.

### Provenance and License

The protocol implementation is derived and slimmed down from an MIT-licensed upstream protocol implementation; PGlite uses Apache-2.0. See `THIRD_PARTY_NOTICES.md` and `LICENSES/` for full details.
