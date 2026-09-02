# @supacloud/db

[中文](#中文) | [English](#english)

## 中文

SupaCloud 的数据库治理层：把 RLS 策略、RPC 函数、触发器、授权（grant）作为**一等资源**做声明式管理，并与 PostgreSQL 真实 Catalog 对账。

定位：它是 Drizzle（schema/迁移）之上的治理层 —— Drizzle 负责表结构，本包负责表结构之外的安全与业务对象（策略、函数、权限）的声明、静态检查与漂移检测。**driver 无关**：所有 Catalog 读取都通过注入的 `QueryExecutor` 完成，不依赖任何数据库客户端，也不 import drizzle-orm（仅类型层兼容 drizzle Table 的内部形状）。

## 目录约定示例

```
db/
  policies/cases_select.sql      -- create policy ... + enable row level security
  functions/case_create.sql      -- security definer set search_path = public
  triggers/cases_updated_at.sql
  grants/cases.sql
  tests/cases_select.sql         -- pgTAP 或 SQL 冒烟测试
```

```ts
import { defineDatabaseModule } from '@supacloud/db';
import { cases } from './schema'; // drizzle 表对象

export const casesModule = defineDatabaseModule({
  name: 'cases',
  tables: [cases], // 也接受 'public.cases' 字符串
  policies: [
    {
      name: 'cases_select',
      table: 'public.cases',
      operation: 'select',
      roles: ['authenticated'],
      source: 'db/policies/cases_select.sql',
      tests: ['db/tests/cases_select.sql'],
    },
  ],
  functions: [
    {
      name: 'public.case_create',
      source: 'db/functions/case_create.sql',
      security: 'definer',
      permission: 'case.create',
      tests: ['db/tests/case_create.sql'],
    },
  ],
  grants: [
    { object: 'public.cases', privilege: 'SELECT', role: 'authenticated', source: 'db/grants/cases.sql' },
  ],
});
```

## API

| 导出 | 说明 |
| --- | --- |
| `defineDatabaseModule(options)` | 声明一个数据库模块，归一化表名为 `schema.name` |
| `readCatalog(executor, schemas?)` | 通过注入的查询执行器读取 PostgreSQL Catalog（默认 `['public']`，参数化 `$1`） |
| `reconcileModule(module, catalog)` | Manifest 与 Catalog 对账，产出 `ReconcileReport` |
| `lintSql(sql, file)` / `lintModule(module, readFile)` | 纯 SQL 文本静态分析，无需数据库 |
| `buildDatabaseManifest(modules)` | 汇总模块为可 JSON 序列化的 `DatabaseManifest`（version 1） |
| `explainObject(manifest, name)` | 人类可读地解释对象的所属模块、类型、源文件、权限、测试 |

## 诊断码

### 对账（reconcile）

| code | 级别 | 含义 |
| --- | --- | --- |
| `missing-policy` | error | 声明的策略在 catalog 中不存在 |
| `missing-function` | error | 声明的 RPC 函数在 catalog 中不存在 |
| `undeclared-policy` | warn | 归属表上存在 manifest 未声明的策略（漂移） |
| `rls-disabled` | error | 归属表 `relrowsecurity = false` |
| `definer-without-search-path` | error | security definer 函数未设置固定 search_path（含空元素或 `pg_temp` 也算不固定） |
| `security-mismatch` | warn | 声明的 invoker/definer 与 catalog 实际不一致 |
| `wildcard-grant` | error | 归属表上存在授予 `PUBLIC` 的权限 |
| `grant-drift` | warn | 声明的授权在 catalog 中不存在 |

`ReconcileReport.ok = true` 当且仅当没有 error 级问题。

### Lint（静态分析，正则级、大小写不敏感）

| code | 级别 | 含义 |
| --- | --- | --- |
| `definer-no-search-path` | error | 源文件含 `security definer` 但不含 `set search_path` |
| `grant-to-public` | error | `grant ... to public` |
| `missing-rls-enable` | warn | 声明了策略但所有策略源文件都没有 `enable row level security` |
| `drop-without-if-exists` | warn | `drop table/column` 缺少 `if exists` |
| `policy-without-test` | warn | 声明的策略/函数没有 `tests` 条目 |

## 与 Supabase / PostgreSQL 的关系

SupaCloud 兼容 Supabase 的托管 PostgreSQL 模型：`authenticated` / `anon` / `service_role` 角色、RLS 策略、`security definer` RPC 都是治理对象。本包读取的系统目录（`pg_class` / `pg_policy` / `pg_proc` / `information_schema`）是标准 PostgreSQL 接口，因此同样适用于自托管 PostgreSQL；针对 Supabase 风格的角色与 schema 约定没有硬编码依赖。

## 开发

```sh
bun install
bun test            # bun test，同置 *.test.ts
bun run typecheck
bun run typecheck:test
bun run build       # bun build --target node + tsc 声明文件
```

## English

`@supacloud/db` is the SupaCloud database governance layer. It treats RLS policies, RPC functions, triggers, and grants as first-class declarative resources and reconciles them with the real PostgreSQL catalog.

It sits above Drizzle schema and migrations: Drizzle owns table structure, while this package owns security and business objects outside the table definition. The package is driver-independent. Catalog reads use an injected `QueryExecutor`; no database client or `drizzle-orm` runtime dependency is required.

### Example

```ts
import { defineDatabaseModule } from "@supacloud/db";

export const casesModule = defineDatabaseModule({
  name: "cases",
  tables: ["public.cases"],
  policies: [{
    name: "cases_select",
    table: "public.cases",
    operation: "select",
    roles: ["authenticated"],
    source: "db/policies/cases_select.sql",
    tests: ["db/tests/cases_select.sql"],
  }],
});
```

### API

| Export | Description |
|---|---|
| `defineDatabaseModule(options)` | Declare a database module and normalize table names to `schema.name`. |
| `readCatalog(executor, schemas?)` | Read the PostgreSQL catalog through an injected executor. |
| `reconcileModule(module, catalog)` | Compare a manifest module with the live catalog. |
| `lintSql(sql, file)` / `lintModule(module, readFile)` | Run database-independent SQL and module checks. |
| `buildDatabaseManifest(modules)` | Build a JSON-serializable version 1 database manifest. |
| `explainObject(manifest, name)` | Explain an object's module, type, source, permissions, and tests. |

### Checks

Reconciliation detects missing or undeclared policies and functions, disabled RLS, unsafe `security definer` search paths, security mismatches, wildcard grants, and grant drift. SQL linting detects unsafe definer functions, grants to `PUBLIC`, missing RLS enablement, destructive drops without `IF EXISTS`, and policies or functions without tests.

`ReconcileReport.ok` is true only when there are no error-level findings.

### Development

```bash
bun install
bun test
bun run typecheck
bun run typecheck:test
bun run build
```

### License

MIT
