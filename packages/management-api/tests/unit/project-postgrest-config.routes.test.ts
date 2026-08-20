// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const databaseModule = await import("../../src/db");
const servicesModule = await import("../../src/services");
const runtimeModule = await import("../../src/services/tenant-runtime.service");

const requireProjectOrAdminAuth = mock(async () => null);
const getProjectSettings = mock(async () => ({ postgrest: { exposed_schemas: ["api"] } }));
const updateProjectSettings = mock(async (_ref: string, settings: unknown) => settings);
const databaseUnsafe = mock(async () => [
  { nspname: "api" },
  { nspname: "graphql_public" },
  { nspname: "pgmq_public" },
  { nspname: "public" },
  { nspname: "storage" },
]);
const statusPostgrest = mock(async () => ({ desired: "running", actual: "running", health: "healthy" }));
const restartPostgrest = mock(async () => ({ desired: "running", actual: "running", health: "healthy" }));

const spies = [
  spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
    requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
  ),
  spyOn(databaseModule, "resolveDbName").mockResolvedValue("supa_proj_1"),
  spyOn(databaseModule, "getProjectDb").mockImplementation(
    () => ({ unsafe: databaseUnsafe }) as never,
  ),
  spyOn(servicesModule.projectService, "getProjectSettings").mockImplementation(
    getProjectSettings as typeof servicesModule.projectService.getProjectSettings,
  ),
  spyOn(servicesModule.projectService, "updateProjectSettings").mockImplementation(
    updateProjectSettings as typeof servicesModule.projectService.updateProjectSettings,
  ),
  spyOn(runtimeModule.tenantRuntimeService, "statusPostgrest").mockImplementation(
    statusPostgrest as typeof runtimeModule.tenantRuntimeService.statusPostgrest,
  ),
  spyOn(runtimeModule.tenantRuntimeService, "restartPostgrest").mockImplementation(
    restartPostgrest as typeof runtimeModule.tenantRuntimeService.restartPostgrest,
  ),
];

const { projectConfigRoutes } = await import(
  "../../src/routes/project-config?project-postgrest-config-routes-test"
);
const app = new Elysia().use(projectConfigRoutes);

function request(method: "GET" | "PATCH", body?: Record<string, unknown>) {
  return app.handle(new Request("http://localhost/v1/projects/proj_1/config/postgrest", {
    method,
    headers: {
      authorization: "Bearer dev-master-token",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

afterAll(() => spies.forEach((spy) => spy.mockRestore()));

beforeEach(() => {
  getProjectSettings.mockReset();
  getProjectSettings.mockResolvedValue({ postgrest: { exposed_schemas: ["api"] } } as never);
  updateProjectSettings.mockReset();
  updateProjectSettings.mockImplementation(async (_ref, settings) => settings as never);
  databaseUnsafe.mockReset();
  databaseUnsafe.mockResolvedValue([
    { nspname: "api" }, { nspname: "graphql_public" }, { nspname: "pgmq_public" },
    { nspname: "public" }, { nspname: "rpc" }, { nspname: "storage" },
  ]);
  statusPostgrest.mockReset();
  statusPostgrest.mockResolvedValue({ desired: "running", actual: "running", health: "healthy" } as never);
  restartPostgrest.mockReset();
  restartPostgrest.mockResolvedValue({ desired: "running", actual: "running", health: "healthy" } as never);
});

describe("project PostgREST schema config routes", () => {
  test("GET reports custom, effective, and missing schemas", async () => {
    const response = await request("GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      exposed_schemas: ["api"],
      effective_schemas: ["public", "storage", "graphql_public", "pgmq_public", "api"],
      missing_schemas: [],
    });
  });

  test("PATCH persists a normalized schema set and restarts a running runtime", async () => {
    const response = await request("PATCH", { exposed_schemas: ["RPC", "api"] });
    expect(response.status).toBe(200);
    expect(updateProjectSettings).toHaveBeenCalledWith("proj_1", expect.objectContaining({
      postgrest: { exposed_schemas: ["api", "rpc"] },
    }));
    expect(restartPostgrest).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      exposed_schemas: ["api", "rpc"],
      runtime_applied: true,
      idempotent: false,
    });
  });

  test("PATCH rejects missing schemas before persistence", async () => {
    databaseUnsafe.mockResolvedValue([{ nspname: "public" }, { nspname: "storage" }, { nspname: "graphql_public" }]);
    const response = await request("PATCH", { exposed_schemas: ["missing_api"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "POSTGREST_SCHEMA_NOT_FOUND",
      missing_schemas: ["missing_api"],
    });
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  test("PATCH rejects stale revisions without side effects", async () => {
    const response = await request("PATCH", {
      exposed_schemas: ["api", "rpc"],
      expected_revision: "0".repeat(64),
    });
    expect(response.status).toBe(409);
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(restartPostgrest).not.toHaveBeenCalled();
  });

  test("PATCH persists paused runtime changes without restarting PostgREST", async () => {
    statusPostgrest.mockResolvedValue({
      desired: "stopped",
      actual: "stopped",
      health: "unknown",
    } as never);

    const response = await request("PATCH", { exposed_schemas: ["api", "rpc"] });

    expect(response.status).toBe(200);
    expect(restartPostgrest).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      runtime_applied: false,
      restart_required: true,
    });
  });

  test("PATCH restores persisted and running state after restart failure", async () => {
    restartPostgrest.mockRejectedValueOnce(new Error("restart failed"));
    restartPostgrest.mockResolvedValueOnce({
      desired: "running",
      actual: "running",
      health: "healthy",
    } as never);

    const response = await request("PATCH", { exposed_schemas: ["api", "rpc"] });

    expect(response.status).toBe(503);
    expect(updateProjectSettings).toHaveBeenCalledTimes(2);
    expect(updateProjectSettings.mock.calls[1]?.[1]).toMatchObject({
      postgrest: { exposed_schemas: ["api"] },
    });
    expect(restartPostgrest).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({
      code: "POSTGREST_SCHEMA_APPLY_FAILED",
      rollback: { attempted: true, succeeded: true },
    });
  });
});
