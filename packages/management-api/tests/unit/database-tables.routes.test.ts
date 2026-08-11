import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

type QueryCall = { text: string; values: unknown[] };

const tableQueries: QueryCall[] = [];
const unsafeQueries: string[] = [];
let tableRows: Array<Record<string, unknown>> = [];
let columnRows: Array<Record<string, unknown>> = [];
let rowPageRows: Array<Record<string, unknown>> = [];
let rowCount = 0;
let tableQueryError: Error | null = null;

const managementDb = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  if (text.includes("SELECT db_name, db_user, db_password")) {
    return Promise.resolve([{ db_name: "tenant_db", db_user: "tenant_user", db_password: "test-password" }]);
  }
  return Promise.resolve([]);
});

const tenantUnsafe = mock(async (query: string) => {
  unsafeQueries.push(query);
  if (tableQueryError) throw tableQueryError;
  if (query.includes("count(*)")) return [{ count: String(rowCount) }];
  return rowPageRows;
});

const tenantDb = Object.assign(
  mock((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    tableQueries.push({ text, values });
    if (tableQueryError) return Promise.reject(tableQueryError);
    if (text.includes("FROM information_schema.columns")) return Promise.resolve(columnRows);
    return Promise.resolve(tableRows);
  }),
  { unsafe: tenantUnsafe },
);

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

function tableRequest(path: string, query = "") {
  return request(`/${path}${query}`);
}

