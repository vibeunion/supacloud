# SupaCloud Lite

SupaCloud Lite 是一个面向单项目部署的 Bun 原生 Supabase 兼容后端。它使用 PGlite 在进程内运行 PostgreSQL，并实现 Supabase 客户端依赖的 REST、Auth、Storage、Realtime 和 Edge Functions 协议。

V1 的目标不是复刻完整 Supabase 平台控制面，而是让现有应用在尽量少改代码的前提下，使用官方 `@supabase/supabase-js` 连接一个轻量、本地、无 Docker 的后端。

## 状态

- 运行时：Bun 1.3+
- 数据库：PGlite 0.5.4
- 项目模型：单进程、单项目，内部 project ref 固定为 `local`
- 客户端：直接使用官方 `@supabase/supabase-js`
- 数据目录：`.supacloud-lite/db`
- 对象存储：默认使用 `.supacloud-lite/storage`，也可切换为内存或远端 S3
- 密钥文件：`.supacloud-lite/secrets.json`，权限为 `0600`

## 快速开始

```bash
bun add @supacloud/lite
bunx supacloud-lite start
```

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

## 项目约定

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

### Auth 运行方式

Lite 不下载、安装或启动独立的 GoTrue 进程。`/auth/v1/*` 由同一个 Bun 进程中的内置 Auth 实现处理，并与该 Lite 项目的 PGlite `auth` schema 共享生命周期；这避免了 sidecar 的配置、端口和会话一致性负担。

Auth 默认启用。如项目不需要客户端登录接口，可在 `supabase/config.toml` 中关闭该路由：

```toml
[auth]
enabled = false
```

关闭后 `/auth/v1/*` 返回 `404`，但不会把 Lite 变成完整 GoTrue 运行时，也不会自动移除已有的 `auth` schema 或 API key。需要完整 GoTrue 行为、多项目鉴权或独立鉴权进程时，应使用完整 SupaCloud 平台。

## CLI

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
supacloud-lite version
```

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
- `SUPACLOUD_LITE_JWT_SECRET`
- `SUPACLOUD_LITE_VAULT_KEY`

使用远端 S3 时，启动前设置 `SUPACLOUD_LITE_STORAGE_BACKEND=s3`，并按 Bun S3 约定提供 `S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_ENDPOINT`、`S3_REGION` 等变量；也支持对应的 `AWS_*` 变量。CLI 不接受密钥参数，避免凭据出现在进程列表中。

S3 模式下 `db reset` 会被拒绝，因为 Lite 不能把数据库元数据清理与远端对象删除做成原子操作；需要先明确处理远端 bucket/prefix，再切回本地或内存存储执行重置。

网络暴露时必须提供足够强的 JWT secret 和独立 vault key。默认生成的密钥适合单机项目；不要把 `.supacloud-lite/secrets.json` 提交到版本库。

## Windows 内嵌终端排障

Lite 需要 Bun 读取已安装的 `dist/cli.js`、项目配置和 PGlite WASM 文件。若在 TRAE 等 IDE 内嵌 PowerShell 中出现 `EPERM reading`，先在同一终端运行最小文件读取测试：

```powershell
Set-Content .\bun-read-test.js 'console.log("ok")'
bun .\bun-read-test.js
```

如果这个不含 Lite 的命令也返回 `EPERM`，故障发生在 Bun 启动应用之前，Lite 无法在应用代码内绕过宿主终端的文件访问限制。请切换到系统 PowerShell 或 Windows Terminal；随后升级到当前稳定版 Bun，并检查 IDE 沙箱、终端隔离和安全软件策略。`node` 能读取同一文件不代表 Bun 进程获得了相同的宿主权限。修复环境后再运行 `npx supacloud-lite --help` 验证。

若最小测试成功而 Lite 仍失败，请保留完整错误、`bun --version`、终端类型和项目路径，再提交 Lite 问题。不要为绕过 `EPERM` 放宽项目目录的全局 ACL。

## 升级、快照与恢复

生产或持久化环境升级时，先更新项目锁定的 npm 依赖，再运行 Lite 的受控升级命令：

```bash
# 明确指定目标版本；不要在生产启动命令中隐式使用 @latest
bun add @supacloud/lite@0.2.0

