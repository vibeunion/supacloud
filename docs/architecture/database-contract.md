# Database Contract：可替换的模型后端

- 状态：Accepted
- 日期：2026-11-09
- 范围：SupaCloud 数据访问、模型策略、Command 与存量项目迁移

## 两套命令表

不要把下面两套账本当成一张表，也不要合并它们的写入管线：

| 账本 | 位置 | 用途 |
| --- | --- | --- |
| `supacloud_commands.receipts` | `packages/management-api/src/db/sql-modules/commands-public.sql` | 租户引导命令。`workflow_run_id` 外键指向 `supacloud_workflows.runs` |
| `supacloud_commands.execution_receipts` 与 `execution_audit` | `packages/db/src/command-schema.ts` | 应用 durable Command。业务写入、回执和审计在应用事务里 |

Management API 的 bootstrap 函数 `supacloud_commands.submit` 写入第一张表。
应用 `createPostgresCommandStore` 写入第二组表。

## 决策

SupaCloud 对应用公开的稳定边界是 **Database Contract**，不是某个 ORM 或模型编译器。
Database Contract 包含模型关系、行策略、受治理的 SQL/RLS/grants/views、PostgREST
契约、RPC registry/catalog，以及供 Command 使用的身份绑定读端口和事务模型端口。

当前实现后端仍是 ZModel + ZenStack。它负责模型推导、策略查询约束和生成类型；
`@supacloud/db-zenstack` 是可信 host 内部的 adapter；`@supacloud/db/zenstack` 只做兼容再导出。应用业务代码不得依赖 Prisma
client、ZenStack 通用 CRUD 或 ZenStack 生成的业务 RPC。替换该 adapter
只表示在同一套 PostgreSQL Database Contract 上更换模型/策略适配器（当前是 ZenStack）。
迁移账本仍然只有一份。这不是新增第二套写入数据库、查询语言、迁移账本或身份存储的许可。

ZenStack policy 只约束经过 model adapter 的访问，不能代替 PostgreSQL 的 RLS、grants
或 PostgREST/RPC 的数据库权限。模型策略与 SQL/RLS 必须通过显式 parity 检查保持一致；
在 compiler 能够生成并验证 RLS 之前，不得宣称它们来自同一份自动生成结果。

## 四类入口

| 入口 | 适用范围 | 约束 |
| --- | --- | --- |
| `model-command` | 编译器应用车道的业务写入、状态转换、幂等、审计、跨表事务 | 进入 durable Command，使用 `transaction.db` |
| `postgrest-read` | 普通查询、低风险 CRUD、`@supabase/supabase-js` 及其他兼容客户端 | 使用最小数据库角色、RLS 和公开 contract |
| `governed-sql` | 不能安全重写的稳定 SQL 投影、领域函数或生成 RPC | 只能通过受审查的函数/读 contract，禁止裸 SQL；允许由代码或工具生成，但必须进入 registry/catalog |
| `legacy-rpc` | 存量 RPC 迁移桥 | 保留退出条件；新增 RPC 应进入 governed-sql，并保留来源和契约 |

Command 只是编译器应用车道的写入边界，不是全平台唯一业务写入路径。在该车道内，
Command 决定“能否执行业务动作”，模型 policy 决定“能访问哪些记录”，RLS 和 grants
保护数据库入口，约束保证数据不变量。任何一层都不能替代另外一层。PostgREST 与
`@supabase/supabase-js` 仍是普通读取和低风险 CRUD 的一等数据面。

## 迁移规则

1. 编译器应用车道上的新功能默认选择 `model-command` 或 `postgrest-read`。普通读取和低风险 CRUD 继续走 PostgREST 与 `@supabase/supabase-js`。
2. 需要保留 SQL 事实源或生成 RPC 时，选择 `governed-sql`，并记录函数签名、权限、事务语义、返回契约和生成来源。代码生成器可以产出 SQL、registry 或 catalog；生成方式不改变审查和数据库权限要求。
3. 存量 `legacy-rpc` 只能通过迁移台账维护，不得因为“架构纯粹”批量删除；新 RPC 不能成为无来源的孤立 capability。
4. 删除一个 legacy RPC 前，必须证明新入口的行为、权限、幂等、审计、事务回滚和跨租户隔离等价，
   并通过唯一的正向 migration 交付。
5. 应用只依赖 `@supacloud/db/model-contract` 的 port。当前模型/策略适配器仍是
   `@supacloud/db/zenstack`。以后替换它，仍落在同一套 PostgreSQL Database Contract
   和同一份迁移账本上。

`@supacloud/compiler` 的 `database-contracts` 可以同时记录 `modelSchema`、PostgREST
snapshot、RPC registry、RPC catalog 和 migration order。`--check` 是离线新鲜度门禁；
发布门禁再执行模块 Catalog 对账、RLS/grants 检查和实际行为测试。

## 验收

```gherkin
Feature: Backend-neutral database contract
  Scenario: Model backend remains replaceable
    Given an application uses the model read and command ports
    When the trusted host selects a different model/policy adapter
    Then business modules require no ORM client or generated RPC changes
    And the same PostgreSQL Database Contract and its one migration ledger remain
    And no second write database, query language, or auth store is introduced

  Scenario: Direct database access remains protected
    Given a model policy allows a tenant-scoped read
    When the same table is queried through PostgREST or RPC
    Then database role grants and RLS still enforce the tenant boundary

  Scenario: Generated RPC remains traceable
    Given a new RPC capability is produced by code or a SQL generator
    When its registry or generated catalog entry is absent
    Then the project boundary check fails

  Scenario: Command remains the compiler-lane write boundary
    Given a compiler-application business write is invoked through HTTP or a worker
    When the same idempotency key is replayed
    Then one transaction produces one business change, one receipt and one audit result
    And ordinary reads and low-risk CRUD still use PostgREST and @supabase/supabase-js
```