describe("database table list route", () => {
  beforeEach(() => {
    tableQueries.length = 0;
    unsafeQueries.length = 0;
    tableRows = [];
    columnRows = [];
    rowPageRows = [];
    rowCount = 0;
    tableQueryError = null;
    managementDb.mockClear();
    tenantDb.mockClear();
    tenantUnsafe.mockClear();
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
    expect(tableQueries[0]?.text).toContain("GREATEST(c.reltuples::bigint, 0) AS row_estimate");
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

  test("returns primary-key metadata for existing quoted identifiers", async () => {
    columnRows = [
      {
        column_name: "tenant_id",
        data_type: "uuid",
        udt_name: "uuid",
        is_nullable: "NO",
        column_default: null,
        is_primary_key: true,
        primary_key_position: 1,
      },
    ];

    const response = await tableRequest(`public/${encodeURIComponent('a"b')}/columns`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: columnRows });
    expect(tableQueries).toHaveLength(1);
    expect(tableQueries[0]).toMatchObject({ values: ["public", 'a"b'] });
    expect(tableQueries[0]?.text).toContain("FROM information_schema.columns");
    expect(tableQueries[0]?.text).toContain("information_schema.table_constraints");
    expect(tableQueries[0]?.text).toContain("information_schema.key_column_usage");
    expect(tableQueries[0]?.text).toContain("PRIMARY KEY");
    expect(tableQueries[0]?.text).toContain("ordinal_position");
    expect(tableQueries[0]?.text).not.toContain('a"b');
  });

  test("rejects invalid existing identifiers before opening the project database", async () => {
    const response = await tableRequest("public/bad%00name/rows");

    expect(response.status).toBe(400);
    expect(managementDb).not.toHaveBeenCalled();
    expect(tableQueries).toHaveLength(0);
    expect(unsafeQueries).toHaveLength(0);
  });

  test("returns safe errors while retaining redacted column and row diagnostics", async () => {
    tableQueryError = Object.assign(
      new Error("postgres://admin:secret@db.internal/app password=secret token=secret"),
      { code: "28P01" },
    );

    const columnsResponse = await tableRequest("public/events/columns");
    expect(columnsResponse.status).toBe(500);
    expect(await columnsResponse.json()).toEqual({
      message: "Failed to list columns",
      code: "500",
      status: 500,
    });

    const rowsResponse = await tableRequest("public/events/rows");
    expect(rowsResponse.status).toBe(500);
    expect(await rowsResponse.json()).toEqual({
      message: "Failed to fetch rows",
      code: "500",
      status: 500,
    });

    expect(loggerError).toHaveBeenCalledTimes(2);
    for (const [, details] of loggerError.mock.calls) {
      expect(details).toMatchObject({ projectRef: "proj_1", errorCode: "28P01" });
      expect(details.errorMessage).toContain("postgres://[REDACTED]@db.internal/app");
      expect(details.errorMessage).not.toContain("secret");
    }
  });

  test("orders offset pages by composite primary-key position and safely quotes identifiers", async () => {
    columnRows = [
      { column_name: "first_key", is_primary_key: true, primary_key_position: 2 },
      { column_name: 'second"key', is_primary_key: true, primary_key_position: 1 },
      { column_name: "payload", is_primary_key: false, primary_key_position: null },
    ];
    rowPageRows = [{ first_key: 1, 'second"key': 2, payload: "ok" }];
    rowCount = 7;
    const tableName = 'events"; DROP TABLE audit_log; --';

    const response = await tableRequest(
      `public/${encodeURIComponent(tableName)}/rows`,
      "?_page=2&_limit=2",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: rowPageRows, total: 7 });
    expect(tableQueries).toHaveLength(1);
    expect(tableQueries[0]).toMatchObject({ values: ["public", tableName] });
    expect(unsafeQueries).toHaveLength(2);
    expect(unsafeQueries[0]).toContain(
      'FROM "public"."events""; DROP TABLE audit_log; --" ORDER BY "second""key", "first_key" LIMIT 2 OFFSET 2',
    );
    expect(unsafeQueries[0]).not.toContain('"events"; DROP TABLE');
    expect(unsafeQueries[1]).toContain(
      'SELECT count(*) as count FROM "public"."events""; DROP TABLE audit_log; --"',
    );
  });

  test("uses a deterministic physical fallback when a table has no primary key", async () => {
    columnRows = [{ column_name: "payload", is_primary_key: false, primary_key_position: null }];
    rowPageRows = [{ payload: "first" }];
    rowCount = 1;

    const response = await tableRequest("public/events/rows");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: rowPageRows, total: 1 });
    expect(unsafeQueries[0]).toContain(
      'SELECT * FROM "public"."events" ORDER BY tableoid, ctid LIMIT 50 OFFSET 0',
    );
  });

  test("applies only allowlisted table-column sorters", async () => {
    columnRows = [
      { column_name: "created_at", is_primary_key: false, primary_key_position: null },
      { column_name: "tenant_id", is_primary_key: true, primary_key_position: 1 },
      { column_name: "id", is_primary_key: true, primary_key_position: 2 },
    ];

    const response = await tableRequest("public/events/rows", "?_sort=created_at&_order=desc");

    expect(response.status).toBe(200);
    expect(unsafeQueries[0]).toContain('ORDER BY "created_at" DESC, "tenant_id", "id"');

    unsafeQueries.length = 0;
    const partialPrimaryKey = await tableRequest(
      "public/events/rows",
      "?_sort=created_at,tenant_id&_order=desc,desc",
    );
    expect(partialPrimaryKey.status).toBe(200);
    expect(unsafeQueries[0]).toContain('ORDER BY "created_at" DESC, "tenant_id" DESC, "id"');

    columnRows = [
      { column_name: "created_at", is_primary_key: false, primary_key_position: null },
    ];
    unsafeQueries.length = 0;
    const physicalTieBreaker = await tableRequest(
      "public/events/rows",
      "?_sort=created_at&_order=desc",
    );
    expect(physicalTieBreaker.status).toBe(200);
    expect(unsafeQueries[0]).toContain('ORDER BY "created_at" DESC, tableoid, ctid');

    unsafeQueries.length = 0;
    const rejected = await tableRequest(
      "public/events/rows",
      `?_sort=${encodeURIComponent('created_at; drop table audit_log')}&_order=desc`,
    );
    expect(rejected.status).toBe(400);
    expect(unsafeQueries).toHaveLength(0);
  });
});
