import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import {
  clearActiveSqlQueriesForTests,
  runRegisteredSqlQuery,
} from "../../src/db/sql-query-registry";

const executeQuery = mock(async () => ({
  rows: [{ ok: 1 }],
  rowCount: 1,
  command: "SELECT",
  fields: ["ok"],
  notices: [],
  durationMs: 1,
}));
const managementDb = mock((strings: TemplateStringsArray) => {
  if (strings.join("?").includes("SELECT db_name, db_user, db_password")) {
    return Promise.resolve([{
      db_name: "shared_tenant_db",
      db_user: "tenant_user",
      db_password: "test-password",
    }]);
  }
  return Promise.resolve([]);
});
const getProject = mock(async (ref: string) => ({ ref }));
const requireAdminAuth = mock(async () => undefined);
const requireProjectOrAdminAuth = mock(async () => undefined as undefined | {
  status: number;
  body: { error: string };
});
const rlsUnsafe = mock(async (query: string) => {
  if (query.startsWith("EXPLAIN")) {
    return [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan", Schema: "public", "Relation Name": "todos" } }] }];
  }
  if (query.includes("pg_stat_statements")) {
    return [{ query: "select 1", calls: 4, total_exec_time: 12, mean_exec_time: 3, rows: 4 }];
  }
  return Array.from({ length: 501 }, (_, index) => ({ id: index + 1 }));
});
const schemaReloadQueries: Array<{ text: string; values: unknown[] }> = [];
let schemaReloadShouldFail = false;
const rlsConnection = Object.assign(
  ((..._args: unknown[]) => Promise.resolve([])) as unknown as Record<string, unknown>,
  { unsafe: rlsUnsafe, release: mock(() => undefined) },
);
const rlsDb = Object.assign(
  ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    if (sql.includes("pg_notify")) {
      schemaReloadQueries.push({ text: sql, values });
      if (schemaReloadShouldFail) return Promise.reject(new Error("schema reload unavailable"));
    }
    if (sql.includes("FROM pg_extension")) {
      return Promise.resolve([{ schema_name: "extensions", has_view: true }]);
    }
    if (sql.includes("pg_policies")) {
      return Promise.resolve([{ schemaname: "public", tablename: "todos", policyname: "owner", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "SELECT", qual: "(owner_id = auth.uid())", with_check: null }]);
    }
    if (sql.includes("pg_class")) {
      return Promise.resolve([{ schemaname: "public", tablename: "todos", relrowsecurity: true, relforcerowsecurity: false }]);
    }
    return Promise.resolve([]);
  }) as unknown as Record<string, unknown>,
  {
    reserve: mock(async () => rlsConnection),
    unsafe: rlsUnsafe,
    begin: mock(async (operation: (transaction: typeof rlsDb) => Promise<unknown>) => operation(rlsDb)),
  },
);
const getProjectDb = mock(() => rlsDb);
const getProjectRoleDb = mock(() => rlsDb);
const withProjectMigrationLocks = mock(async (_scope: unknown, operation: () => Promise<unknown>) => operation());
const assertInactive = mock(async () => undefined);

const actualDb = await import("../../src/db");
mock.module("../../src/db", () => ({
  ...actualDb,
  db: { ...actualDb.db, executeQuery },
  sql: managementDb,
  getProjectDb,
  getProjectRoleDb,
}));
mock.module("../../src/services", () => ({ projectService: { getProject } }));
const actualLock = await import("../../src/services/migration-lock");
mock.module("../../src/services/migration-lock", () => ({
  ...actualLock,
  withProjectMigrationLocks,
}));
const actualJournal = await import("../../src/services/branch-replacement-journal");
mock.module("../../src/services/branch-replacement-journal", () => ({
  ...actualJournal,
  branchReplacementJournal: { assertInactive },
}));
mock.module("../../src/middleware/auth", () => ({
  requireAdminAuth,
  requireProjectOrAdminAuth,
}));
mock.module("../../src/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { databaseRoutes } = await import(
  new URL("../../src/routes/database.ts?database-sql-routes-test", import.meta.url).href,
);
const app = new Elysia().use(databaseRoutes);
const queryId = "shared-query-id-123456";

