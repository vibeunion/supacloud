// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const databaseModule = await import("../../src/db");
const servicesModule = await import("../../src/services");

const requireProjectOrAdminAuth = mock(async () => null);
const getProjectSettings = mock(async () => ({ database: {} }));
const updateProjectSettings = mock(async (_ref: string, settings: unknown) => settings);
const databaseUnsafe = mock(async (_query: string) => [] as Record<string, unknown>[]);

const authSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const resolveDbNameSpy = spyOn(databaseModule, "resolveDbName").mockResolvedValue(
  "supa_proj_1",
);
const getProjectDbSpy = spyOn(databaseModule, "getProjectDb").mockImplementation(
  () => ({ unsafe: databaseUnsafe }) as never,
);
const getProjectSettingsSpy = spyOn(
  servicesModule.projectService,
  "getProjectSettings",
).mockImplementation(
  getProjectSettings as typeof servicesModule.projectService.getProjectSettings,
);
const updateProjectSettingsSpy = spyOn(
  servicesModule.projectService,
  "updateProjectSettings",
).mockImplementation(
  updateProjectSettings as typeof servicesModule.projectService.updateProjectSettings,
);

const { projectConfigRoutes } = await import(
  "../../src/routes/project-config?project-database-config-routes-test"
);
const app = new Elysia().use(projectConfigRoutes);

function request(method: "GET" | "PATCH", body?: Record<string, unknown>) {
  return app.handle(new Request(
    "http://localhost/v1/projects/proj_1/config/database",
    {
      method,
      headers: {
        authorization: "Bearer dev-master-token",
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  ));
}

function liveSettings() {
  return [
    {
      name: "idle_in_transaction_session_timeout",
      setting: "5000",
      unit: "ms",
      context: "user",
      pending_restart: false,
    },
    {
      name: "max_connections",
      setting: "100",
      unit: null,
      context: "postmaster",
      pending_restart: false,
    },
    {
      name: "statement_timeout",
      setting: "2500",
      unit: "ms",
      context: "user",
      pending_restart: false,
    },
  ];
}

afterAll(() => {
  authSpy.mockRestore();
  resolveDbNameSpy.mockRestore();
  getProjectDbSpy.mockRestore();
  getProjectSettingsSpy.mockRestore();
  updateProjectSettingsSpy.mockRestore();
});

beforeEach(() => {
  requireProjectOrAdminAuth.mockReset();
  requireProjectOrAdminAuth.mockResolvedValue(null);
  getProjectSettings.mockReset();
  getProjectSettings.mockResolvedValue({
    database: {
      pgbouncer_enabled: true,
      pgbouncer_settings: { pool_mode: "transaction" },
    },
  } as never);
  updateProjectSettings.mockReset();
  updateProjectSettings.mockImplementation(async (_ref, settings) => settings as never);
  databaseUnsafe.mockReset();
  databaseUnsafe.mockResolvedValue([]);
});

describe("project database config routes", () => {
  test("GET returns live settings metadata and legacy flat fields", async () => {
    databaseUnsafe.mockResolvedValue(liveSettings());

    const response = await request("GET");
    const responseBody = await response.json();

    expect(response.status).toBe(200);
    expect(responseBody).toMatchObject({
      max_connections: 100,
      statement_timeout: 2500,
      idle_in_transaction_session_timeout: 5000,
      pgbouncer_enabled: true,
      settings: liveSettings(),
    });
  });

  test("GET reports database read failures instead of fabricated defaults", async () => {
    databaseUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await request("GET");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: "Failed to read live database settings",
      code: "DATABASE_SETTINGS_READ_FAILED",
    });
  });

  test("PATCH rejects max_connections with zero project or database side effects", async () => {
    const response = await request("PATCH", { max_connections: 200 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_SETTING_SCOPE",
    });
    expect(getProjectSettings).not.toHaveBeenCalled();
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(databaseUnsafe).not.toHaveBeenCalled();
  });

  test("PATCH applies only requested settings before persisting metadata", async () => {
    const events: string[] = [];
    databaseUnsafe.mockImplementation(async (query) => {
      if (query.includes("pg_db_role_setting")) return [];
      if (query.includes("ALTER DATABASE")) {
        events.push(query);
        return [];
      }
      return liveSettings();
    });
    updateProjectSettings.mockImplementation(async (_ref, settings) => {
      events.push("persist");
      return settings as never;
    });

    const response = await request("PATCH", { statement_timeout: "2500" });

    expect(response.status).toBe(200);
    expect(events).toEqual([
      'ALTER DATABASE "supa_proj_1" SET statement_timeout = 2500',
      "persist",
    ]);
    expect(updateProjectSettings).toHaveBeenCalledWith(
      "proj_1",
      expect.objectContaining({
        database: expect.objectContaining({ statement_timeout: 2500 }),
      }),
    );
  });

  test("PATCH keeps PgBouncer metadata compatible without ALTER DATABASE", async () => {
    const response = await request("PATCH", {
      pgbouncer_enabled: false,
      pgbouncer_settings: { pool_mode: "session" },
    });

    expect(response.status).toBe(200);
    expect(databaseUnsafe).toHaveBeenCalledTimes(1);
    expect(databaseUnsafe.mock.calls[0]?.[0]).toContain("FROM pg_settings");
    expect(updateProjectSettings).toHaveBeenCalledWith(
      "proj_1",
      expect.objectContaining({
        database: expect.objectContaining({
          pgbouncer_enabled: false,
          pgbouncer_settings: { pool_mode: "session" },
        }),
      }),
    );
  });

  test("PATCH returns 503 and does not persist when PostgreSQL apply fails", async () => {
    databaseUnsafe.mockImplementation(async (query) => {
      if (query.includes("pg_db_role_setting")) return [];
      throw new Error("database rejected setting");
    });

    const response = await request("PATCH", { statement_timeout: 2500 });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "DATABASE_SETTINGS_APPLY_FAILED",
    });
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  test("PATCH maps project database resolution failures to apply failure", async () => {
    resolveDbNameSpy.mockRejectedValueOnce(new Error("control database unavailable"));

    const response = await request("PATCH", { statement_timeout: 2500 });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "DATABASE_SETTINGS_APPLY_FAILED",
      rollback: { attempted: false, succeeded: null },
    });
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(databaseUnsafe).not.toHaveBeenCalled();
  });

  test("PATCH returns 500 and restores the prior override when persistence fails", async () => {
    const statements: string[] = [];
    databaseUnsafe.mockImplementation(async (query) => {
      if (query.includes("pg_db_role_setting")) {
        return [{ name: "statement_timeout", setting: "2s" }];
      }
      statements.push(query);
      return [];
    });
    updateProjectSettings.mockRejectedValue(new Error("metadata unavailable"));

    const response = await request("PATCH", { statement_timeout: 2500 });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "DATABASE_SETTINGS_PERSIST_FAILED",
      rollback: { attempted: true, succeeded: true, failed_settings: [] },
    });
    expect(statements).toEqual([
      'ALTER DATABASE "supa_proj_1" SET statement_timeout = 2500',
      'ALTER DATABASE "supa_proj_1" SET statement_timeout = \'2s\'',
    ]);
  });
});
