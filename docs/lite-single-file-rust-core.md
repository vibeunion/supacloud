# Lite 单文件发行与 Rust Realtime 核心嵌入

状态：Lite 服务 Realtime 时只使用 Rust core。没有 TypeScript/Rust 实现模式，
也没有运行时开关；core 缺失、校验失败或 ABI 不匹配都会直接报错。
TypeScript 引擎仅作为 parity 测试的参考实现保留。

## 1. 目标与边界

目标：

- 用户只下载一个 `supacloud-lite` 可执行文件，不需要额外安装 Rust、动态库或 sidecar。
- Realtime 的协议与状态机在 Lite 与 Full SupaCloud 之间共享同一份 Rust 实现。
- PGlite、RLS 授权、JWT 校验、HTTP/WebSocket 生命周期继续由 Bun 持有。

非目标：

- 不把 PGlite 内部替换成 Rust/PostgreSQL。
- 不把完整 `postrust-server` 改造成 FFI 库。
- 不为 Lite 保留可切换的 TypeScript Realtime 运行时。

## 2. 为什么是“核心嵌入”而不是“整个服务嵌入”

完整 Rust Realtime 网关包含 Axum、Tokio、PostgreSQL CDC、租户注册表和
WebSocket 服务器。直接通过 FFI 启动它会把异步 runtime、回调和 Bun 事件循环
绑在一起，难以保证生命周期与崩溃隔离。

因此拆成两层：

```text
realtime-core (Rust cdylib, 无 I/O)
  ├─ Phoenix v1/v2 编解码
  ├─ postgres_changes 过滤匹配
  ├─ presence 状态
  └─ channel / broadcast / join 状态机

Bun Lite (宿主)
  ├─ WebSocket / HTTP
  ├─ PGlite 或 native PostgreSQL
  ├─ JWT 校验与 RLS 授权
  ├─ broadcast 持久化 / 跨实例转发
  └─ CDC 监听
```

Rust core 不依赖 Tokio、Axum、tokio-postgres 或 WebSocket，仅依赖
`serde` / `serde_json`。这让同一个 crate 可以同时被独立 Rust 网关和 Bun 复用。

## 3. ABI 契约

库文件：

| 平台 | 文件名 |
| --- | --- |
| macOS | `libsupacloud_realtime_core.dylib` |
| Linux | `libsupacloud_realtime_core.so` |
| Windows | `supacloud_realtime_core.dll` |

所有跨边界数据都是 UTF-8 JSON 字节或 opaque 指针，不传 Rust struct、
引用、future 或 Bun 对象。ABI 版本常量为 `1`，命令或响应结构变化时必须递增。

导出函数：

```c
uint32_t sc_realtime_core_abi_version(void);
ScSession *sc_realtime_core_new(const uint8_t *config, size_t len);
void sc_realtime_core_free(ScSession *session);
ScBuffer *sc_realtime_core_handle(ScSession *session, const uint8_t *req, size_t len);
const uint8_t *sc_realtime_core_buffer_data(const ScBuffer *buf);
size_t sc_realtime_core_buffer_len(const ScBuffer *buf);
void sc_realtime_core_buffer_free(ScBuffer *buf);
ScBuffer *sc_realtime_core_last_error(void);
```

约束：

- 每个输出 `ScBuffer` 只释放一次。
- panic 在 FFI 边界内被捕获，转换为 `last_error` 与空返回值，不会展开到 Bun。
- 空指针、非 UTF-8、非法 JSON 都返回明确错误，不静默忽略。

### 3.1 命令

```json
{"op":"frame","connection_id":"c1","frame": <Phoenix v1 对象或 v2 数组>}
{"op":"authorize_result","connection_id":"c1","request_id":"authz_1","read":true,"write":false}
{"op":"cdc","event":{"schema":"public","table":"todos","type":"INSERT","record":{}}}
{"op":"presence_state","connection_id":"c1","topic":"realtime:chat"}
{"op":"disconnect","connection_id":"c1"}
```

`frame` 同时接受两种 Phoenix 序列化，并按连接协商的版本回复。

### 3.2 响应

```json
{
  "frames": [{ "connection_id": "c1", "frame": ["1", "2", "realtime:room", "phx_reply", {}] }],
  "effects": [
    { "type": "authorize", "request_id": "authz_1", "connection_id": "c1", "topic": "realtime:secret", "join_ref": "1" },
    { "type": "broadcast", "topic": "realtime:room", "event": "cursor", "payload": {}, "private": false }
  ],
  "errors": []
}
```

- `frames`：宿主直接发送给对应连接。
- `effects.authorize`：宿主必须执行 `realtime.messages` 的 RLS 探测，然后回调
  `authorize_result`；core 在收到结果前不回复 join。
- `effects.broadcast`：本地 fan-out 已由 core 完成；宿主负责持久化或跨实例转发。

私有频道授权失败时，core 返回 `phx_reply` 错误并丢弃该 channel；不会静默降级为公共频道。

## 4. 资源生命周期与信任

优先级：

1. `SUPACLOUD_LITE_REALTIME_CORE` 显式路径。
2. standalone 内嵌资源。
3. 可执行文件同目录 `native/<library>`。
4. 开发环境 `crates/realtime-core/target/{release,debug}`。

