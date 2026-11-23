# ADR：统一 Data API，退役每项目 PostgREST 进程

## 1. 决议状态

| 属性 | 内容 |
| --- | --- |
| 决议标识 | ADR-2026-11-24-DATA-PLANE |
| 决议状态 | Approved |
| 实施状态 | 第一阶段已实施（可运行的数据面进程 + 契约测试）；控制面切换未开始 |
| 范围 | `packages/supacloud-lite` 数据面、Management API 项目运行时、Caddy 路由、systemd 单元 |
| 取代 | 部分取代 [ADR-2026-11-23-RUST](2026-11-23-rust-platform-adoption.md) 第 4 节“当前不替换 PostgREST” |
| 保持 | 该决议的其余部分（Rust 服务基线、控制面协调、编译器增强）不变 |

## 2. 背景

PostgREST 至今承担项目 REST 数据面。它按项目一个 `supacloud-pgrst@<ref>` systemd
单元运行，配置由 [postgrest-runtime-lifecycle](../postgrest-runtime-lifecycle.md)
描述。替换它的动机不是性能，而是：

1. 平台有两套 CRUD 引擎（Haskell PostgREST 与 ZenStack 模型层），行为、错误码和
   类型来源分叉；
2. 每项目一个外部二进制意味着配置模板、watchdog、日志采集、升级脚本、状态字段
   都要为它单独存在；
3. 普通读取与编译器应用车道的查询语义无法共享。

反目标：

- 不引入第二套数据库、权限模型或迁移账本；
- 不让数据面绕过 PostgreSQL grants 与 RLS；
- 不用“功能不多”作为删除契约面的理由；契约面以实测白名单为准。

### 事实基线（审查后纠正）

计划初稿假设 REST 契约面很小。核对代码后该假设不成立，以下都必须由实现共同覆盖：

| 契约 | 位置 |
| --- | --- |
| 嵌入树、`!inner`、`...spread`、逻辑树、聚合 | `packages/supacloud-lite/src/runtime/rest/parse.ts` |
| `Range`/`Range-Unit`/`Content-Range`、`count=exact/planned/estimated` | `packages/supacloud-lite/src/runtime/rest/handler.ts` |
| `Prefer: return/count/resolution/missing/tx` | 同上 |
| `Accept-Profile` / `Content-Profile` 与 `PGRST106` | 同上 |
| `/rpc/*`、`on_conflict`、`?columns=` | 同上 |
| `PGRST1xx/PTxxx` 与结构化异常、自定义 status/headers | `packages/supacloud-lite/src/runtime/rest/errors.ts` |
| `pgmq_public`、`graphql_public` 的 `.schema()` 路径 | `docs/queues-pgmq-migration.md` |
| 客户端实际使用 `count=exact` 与 `Range` | `packages/cli/src/shared/tools/app-starter-query.ts` |
| SDK 行为对账 | `packages/management-api/tests/integration/sdk-parity.test.ts` |

结论：**替换对象不是“写一个 REST 网关”，而是把已有的 Lite Data API 提升为
平台唯一数据面实现。** 新写一个 PostgREST 兼容层是最差的选项。

## 3. 决策

### 3.1 唯一 CRUD 实现

平台只保留一个 REST 实现：`@supacloud/lite` 的 Data API
（`RestHandler` + `QueryBuilder` + `parse`）。Full Platform 的项目数据面
运行同一个实现，而不是另一份代码。ZenStack 继续作为模型/策略层
（`@supacloud/db-zenstack`），不是第二个 HTTP 数据面。

两层职责不重叠：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Data API（本决议） | `/rest/v1` 契约、JWT→角色、schema profile、Range/Prefer、错误码 | 业务规则、幂等、审计 |
| ZenStack 模型层 | 编译器应用车道的模型读写与 policy | 通用 REST 契约、任意视图/RPC |
| durable Command | 业务写入、幂等、回执、审计、跨表事务 | 普通读取 |

### 3.2 双层权限执行，不允许旁路

每个请求的处理顺序固定为：

