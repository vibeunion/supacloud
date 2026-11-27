# Lite 单文件发行与 Rust Realtime 核心嵌入

状态：第一、二阶段已落地（Rust core + `bun:ffi` 绑定 + standalone 资源管线 + `RealtimeEngine` 可选注入）；
parity vectors、真实库 lifecycle 回归、跨目标嵌入与同步 FFI 压测已补全。
默认仍使用 TypeScript Realtime 引擎；设置 `SUPACLOUD_LITE_REALTIME_CORE_MODE=rust`
才启用 Rust core，且启用后缺失或校验失败会直接报错，不会静默回退。

## 1. 目标与边界

目标：

- 用户只下载一个 `supacloud-lite` 可执行文件，不需要额外安装 Rust、动态库或 sidecar。
- Realtime 的协议与状态机在 Lite 与 Full SupaCloud 之间共享同一份 Rust 实现。
- PGlite、RLS 授权、JWT 校验、HTTP/WebSocket 生命周期继续由 Bun 持有。

非目标：

- 不把 PGlite 内部替换成 Rust/PostgreSQL。
- 不把完整 `postrust-server` 改造成 FFI 库。
- 不在本阶段把 Rust core 设为默认 Realtime 路径。

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

跨平台发行需要为每个目标 triple 提供对应 cdylib，暂存布局为
`dist/native/<rust-triple>/<library>`。匹配 host 的目标会自动 cargo build，
其他目标从暂存目录解析预编译产物：

```bash
# 在 macos-arm64 主机上为两个 macOS 目标准备 core
bun run build:realtime-core --target x86_64-apple-darwin

# 缺失跨目标 core 时构建失败；SUPACLOUD_LITE_SKIP_REALTIME_CORE=1 可显式跳过
SUPACLOUD_LITE_REQUIRE_REALTIME_CORE=1 bun run build:standalone:macos
```

对应关系与暂存解析见 `packages/supacloud-lite/scripts/realtime-core-targets.ts`；
`dist/native` 可用 `SUPACLOUD_LITE_REALTIME_CORE_DIR` 重定向。CI 通过
`.github/workflows/lite-rust-core.yml` 的三平台矩阵（linux x64/arm64、macos
x64/arm64、windows x64）在每个 OS 上构建匹配 triple 的 core 并以
`REQUIRE=1` 打包 standalone，再用 rust core 模式跑 `gen types` 冒烟。

`release-please.yml` 的 standalone 发布任务仍在单一 Linux runner 上构建全矩阵；
跨目标在缺少暂存 core 时会告警并产出不含 core 的二进制（运行期 fail-closed）。
正式发布跨目标单文件前需要把该任务拆到各 OS，或先暂存预编译 core。

### 5.1 运行时启用

```bash
# 默认：TypeScript Realtime 引擎
supacloud-lite start

# 灰度：使用内嵌 Rust core
SUPACLOUD_LITE_REALTIME_CORE_MODE=rust supacloud-lite start
```

启用后职责划分：

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
| 跨目标构建消费暂存 cdylib（`dist/native/<triple>/`） | 已完成，5 个构建目标测试 |
| `RealtimeEngine` 显式 `core` 注入点（默认关闭） | 已完成，7 个引擎集成测试 |
| RLS 授权 effect、CDC 逐订阅者可见性、token 刷新同步 | 已完成 |
| 环境变量灰度 `SUPACLOUD_LITE_REALTIME_CORE_MODE=rust` | 已完成 |
| TypeScript/Rust 全量 parity vectors | 已完成，29 个测试纳入 CI |
| 真实 PGlite / native PostgreSQL lifecycle 回归 | 已完成，各 3 个测试纳入 CI |
| 同步 FFI 压测脚本与 CI 守门 | 已完成 |
| 默认切换 | 未开始，见压测结论 |
| Postrust sidecar | 不在本阶段 |

## 6.1 同步 FFI 压测

`bun run benchmark:realtime-core` 用同一组 socket/帧分别压
`core.call`（JSON 编码 → FFI → JSON 解码）、TS 引擎与 Rust 引擎端到端路径，
并用 1ms `setInterval` 观测 Bun 事件循环被同步调用阻塞的时长。
`--quick` 为 CI 守门，`--json --assert-max-lag <ms>` 可断言最大阻塞预算。
数字是合成场景（无真实 socket I/O），作为回归护栏而不是生产 SLA。

参考值：darwin-arm64（10 核）、Bun 1.4.5、release core、200 连接 / 200 次迭代。

| 场景 | Rust core p50 | Rust core 最大事件循环阻塞 | TS 引擎 p50 |
| --- | --- | --- | --- |
| heartbeat | 0.01 ms | ~1 ms（timer 粒度） | - |
| join + 50 bindings | 0.18 ms | ~1 ms | - |
| broadcast 1 KiB × 200 | 0.87 ms | ~1.5 ms | 0.06 ms |
| broadcast 64 KiB × 200 | 15.08 ms | 79.16 ms（阻塞占比 82%） | 1.88 ms |
| broadcast 1 MiB × 20 | 23.09 ms | 48.39 ms（阻塞占比 88%） | 2.90 ms |
| CDC 1 MiB × 20 | 30.24 ms | 288.37 ms（阻塞占比 93%） | 2.29 ms |
| Rust 引擎端到端 64 KiB × 200 | 18.13 ms | 22.07 ms | 1.88 ms |
| Rust 引擎端到端 1 MiB × 20 | 48.60 ms | 242.75 ms | 2.90 ms |
| Rust 引擎端到端 CDC 1 MiB × 20 | 53.13 ms | 231.97 ms | 2.29 ms |

结论：

- 小 payload（≤1 KiB）下 Rust core 的同步调用无感知，协议一致性收益成立。
- 大 fan-out / 大 payload 时，JSON 同步桥是主要成本：每次调用要把请求
  JSON 化、在 Rust 侧复制并序列化整个响应、再在 Bun 侧解码和逐帧序列化，
  p50 达到几十毫秒、长尾数百毫秒，期间 Bun 完全停摆。
- 因此默认路径保持 TypeScript 引擎；切换默认前需要二进制或批量 FFI 协议，
  或把大 fan-out 保留在 TS 路径并对 core 模式设置 payload/扇出上限。

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

1. `broadcast` effect 的跨实例持久化（当前 Lite 单进程无需）。
2. 发布管线：`release-please.yml` 的 standalone 矩阵拆到各 OS（或暂存预编译 core），
   让正式发行也默认携带跨目标嵌入 core。
3. 大 payload 场景的二进制/批量 FFI 协议，消除 JSON 同步桥的编码/解码与复制成本。
4. 真实 WebSocket 客户端的长时间 soak：断线重连风暴、presence 抖动、token 刷新并发。
5. 灰度稳定后，再决定是否设为默认路径。
6. 评估 native 模式下 Postrust 作为可选 sidecar 的内嵌发行。
