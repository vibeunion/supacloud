# SupaCloud Lite

SupaCloud Lite 是一个面向单项目部署的 Bun 原生 Supabase 兼容后端。它使用 PGlite 在进程内运行 PostgreSQL，并实现 Supabase 客户端依赖的 REST、Auth、Storage、Realtime 和 Edge Functions 协议。

V1 的目标不是复刻完整 Supabase 平台控制面，而是让现有应用在尽量少改代码的前提下，使用官方 `@supabase/supabase-js` 连接一个轻量、本地、无 Docker 的后端。

## 状态

- 运行时：Bun 1.3+
- 数据库：PGlite 0.5.4
- 项目模型：单进程、单项目，内部 project ref 固定为 `local`
- 客户端：直接使用官方 `@supabase/supabase-js`
- 数据目录：`.supacloud-lite/db`
- 对象目录：`.supacloud-lite/storage`
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
- `--memory`：使用内存数据库

环境变量：

- `SUPACLOUD_LITE_HOST`
- `SUPACLOUD_LITE_PORT`
- `SUPACLOUD_LITE_API_URL`
- `SUPACLOUD_LITE_SITE_URL`
- `SUPACLOUD_LITE_STATE_DIR`
- `SUPACLOUD_LITE_DATA_DIR`
- `SUPACLOUD_LITE_STORAGE_DIR`
- `SUPACLOUD_LITE_JWT_SECRET`
- `SUPACLOUD_LITE_VAULT_KEY`

网络暴露时必须提供足够强的 JWT secret 和独立 vault key。默认生成的密钥适合单机项目；不要把 `.supacloud-lite/secrets.json` 提交到版本库。

## 兼容范围

| 能力 | V1 状态 | 说明 |
| --- | --- | --- |
| `supabase.from()` | 支持 | CRUD、过滤、排序、分页、嵌套关系、RPC 和 RLS |
| `supabase.auth` | 支持 | 邮箱密码、会话、OTP/Magic Link、匿名用户、OAuth、MFA 子集 |
| `supabase.storage` | 支持 | Bucket、上传下载、列表、移动复制、签名 URL、TUS 子集；对象访问需显式 RLS policy |
| `supabase.channel()` | 支持 | Phoenix WebSocket、Broadcast、Presence、`postgres_changes` |
| `supabase.functions.invoke()` | 支持 | Bun.build 加载 TypeScript，兼容 `Deno.serve()` 常见写法 |
| Supabase migrations | 支持 | 按文件名排序，记录到 `supabase_migrations` |
| PostgreSQL RLS | 支持 | 使用 `anon`、`authenticated`、`service_role` 数据库角色执行 |
| PostgREST 完整线协议 | 部分支持 | 目标是常用 `supabase-js` 行为，不承诺所有 PostgREST 边角行为 |
| PostgreSQL 扩展 | 部分支持 | 仅支持 PGlite 内置或 Lite 模拟的扩展能力 |
| Supabase Studio | 不支持 | V1 不提供管理 UI |
| 多项目控制面 | 不支持 | V1 每个进程只运行一个项目，可通过多个进程部署多个项目 |

## 从 Supabase 迁移

应用代码、SQL migrations、RLS policy、Storage 调用和 Realtime 订阅可以保持原来的 Supabase 形状。迁移时仍需验证以下边界：

1. 把现有 `supabase/migrations`、`config.toml`、Functions 和 seed 文件带到 Lite 项目。
2. 用 `supacloud-lite db reset` 在空库重放 schema，再导入业务数据。
3. 对使用 PGlite 未提供扩展或 PostgREST 高级语法的 SQL/API 做替代处理。
4. 通过真实 `@supabase/supabase-js` 集成测试验证关键查询、RLS、Storage 和 Realtime。

Lite 使用 Bun 原生 bcrypt，并兼容验证常见 GoTrue bcrypt 密码散列，因此经过映射的 `auth.users` 用户可保留密码。Auth 表结构、identity、refresh token 和 provider metadata 仍需通过受控迁移脚本转换；不要直接覆盖整个 `auth` schema。迁移后必须抽样验证登录，并为无法识别的散列准备密码重置流程。

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
})

await running.close()
```

也可以使用 `createLiteBackend()` 直接创建内存或自定义目录的嵌入式后端，并把它的 `fetch` 传给自定义宿主。

## 来源与许可

协议实现派生并精简自 Tinbase，保留其 MIT 许可；PGlite 使用 Apache-2.0。完整说明见 `THIRD_PARTY_NOTICES.md` 和 `LICENSES/`。