```text
verified JWT → role ∈ {anon, authenticated, service_role}
             → set_config('role', …, true) + set_config('request.jwt.claims', …, true)
             → PostgreSQL grants + RLS
```

- 数据面连接**不得**以 superuser 或 `BYPASSRLS` 角色执行；
- `set_config(..., true)` 是事务局部状态，因此一个事务必须固定占用一条连接，
  否则权限会泄漏到其他请求；
- 该约束已由 `createBunSqlEngine` 的 `transaction` 实现并在
  `test/dataplane-engine.test.ts` 中验证。

### 3.3 进程模型：单元粒度不变，实现改变

保留每项目一个 systemd 单元的语义（`supacloud-dataplane@<ref>`），只换单元里的
程序。合并成“一个进程服务所有项目”会把故障半径从 1 个项目放大到全部项目，
不作为本决议的默认形态。

### 3.4 客户端契约不变

`/rest/v1` 与 `apikey`/Bearer 协议保持不变。客户端迁移是可选项，不是本决议的
前置条件；原生路由（`/model/...`）属于编译器应用车道，另行决策。

## 4. 实施台账

### 第一阶段：数据面进程（已实施）

- [x] `packages/supacloud-lite/src/runtime/db/bun-sql-engine.ts`：在**已存在**的
      PostgreSQL 上实现 `DbEngine`，事务固定占用连接，`LISTEN` 缺失时显式失败。
- [x] `packages/supacloud-lite/src/dataplane.ts`：`createDataPlane`
      组装 `Database.attach` + `RestHandler` + JWT 身份绑定，只服务
      `/rest/v1` 与 `/health`。
- [x] `packages/supacloud-lite/src/dataplane-main.ts`：进程入口，接受
      `DATA_PLANE_*` 与 `PGRST_*` 环境名，SIGTERM 排空退出。
- [x] `packages/supacloud-lite/src/runtime/db/database.ts`：新增
      `Database.attach`，挂载已引导数据库而不重跑 Lite bootstrap。
- [x] `packages/supacloud-lite/src/runtime/rest/openapi.ts`：
      `GET /rest/v1/` 返回按 profile 限定的 OpenAPI 3.0.3 文档（表、视图、列类型映射、
      `/rpc/<fn>`、`x-exposed-schemas`），输出顺序稳定以支持生成物 drift 检查。
- [x] `Database.listFunctions(schema)`：为 OpenAPI 与后续类型生成列出可调用 RPC。
- [x] schema reload：`createDataPlane` 订阅 `pgrst` 与 `supacloud_schema_reload`，
      收到 NOTIFY 后 `invalidateSchemaCache()`；引擎无法 `LISTEN` 时在 `/health`
      报 `schema_reload: unavailable`，不静默假装可用。
- [x] 契约测试：`test/dataplane.test.ts`（身份、RLS、Range、`count=exact`、
      `PGRST106`、`Prefer: return=representation`、写入拒绝、health、非 REST 路径）、
      `test/dataplane-engine.test.ts`（连接固定、回滚、`LISTEN` 失败、env 解析）、
      `test/dataplane-schema.test.ts`（OpenAPI 内容与稳定性、跨进程 schema reload）。
- [x] 控制面观察骨架：`projects.dataplane_*` 列、
      `services/dataplane-runtime.service.ts`、
      `GET /v1/projects/:ref/services/dataplane/status`、
      `POST /v1/projects/:ref/services/dataplane/{stop,pause,status}`。
      `start/resume/restart` 在配置生成与端口持久化落地前**故意失败**并返回
      `409 DATA_PLANE_DISABLED`。
- [x] `renderDataPlaneSystemdTemplate` 与
      `infrastructure/systemd/supacloud-dataplane@.service`：每项目一个单元，
      `SIGTERM` + `TimeoutStopSec=30`，不依赖 PostgREST。

### 第二阶段：控制面切换（未开始）

