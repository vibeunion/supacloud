# Database Governance

`@supacloud/db` 把 RLS 策略、RPC 函数、触发器与授权提升为**一等资源**：SQL 文件仍是实现来源，Manifest 是治理来源，PostgreSQL Catalog 是事实来源。三者通过对账（reconcile）保持一致。

This is also SupaCloud's single database contract chain:

PostgREST and compiler-generated business clients consume this chain. Do not add
another ORM or a second production schema source. ZModel is the current maintained
model source for model-backed applications; improve CRUD ergonomics by generating
derived APIs within the existing Compiler and RPC governance boundaries.

```
维护的模型 contract（当前为 ZModel） + SQL/RLS/RPC 源文件
  -> defineDatabaseModule（声明/所有权）
    -> 现有 migration ledger / 部署执行
      -> PostgreSQL Catalog（事实）
        -> reconcileModule（对账）+ lintSql（静态检查）
```

## Compiler 治理模式

`@supacloud/compiler` 的 `databaseGovernance.mode` 分为三档：

| 模式 | 离线源契约与 SQL Lint | 实时 Catalog 对账 | 典型用途 |
|---|---|---|---|
| `off` | 否 | 否 | 仅限存量项目迁移例外 |
| `check` | 是 | 否 | 日常开发、普通构建、离线 CI |
| `enforce` | 是 | 是 | 发布/部署门禁，需要只读数据库连接 |

新生成的数据库 starter 默认使用 `check`，因此普通 `compile/check/build`
不要求数据库网络或凭据，构建保持确定性。生成的 integration 开发配置只在
显式本地集成模式下切换为 `enforce`，并使用 loopback 数据库。

推荐把 `check` 固定在 `supacloud.config.ts`，把 `enforce` 放到独立的发布门禁：

```ts
databaseGovernance: {
  mode: "check",
  projectRoot: ".",
  moduleFile: "db/modules.ts",
  schemas: ["public"],
  rpcBoundary: {
    registry: "db/rpc-registry.json",
    catalog: "db/contracts/rpc-catalog.json",
    legacy: "db/legacy-rpc.json",
  },
}
```

`enforce` 默认由 SupaCloud Management API 使用当前项目 context 执行 Catalog 对账，
数据库连接凭据只留在 Management API 内部，不进入应用进程。业务仓库不应提交
数据库连接 URL，也不应要求每个开发者手工准备数据库凭据。平台内部集成测试仍可
通过编程方式传入 loopback `databaseUrl`；这不是项目配置项。`enforce` 失败即阻止
生成，不会自动生成契约、迁移或修复数据库。
配置 `rpcBoundary` 后，`check` 还会把 `commandCapabilities.rpc` 的每个 capability
与 registry/catalog 对账；只有明确登记的历史 RPC 才能作为 `legacy-rpc` 通过。

## 目录约定

