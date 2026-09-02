# @supacloud/testing

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

## HTTP helpers — `testRequest` / `testJson` / `testJsonError`

Dispatch in-memory requests against any fetch-style handle (Elysia included):

```ts
import { testJson, testJsonError, testRequest } from "@supacloud/testing";

const res = await testRequest(app, "/health");
const { status, body } = await testJson<{ id: string }>(app, "/cases", {
  method: "POST",
  body: JSON.stringify({ title: "hello" }),
});

await testJsonError(app, "/cases/forbidden", {
  status: 403,
  code: "FORBIDDEN",
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
