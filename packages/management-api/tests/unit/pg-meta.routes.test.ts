import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const findByRef = mock(() => Promise.resolve(null));
// getProjectDb returns an object with .unsafe(query) that returns rows.
const unsafe = mock(() => Promise.resolve([]));
const resolveDbName = mock(() => Promise.resolve("supa_test"));

const authModule = await import("../../src/middleware/auth");
const { projectRepository } = await import("../../src/repositories/project.repository");
const dbModule = await import("../../src/db");

const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const resolveDbNameSpy = spyOn(dbModule, "resolveDbName").mockImplementation(
  resolveDbName as typeof dbModule.resolveDbName,
);
const getProjectDbSpy = spyOn(dbModule, "getProjectDb").mockImplementation(() => ({ unsafe }) as never);

const { pgMetaRoutes } = await import("../../src/routes/pg-meta");
const app = new Elysia().use(pgMetaRoutes);

function request(path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

const ENDPOINTS = [
  "/tables",
  "/columns",
  "/indexes",
  "/roles",
  "/schemas",
  "/functions",
  "/triggers",
  "/policies",
  "/publications",
  "/views",
  "/materialized-views",
  "/foreign-tables",
  "/types",
  "/extensions",
  "/constraints",
];

describe("pgMetaRoutes", () => {
  afterAll(() => {
    requireProjectOrAdminAuthSpy.mockRestore();
    findByRefSpy.mockRestore();
    resolveDbNameSpy.mockRestore();
    getProjectDbSpy.mockRestore();
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    findByRef.mockReset();
    unsafe.mockReset();
    resolveDbName.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    findByRef.mockResolvedValue({ ref: "proj_1" } as never);
    resolveDbName.mockResolvedValue("supa_proj_1");
    unsafe.mockResolvedValue([]);
  });

  for (const ep of ENDPOINTS) {
    test(`GET ${ep} returns 200 with array`, async () => {
      const res = await request(`/v1/projects/proj_1/pg-meta${ep}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  }

  test("GET /tables executes catalog SQL filtered by schema param", async () => {
    unsafe.mockResolvedValue([{ schemaname: "public", tablename: "users" }]);
    const res = await request("/v1/projects/proj_1/pg-meta/tables?schema=public");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].tablename).toBe("users");
    const executedSql = unsafe.mock.calls[0][0] as string;
    expect(executedSql).toContain("pg_tables");
    expect(executedSql).toContain("public");
  });

  test("GET /indexes queries pg_indexes catalog", async () => {
    await request("/v1/projects/proj_1/pg-meta/indexes");
    const executedSql = unsafe.mock.calls[0][0] as string;
    expect(executedSql).toContain("pg_indexes");
  });

  test("GET /roles queries pg_roles excluding pg_%", async () => {
    await request("/v1/projects/proj_1/pg-meta/roles");
    const executedSql = unsafe.mock.calls[0][0] as string;
    expect(executedSql).toContain("pg_roles");
    expect(executedSql).toContain("pg_%");
  });

  test("GET /policies queries pg_policies", async () => {
    await request("/v1/projects/proj_1/pg-meta/policies");
    const executedSql = unsafe.mock.calls[0][0] as string;
    expect(executedSql).toContain("pg_policies");
  });

  test("GET returns 404 when project not found", async () => {
    findByRef.mockResolvedValue(null);
    const res = await request("/v1/projects/missing/pg-meta/tables");
    expect(res.status).toBe(404);
  });

  test("GET returns 500 on query error", async () => {
    unsafe.mockRejectedValue(new Error("relation does not exist"));
    const res = await request("/v1/projects/proj_1/pg-meta/foreign-tables");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("relation does not exist");
  });
});