内嵌资源加载流程：

1. 在系统临时目录创建 `0700` 私有目录。
2. 写出库文件，权限 `0700`。
3. 校验构建期 SHA-256；不匹配立即失败。
4. `dlopen` 并校验 ABI 版本。
5. 进程退出时清理；异常残留由后续启动回收。

任一步失败都抛出 `RealtimeCoreUnavailableError` 并列出所有查找位置。
**不允许**回退到未校验的二进制或另一套协议实现。

## 5. 构建与发行

```bash
# 构建 host 库并暂存到 dist/native
bun run build:realtime-core

# 构建并把库写入 embedded-core.ts，随后打包 standalone
bun run build:standalone:host

# 跳过嵌入（生成不含 Rust core 的二进制）
SUPACLOUD_LITE_SKIP_REALTIME_CORE=1 bun run build:standalone:host
```

`build:standalone:host` 会：

1. 调用 `cargo build --release` 生成 host 平台 cdylib。
2. 写入 `src/runtime/realtime/embedded-core.ts` 的静态导入与 SHA-256。
3. 执行 `Bun.build({ compile })`，让库成为单文件内嵌资源。
4. 在 `finally` 中恢复 `embedded-core.ts` 为 `null`，保持工作树干净。

每个 standalone 目标必须携带对应平台/架构的 cdylib：

- 与构建机同平台的目标直接 `cargo build`。
- 跨平台目标使用 `build:realtime-core --target <triple>` 在匹配平台预构建，
  再通过 `dist/native/<triple>/` 或 `SUPACLOUD_LITE_REALTIME_CORE_DIR` 暂存。
- 发布构建设置 `SUPACLOUD_LITE_REQUIRE_REALTIME_CORE=1`，缺少 core 时构建失败，
  不再产出运行期才失败的二进制。
- npm 发布会下载各平台预构建 core 到 `dist/native/<triple>/`，运行时按
  `platform-arch` 解析；没有调整 `prepack`，因此发布时跳过生命周期脚本，
  避免 `clean` 删除已暂存的 core。

### 5.1 运行时行为

```bash
# Realtime 使用内嵌 Rust core；missing core 会直接启动失败
supacloud-lite start
```

`migrate`、`status`、`gen` 等不启动运行时服务的命令不会加载 core。

职责划分：

| 能力 | 归属 |
| --- | --- |
| Phoenix v1/v2 帧、join/leave、broadcast fan-out、presence、CDC 匹配 | Rust core |
| JWT 校验、`access_token` 刷新、token 过期 | Bun |
| `realtime.messages` RLS 授权 | Bun（core 发 `authorize` effect） |
| CDC 触发器、列元数据、逐订阅者 RLS 可见性 | Bun |
| Phoenix 二进制广播 | Bun（不进 JSON core） |
| PGlite / native PostgreSQL | Bun |

嵌入式调用方可直接注入自定义实现，不依赖环境变量：

```ts
createBackend({ realtimeCore: opened.core })
new RealtimeEngine(db, jwtSecret, resolver, { core: opened.core })
```

## 6. 当前落地清单

| 能力 | 状态 |
| --- | --- |
| `crates/realtime-core` C ABI、协议、过滤、presence、CDC、状态机 | 已完成，21 个 Rust 测试 |
| `bun:ffi` 加载、ABI 校验、缓冲区释放、错误映射 | 已完成，5 个 Bun FFI 测试 |
| SHA-256 校验、`0700` 临时解包、退出清理、fail-closed | 已完成 |
| standalone 构建自动嵌入 host cdylib | 已完成 |
| `RealtimeEngine` 显式 `core` 注入点 | 已完成，7 个引擎集成测试 |
| RLS 授权 effect、CDC 逐订阅者可见性、token 刷新同步 | 已完成 |
| TS/Rust parity 向量、生命周期回归、跨平台 core 构建 | 已完成，接入 `lite-rust-core.yml` |
| Lite 服务 Realtime 时固定使用 Rust（无模式开关） | 已完成 |
| 各平台 standalone 与 npm 包内附带对应 core | 已完成，发布流水线强制校验 |
| Postrust sidecar | 不在本阶段 |

## 7. 验收标准

```gherkin
Scenario: 单文件启动并加载 Realtime core
  Given 用户只拥有一个 supacloud-lite 可执行文件
  When 以 PGlite 模式启动
  Then 内嵌的 realtime core 被解包到 0700 私有目录
  And SHA-256 与 ABI 校验通过
  And PGlite 仍然是数据库与 RLS 的权威

Scenario: 私有频道授权
  Given 客户端加入 private 频道
  When core 发出 authorize effect
  Then Bun 执行 realtime.messages 的 RLS 探测
  And 未通过时返回 phx_reply error 且不加入频道

Scenario: 资源缺失时失败关闭
  Given 内嵌资源缺失或校验失败
  When Lite 启动 Realtime
  Then 返回明确的 capability 错误
  And 不加载未校验的二进制
```

## 8. 后续工作

1. 覆盖 `broadcast` effect 的跨实例持久化（当前 Lite 单进程无需）。
2. 持续运行 PGlite/native PostgreSQL 长连接与断线重连 soak。
3. 评估 native 模式下 Postrust 作为可选 sidecar 的内嵌发行。
