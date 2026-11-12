# @supacloud/db

## Reverse Adoption and Role Guards

`reverseDatabase(executor, schemas)` captures a review-only catalog/column
candidate in a pinned read-only transaction. It does not overwrite sources or
register applied migrations. `readDatabaseRole` and
`assertApplicationRoleRestricted` check selected-schema role privileges and
ownership; `renderDatabaseRoleGuardSql` renders reviewed provisioning SQL without
executing it. Review privileged function entrypoints independently.

The project CLI exposes `db reverse`, `db diff`, `db plan`, `db apply`,
`db role_check` and `db role_sql`. See
[Database Adoption Workflow](../../docs/database-adoption-workflow.md) for the
manual declarative SQL baseline boundary, exact-digest approval and existing-ledger
delivery. These commands do not provide automatic production synchronization
or down migrations.
## ZenStack and Bun SQL

ZenStack and Kysely live in `@supacloud/db-zenstack`. `@supacloud/db/zenstack`
and `@supacloud/db/model` re-export that package. The main export, which the
Management API control plane imports, does not load them. Install
`@supacloud/db-zenstack` in an application that compiles ZModel or hosts the
model transaction. Do not add it as a dependency of `@supacloud/db`.

Author models and data policies in `zenstack/schema.zmodel`, generate contracts
with `supacloud-model generate`, and fail stale builds with `supacloud-model check`.
Install `@supacloud/model-tooling` as a development dependency for this binary;
it owns the ZenStack and PostgreSQL introspection toolchain. Do not add `pg` or
`@zenstackhq/cli` to the application manifest directly.
`supacloud-model pull --candidate <file>` uses the Management API project
binding and never receives a `DATABASE_URL` or opens a PostgreSQL connection.
`supacloud db plan` and `supacloud db apply --approved_digest <digest>` use the
same remote binding and existing SupaCloud deployment ledger; they never expose
database credentials to the user CLI or apply an unreviewed migration.

`pull` also adopts a database that has no maintained model yet: it introspects
through a temporary datasource-only model, so a migrated project does not need a
hand-written `zenstack/schema.zmodel` first. The result is still only a review
candidate; `diff` and `generate` remain unavailable until the reviewed file
(with the policy plugin and `@@allow` rules) is in place.

Construct `createZenStackDatabase(schema, pool, {})` from `@supacloud/db/zenstack`
inside `src/host`. Bind a verified identity using `forIdentity(identity)`; inject
its read-only `models` facade into queries and its `commandStore` into the command
runtime. Command handlers receive `transaction.db` with model writes. Model
writes, receipts and audit share one reserved Bun SQL connection. No facade exposes
raw SQL, plugin controls, identity replacement or nested transactions. The caller
owns `pool.close()`. The internal dialect uses upstream Kysely's PostgreSQL
compiler; cursor streaming is explicitly unsupported.

`@supacloud/db/model-contract` contains the backend-neutral model and command ports.
The ZenStack export is the current trusted-host adapter; it is not the application
architecture or a requirement for every SupaCloud project.
`@supacloud/db/rpc-boundary` checks named Command RPC capabilities against registry,
catalog and explicit historical entries, so generated RPCs remain traceable without
requiring a particular generator.

`defineReadQuery` and `createBunReadDatabase` remain available for reviewed native
platform reads, with result decoders, read-only transactions and timeouts. Keep
least-privilege roles and RLS for all direct PostgREST/RPC access. Model policies
do not replace grants. Row-level `@@allow` / `@@deny` emit `authenticated` RLS, and
`supacloud-db check` fails when the migration ledger does not contain it.

See [the breaking upgrade guide](../../docs/architecture/zenstack-upgrade.md).

`supacloud-sql-impact impact.json --check` analyzes ordered, owned migrations:

```json
{
  "migrations": [
    { "id": "001", "owner": "orders", "path": "migrations/001.sql" }
  ],
  "baseline": []
}
```

Paths are relative to this config. Reports include fingerprints, dependencies,
transitive impact, review reasons and a digest. Persist applied IDs and SHA-256
hashes as `baseline`; deleted, reordered or rewritten history fails validation.
Supply `readSqlDependencyGraph(executor, ["app"])` results as `catalogEdges` and
`catalogReview`. Import this catalog reader from `@supacloud/db/sql-analysis`.

Dynamic SQL, opaque functions, unqualified names and unsupported semantics require
review. This is conservative analysis, not proof of arbitrary SQL safety. Approve
the exact reviewed report via `approvedDigest`; changes invalidate approval, and
approval never overrides history errors. The tool does not execute migrations.

## Durable Commands

