// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getProjectSettings = mock(() => Promise.resolve(null));
const updateProjectSettings = mock(() => Promise.resolve({}));

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");

const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getProjectSettingsSpy = spyOn(servicesModule.projectService, "getProjectSettings").mockImplementation(
  getProjectSettings as typeof servicesModule.projectService.getProjectSettings,
);
const updateProjectSettingsSpy = spyOn(servicesModule.projectService, "updateProjectSettings").mockImplementation(
  updateProjectSettings as typeof servicesModule.projectService.updateProjectSettings,
);

const { projectConfigRoutes } = await import("../../src/routes/project-config");

const app = new Elysia().use(projectConfigRoutes);

function requestRealtimeConfig(init: RequestInit = {}) {
  return app.handle(
    new Request("http://localhost/v1/projects/proj_1/config/realtime", {
      ...init,
      headers: {
        Authorization: "Bearer dev-master-token",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("project realtime config routes", () => {
  afterAll(() => {
    requireProjectOrAdminAuthSpy.mockRestore();
    getProjectSettingsSpy.mockRestore();
    updateProjectSettingsSpy.mockRestore();
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    getProjectSettings.mockReset();
    getProjectSettings.mockResolvedValue({ realtime: {} } as never);
    updateProjectSettings.mockReset();
    updateProjectSettings.mockImplementation(async (_ref, settings) => settings as never);
  });

  test("GET includes the required Postgres Changes pool default", async () => {
    const response = await requestRealtimeConfig();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ postgres_changes_pool: null });
  });

  test("GET maps the camel-case Postgres Changes pool setting", async () => {
    getProjectSettings.mockResolvedValue({
      realtime: { postgresChangesPool: 17 },
    } as never);

    const response = await requestRealtimeConfig();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ postgres_changes_pool: 17 });
  });

  test("PATCH returns the official Realtime config shape", async () => {
    const response = await requestRealtimeConfig({
      method: "PATCH",
      body: JSON.stringify({ postgres_changes_pool: 23 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      postgres_changes_pool: 23,
      presence_enabled: false,
    });
  });
});
