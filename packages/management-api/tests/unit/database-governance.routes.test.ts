import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

const tenantQueries: string[] = [];

const managementDb = mock((strings: TemplateStringsArray) => {
  if (strings.join("?").includes("SELECT db_name, db_user, db_password")) {
    return Promise.resolve([{ db_name: "tenant_db", db_user: "tenant_user", db_password: "test-password" }]);
  }
  return Promise.resolve([]);
});

const tenantDb = Object.assign(
  mock(() => Promise.resolve([])),
  {
    unsafe: mock(async (query: string) => {
      tenantQueries.push(query);
      if (query.includes("WHERE p.prosecdef = true")) {
        return [{ schema_name: "public", function_name: "unsafe_rpc", identity_args: "", proconfig: null }];
      }
      if (query.includes("pg_catalog.obj_description")) {
        return [{
          schema_name: "public",
          function_name: "get_case",
          identity_args: "case_id uuid",
          arguments_display: "case_id uuid",
          return_type: "jsonb",
          language: "sql",
          volatility_char: "s",
          security_definer: false,
          is_strict: true,
          config: null,
          comment: "@api query",
        }];
      }
      return [];
    }),
  },
);

const getProject = mock(async () => ({ ref: "proj_1" }));
const requireProjectOrAdminAuth = mock(async () => undefined);

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

const { databaseRoutes } = await import(
  new URL("../../src/routes/database.ts?database-governance-routes-test", import.meta.url).href,
);
const app = new Elysia().use(databaseRoutes);

function request(path: string) {
  return app.handle(new Request(`http://localhost/v1/projects/proj_1/database/${path}`));
}

describe("database governance routes", () => {
  beforeEach(() => {
    tenantQueries.length = 0;
    managementDb.mockClear();
    tenantDb.mockClear();
    tenantDb.unsafe.mockClear();
    getProject.mockClear();
    requireProjectOrAdminAuth.mockClear();
  });

  test("returns bounded linter results from the selected schema", async () => {
    const response = await request("linter?schema=public");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema: "public",
      total_issues: 1,
      danger_count: 1,
      warning_count: 0,
      info_count: 0,
    });
    expect(tenantQueries.find((query) => query.includes("WHERE p.prosecdef = true"))).toContain(
      "n.nspname = 'public'",
    );
  });

  test("rejects invalid schema selectors before opening the tenant database", async () => {
    const response = await request(`linter?schema=${encodeURIComponent("public; drop schema x")}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_SCHEMA", status: 400 });
    expect(managementDb).not.toHaveBeenCalled();
    expect(tenantQueries).toHaveLength(0);
  });

  test("returns only ordinary functions in the RPC catalog", async () => {
    const response = await request("rpc-catalog?schemas=public,api,public");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemas: ["public", "api"],
      total_rpcs: 1,
      commands: 0,
      queries: 1,
      internal: 0,
    });
    expect(tenantQueries.find((query) => query.includes("pg_catalog.obj_description"))).toContain(
      "p.prokind = 'f'",
    );
  });

  test("rejects excessive RPC schemas before opening the tenant database", async () => {
    const schemas = Array.from({ length: 17 }, (_, index) => `s${index}`).join(",");
    const response = await request(`rpc-catalog?schemas=${schemas}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_SCHEMAS", status: 400 });
    expect(managementDb).not.toHaveBeenCalled();
    expect(tenantQueries).toHaveLength(0);
  });
});