# 自动创建升级前快照，然后执行尚未应用的 supabase/migrations
bunx supacloud-lite upgrade
```

`upgrade` 不会自行修改 `package.json` 或联网更新 npm 包。它使用当前项目已经安装并锁定的 Lite 版本，默认把升级前快照写入 `.supacloud-lite/backups/pre-upgrade-<timestamp>.tar.gz`，快照成功后才执行 migrations。升级失败时，快照会保留，并打印恢复命令。

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

## 兼容范围

| 能力 | V1 状态 | 说明 |
| --- | --- | --- |
| `supabase.from()` | 已验证核心 | 自动测试覆盖 CRUD、过滤、RLS；嵌套关系、RPC 和高级 PostgREST 语法属于实验性兼容 |
| `supabase.auth` | 已验证核心 | 由内置 Auth 实现而非独立 GoTrue 进程提供；自动测试覆盖邮箱密码、会话和 bcrypt；OTP/Magic Link、匿名用户、OAuth、MFA 属于实验性兼容 |
| `supabase.storage` | 已验证核心 | 覆盖上传下载、列表、删除、TUS/RLS、远端 S3 驱动，以及 Bun.Image 的 `contain`/`fill`、格式和质量变换子集；`cover` 明确不支持 |
| `supabase.channel()` | 已验证核心 | 自动测试覆盖 `postgres_changes`、DELETE RLS 隔离和事件快照校验；Broadcast、Presence 属于实验性兼容 |
| `supabase.functions.invoke()` | 已验证核心 | 自动测试覆盖 Bun.build、`Deno.serve()`、公开函数和同进程重启 |
| Supabase Queues / PGMQ | 已验证核心 | 提供 `pgmq_public` 的 `send`、`send_batch`、`read`、`pop`、`archive`、`delete` RPC；队列数据持久化在同一 PGlite 项目中 |
| Edge Functions `SupaCloud.pgredis` | 已验证核心 | 提供单项目持久 KV、TTL、原子 `getset`/`getdel`；绑定只在当前函数请求内可用 |
| Supabase migrations | 支持 | 按文件名排序，记录到 `supabase_migrations` |
| PostgreSQL RLS | 支持 | 使用 `anon`、`authenticated`、`service_role` 数据库角色执行 |
| PostgREST 完整线协议 | 部分支持 | 目标是常用 `supabase-js` 行为，不承诺所有 PostgREST 边角行为 |
| PostgreSQL 扩展 | 部分支持 | 仅支持 PGlite 内置或 Lite 模拟的扩展能力 |
| Supabase Studio | 不支持 | V1 不提供管理 UI |
| 多项目控制面 | 不支持 | V1 每个进程只运行一个项目，可通过多个进程部署多个项目 |

RLS 表的 Realtime DELETE 无法在行删除后安全重放 SELECT policy，因此 V1 只向 `service_role` 订阅者发送这类 DELETE 事件。普通用户仍可收到通过逐行 RLS 校验的 INSERT/UPDATE 事件。

## 从 Supabase 迁移

应用代码、SQL migrations、RLS policy、Storage 调用和 Realtime 订阅可以保持原来的 Supabase 形状。迁移时仍需验证以下边界：

1. 把现有 `supabase/migrations`、`config.toml`、Functions 和 seed 文件带到 Lite 项目。
2. 用 `supacloud-lite db reset` 在空库重放 schema，再导入业务数据。
3. 对使用 PGlite 未提供扩展或 PostgREST 高级语法的 SQL/API 做替代处理。
4. 通过真实 `@supabase/supabase-js` 集成测试验证关键查询、RLS、Storage 和 Realtime。

Lite 使用 Bun 原生 bcrypt，并兼容验证常见 GoTrue bcrypt 密码散列，因此经过映射的 `auth.users` 用户可保留密码。Auth 表结构、identity、refresh token 和 provider metadata 仍需通过受控迁移脚本转换；不要直接覆盖整个 `auth` schema。迁移后必须抽样验证登录，并为无法识别的散列准备密码重置流程。

## 队列与 Edge 缓存

Lite 在同一个 PGlite 数据库中提供 Supabase Queues 的公开 RPC façade。应用可以直接使用官方客户端的
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

Lite 的 `pgmq` 模拟层还提供 `set_vt`，支持直接 SQL 调整可见性超时。消息按 PGMQ 语义至少投递一次；`pop` 会立即删除消息，`archive` 是确认路径。队列创建、指标、purge、设置和管理 API 不属于 Lite 的公开 RPC façade，仍需由项目 SQL 或完整 SupaCloud 控制面处理。
队列名遵循标准版的 1-128 位小写字母、数字、下划线和短横线规则，并且必须以字母或数字开头；Lite 会安全映射超出 PostgreSQL 63-byte 标识符上限的名称，避免截断后串队。默认 Data API 暴露 `public` 和 `pgmq_public`；如果显式设置 `dbSchemas`，Lite 会严格使用该列表，需要队列 RPC 时应把 `pgmq_public` 明确加入。

Edge Function 内可使用 `globalThis.SupaCloud.pgredis`：

```ts
const cache = globalThis.SupaCloud.pgredis
await cache.set('welcome:user:42', { rendered: true }, 60_000)
const value = await cache.get<{ rendered: boolean }>('welcome:user:42')
```

缓存实现使用项目自己的 PGlite 表，支持 `get`、`set`、`delete`、`ttl`、原子 `getset` 和原子 `getdel`。默认边界与标准版一致：key 最长 512 个字符、JSON 值最大 1,048,576 bytes、TTL 最大 31,536,000,000ms。有 TTL 的值在读取时会惰性清理，Lite 的 retention sweeper 还会周期性删除过期行；文件数据库会跨重启保留缓存，`--memory` 数据库则随进程退出丢失。绑定按函数请求和项目隔离，函数返回后启动的 detached Promise 不能继续访问它；Lite 不提供跨项目共享、Redis 协议、队列或限流能力。
Lite 的缓存调用是进程内数据库操作，不具备标准版跨进程 HTTP binding 的超时和请求中止传播；不要在同一 JavaScript 进程中混合加载 Lite 与标准 Edge Runtime，两者都拥有全局 `SupaCloud` binding，Lite 检测到已有其他实现时会拒绝启动。

## 多项目

V1 不在一个进程内复用多个 PGlite 项目。需要多个项目时，为每个项目配置独立的工作目录、端口和 `.supacloud-lite` 状态目录，并用进程管理器分别启动。这样可保持数据库、JWT、Storage 和 Realtime 的故障域隔离。

## 资源边界

PGlite 是 WebAssembly PostgreSQL，不是 SQLite。它换来了 PostgreSQL SQL、角色、RLS 和 Supabase 迁移兼容性，但内存占用通常高于 PocketBase/SQLite。生产部署前应按真实 schema、并发和 Realtime 负载做容量测试。

当前 npm 包依赖 PGlite 的 WASM 资源，不承诺 Bun `--compile` 单文件二进制可直接携带全部资源。V1 推荐通过 Bun + npm 包部署。

## API

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

## 来源与许可

协议实现派生并精简自 Tinbase，保留其 MIT 许可；PGlite 使用 Apache-2.0。完整说明见 `THIRD_PARTY_NOTICES.md` 和 `LICENSES/`。
