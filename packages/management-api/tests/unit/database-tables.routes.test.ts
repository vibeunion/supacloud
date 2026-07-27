import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

type QueryCall = { text: string; values: unknown[] };

const tableQueries: QueryCall[] = [];
let tableRows: Array<Record<string, unknown>> = [];
let tableQueryError: Error | null = null;

const managementDb = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  if (text.includes("SELECT db_name, db_user, db_password")) {
    return Promise.resolve([{ db_name: "tenant_db", db_user: "tenant_user", db_password: "test-password" }]);
  }
  return Promise.resolve([]);
});

const tenantDb = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  tableQueries.push({ text: strings.join("?"), values });
  if (tableQueryError) return Promise.reject(tableQueryError);
  return Promise.resolve(tableRows);
});

const getProject = mock(async () => ({ ref: "proj_1" }));
const requireProjectOrAdminAuth = mock(async () => undefined);
const loggerError = mock(() => undefined);

const actualDb = await import("../../src/db");
mock.module("../../src/db", () => ({
  ...actualDb,
  sql: managementDb,
  getProjectRoleDb: mock(() => tenantDb),
}));
mock.module("../../src/services", () => ({ projectService: { getProject } }));
mock.module("../../src/middleware/auth", () => ({
  requireAdminAuth: mock(async () => undefined),
  requireProjectOrAdminAuth,
}));
mock.module("../../src/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: loggerError,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { databaseRoutes } = await import(
  new URL("../../src/routes/database.ts?database-tables-routes-test", import.meta.url).href,
);
const app = new Elysia().use(databaseRoutes);

function request(query = "", init?: RequestInit) {
  return app.handle(new Request(`http://localhost/v1/projects/proj_1/database/tables${query}`, init));
}

describe("database table list route", () => {
  beforeEach(() => {
    tableQueries.length = 0;
    tableRows = [];
    tableQueryError = null;
    managementDb.mockClear();
    tenantDb.mockClear();
    getProject.mockClear();
    requireProjectOrAdminAuth.mockClear();
    loggerError.mockClear();
  });

  test("lists quoted identifiers through catalogs without constructing a regclass name", async () => {
    tableRows = [
      { table_name: 'a"b', table_schema: "public", table_type: "BASE TABLE", row_estimate: 2 },
      { table_name: "plain", table_schema: "public", table_type: "BASE TABLE", row_estimate: 5 },
    ];

    const response = await request("?_page=1&_limit=10");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: tableRows, total: 2 });
    expect(tableQueries).toHaveLength(1);
    expect(tableQueries[0]).toMatchObject({ values: ["%%"] });
    expect(tableQueries[0]?.text).toContain("FROM pg_class AS c");
    expect(tableQueries[0]?.text).toContain("JOIN pg_namespace AS n ON n.oid = c.relnamespace");
    expect(tableQueries[0]?.text).toContain("c.reltuples::bigint AS row_estimate");
    expect(tableQueries[0]?.text).not.toContain("::regclass");
    expect(tableQueries[0]?.text).not.toContain("information_schema.tables");
  });

  test("uses the same catalog query when searching for a quoted identifier", async () => {
    tableRows = [{ table_name: 'a"b', table_schema: "public", table_type: "BASE TABLE", row_estimate: 2 }];

    const response = await request(`?q=${encodeURIComponent('a"b')}&_page=1&_limit=10`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: tableRows, total: 1 });
    expect(tableQueries).toHaveLength(1);
    expect(tableQueries[0]).toMatchObject({ values: ['%a"b%'] });
    expect(tableQueries[0]?.text).toContain("FROM pg_class AS c");
    expect(tableQueries[0]?.text).not.toContain("::regclass");
  });

  test("keeps the safe 500 response while logging redacted database details", async () => {
    tableQueryError = Object.assign(new Error("connection failed password=super-secret"), { code: "08006" });

    const response = await request();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: "Failed to list tables",
      code: "500",
      status: 500,
    });
    expect(loggerError).toHaveBeenCalledWith("[database] failed to list tables", {
      projectRef: "proj_1",
      errorCode: "08006",
      errorMessage: "connection failed password=[REDACTED]",
    });
  });

  test("rejects invalid table definitions before opening a database connection", async () => {
    const response = await request("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "orders; drop table users",
        columns: [{ name: "id", type: "bigint", primaryKey: true, identity: true }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "name must be a PostgreSQL identifier",
      code: "invalid_table_definition",
      status: 400,
    });
    expect(managementDb).not.toHaveBeenCalled();
  });
});