前置：`start` 目前恒失败（`DATA_PLANE_DISABLED` / `DATA_PLANE_NOT_PROVISIONED`），
因为生成配置、分配并持久化端口、以及 Caddy 原子接管都还不存在。这是刻意的门，
不是遗漏。


- [ ] Management API 生成 `supacloud-dataplane@<ref>` 单元，`postgrest-config`
      revision 改名并保留旧 revision 的读取兼容。
- [ ] Caddy 动态路由指向新端口，保留原子切换与 in-flight 排空。
- [ ] 项目状态增加 `dataplane_desired` / `dataplane_actual` /
      `dataplane_health`，与现有 `postgrest_*` 并存一个发布周期。
- [ ] 只读影子比对：同一请求同时发给 PostgREST 与新数据面，只比较、不返回。
      写请求**不得**影子双打（会产生重复副作用）。
- [ ] 真实主机证据：连接池上限、并发、未知提交结果、回滚后旧单元健康。

### 第三阶段：拆除（未开始）

- [ ] 删除 `supacloud-pgrst@*` 单元、watchdog、`postgrest-*` 服务脚本、
      vector/日志采集条目、`ssh-tools` 探针。
- [ ] 更新 `AGENTS.md`、`docs/architecture/database-contract.md`、
      `docs/postgrest-runtime-lifecycle.md` 的“PostgREST 是一等数据面”表述。
- [ ] 删除必须在回滚窗口结束之后，且需要一份正向迁移说明权限面没有变化。

## 5. 支持面矩阵

数据面**已经实现**以下契约，切换时不需要再补：

| 能力 | 状态 |
| --- | --- |
| 列选择、别名、cast、`json->>` | 已实现 |
| 嵌入（一对多/一对一/多对多）、`!inner`、`!hint`、`...spread` | 已实现 |
| 过滤操作符全集（`eq/neq/gt/gte/lt/lte/like/ilike/match/imatch/in/is/fts/plfts/phfts/wfts` 等） | 已实现 |
| `or=` / `and=` / `not.` 逻辑树 | 已实现 |
| `order`、`limit`、`offset`、`Range`、`Range-Unit` | 已实现 |
| `Content-Range` 与 `Prefer: count=exact/planned/estimated` | 已实现 |
| `Prefer: return=representation/minimal/headers-only` | 已实现 |
| `Prefer: resolution=merge-duplicates/ignore-duplicates`、`on_conflict` | 已实现 |
| `Prefer: missing=default/null`、`?columns=` | 已实现 |
| `Prefer: tx=rollback` | 已实现 |
| `Accept-Profile` / `Content-Profile` 与 `PGRST106` 暴露校验 | 已实现 |
| `/rpc/<fn>`、重载歧义、默认参数、`max-rows` | 已实现 |
| 聚合、`count()`、`singular` 媒体类型 `application/vnd.pgrst.object+json` | 已实现 |
| CSV 输出、`application/vnd.pgrst.plan` | 已实现 |
| 结构化 `PGRST` / `PT` 异常、自定义 status/headers | 已实现 |

第一阶段已补齐（原“需要新增”缺口）：

| 能力 | 实现 |
| --- | --- |
| schema cache 跨进程失效 | `LISTEN pgrst` / `LISTEN supacloud_schema_reload` → `invalidateSchemaCache()`，`/health` 暴露 `schema_reload` |
| OpenAPI 根文档 | `GET /rest/v1/` 按 profile 返回 OpenAPI 3.0.3 |
| 每项目单元状态字段 | `dataplane_desired/actual/health/port/last_error/updated_at` |

仍然缺失（切换前必须补）：

| 缺口 | 为什么必须补 |
| --- | --- |
| 配置生成 + 端口分配持久化 | 没有它们 `start` 只能失败；当前由 `409 DATA_PLANE_DISABLED` 表达 |
| `getProjectServiceStatuses` 列表项 | Studio 服务面板目前只列 PostgREST/GoTrue；数据面只在专用 status 路由可见 |
| Caddy 动态路由接管与 in-flight 排空 | 切换必须原子且可回滚 |

