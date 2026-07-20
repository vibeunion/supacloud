import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

const requireProjectOrAdminAuth = mock(async () => undefined);
const getProject = mock(async () => ({ ref: "proj_1" }));
const resolveDbName = mock(async () => "postgres");
let databaseError: Error & { code?: string; errno?: string };
const tenantDb = mock(async () => {
  throw databaseError;
});

mock.module("../../src/middleware/auth", () => ({ requireProjectOrAdminAuth }));
mock.module("../../src/services", () => ({ projectService: { getProject } }));
mock.module("../../src/db", () => ({
  resolveDbName,
  getProjectDb: () => tenantDb,
}));
mock.module("../../src/services/auth-runtime.service", () => ({
  getAuthRuntimeManagedError: () => null,
}));
mock.module("../../src/services/audit.service", () => ({ redactAuditValue: (value: unknown) => value }));
mock.module("../../src/services/project-control-secrets.service", () => ({
  projectControlSecretsService: {},
}));
mock.module("../../src/services/tenant-runtime.service", () => ({ tenantRuntimeService: {} }));

const { authHooksRoutes } = await import(
  new URL("../../src/routes/auth-hooks.ts?auth-hooks-routes-test", import.meta.url).href
);
const app = new Elysia().use(authHooksRoutes);

describe("database webhook capability errors", () => {
  beforeEach(() => {
    databaseError = Object.assign(new Error("relation supabase_functions.hooks does not exist"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "42P01",
    });
  });

  test("classifies Bun postgres errno for a missing hooks table as capability unavailable", async () => {
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj_1/database/webhooks",
    ));

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "database_webhooks_not_available",
    });
  });

  test("keeps unrelated database failures service unavailable", async () => {
    databaseError = Object.assign(new Error("database connection reset"), { code: "ECONNRESET" });
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj_1/database/webhooks",
    ));

    expect(response.status).toBe(503);
  });
});
