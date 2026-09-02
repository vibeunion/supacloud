# Database Governance

`@supacloud/db` 把 RLS 策略、RPC 函数、触发器与授权提升为**一等资源**：SQL 文件仍是实现来源，Manifest 是治理来源，PostgreSQL Catalog 是事实来源。三者通过对账（reconcile）保持一致。

```
SQL 源文件（实现）
  -> defineDatabaseModule（声明/所有权）
    -> Drizzle migration / 部署执行
      -> PostgreSQL Catalog（事实）
        -> reconcileModule（对账）+ lintSql（静态检查）
```

## 目录约定

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

`tables` 也接受 Drizzle 表对象（自动提取 `schema.name`），便于与 Drizzle schema 共存而不重复定义。

## Catalog 对账

```ts
import { readCatalog, reconcileModule } from "@supacloud/db";

const catalog = await readCatalog(executor, ["public"]);   // executor: 注入的 query 执行器
const report = reconcileModule(caseDb, catalog);
```

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

`db.manifest.json` 记录表/策略/函数/测试的所有权关系，是 `db graph`、`db impact` 与 AI 辅助修改的基础数据。

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

- **Drizzle**：表结构、查询与迁移生成底座；本包在其上增加 RLS/RPC 治理，不重复实现 ORM 能力
- **PostgreSQL/Supabase**：权限与一致性的最终权威；对账直接读取 `pg_policy`、`pg_proc`、`pg_class` 与 grants
- **SupaCloud Compiler**：把数据库模块与业务模块（Command ↔ RPC ↔ 表 ↔ 策略）关联成统一依赖图

本期范围为只读治理（check/lint/explain/reconcile）。生产迁移执行器（plan/apply/审批）在后续版本提供。