明确**不做**（由其他进程负责，数据面必须显式 404）：

- `/auth/v1`、`/storage/v1`、`/functions/v1`、`/realtime/v1`；
- 多进程共享的连接池与跨项目路由。

## 6. 与既有规则的关系

| 规则 | 处理 |
| --- | --- |
| `AGENTS.md`：“PostgREST 与 `@supabase/supabase-js` 是普通读取和低风险 CRUD 的一等数据面” | 第三阶段改写为“项目 REST 数据面由 `supacloud-dataplane` 提供，契约不变” |
| `docs/architecture/database-contract.md` 四类入口 | `postgrest-read` 改名为 `data-api-read`，语义与约束不变 |
| `docs/architecture/zenstack-upgrade.md`：现行集成是显式只读资源 | 不变。本决议不扩大 ZenStack 的资源暴露面 |
| [ADR-2026-11-23-RUST](2026-11-23-rust-platform-adoption.md) 第 4 节 | 标记为部分被本决议取代；其证据门槛移到本决议第 7 节 |

## 7. 切换门槛（沿用并收窄旧门槛）

切换一个项目的数据面前，必须同时满足：

1. 第 5 节“需要新增”三项补齐；
2. `packages/management-api/tests/integration/sdk-parity.test.ts` 对新数据面全绿；
3. 只读影子比对连续 7 天差异为 0；
4. 回滚演练通过：改回 `postgrest_desired = running` 后旧进程恢复健康，且客户端无感；
5. 一份实测记录说明该项目的真实使用面落在已实现矩阵内。

## 8. 验收

```gherkin
Feature: Unified data plane
  Scenario: PostgreSQL remains the enforcement layer
    Given a table with grants and RLS for anon, authenticated and service_role
    When a request reaches the data plane with a verified project JWT
    Then the transaction sets the caller's role and request.jwt.claims
    And PostgreSQL grants and RLS decide the visible rows
    And the data plane never connects as a bypass role

  Scenario: The REST contract is not silently narrowed
    Given a client using Range, Prefer: count=exact and Accept-Profile
    When it calls /rest/v1 through the data plane
    Then the response carries Content-Range and the profile rules
    And an unexposed schema is rejected with PGRST106

  Scenario: The data plane is not a second runtime
    Given a request for /auth/v1 or /storage/v1
    When it reaches the data plane process
    Then the response is 404 and names /rest/v1 as the only surface

  Scenario: Request-scoped state cannot leak across requests
    Given two concurrent data plane transactions
    When each sets a different role
    Then each runs on its own pinned connection
    And neither observes the other's role or claims

  Scenario: Rollback is a desired-state change
    Given a project switched to the data plane
    When the operator restores the PostgREST desired state
    Then the project serves ordinary reads from PostgREST again
    And no client or migration change is required
```

## 9. 回滚边界

第一阶段只新增代码与导出，不改变任何现有路径：

- 现有 PostgREST 单元、Caddy 路由、`postgrest_*` 状态字段、日志采集全部不变；
- 删除 `src/dataplane*.ts`、`src/runtime/db/bun-sql-engine.ts`、两处 `index.ts` 导出与
  `Database.attach` 即可完全回滚，不影响数据库、迁移账本或客户端。

## 10. 已知风险

1. **连接池语义**：Bun `SQL` 的池上限必须小于项目数据库的连接预算，否则多项目
   共享一台主机时会互相挤占；控制面切换阶段需要每项目的连接上限参数。
2. **schema cache**：现有失效是进程内缓存；多实例或其他进程执行 DDL 后必须显式
   触发，否则会读到过期列。
3. **RLS 覆盖面**：`policy-rls.ts` 只投影可解析的行策略；关系谓词、字段级 `@deny`、
   grants 仍需要手写 SQL。这与现状一致，但切换时不能把它当成“已经覆盖”。
4. **`LISTEN` 缺失**：数据面引擎不支持 `LISTEN`；realtime、队列与任何依赖
   `pg_notify` 的路径继续留在原进程。