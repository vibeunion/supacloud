# @supacloud/db

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
import { createDatabaseAccessBoundary, defineDatabaseModule } from '@supacloud/db';
import { requireTrustedIdentity } from '@supacloud/elysia';
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
| `createDatabaseAccessBoundary(options)` | 统一用户 RLS 客户端与显式 service-role 客户端的访问边界 |
| `planModule(module, readFile)` | 把模块声明编译为有序 `ModulePlan`（step 依赖序：function → policy → trigger → grant），含 sha256 与 lint 风险 |
| `applyModulePlan(executor, plan)` | 按 plan 落库：账本幂等 + advisory lock + 单事务 + catalog 回读验证 |

### 数据库访问边界

业务请求只应通过 `forUser({ subject, accessToken })` 创建 RLS-preserving 客户端；
后台任务才可以通过 `forService("declared-reason")` 获取缓存的 service-role 客户端。
service-role 原因必须预先加入 `allowedServiceReasons`，缺少身份、令牌或理由时会 fail-closed。

```ts
const database = createDatabaseAccessBoundary({
  createUserClient: ({ accessToken }) => createSupabaseClient(accessToken),
  createServiceClient: () => createServiceRoleClient(),
  allowedServiceReasons: ["scheduled-worker", "migration-check"],
});

const userDb = await database.forUser(requireTrustedIdentity(requestContext));
const workerDb = await database.forService("scheduled-worker");
```

## 诊断码

### 对账（reconcile）

| code | 级别 | 含义 |
| --- | --- | --- |
| `missing-policy` | error | 声明的策略在 catalog 中不存在 |
| `missing-function` | error | 声明的 RPC 函数在 catalog 中不存在 |
| `missing-trigger` | error | 声明的触发器在 catalog 中不存在（按 schema.table + name 匹配） |
| `undeclared-policy` | warn | 归属表上存在 manifest 未声明的策略（漂移） |
| `undeclared-trigger` | warn | 归属表上存在 manifest 未声明的触发器（含已禁用的，漂移） |
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
| `non-idempotent-policy` | warn | `create policy` 前缺少 `drop policy if exists`（PostgreSQL CREATE POLICY 无 IF NOT EXISTS，不先 drop 就不可重复执行） |
| `policy-without-test` | warn | 声明的策略/函数没有 `tests` 条目 |

## Plan / Apply

`planModule` 把模块声明编译为 `ModulePlan`（version 1）：每个声明对象（函数/策略/触发器/授权）对应一个 `PlanStep`，按依赖序 **function → policy → trigger → grant** 排列；每个 step 携带源文件内容的 sha256、`lintSql` 静态分析得出的 `risk`（error 级 lint 原样保留 severity=error），plan 级 `digest` 为全部 step sha256 的组合哈希。step 的 `name` 是对象标识：函数为 schema 限定名，策略/触发器为 `table.name`，授权为 `object:privilege:role`。

`applyModulePlan` 的语义：

1. plan 含任何 error 级 risk → 直接抛错拒绝执行，不触碰数据库。
2. 确保账本：`create schema if not exists _supacloud` + `create table if not exists _supacloud.db_object_ledger(object_identity text primary key, module text, sha256 text, applied_at timestamptz default now())`。
3. `pg_advisory_lock(hashtext('supacloud-db-apply'))` 串行化并发 apply，`finally` 中 unlock。
4. 单事务内逐 step 执行：`object_identity = ${kind}:${name}` 查账本，sha256 一致则 `skipped`；否则执行 step.sql 并 upsert 账本。任何 step 失败 → ROLLBACK 并返回 `failed`；全成功 → COMMIT。
5. 提交后 `readCatalog` 回读验证声明对象真实存在，结果进 `verified`，缺失进 `failed`。

**幂等要求**：step.sql 必须可重复执行（`create or replace function`、`drop policy if exists` + `create policy`、`drop trigger if exists` + `create trigger`、`grant` 天然幂等）。sha256 一致即跳过，因此改源文件才会触发重放。executor 提供可选 `transaction(fn)` 时用它管理事务，否则退化为顺序执行 `begin/commit/rollback` 语句。

**与 migration 的边界**：本执行器只管模块声明的**可重复 SQL 对象**（函数/策略/触发器/授权），不做表结构变更 —— 建表、加列等表结构演进仍走前向 migration（Drizzle/SQL migration 文件）。

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
