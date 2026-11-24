# ADR：Rust 平台能力引入与 PostgREST 边界

## 1. 决议状态

| 属性 | 内容 |
| --- | --- |
| 决议标识 | ADR-2026-11-23-RUST |
| 决议状态 | Approved |
| 实施状态 | 第一阶段已实施；后续阶段按验收台账推进 |
| 适用范围 | `crates/*`、Management API、应用脚手架、部署控制面和数据面边界 |

本决议吸收 Rust 生态中值得借鉴的工程模式，但不把外部项目整体引入，
也不因此新增第二套数据库、DI、队列、工作流或写入账本。

## 2. 真实目标与反目标

### 真实目标

1. 为 Rust Gateway、Worker 和 CPU 密集服务提供一致的配置、Tracing、健康检查和优雅退出。
2. 让部署控制面采用 desired state、operation identity、observed state 和回读协调。
3. 把编译期依赖图、边界诊断和生成清单继续沉淀到现有 SupaCloud Compiler。
4. 改善 `app init`、Lite 和本地开发的标准化体验。
5. 保持 PostgreSQL、RLS、PGMQ、现有 Command ledger 和 Supabase 客户端协议的唯一边界。

### 反目标

- 不重写整个平台为 Rust。
- 不用 SurrealDB 或其他数据库替换 PostgreSQL。
- 不引入第二套 DI、Schema、Queue、Workflow 或 migration executor。
- 不让 Rust 服务绕过 Management API 的授权、审计、幂等和项目隔离。
- 不为了“统一技术栈”替换已经稳定的 PostgREST 数据面。

## 3. Rust 能力分层

| 层级 | 采用方式 | 当前状态 |
| --- | --- | --- |
| 服务运行时 | Axum/Tower 风格组合、统一配置、Tracing、健康和 shutdown | 已实施：`supacloud-runtime-core` |
| 高性能边界 | Realtime、JIT Gateway、图片处理、网络代理、CPU 密集 Worker | 已有三个 Rust 服务，继续扩展 |
| 控制面执行 | desired state、幂等 operation、回读和未知结果处置 | 复用现有 Management API 契约，分阶段增强 |
| 编译器 | 借鉴 Pavex 的静态 wiring 和诊断思想 | 继续增强现有 `@supacloud/compiler` |
| 开发体验 | 借鉴 Loco 的生成器、约定式目录和生命周期入口 | 继续增强 `app init`，不引入 Loco runtime |
| 对象存储 | RustFS 只作为可选 S3 provider 候选 | 必须先通过 S3、恢复和故障验收 |

## 4. PostgREST 决议

> 本节已由 [ADR-2026-11-24-DATA-PLANE](2026-11-24-postgrest-dataplane-unification.md) 部分取代。
> 取代的是“当前不替换”这一结论方向：平台改为把已有的 Lite Data API 提升为唯一
> REST 实现，并退役每项目 PostgREST 进程。下文第 5 条证据门槛被收窄并移入新决议
> 第 7 节，仍然有效：没有实测白名单、SDK 对账、影子比对和回滚演练，就不切换。
> Rust 边界（第 3 节）与实施台账（第 5 节）不受影响。

**原决议（历史记录）：当前不替换 PostgREST。**

PostgREST 仍负责：

- 普通读取和低风险 CRUD；
- PostgreSQL grants/RLS 保护的数据面；
- `@supabase/supabase-js` 和现有 REST 客户端协议；
- 作为项目级、可独立管理的运行时组件。

Rust 服务可以承担：

- Gateway、网络策略、连接管理、Realtime 和高吞吐边界；
- 高性能、非兼容性的内部接口；
- 明确声明为 `command` 或 `model-command` 的业务写入。

只有在以下证据全部成立时，才重新评估替换：

1. 真实项目基准证明 PostgREST 成为主要瓶颈；
2. 新实现覆盖所需 REST、RPC、过滤、嵌入、错误、JWT、RLS 和 schema reload 契约；
3. 现有 `supabase-js`、CLI、生成类型和升级流程通过兼容性矩阵；
4. 多项目隔离、回滚、恢复和未知状态处置有真实主机证据；
5. 新实现不会把业务写入、权限或迁移事实源移出 PostgreSQL。

在这些证据出现前，替换 PostgREST 只会扩大风险和维护面。

## 5. 实施台账

### 第一阶段：Rust 服务基线

- [x] 公共 `supacloud-runtime-core` crate。
- [x] 三个 Rust 服务统一 Tracing 初始化。
- [x] 三个 Rust 服务统一 bind 地址解析。
- [x] 统一健康响应字段。
- [x] Realtime 统一 SIGTERM/Ctrl-C 优雅退出。
- [x] JIT Gateway 和 Image Service 增加同等 graceful shutdown。
- [ ] 增加 Rust 服务的 contract/black-box HTTP fixtures。

### 第二阶段：控制面协调

- [ ] 每个 Rust 服务的 desired/observed 状态进入现有项目运行时读模型。
- [ ] 所有启动、停止、重启和绑定操作携带稳定 operation identity。
- [ ] 未知结果只触发回读，不自动创建第二个 mutation。
- [ ] 健康检查、日志和部署证据关联到同一个 operation identity。

### 第三阶段：应用工程

- [x] 编译器输出依赖图摘要和 inference/capability context；Rust runtime 提供版本化 boundary manifest 模型。
- [ ] `app init` 提供标准 feature、health、test 和 config 目录。
- [ ] Lite 复用相同的本地检查和状态诊断入口。
- [ ] 生成产物 drift 检查覆盖 Rust boundary manifest。

## 6. 验收标准

```gherkin
Feature: Rust boundary runtime
  Scenario: Service startup uses one runtime contract
    Given a Rust gateway with its default environment
    When the process starts
    Then its health response exposes status, engine and version
    And tracing uses the shared environment filter behavior

  Scenario: Graceful shutdown preserves cleanup
    Given a running Realtime gateway with active listeners
    When SIGTERM is received
    Then the server stops accepting new connections
    And owned listeners are released before process exit

Feature: PostgREST remains the ordinary data plane
  Scenario: Ordinary reads stay compatible
    Given a project using RLS-protected PostgREST
    When a client performs an ordinary read or low-risk CRUD request
    Then the request continues to use PostgREST and the existing client contract
    And no Rust service bypasses PostgreSQL grants or RLS

  Scenario: Business writes use the governed lane
    Given a cross-table business mutation
    When the application invokes the mutation
    Then it uses the existing Command/RPC governance
    And authorization, idempotency, transaction and audit remain platform-owned
```

## 7. 回滚边界

移除 `supacloud-runtime-core` 的路径依赖并恢复各服务原有 bootstrap 即可回滚第一阶段。
该回滚不改变数据库、PostgREST、项目配置、迁移或现有运行时协议。
