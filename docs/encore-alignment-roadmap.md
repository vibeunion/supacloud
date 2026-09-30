# Encore 对齐：下一阶段完善路线

Status: **PROPOSAL**（设计提案，不是完成声明；本文不含任何已实现或已验收的结论）。
Updated: 2026-09-29

本文对照 Encore 的官方文档，梳理 SupaCloud 现有基础与下一步应完善的能力。
现有实现以仓库代码和文档为准；本文只描述目标、边界和验收标准，不宣称已落地。

相关文档：
[Encore 方向交付证据账本](./encore-inspired-delivery.md)、
[工程目标](./engineering-goals.md)、
[应用框架](./application-framework.md)、
[执行上下文](./execution-context.md)、
[请求与后台任务追踪](./request-task-tracing.md)、
[可观测性](./observability.md)、
[数据库环境晋升](./database-environment-promotion.md)、
[AI 运维 MCP](./mcp-ai-operations.md)。

## 1. 学习目标：同一个模型贯穿全过程

Encore 最值得借鉴的不是 API 语法，而是同一个应用模型贯穿开发与交付的完整链路：
编译器从源码静态分析出服务、API、数据库、存储、消息及其使用关系，本地运行、
客户端生成、架构视图、追踪和部署共同消费这一份模型，开发者只需声明一次。

SupaCloud 的目标链路是：

```text
业务声明 → 应用与资源图 → 编译检查 → 本地运行 → 调试与测试
        → 部署计划 → 运行结果回读
```

必须区分 Encore 的两层能力：

- **开源工具链**：本地运行、客户端/OpenAPI 生成、自托管镜像构建，可以在仓库内实现。
- **可选平台能力**：自动云资源配置、IAM、托管预览环境，属于商业平台规模，不在对标范围内。

我们只学这条完整链路，不复制其云平台规模，也不引入第二套框架。

## 2. 现状与差距

现有基础来自仓库当前实现，不应作为"缺失项"重复建设。

| 对比方向 | 参考点 | SupaCloud 当前基础 | 判断 |
| --- | --- | --- | --- |
| 应用模型 | 服务、API、基础设施及使用关系统一建模 | `ApplicationGraph`（`packages/compiler/src/types.ts`）已覆盖 modules、providers、controllers、commands、jobs、queries、externalTokens、featureSpec | **P0**：扩展资源与资源使用关系，不另造应用图 |
| 本地开发 | `encore run` 按声明启动并连接本地依赖 | 生成应用的 `bun run dev` 是本地 watch/compile/restart（`scripts/dev.ts` + `watchProject`）；`supacloud dev sync` 是远程测试同步 | **P0**：统一应用级本地运行入口，保留远程同步边界 |
| 可观测性 | 本地与部署环境都能查看自动采集的请求/调用/数据库追踪 | 已有 VictoriaLogs、请求标识、W3C `traceparent` 传播（含后台任务与出站 fetch）、指标基线 | **P0**：从"有关联 ID"提升为"能解释一次业务执行" |
| 开发控制台 | API Explorer、服务目录、架构图、Trace 随代码更新 | 已有编译图、Context Pack、Doctor、Fix、`app check/context` | **P1**：把已有信息整合为应用开发控制台 |
| 预览环境 | 平台为 PR 提供临时环境 | 已有数据库分支、schema-only 克隆、迁移晋升与破坏性操作保护 | **P1**：从数据库分支扩展为完整应用环境 |
| AI 集成 | 本地 MCP 提供服务/数据库信息并调用端点验证 | 已有编译图 Context/Doctor，以及受限的**运维** MCP（plan-only） | **P1**：补开发验证闭环，不与运维 MCP 混权限 |

已具备且不应从零建设的能力：静态 DI、模块边界校验、Schema-first 契约、
客户端/OpenAPI 生成、命令治理、静态 AOP 边界。

## 3. 优先事项

### P0-1 应用模型：`ApplicationGraph` 扩展为"应用 + 资源 + 使用关系"

