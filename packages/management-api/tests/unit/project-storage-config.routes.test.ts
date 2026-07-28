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

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer dev-master-token",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("project storage config routes", () => {
  afterAll(() => {
    requireProjectOrAdminAuthSpy.mockRestore();
    getProjectSettingsSpy.mockRestore();
    updateProjectSettingsSpy.mockRestore();
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    getProjectSettings.mockReset();
    getProjectSettings.mockResolvedValue({
      storage: {
        features: {
          icebergCatalog: { enabled: true, maxTables: 99 },
          vectorBuckets: { enabled: true, maxBuckets: 12 },
        },
        capabilities: {
          iceberg_catalog: true,
          storage_iceberg: true,
          storage_vectors: true,
        },
      },
    } as never);
    updateProjectSettings.mockReset();
    updateProjectSettings.mockImplementation(async (_ref, settings) => settings as never);
  });

  test("GET advertises vectors while keeping Iceberg unavailable", async () => {
    const res = await request("/v1/projects/proj_1/config/storage");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.features.icebergCatalog).toMatchObject({ enabled: false, maxTables: 99 });
    expect(body.features.vectorBuckets).toMatchObject({ enabled: true, maxBuckets: 100, maxIndexes: 10 });
    expect(body.capabilities).toMatchObject({
      iceberg_catalog: false,
      storage_iceberg: false,
      storage_vectors: true,
    });
  });

  test("PATCH response preserves the implemented vector capability", async () => {
    const res = await request("/v1/projects/proj_1/config/storage", {
      method: "PATCH",
      body: JSON.stringify({
        features: {
          vectorBuckets: { enabled: true, maxIndexes: 3 },
        },
        capabilities: {
          storage_vectors: true,
        },
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.features.vectorBuckets).toMatchObject({ enabled: true, maxBuckets: 100, maxIndexes: 10 });
    expect(body.capabilities.storage_vectors).toBe(true);
    expect(requireProjectOrAdminAuth).toHaveBeenCalledWith(expect.any(Request), "proj_1");
  });
});