`createPostgresCommandStore(database)` implements the protocol's storage ports.
Use `createBunSqlHost` from `@supacloud/db/bun` in the trusted host to create the
platform-owned Bun SQL pool from its runtime settings. Pass `host.pool` to
`createBunCommandDatabase`; application modules receive only their injected
database port and never read or parse `DATABASE_URL`. Call `host.close()` during
shutdown. The helper supports both `DATABASE_URL` and the private Unix socket
settings (`DATABASE_SOCKET_PATH`, `DATABASE_NAME`, `DATABASE_USER`).
This package contains transaction/receipt SQL, Workflow binding, row validation
and input redaction. It does not own a recovery polling queue.

Execution factories moved to `@supacloud/commands`; pass `store` instead of
`database`. Errors moved to `CommandError` in `@supacloud/contracts`. Neither
remote sending nor command orchestration is re-exported here. The DB package
does not depend on the command runtime in production. The model integration regression verifies the shared transaction boundary.

Install the existing PGMQ/Workflow runtime and updated commands-public SQL module,
then `COMMAND_PERSISTENCE_SQL` through a privileged application migration.
Existing unreleased v1 tables require `COMMAND_PERSISTENCE_UPGRADE_SQL`, with old
writers stopped; preserve operation identifiers during cutover.
The upgrade enqueues pending recovery using existing Workflow and removes prototype
lease/backoff columns. Use `createPostgresCommandStore(database, { submission })`
inside a submitted command's execute step to preserve its command ID and atomically
advance to reconciliation (external) or complete its Workflow (transactional).
`submission` carries commandId, stepId, messageId, attempt and workerId. The adapter
checks the current attempt, recorded tenant/actor/command, and original input.
Keep its schema private and supply domain authorization, JSON-stable input/result
decoders and a single-connection transaction adapter. Metadata cannot provide a
distributed transaction. See [migration, deployment and recovery](../../docs/command-migration.md).

For reviewed deployment-time public SQL parameters, see
[Controlled Migration Bindings](./MIGRATION_BINDINGS.md). This opt-in API preserves
model source ownership and the existing executor's migration ledger.

SupaCloud 的数据库治理层：把 RLS 策略、RPC 函数、触发器、授权（grant）作为**一等资源**做声明式管理，并与 PostgreSQL 真实 Catalog 对账。

定位：ZModel 负责业务模型和数据策略，ZenStack 执行模型查询；本包负责 Bun SQL 适配、Command 事务，以及 RLS/RPC 的声明、静态检查和漂移检测。Catalog 读取通过注入的 `QueryExecutor` 完成。

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

export const casesModule = defineDatabaseModule({
  name: 'cases',
  tables: ["public.cases"], // 也接受 'public.cases' 字符串
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

### Typed RPC boundary

`createRpcClient(transport, contracts)` validates arguments before transport and results
before returning them. Names, arguments and results are inferred from the registry;
callers cannot supply an arbitrary result type. It uses the supplied client without
changing its identity, RLS policy or credentials.

```ts
import { createRpcClient, defineRpcContract } from '@supacloud/db';

const rpc = createRpcClient(userDb, {
  case_create: defineRpcContract({
    args: decodeCreateCaseArgs,
    result: decodeCreatedCase,
  }),
});
const result = await rpc.call('case_create', { title: 'Investigation' });
if (result.ok) {
  console.log(result.data);
} else {
  handleDatabaseFailure(result.error);
}
```

Decoders must accept `unknown`, validate it at runtime and throw on invalid values.
They may project extra fields away. Schema libraries such as TypeBox can supply
these functions; this driver-independent package adds no schema-library dependency.
Database failures bypass result decoding. Contract failures throw `RpcContractError`
with a phase and no raw payload or decoder error. Calls are never retried automatically,
including result-validation failures after a potentially committed command.

This is an explicit contract boundary, not inference of JSONB fields from SQL,
authorization, migration execution or automatic HTTP client generation.

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

**与 migration 的边界**：本执行器只管模块声明的**可重复 SQL 对象**（函数/策略/触发器/授权），不做表结构变更 —— 建表、加列等表结构演进仍走前向 migration（reviewed SQL migration 文件）。

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

## Database Source Defaults

`supacloud-db assess|generate|check --root <project>` provides offline source-boundary
assessment, RPC contracts and freshness checks. Use `database.sources.json` to
separate ZModel declarations, maintained function SQL, append-only migrations,
derived contracts and audit output. `check` and `assess` never write or connect;
`generate` only writes derived contracts and refuses changes to recorded migration
history. See the repository's `docs/database-source-contracts.md` for adoption.