这是后续所有能力的基础，建议最先做。当前 `ApplicationGraph` 顶层以 `modules`、
`externalTokens` 为核心，数据库、Bucket、队列、配置、Secret 及其消费关系尚无统一表达。
已有的 Command、Job、业务状态声明保留并继续扩展。

建议增加三个明确概念（名称为设计建议）：

| 概念 | 表达什么 | 不负责什么 |
| --- | --- | --- |
| InfraResource | 应用需要哪些数据库资源、逻辑 Bucket、队列、配置与 Secret | 不保存生产凭据，不直接创建云资源 |
| ResourceUse | 哪个模块/命令/任务对哪个资源执行哪些操作 | 不推断业务对象级授权 |
| EnvironmentBinding | 同一逻辑资源在本地/Preview/生产分别绑定到哪里 | 不把生产地址写死在业务代码中 |

> 命名注意：`@supacloud/app` 已有响应式数据加载原语 `resource<T>()`
> （`packages/app/src/resource.ts`，对标 Angular `resource`）。基础设施资源必须使用
> 不同命名（例如 `InfraResource` / `defineResource`），避免与本原语混淆。

编译产物应能回答：

- `orders.create` 会写哪个数据库、发布什么事件、访问哪个 Bucket？
- 哪些任务消费该事件？
- 应用部署到项目 A 时，所需资源是否全部绑定？
- 删除某个资源会影响哪些入口？

**实现边界（必须保持）：**

- **应用声明与物理基础设施分离。** 应用声明"需要 attachments Bucket"，平台决定它
  对应哪个项目存储绑定。保持既有的"每项目一个独立 S3 后端、项目内逻辑 Bucket 共用
  该绑定"，不要借改造变成 Bucket 级多后端或自动故障切换。
- **静态声明与运行证据分离。** 编译器只检查资源声明、引用和能力要求；部署预检检查
  实际绑定、权限和服务状态。配置写着 `transaction: true` 不等于目标运行环境真的提供
  正确事务。
- **声明资源关系，不试图理解任意代码。** 第一版只支持显式资源引用和显式 `uses`；
  动态 SQL、任意 `fetch`、第三方 SDK 保留为显式外部依赖入口，不声称能完整推断副作用。

**验收标准：** 缺资源、缺绑定、非法跨模块资源访问，在启动或部署之前给出可定位诊断，
而不是第一次请求时才报错。

### P0-2 应用级本地开发入口

现状差异对新人和 AI 都容易误用：生成应用的 `bun run dev` 是本地 watch/compile/restart，
而 `supacloud dev sync` 是远程同步、监听和迁移。建议统一到应用命名空间，同时保留远程
同步的清晰边界。建议命令形态（非现有命令声明）：

```sh
supacloud-cli app dev --profile fast
supacloud-cli app dev --profile integration
```