function request(ref: string, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost/v1/projects/${ref}/database${path}`, init));
}

function executeSql(ref: string, scopedQueryId = queryId) {
  return request(ref, "/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "SELECT 1", query_id: scopedQueryId }),
  });
}

describe("database SQL routes", () => {
  beforeEach(() => {
    clearActiveSqlQueriesForTests();
    executeQuery.mockClear();
    managementDb.mockClear();
    rlsUnsafe.mockClear();
    rlsConnection.release.mockClear();
    schemaReloadQueries.length = 0;
    schemaReloadShouldFail = false;
    rlsDb.begin.mockClear();
    rlsDb.reserve.mockClear();
    getProjectDb.mockClear();
    getProjectRoleDb.mockClear();
    getProject.mockClear();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(undefined);
    withProjectMigrationLocks.mockClear();
    assertInactive.mockClear();
  });

  test("authenticates SQL execution before project lookup", async () => {
    requireProjectOrAdminAuth.mockResolvedValueOnce({
      status: 401,
      body: { error: "Unauthorized" },
    });

    const response = await executeSql("project-a");

    expect(response.status).toBe(401);
    expect(getProject).not.toHaveBeenCalled();
    expect(managementDb).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  test("rejects a non-member before SQL execution", async () => {
    requireProjectOrAdminAuth.mockResolvedValueOnce({
      status: 403,
      body: { error: "Project access denied" },
    });

    const response = await executeSql("project-a");

    expect(response.status).toBe(403);
    expect(getProject).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  test("rejects a non-member before cancellation lookup", async () => {
    let releaseQuery!: () => void;
    let cancelCalls = 0;
    const execution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId,
      query: {
        execute: () => new Promise<void>((resolve) => { releaseQuery = resolve; }),
      },
      cancel: async () => { cancelCalls += 1; return true; },
      startedAt: performance.now(),
    });
    requireProjectOrAdminAuth.mockResolvedValueOnce({
      status: 403,
      body: { error: "Project access denied" },
    });

    const response = await request("project-a", `/sql/${queryId}/cancel`, { method: "POST" });

    expect(response.status).toBe(403);
    expect(cancelCalls).toBe(0);
    expect(getProject).not.toHaveBeenCalled();
    releaseQuery();
    await execution;
  });

  test("passes the authenticated project ref as the cancellation scope", async () => {
    expect((await executeSql("project-a")).status).toBe(200);
    expect((await executeSql("project-b")).status).toBe(200);

    expect(executeQuery.mock.calls).toEqual([
      ["shared_tenant_db", "SELECT 1", {
        mode: "read",
        projectRef: "project-a",
        queryId,
        username: "tenant_user",
        password: "test-password",
      }],
      ["shared_tenant_db", "SELECT 1", {
        mode: "read",
        projectRef: "project-b",
        queryId,
        username: "tenant_user",
        password: "test-password",
      }],
    ]);
  });

  test("sends a schema reload after migration-mode SQL", async () => {
    const response = await request("project-a", "/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "CREATE TABLE public.items(id bigint)", mode: "migration" }),
    });

    expect(response.status).toBe(200);
    expect(executeQuery).toHaveBeenCalledWith("shared_tenant_db", "CREATE TABLE public.items(id bigint)", {
      mode: "migration",
      username: "tenant_user",
      password: "test-password",
    });
    expect(getProjectDb).toHaveBeenCalledWith("shared_tenant_db");
    expect(schemaReloadQueries.some(({ values }) => values.includes("pgrst_project-a"))).toBe(true);
    expect(await response.json()).toMatchObject({
      schema_reload: { status: "notified", ddl_committed: true },
    });
  });

  test("sends a schema reload after admin-mode DDL", async () => {
    executeQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: "ALTER",
      fields: [],
      notices: [],
      durationMs: 1,
    });

    const response = await request("project-a", "/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "ALTER TABLE public.items ADD COLUMN name text", mode: "admin", admin: true }),
    });

    expect(response.status).toBe(200);
    expect(requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(getProjectDb).toHaveBeenCalledWith("shared_tenant_db");
    expect(schemaReloadQueries.some(({ values }) => values.includes("pgrst_project-a"))).toBe(true);
  });

  test("detects admin DDL from the submitted SQL when the driver reports the final command", async () => {
    const response = await request("project-a", "/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sql: "CREATE TABLE public.items(id bigint); SELECT 1",
        mode: "admin",
        admin: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(schemaReloadQueries.some(({ values }) => values.includes("pgrst_project-a"))).toBe(true);
  });

  test("does not claim committed DDL for admin SQL with caller-controlled transactions", async () => {
    const response = await request("project-a", "/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sql: "BEGIN; CREATE TABLE public.items(id bigint); ROLLBACK;",
        mode: "admin",
        admin: true,
      }),
    });
    const payload = await response.json() as { schema_reload?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.schema_reload).toMatchObject({ status: "notified" });
    expect(payload.schema_reload).not.toHaveProperty("ddl_committed");
  });

  test.each([
    "CALL public.rollback_schema_change()",
    "DO $$ BEGIN EXECUTE 'CREATE TABLE public.items(id bigint)'; ROLLBACK; END $$",
  ])("does not claim committed DDL for indirect admin SQL: %s", async (sql) => {
    executeQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: sql.startsWith("CALL") ? "CALL" : "DO",
      fields: [],
      notices: [],
      durationMs: 1,
    });

    const response = await request("project-a", "/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, mode: "admin", admin: true }),
    });
    const payload = await response.json() as { schema_reload?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.schema_reload).toMatchObject({ status: "notified" });
    expect(payload.schema_reload).not.toHaveProperty("ddl_committed");
  });

  test("returns an explicit partial-success receipt when schema reload notification fails", async () => {
    schemaReloadShouldFail = true;

    const response = await request("project-a", "/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "ALTER TABLE public.items ADD COLUMN note text", mode: "migration" }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      schema_reload: { status: "notification_failed", ddl_committed: true },
    });
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  test("creates and drops materialized views with transactional schema reloads", async () => {
    const createResponse = await request("project-a", "/materialized-views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "public",
        name: "orders_daily",
        definition: "SELECT current_date AS day",
        withData: false,
      }),
    });
    const dropResponse = await request(
      "project-a",
      "/materialized-views/public/orders_daily?if_exists=true",
      { method: "DELETE" },
    );

    expect(createResponse.status).toBe(201);
    expect(dropResponse.status).toBe(200);
    expect(rlsDb.begin).toHaveBeenCalledTimes(2);
    expect(rlsUnsafe.mock.calls.some((call) => String(call[0]).startsWith("CREATE MATERIALIZED VIEW"))).toBe(true);
    expect(rlsUnsafe.mock.calls.some((call) => String(call[0]).startsWith("DROP MATERIALIZED VIEW"))).toBe(true);
    expect(schemaReloadQueries.filter(({ values }) => values.includes("pgrst_project-a"))).toHaveLength(2);
  });

  test("reads query performance through a fixed admin-only statistics query", async () => {
    const response = await request("project-a", "/query-performance");
    const body = await response.json() as { installed: boolean; rows: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.installed).toBe(true);
    expect(body.rows).toEqual([{ query: "select 1", calls: 4, total_exec_time: 12, mean_exec_time: 3, rows: 4 }]);
    expect(getProjectDb).toHaveBeenCalledWith("shared_tenant_db");
    expect(executeQuery).not.toHaveBeenCalled();
  });

  test("does not cancel another project query sharing the same query ID", async () => {
    let releaseQuery!: () => void;
    let cancelCalls = 0;
    const execution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId,
      query: {
        execute: () => new Promise<void>((resolve) => { releaseQuery = resolve; }),
      },
      cancel: async () => { cancelCalls += 1; return true; },
      startedAt: performance.now(),
    });

    const crossProject = await request("project-b", `/sql/${queryId}/cancel`, { method: "POST" });
    expect(crossProject.status).toBe(404);
    expect(cancelCalls).toBe(0);

    const ownerProject = await request("project-a", `/sql/${queryId}/cancel`, { method: "POST" });
    expect(ownerProject.status).toBe(200);
    expect(cancelCalls).toBe(1);

    releaseQuery();
    await execution;
  });

  test("does not report success when PostgreSQL rejects cancellation", async () => {
    let releaseQuery!: () => void;
    const execution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId,
      query: {
        execute: () => new Promise<void>((resolve) => { releaseQuery = resolve; }),
      },
      cancel: async () => false,
      startedAt: performance.now(),
    });

    const response = await request("project-a", `/sql/${queryId}/cancel`, { method: "POST" });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.code).toBe("QUERY_CANCEL_NOT_CONFIRMED");
    expect(payload).not.toHaveProperty("cancelled", true);
    releaseQuery();
    await execution;
  });

  test("returns an error when the cancellation control query fails", async () => {
    let releaseQuery!: () => void;
    const execution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId,
      query: {
        execute: () => new Promise<void>((resolve) => { releaseQuery = resolve; }),
      },
      cancel: async () => { throw new Error("control connection failed"); },
      startedAt: performance.now(),
    });

    const response = await request("project-a", `/sql/${queryId}/cancel`, { method: "POST" });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload.code).toBe("QUERY_CANCEL_FAILED");
    expect(payload).not.toHaveProperty("cancelled", true);
    releaseQuery();
    await execution;
  });

  test("rejects invalid query IDs before route side effects", async () => {
    const executeResponse = await executeSql("project-a", "short");
    const cancelResponse = await request("project-a", "/sql/short/cancel", { method: "POST" });

    expect(executeResponse.status).toBe(422);
    expect(cancelResponse.status).toBe(422);
    expect(requireProjectOrAdminAuth).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  test("runs RLS Tester with bounded results and transaction safety settings", async () => {
    const response = await request("project-a", "/rls-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "select * from public.todos",
        role: "authenticated",
        user_id: "00000000-0000-4000-8000-000000000001",
        email: "user@example.com",
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect((body.rows as unknown[]).length).toBe(500);
    expect(body.truncated).toBe(true);
    expect(body.relationSecurity).toEqual([{ schema: "public", table: "todos", rlsEnabled: true, rlsForced: false }]);
    expect(getProjectRoleDb).toHaveBeenCalledWith("shared_tenant_db", "authenticator_project-a", "test-password");
    expect(rlsUnsafe.mock.calls.map(([query]) => query)).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SET LOCAL row_security = on",
      "SET LOCAL statement_timeout = '10s'",
      "SET LOCAL lock_timeout = '1s'",
      "SET LOCAL idle_in_transaction_session_timeout = '15s'",
      "SET LOCAL ROLE authenticated",
      "EXPLAIN (FORMAT JSON, VERBOSE TRUE) select * from public.todos",
      'SELECT * FROM (\nselect * from public.todos\n) AS "__supacloud_rls_test" LIMIT 501',
      "ROLLBACK",
    ]);
    expect(rlsConnection.release).toHaveBeenCalledTimes(1);
  });

  test("rejects unsafe RLS SQL before opening a tenant connection", async () => {
    const response = await request("project-a", "/rls-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "select pg_sleep(30)", role: "anon" }),
    });
    expect(response.status).toBe(400);
    expect(rlsDb.reserve).not.toHaveBeenCalled();
  });
});
