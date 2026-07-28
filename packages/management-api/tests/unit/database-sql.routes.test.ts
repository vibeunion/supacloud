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
const requireProjectOrAdminAuth = mock(async () => undefined as undefined | {
  status: number;
  body: { error: string };
});

const actualDb = await import("../../src/db");
mock.module("../../src/db", () => ({
  ...actualDb,
  db: { ...actualDb.db, executeQuery },
  sql: managementDb,
}));
mock.module("../../src/services", () => ({ projectService: { getProject } }));
mock.module("../../src/middleware/auth", () => ({
  requireAdminAuth: mock(async () => undefined),
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
    getProject.mockClear();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);
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
});