> **第一切片已实现（2026-09-29）**：`supacloud-cli app dev` 已提供 profile 感知的
> 统一入口：编译、诊断、watch，并明确报告当前 profile、数据库模式（凭据脱敏）与
> “未验证项”；`fast` 无需外部数据库，`integration` 必须显式提供数据库 URL，否则拒绝。
> “解析资源绑定 → 连接依赖 → 迁移/seed → 启动应用与任务”仍待后续切片。
> 详见 [Application Starter](./application-starter.md#local-development-entry)。

| 模式 | 目标 | 约束 |
| --- | --- | --- |
| fast | 快速写业务、看接口、验证契约 | 可用 Lite/PGlite 或明确标识的轻量适配器 |
| integration | 验证生产依赖语义 | 使用受支持的原生 PostgreSQL、真实队列能力及目标存储适配器 |

统一入口应完成：检查应用图 → 解析资源绑定 → 启动或连接依赖 → 应用迁移与 seed →
启动应用和任务 → watch 重编译 → 展示诊断。

**不要**把"零配置"理解为隐藏配置。开发者应能随时看清：当前连接哪个数据库、哪些资源
是模拟的、哪些验证还没有发生。

**发布后消费验收（发布关卡）：** 在干净目录安装实际发布包 → 初始化应用 → 检查 →
测试 → 本地启动 → 调用接口 → 构建。验收标准：新项目不依赖仓库内部 workspace 路径，
也不需要人工串联多个包，即可完成完整开发流程。

### P0-3 业务执行时间线

现有可观测性不缺日志，缺的是有语义的执行追踪。建议先覆盖这条时间线：

```text
请求进入
  → 身份与授权
  → 幂等判定
  → 事务开始
  → Command / Query
  → 数据库或外部资源调用
  → 审计写入与提交
  → 任务投递
  → 后续任务执行
```

每个阶段要能关联到项目、应用、模块、命令、任务、代码版本及执行结果。开发者应能直接
判断：慢在权限检查、连接池等待还是数据库执行；请求是业务失败还是提交成功但响应丢失；
重试是否再次产生外部副作用；一次 HTTP 调用投递的任务后来发生了什么。

**实现边界：** Trace 不替代持久审计；长任务用关联关系连接，不长期保持一条活跃请求；
日志继续沿用既有存储路线，不搬到业务 PostgreSQL。追踪应关联现有事务命令回执与
Workflow 恢复基础，而不是另建一套“执行状态真相”。

> **第一切片已实现（2026-09-29）**：`execution-context` 新增 `timeline` 投影，按
> `kind+operation` 与 `attempt` 分组，给出每阶段的顺序/耗时、`failed`/`complete`、
> `missingStages`/`unexpectedStages` 与 `traceIds`；事件格式新增可选 `attempt` 与
> `traceId`。它仍标记 `current-graph-only`、`eventsTrusted: false`、
> `deploymentVerified: false`，不替代持久回执/审计。参见
> [Execution Context](./execution-context.md#business-execution-timeline)。

**验收标准：** 一个 Command 经 HTTP 进入、投递后台任务、最终完成后，可以从同一业务
操作入口定位整个过程，并区分每次尝试。

### P1-4 应用开发控制台与 Developer MCP 共用一份数据

建议区分两种产品界面：

- **平台控制台（运维）**：项目生命周期、存储绑定、备份、资源容量、平台组件。
- **应用开发控制台（开发者）**：模块关系、API 契约、资源使用、Command/Job 执行、
  编译诊断。

第一版不需要庞大新产品。最有价值的是：选择一个接口，看到其契约、调用关系、治理要求、
资源依赖，再调用一次并查看执行时间线。

同一份数据应通过 Developer MCP 提供给 AI。已有 Context、Doctor、Fix 可作为基础，
需要补的是闭环：

```text
读取应用图 → 修改代码 → 编译检查 → 在隔离环境调用 → 读取失败证据 → 再修复
```

**边界：** 不要让 AI 每次重扫整个仓库，也不要让它凭日志猜测应用结构。开发 MCP 与运维
MCP 的权限不能混在一起：现有运维 MCP 的 plan-only、项目范围限制和凭据脱敏继续保持；
允许调用端点或执行测试的能力必须绑定到明确的本地/测试环境，不自动延伸到生产。

> **决策与第一/二切片（2026-09-29）**：**不新建控制台**。应用开发视图复用现有
> `packages/web-console` 的 project 区域（与现有 applications 运行态页并列），
> Developer MCP 与运维 MCP 分端点/分权限。已落地“一份数据”的编译期契约：
> `supacloud.application-development.v1`（`createApplicationDevelopmentContext` /
> `dev-context` CLI），红化输出模块/路由/资源/诊断；并已随交付构建发布
> `bundle/application-development.json`，由 `readApplicationDevelopmentContext`
> 按目标/哈希校验读取（`verified-build-snapshot`），无需源码 checkout。
> **Developer MCP 工具已落地（第三切片）**：独立端点
> `POST /mcp/developer/projects/{project_ref}`，只读、项目限域，仅暴露
> `supacloud.get_application_development`，从不可变 release 归档读取并校验同一份
> `supacloud.application-development.v1` 契约；运维 MCP 端点不暴露该工具。
> Web Console 视图为后续切片。参见
> [Application Development Context](./application-development-context.md) 与
> [Optional AI Operations MCP](./mcp-ai-operations.md)。

**验收标准：** 人和 AI 查看的是同一份应用结构、同一条执行证据，而不是各自维护一套解释。

### P1-5 完整应用 Preview 与统一发布证据

现有数据库分支与迁移晋升已具备 schema-only、迁移 checksum、共同祖先校验、破坏性操作
确认和失败恢复边界，不应推翻。下一步把 Preview 定义为完整环境：

| 环境组成 | 应补齐的统一行为 |
| --- | --- |
| 应用与函数 | 绑定确切构建产物、契约版本和运行配置 |
| 数据库 | 复用现有分支与迁移机制，默认 schema-only |
| 队列与任务 | 独立命名空间、消费者和任务状态 |
| 对象存储 | 明确项目绑定、访问权限及清理范围 |
| Secret 与外部服务 | 使用测试凭据；默认禁止生产支付、邮件等真实副作用 |
| 生命周期 | PR 更新、关闭、超时回收和失败残留处理 |

**避免"换个前缀就算隔离"。** 数据库角色、存储权限、消费者身份和路由访问控制都应进入
验收。

> **实现进展（Preview 环境组合切片）**：新增只读端点
> `POST /v1/projects/:ref/previews/plan`，确定性地组合完整环境（database/application/
> configuration/resources/queues/storage/secrets）、四项**隔离验收检查**、回收策略
> （`pr_closed`/`timeout`）与残渣清理；默认 `schema_only`（复用现有数据库分支/
> 迁移晋升），`full_clone` 需显式授权。**生产阻断**：`prod`/`production`/`live`/`release`
> 形状的环境名、分支名与资源绑定被拒绝；内联凭据被拒绝。参见
> [Preview Environment Composition](./preview-environment.md)。
> 实际供给器、隔离验证器与回收 worker 为后续切片。

发布时把这些信息合成一份可查询结果：源代码提交、构建摘要、契约版本、迁移计划、资源
绑定版本、健康检查，以及回滚目标。不要承诺"回滚镜像即可回滚一切"：应用回滚、数据库
迁移恢复、存储变更恢复应分别记录可行路径；破坏性数据库变更仍需专门处理。

**验收标准：** 一个 PR 能获得可运行、可验证、可回收的整套环境；一次发布能说明每个组成
部分究竟成功、失败还是结果待确认。

## 4. 实施顺序与依赖

1. **P0-1 资源模型**是基础：P0-2、P0-3、P1-5 都消费它，应先定义稳定的类型与诊断。
2. **P0-2 本地入口**依赖 P0-1 的绑定解析，并与现有生成应用 `dev` 脚本、`dev sync` 收敛。
3. **P0-3 执行时间线**可与 P0-1/P0-2 并行，但必须复用现有回执与追踪管道。
4. **P1-4 控制台/MCP** 消费 P0-1 的图和 P0-3 的证据。
5. **P1-5 完整 Preview** 依赖 P0-1 的 `EnvironmentBinding` 和 P0-2 的本地/集成 profile。

每个阶段沿用 `docs/encore-inspired-delivery.md` 的账本模式，记录范围、证据和未决项，
不以单点通过提升为整体验收。

## 5. 非目标

- 不采用或 fork AponiaJS/Encore，不引入第二套 DI/AOP/ORM/工作流引擎。
- 不实现自动云资源创建、IAM 或托管预览环境的商业平台规模能力。
- 不把生产凭据、地址写进业务声明或编译产物。
- 不声称编译器能完整推断任意动态代码的外部副作用。
- 不绕过现有命令治理、模块边界或类型安全门禁。

## 6. 参考

- Encore 官方文档（应用模型、`encore run`、本地 Trace、预览环境）。
- 仓库内既有实现与证据：[Encore 方向交付证据账本](./encore-inspired-delivery.md)。
- 边界与所有权：[工程目标](./engineering-goals.md)、[应用架构](./application-architecture.md)。
- 可观测性：[请求与后台任务追踪](./request-task-tracing.md)、[可观测性](./observability.md)。
- 环境：[数据库环境晋升](./database-environment-promotion.md)。
- AI 运维边界：[AI 运维 MCP](./mcp-ai-operations.md)。