数据库 starter 默认使用 ZModel 维护模型结构，并通过 `supacloud-db check`
检查源码边界与 RPC 契约新鲜度。完整 SQL 导出只用于审计，不作为日常类型或测试输入。
RPC 可以由代码生成器、SQL 生成器或其他受治理工具产生；生成结果必须落在维护的
function source、registry 或 catalog contract 中，记录签名、权限、返回契约和来源。
没有这些追溯信息的 capability 不能进入 `governed-sql`，只能继续作为已登记的
`legacy-rpc` 迁移桥。
存量项目先运行只读评估；参见 [Database Source Contracts](./database-source-contracts.md)。
离线检查不替代下文的 Catalog、权限与行为验证。模型行级 policy 与已提交 RLS
的一致性走现有 source contract（`policy-rls-mismatch` / `policy-rls-unsupported`），
doctor 层仍是 `source` 或 checker 无法运行时的 `runtime`。不要为此再加一套 Catalog 码。
证明 `pg_get_expr` 文本等于发出的行级谓词，以及关系谓词、字段级 `@deny`、grants、
`FORCE ROW LEVEL SECURITY`、命令宿主 JWT claims、去掉 command starter 的
`policyRls: "deferred"`，都是 [#2549](https://github.com/vibeunion/supacloud/pull/2549)
已记录、尚未开工的后续。见 [Database Contract](architecture/database-contract.md#已记录的后续事项2549此处未开工)。
`policyRls: "deferred"` 不表示 SQL 已经与模型一致。现有可选 `usingExpr` 对账不是那份在线证明。

```
features/case/db/
  manifest.ts              # defineDatabaseModule
  policies/
    cases_select.sql
    cases_insert.sql
  functions/
    case_create.sql
  tests/
    cases_rls.test.sql
    case_create.test.sql
```

## 声明数据库模块

```ts
import { defineDatabaseModule } from "@supacloud/db";

export const caseDb = defineDatabaseModule({
  name: "case",
  tables: ["public.cases", "public.case_members"],
  policies: [
    {
      name: "cases_select",
      table: "public.cases",
      operation: "select",
      roles: ["authenticated"],
      source: "policies/cases_select.sql",
      tests: ["tests/cases_rls.test.sql"],
    },
  ],
  functions: [
    {
      name: "public.case_create",
      source: "functions/case_create.sql",
      permission: "case.create",
      transaction: "required",
      security: "invoker",
      audit: "case.created",
      tests: ["tests/case_create.test.sql"],
    },
  ],
});
```

`tables` 仅接受 schema-qualified 字符串，例如 `public.cases`；不接受 ORM 内部表对象。

### 操作所有权（operation ownership）

`operationOwnership` 在同一个 `defineDatabaseModule` 声明里为每个
schema-qualified 表操作指定**唯一**入口。它是声明与校验，不新增迁移账本、
不改变 PostgREST 公开协议，也不暴露 ZenStack CRUD：

```ts
export const caseDb = defineDatabaseModule({
  name: "case",
  tables: ["public.cases"],
  operationOwnership: [
    { table: "public.cases", operation: "select", owner: "postgrest-data-api" },
    { table: "public.cases", operation: "insert", owner: "durable-command" },
    { table: "public.cases", operation: "update", owner: "governed-sql-rpc" },
    { table: "public.cases", operation: "delete", owner: "legacy-rpc" },
  ],
});
```

| owner | 含义 | 现有入口名 |
|---|---|---|
| `postgrest-data-api` | PostgREST / Data API，普通读取与低风险 CRUD | `postgrest-read` |
| `durable-command` | 编译器应用车道的 durable Command | `model-command` |
| `governed-sql-rpc` | 受治理的 SQL 投影、函数或生成 RPC | `governed-sql` |
| `legacy-rpc` | 已登记的存量 RPC 迁移桥 | `legacy-rpc` |

规则：

- 每一行必须显式写出 `table`、`operation` 和 `owner`；不接受默认归属。
- `table` 必须由同一个模块的 `tables` 声明，`operation` 只能是
  `select` / `insert` / `update` / `delete`。
- 同一模块内重复的 `table + operation` 会被拒绝（同名 owner 是重复，不同
  owner 是冲突）；跨模块声明同一 `table + operation` 但 owner 不同时，
  compiler 以 `database-operation-ownership` 报错。
- 未声明的表或操作保持未分类，不推断归属；可以先只声明已经迁移完成的条目。
- `ownership: "assist"` 会在 `check` 阶段读取模块并输出带 evidence 的 warning；
  `ownership: "enforce"` 会把 ambiguous/unknown 变成 error。未开启 ownership
  时，`check` 仍保持离线且不导入可执行模块；`enforce` 始终在 Catalog 对账前读取模块。

渐进迁移建议先在新项目和存量项目的 CI 中启用 `ownership: "assist"`，再用 CLI
审阅并采纳高置信度建议：

```bash
supacloud db operation-ownership suggest --module cases
supacloud db operation-ownership adopt --module cases
supacloud db operation-ownership adopt --module cases --write
```

`adopt` 默认只预览；它只会自动写入带明确证据的 `suggested` 条目（当前是
匿名/登录用户的 `SELECT` grant -> `postgrest-data-api`）。写操作的 grant 不能
区分 PostgREST 与 durable Command，因此必须显式决定：

```bash
supacloud db operation-ownership adopt \
  --target public.cases --operation insert --owner durable-command --write
```

当 `suggest` 的 `ambiguous` 和 `unknown` 数量归零后，再把配置从
`ownership: "assist"` 切换为 `ownership: "enforce"`；强制模式会把未分类操作
作为编译错误，而不是兼容性 warning。

`buildDatabaseManifest` 会序列化 `operationOwnership`；`explainObject` 支持
`public.cases.select` 形式的对象名，表的解释里也会列出已声明的操作归属。

## Catalog 对账

```ts
import { readCatalog, reconcileModule } from "@supacloud/db";

const catalog = await readCatalog(executor, ["public"]);   // executor: 注入的 query 执行器
const report = reconcileModule(caseDb, catalog);
```

托管项目不需要把 tenant 数据库 URL 交给开发者：Management API 使用平台内部
凭据执行同一套对账，只返回诊断结果。需要显式调用时仍可使用：

```bash
supacloud db module_check --module_file db/modules.ts --remote --ref <project-ref>
```

该命令仍需要 Management API 的认证上下文，但不会把数据库连接串返回给 CLI
或写入构建日志。

对账诊断：

| 级别 | 码 | 含义 |
|---|---|---|
| error | `missing-policy` / `missing-function` | 声明的资源在数据库中不存在 |
| error | `rls-disabled` | 归属表未启用 Row Level Security |
| error | `definer-without-search-path` | security definer 函数未固定 `search_path` |
| error | `wildcard-grant` | 归属表存在 `GRANT ... TO PUBLIC` |
| warn | `undeclared-policy` | 数据库存在但 manifest 未声明的策略（漂移） |
| warn | `security-mismatch` | 声明 invoker/definer 与实际不符 |
| warn | `grant-drift` | 声明的授权在数据库中不存在 |

### Catalog contract checks

Declared tables that are absent fail with `missing-table`. Policy operations and
role sets must match (`policy-command-mismatch`, `policy-roles-mismatch`);
role order is ignored, but identifier case is preserved.
Optional `usingExpr` / `checkExpr` declarations compare exact `pg_get_expr`
output, including parentheses, casts and literal whitespace. Omit a field to skip
it; set it to `null` to require no expression. This is a catalog text contract,
not a proof of SQL semantic equivalence.

Functions may declare `signature`, for example
`public.case_create(uuid, text)`: use schema/name plus the exact
`pg_catalog.oidvectortypes(proargtypes)` output, without parameter names.
A name-only declaration remains supported for one candidate; multiple candidates
fail with `ambiguous-function-overload`. A missing explicit signature fails with
`missing-function` and never falls back to another overload. Custom catalog
adapters must populate `identityArguments` to check explicit signatures.

Declared triggers default to enabled. Disabled triggers fail with
`disabled-trigger`; `enabled: false` explicitly requires disabled state and fails
with `trigger-enabled-mismatch` if enabled. This does not compare trigger bodies,
events, or execution modes beyond the existing enabled/disabled catalog field.

Explicit empty `search_path` values are accepted; unset paths and dynamic
`$user` paths are rejected. This check does not prove that schemas in a nonempty
path are protected from untrusted writes. Grant coverage and warning severities
are unchanged.

## SQL 静态检查（无需数据库连接）

```ts
import { lintModule } from "@supacloud/db";
const issues = await lintModule(caseDb, readFile);
```

规则：`definer-no-search-path`、`grant-to-public`（error）；`missing-rls-enable`、`drop-without-if-exists`、`policy-without-test`（warn）。

## Manifest 与影响分析

```ts
import { buildDatabaseManifest, explainObject } from "@supacloud/db";

const manifest = buildDatabaseManifest([caseDb, intakeDb]);
console.log(explainObject(manifest, "public.case_create"));
```

`db.manifest.json` 记录表/策略/函数/测试以及表操作归属关系，是 `db graph`、`db impact` 与 AI 辅助修改的基础数据。

## 测试

`@supacloud/testing` 提供事务隔离的 SQL 测试执行器：

```sql
-- tests/cases_rls.test.sql
-- @test tenant member can read own cases
select 1 from public.cases where id = '...';

-- @test cross-tenant access denied
-- @expect error
select private.raise_forbidden();
```

```ts
import { runSqlTests, assertPolicyDenies } from "@supacloud/testing";

const results = await runSqlTests(executor, ["tests/cases_rls.test.sql"]);
await assertPolicyDenies(executor, "select * from public.cases");
```

## 与其他工具的关系

- **ZModel**：表结构、查询与迁移生成底座；本包在其上增加 RLS/RPC 治理，不重复实现 ORM 能力
- **PostgreSQL/Supabase**：权限与一致性的最终权威；对账直接读取 `pg_policy`、`pg_proc`、`pg_class` 与 grants
- **SupaCloud Compiler**：把数据库模块与业务模块（Command ↔ RPC ↔ 表 ↔ 策略）关联成统一依赖图

本期范围为只读治理（check/lint/explain/reconcile）。生产迁移执行器（plan/apply/审批）在后续版本提供。
