// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getProjectSettings = mock(() => Promise.resolve<Record<string, unknown> | null>({}));
const updateProjectSettings = mock((_ref: string, settings: Record<string, unknown>) => Promise.resolve(settings));
const reconcileGatewayRoutes = mock(() => Promise.resolve({ total: 1, configured: 1, skipped: 0, errors: [] }));

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");

const authSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getSettingsSpy = spyOn(servicesModule.projectService, "getProjectSettings").mockImplementation(
  getProjectSettings as typeof servicesModule.projectService.getProjectSettings,
);
const updateSettingsSpy = spyOn(servicesModule.projectService, "updateProjectSettings").mockImplementation(
  updateProjectSettings as typeof servicesModule.projectService.updateProjectSettings,
);
const reconcileSpy = spyOn(servicesModule.frontendService, "reconcileGatewayRoutes").mockImplementation(
  reconcileGatewayRoutes as typeof servicesModule.frontendService.reconcileGatewayRoutes,
);

const { projectConfigRoutes } = await import("../../src/routes/project-config?delivery-optimization-routes-test");
const app = new Elysia().use(projectConfigRoutes);

function request(method: "GET" | "PATCH", body?: Record<string, unknown>) {
  return app.handle(new Request("http://localhost/v1/projects/proj_1/config/delivery-optimization", {
    method,
    headers: {
      Authorization: "Bearer project-admin-token",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

afterAll(() => {
  authSpy.mockRestore();
  getSettingsSpy.mockRestore();
  updateSettingsSpy.mockRestore();
  reconcileSpy.mockRestore();
});

beforeEach(() => {
  requireProjectOrAdminAuth.mockReset();
  requireProjectOrAdminAuth.mockResolvedValue(null);
  getProjectSettings.mockReset();
  getProjectSettings.mockResolvedValue({});
  updateProjectSettings.mockReset();
  updateProjectSettings.mockImplementation(async (_ref, settings) => settings);
  reconcileGatewayRoutes.mockReset();
  reconcileGatewayRoutes.mockResolvedValue({ total: 1, configured: 1, skipped: 0, errors: [] });
});

describe("project delivery optimization routes", () => {
  test("GET returns the safe default policy", async () => {
    const response = await request("GET");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project_ref: "proj_1",
      delivery_optimization: {
        compression: true,
        cache_mode: "public_versioned",
        cache_ttl_seconds: 31536000,
        stale_while_revalidate_seconds: 3600,
      },
    });
  });

  test("PATCH accepts a project-scoped administrator and reconciles the gateway", async () => {
    const response = await request("PATCH", {
      cache_mode: "public",
      cache_ttl_seconds: 600,
      stale_while_revalidate_seconds: 60,
    });

    expect(response.status).toBe(200);
    expect(updateProjectSettings).toHaveBeenCalledWith("proj_1", {
      delivery_optimization: {
        compression: true,
        cache_mode: "public",
        cache_ttl_seconds: 600,
        stale_while_revalidate_seconds: 60,
      },
    });
    expect(reconcileGatewayRoutes).toHaveBeenCalledWith("proj_1");
  });

  test("PATCH rejects unknown fields and attempts no persistence", async () => {
    const response = await request("PATCH", { rewrite_html: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "DELIVERY_OPTIMIZATION_INVALID" });
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(reconcileGatewayRoutes).not.toHaveBeenCalled();
  });

  test("PATCH reports a saved policy when gateway reconciliation fails", async () => {
    reconcileGatewayRoutes.mockResolvedValue({ total: 1, configured: 0, skipped: 0, errors: ["caddy unavailable"] });

    const response = await request("PATCH", { cache_mode: "disabled" });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "DELIVERY_OPTIMIZATION_GATEWAY_RECONCILE_FAILED",
      delivery_optimization: {
        compression: true,
        cache_mode: "disabled",
        cache_ttl_seconds: 0,
        stale_while_revalidate_seconds: 0,
      },
    });
  });
});
