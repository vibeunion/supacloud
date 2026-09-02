# @supacloud/testing

[English](#english) | [中文](#中文)

## English

Testing utilities for SupaCloud applications. The package is dependency-free:
all inputs are accepted through structural typing, so it works with
`@supacloud/app` metadata, Elysia apps and any SQL executor without importing
them (npm-publish safe — no `file:` dependencies).

## Provider overrides — `createTestModule`

Instantiate a module with a lightweight container and replace any provider
with a fake. Deps are read from the static metadata written by
`@Injectable()` / `@Inject()` (`supacloud:injectable`, `supacloud:inject-params`)
or from explicit `deps` on object providers.

```ts
import { createTestModule } from "@supacloud/testing";

const container = createTestModule(caseModuleMeta, [
  { token: CASE_REPOSITORY, useValue: fakeRepository },
]);

const command = container.createCaseCommand as CreateCaseCommand;
// command's transitive CASE_REPOSITORY dependency is the fake.
```

Result keys are derived from the token: `InjectionToken` names are camelCased
(`'case.repository'` → `caseRepository`), classes use the class name with a
lowercase first letter. `tokenKey(token)` exposes the same mapping for
assertions. Circular dependencies throw with the ring path. Only
application-level instantiation is supported — re-create request/job scoped
providers yourself with a context object.

## HTTP helpers — `testRequest` / `testJson`

Dispatch in-memory requests against any fetch-style handle (Elysia included):

```ts
import { testJson, testRequest } from "@supacloud/testing";

const res = await testRequest(app, "/health");
const { status, body } = await testJson<{ id: string }>(app, "/cases", {
  method: "POST",
  body: JSON.stringify({ title: "hello" }),
});
```

## SQL tests and RLS assertions — `runSqlTests`, `assertPolicyAllows`, `assertPolicyDenies`

Write SQL tests as files with `-- @test <name>` segments; each segment runs in
a `BEGIN`/`ROLLBACK` transaction. Add `-- @expect error` to a segment that
must fail:

```sql
-- @test owner can read own cases
SELECT * FROM cases;

-- @test anonymous cannot insert
-- @expect error
INSERT INTO cases (title) VALUES ('x');
```

```ts
import { assertPolicyDenies, assertPolicyAllows, runSqlTests } from "@supacloud/testing";

const results = await runSqlTests(executor, ["sql/cases.test.sql"]);
expect(results.every((r) => r.passed)).toBe(true);

await assertPolicyAllows(userExecutor, "SELECT * FROM cases WHERE id = $1", { params: [id] });
await assertPolicyDenies(anonExecutor, "DELETE FROM cases"); // throws, or returns 0 rows
```

`SqlExecutor` is structural (`query(sql, params)`), so postgres.js, `pg` or a
fake all work.

## 中文

`@supacloud/testing` 为 SupaCloud 应用提供测试工具。它是无依赖包：所有输入都使用结构类型，因此可以与 `@supacloud/app` 元数据、Elysia 应用以及任意 SQL executor 配合使用，不会产生 `file:` 依赖。

### Provider 覆盖：`createTestModule`

使用轻量级容器实例化模块，并用 fake 替换任意 provider：

```ts
import { createTestModule } from "@supacloud/testing";

const container = createTestModule(caseModuleMeta, [
  { token: CASE_REPOSITORY, useValue: fakeRepository },
]);
```

结果 key 根据 token 推导：`InjectionToken` 名称会转为 camelCase，类名只把首字母小写。循环依赖会带环路路径抛出。该工具只支持 application-level 实例化；request/job provider 需要结合 context 自行创建。

### HTTP 工具：`testRequest` / `testJson`

可以对任意 fetch 风格的 handle（包括 Elysia）发送内存请求：

```ts
const res = await testRequest(app, "/health");
const { status, body } = await testJson(app, "/cases", {
  method: "POST",
  body: JSON.stringify({ title: "hello" }),
});
```

### SQL 测试与 RLS 断言

SQL 文件可以使用 `-- @test <name>` 分段，每段在 `BEGIN` / `ROLLBACK` 事务中执行；使用 `-- @expect error` 标记必须失败的片段。`assertPolicyAllows` 和 `assertPolicyDenies` 分别用于验证策略允许与拒绝访问。

`SqlExecutor` 只要求提供结构化的 `query(sql, params)` 方法，因此 postgres.js、`pg` 或测试 fake 都可以使用。
