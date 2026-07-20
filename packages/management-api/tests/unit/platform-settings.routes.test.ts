import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const settingsModule = await import("../../src/services/platform-settings.service");
const requireAdmin = spyOn(authModule, "requireAdminAuth").mockResolvedValue(undefined);
const list = spyOn(settingsModule.platformSettingsService, "list").mockResolvedValue([]);
const getSafe = spyOn(settingsModule.platformSettingsService, "getSafe").mockResolvedValue(null);
const update = spyOn(settingsModule.platformSettingsService, "update").mockResolvedValue(0);

const { platformSettingsRoutes } = await import("../../src/routes/platform-settings");
const app = new Elysia().use(platformSettingsRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { authorization: "Bearer admin", "content-type": "application/json", ...(init.headers || {}) },
  }));
}

describe("platform settings routes", () => {
  afterAll(() => {
    requireAdmin.mockRestore();
    list.mockRestore();
    getSafe.mockRestore();
    update.mockRestore();
  });

  beforeEach(() => {
    requireAdmin.mockResolvedValue(undefined);
    list.mockReset();
    list.mockResolvedValue([]);
    getSafe.mockReset();
    getSafe.mockResolvedValue(null);
    update.mockReset();
    update.mockResolvedValue(0);
  });

  test("requires admin authentication for reads", async () => {
    requireAdmin.mockResolvedValueOnce({
      status: 403,
      body: { code: "FORBIDDEN", message: "Forbidden" },
    });

    const response = await request("/v1/platform/settings");

    expect(response.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  test("returns masked secret state without exposing stored values", async () => {
    list.mockResolvedValueOnce([{
      key: "ai_api_key",
      value: "********",
      description: "AI key",
      is_secret: true,
      configured: true,
      updated_at: "2026-07-19T00:00:00.000Z",
    }]);

    const response = await request("/v1/platform/settings");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data[0]).toMatchObject({ value: "********", configured: true });
    expect(JSON.stringify(payload)).not.toContain("sk-secret");
  });

  test("does not convert database failure into an empty list", async () => {
    list.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request("/v1/platform/settings");

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('"data":[]');
  });
});
