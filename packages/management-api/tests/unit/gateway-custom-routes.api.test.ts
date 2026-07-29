import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { frontendService } from "../../src/services/frontend.service";
import { gatewayService, MAX_CUSTOM_GATEWAY_PATHS } from "../../src/services/gateway.service";
import { projectService } from "../../src/services/project.service";

const masterHeaders = { Authorization: "Bearer dev-master-token", "Content-Type": "application/json" };
const app = new Elysia().use(projectConfigRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("controlled custom gateway routes API", () => {
  test("requires admin auth", async () => {
    const response = await request("/v1/projects/proj123/gateway/routes");
    expect(response.status).toBe(401);
  });

  test("GET returns persisted redirect routes with normalized defaults", async () => {
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [
        {
          id: "canonical-https",
          hosts: ["WWW.EXAMPLE.COM"],
          path: "/*",
          protocol: "http",
          redirect_to: "https://www.example.com{http.request.uri}",
        },
      ],
    } as any);

    try {
      const response = await request("/v1/projects/proj123/gateway/routes", {
        headers: masterHeaders,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        routes: [expect.objectContaining({
          id: "canonical-https",
          hosts: ["www.example.com"],
          protocol: "http",
          redirect_to: "https://www.example.com{http.request.uri}",
          redirect_status: 308,
        })],
      });
    } finally {
      getSettings.mockRestore();
    }
  });

  test("POST stores normalized routes and reconciles the gateway", async () => {
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [],
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockResolvedValue({
      gateway_routes: [],
    } as any);
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes").mockResolvedValue({ success: true });

    try {
      const response = await request("/v1/projects/proj123/gateway/routes", {
        method: "POST",
        headers: masterHeaders,
        body: JSON.stringify({
          id: "ocr",
          hosts: ["OCR.EXAMPLE.COM"],
          path: "/api/*",
          upstream: "https://10.20.0.12:4001",
          upstream_tls_insecure_skip_verify: true,
          rewrite_uri: "/functions/v1/supauth{http.request.uri.path}",
          headers: { "X-Upstream": "ocr" },
          cors: ["https://app.example.com"],
          priority: 5,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        route: expect.objectContaining({
          id: "ocr",
          hosts: ["ocr.example.com"],
          path: "/api/*",
          upstream: "https://10.20.0.12:4001",
          upstream_tls_insecure_skip_verify: true,
          rewrite_uri: "/functions/v1/supauth{http.request.uri.path}",
          priority: 5,
          enabled: true,
        }),
      });
      expect(configureRoutes).toHaveBeenCalledWith("proj123", [
        expect.objectContaining({ id: "ocr", hosts: ["ocr.example.com"] }),
      ]);
      expect(updateSettings).toHaveBeenCalledWith("proj123", {
        gateway_routes: [
          expect.objectContaining({
            id: "ocr",
            hosts: ["ocr.example.com"],
            upstream_tls_insecure_skip_verify: true,
            rewrite_uri: "/functions/v1/supauth{http.request.uri.path}",
          }),
        ],
      });
      expect(getSettings).toHaveBeenCalledWith("proj123");
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("POST and PUT persist the managed Edge Functions symbol without resolving a port", async () => {
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [],
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockResolvedValue({} as any);
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes").mockResolvedValue({ success: true });

    try {
      const postResponse = await request("/v1/projects/proj123/gateway/routes", {
        method: "POST",
        headers: masterHeaders,
        body: JSON.stringify({
          id: "sync-function",
          hosts: ["functions.example.com"],
          path: "/invoke/*",
          managed_upstream: "edge-functions",
        }),
      });

      expect(postResponse.status).toBe(200);
      expect(await postResponse.json()).toEqual({
        success: true,
        route: expect.objectContaining({
          id: "sync-function",
          managed_upstream: "edge-functions",
        }),
      });
      expect(configureRoutes).toHaveBeenCalledWith("proj123", [
        expect.objectContaining({ managed_upstream: "edge-functions", upstream: undefined }),
      ]);
      expect(updateSettings).toHaveBeenCalledWith("proj123", {
        gateway_routes: [expect.objectContaining({ managed_upstream: "edge-functions", upstream: undefined })],
      });

      getSettings.mockResolvedValue({
        gateway_routes: [{
          id: "sync-function",
          hosts: ["functions.example.com"],
          path: "/invoke/*",
          managed_upstream: "edge-functions",
        }],
      } as any);
      updateSettings.mockClear();
      configureRoutes.mockClear();

      const putResponse = await request("/v1/projects/proj123/gateway/routes/sync-function", {
        method: "PUT",
        headers: masterHeaders,
        body: JSON.stringify({
          hosts: ["functions.example.com"],
          path: "/invoke/*",
          managed_upstream: "edge-functions",
        }),
      });

      expect(putResponse.status).toBe(200);
      expect(await putResponse.json()).toEqual({
        success: true,
        route: expect.objectContaining({
          id: "sync-function",
          managed_upstream: "edge-functions",
        }),
      });
      expect(configureRoutes).toHaveBeenCalledWith("proj123", [
        expect.objectContaining({ managed_upstream: "edge-functions", upstream: undefined }),
      ]);
      expect(updateSettings).toHaveBeenCalledWith("proj123", {
        gateway_routes: [expect.objectContaining({ managed_upstream: "edge-functions", upstream: undefined })],
      });
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("rejects an unknown managed upstream at the API schema boundary", async () => {
    const response = await request("/v1/projects/proj123/gateway/routes", {
      method: "POST",
      headers: masterHeaders,
      body: JSON.stringify({
        id: "unknown-managed",
        hosts: ["functions.example.com"],
        path: "/invoke/*",
        managed_upstream: "not-a-managed-upstream",
      }),
    });

    expect(response.status).toBe(422);
  });

  test("POST rejects reserved proxy request headers before changing gateway state", async () => {
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [],
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockResolvedValue({} as any);
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes").mockResolvedValue({ success: true });

    try {
      const response = await request("/v1/projects/proj123/gateway/routes", {
        method: "POST",
        headers: masterHeaders,
        body: JSON.stringify({
          id: "unsafe-project-ref",
          hosts: ["api.example.com"],
          path: "/*",
          upstream: "127.0.0.1:8080",
          headers: { "X-pRoJeCt-ReF": "other-project" },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "Custom proxy route headers must not override reserved header: X-pRoJeCt-ReF",
        code: "400",
      });
      expect(updateSettings).not.toHaveBeenCalled();
      expect(configureRoutes).not.toHaveBeenCalled();
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("PUT persists a protocol-scoped redirect route", async () => {
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [
        {
          id: "canonical-https",
          hosts: ["www.example.com"],
          path: "/*",
          protocol: "http",
          redirect_to: "https://www.example.com{http.request.uri}",
          redirect_status: 308,
        },
      ],
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockResolvedValue({} as any);
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes").mockResolvedValue({ success: true });

    try {
      const response = await request("/v1/projects/proj123/gateway/routes/canonical-https", {
        method: "PUT",
        headers: masterHeaders,
        body: JSON.stringify({
          hosts: ["WWW.EXAMPLE.COM"],
          path: "/*",
          protocol: "http",
          redirect_to: "https://www.example.com{http.request.uri}",
          redirect_status: 307,
          headers: { "Cache-Control": "no-store" },
          priority: 1000,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        route: expect.objectContaining({
          id: "canonical-https",
          hosts: ["www.example.com"],
          path: "/*",
          protocol: "http",
          redirect_to: "https://www.example.com{http.request.uri}",
          redirect_status: 307,
          priority: 1000,
          enabled: true,
        }),
      });
      expect(configureRoutes).toHaveBeenCalledWith("proj123", [
        expect.objectContaining({ id: "canonical-https", redirect_status: 307 }),
      ]);
      expect(updateSettings).toHaveBeenCalledWith("proj123", {
        gateway_routes: [
          expect.objectContaining({
            id: "canonical-https",
            protocol: "http",
            redirect_to: "https://www.example.com{http.request.uri}",
            redirect_status: 307,
          }),
        ],
      });
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("PUT rejects reserved internal proxy headers before changing gateway state", async () => {
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [
        { id: "proxy", hosts: ["api.example.com"], path: "/*", upstream: "127.0.0.1:8080" },
      ],
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockResolvedValue({} as any);
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes").mockResolvedValue({ success: true });

    try {
      const response = await request("/v1/projects/proj123/gateway/routes/proxy", {
        method: "PUT",
        headers: masterHeaders,
        body: JSON.stringify({
          hosts: ["api.example.com"],
          path: "/*",
          upstream: "127.0.0.1:8080",
          headers: { "x-SUPACLOUD-internal-token": "untrusted-token" },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "Custom proxy route headers must not override reserved header: x-SUPACLOUD-internal-token",
        code: "400",
      });
      expect(updateSettings).not.toHaveBeenCalled();
      expect(configureRoutes).not.toHaveBeenCalled();
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("POST accepts and reconciles a hosted route with twenty-one paths", async () => {
    const hostedPaths = Array.from({ length: 21 }, (_, index) => `/hosted-${index}`);
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [],
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockResolvedValue({} as any);
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes").mockResolvedValue({ success: true });

    try {
      const response = await request("/v1/projects/proj123/gateway/routes", {
        method: "POST",
        headers: masterHeaders,
        body: JSON.stringify({
          id: "hosted-auth",
          hosts: ["auth.example.com"],
          path: hostedPaths,
          upstream: "127.0.0.1:9000",
        }),
      });

      expect(response.status).toBe(200);
      expect(configureRoutes).toHaveBeenCalledWith("proj123", [
        expect.objectContaining({ id: "hosted-auth", path: hostedPaths }),
      ]);
      expect(updateSettings).toHaveBeenCalledWith("proj123", {
        gateway_routes: [expect.objectContaining({ id: "hosted-auth", path: hostedPaths })],
      });
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("POST rejects path arrays above the API schema limit", async () => {
    const excessivePaths = Array.from(
      { length: MAX_CUSTOM_GATEWAY_PATHS + 1 },
      (_, index) => `/excessive-${index}`,
    );
    const response = await request("/v1/projects/proj123/gateway/routes", {
      method: "POST",
      headers: masterHeaders,
      body: JSON.stringify({
        id: "too-many-paths",
        hosts: ["auth.example.com"],
        path: excessivePaths,
        upstream: "127.0.0.1:9000",
      }),
    });

    expect(response.status).toBe(422);
  });

  test("rolls Caddy back to persisted routes when the project config write fails", async () => {
    const existingRoutes = [
      { id: "docs", hosts: ["docs.example.com"], path: "/*", static_root: "/var/supacloud/custom-sites/docs" },
    ];
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: existingRoutes,
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockRejectedValue(new Error("simulated DB write failure"));
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes")
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true });

    try {
      const response = await request("/v1/projects/proj123/gateway/routes", {
        method: "POST",
        headers: masterHeaders,
        body: JSON.stringify({
          id: "canonical-https",
          hosts: ["www.example.com"],
          path: "/*",
          protocol: "http",
          redirect_to: "https://www.example.com{http.request.uri}",
        }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "500", message: expect.stringContaining("simulated DB write failure") });
      expect(configureRoutes).toHaveBeenCalledTimes(2);
      expect(configureRoutes.mock.calls[0]?.[1]).toEqual([
        expect.objectContaining({ id: "docs" }),
        expect.objectContaining({ id: "canonical-https" }),
      ]);
      expect(configureRoutes.mock.calls[1]?.[1]).toEqual([
        expect.objectContaining({ id: "docs" }),
      ]);
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("DELETE removes the route from DB state and reconciles the gateway", async () => {
    const getSettings = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      gateway_routes: [
        { id: "ocr", hosts: ["ocr.example.com"], path: "/*", upstream: "10.20.0.12:4001" },
        { id: "docs", hosts: ["docs.example.com"], path: "/*", static_root: "/var/supacloud/custom-sites/docs" },
      ],
    } as any);
    const updateSettings = spyOn(projectService, "updateProjectSettings").mockResolvedValue({
      gateway_routes: [],
    } as any);
    const configureRoutes = spyOn(gatewayService, "configureCustomGatewayRoutes").mockResolvedValue({ success: true });

    try {
      const response = await request("/v1/projects/proj123/gateway/routes/ocr", {
        method: "DELETE",
        headers: masterHeaders,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, deleted: true });
      expect(configureRoutes).toHaveBeenCalledWith("proj123", [
        expect.objectContaining({ id: "docs" }),
      ]);
      expect(updateSettings).toHaveBeenCalledWith("proj123", {
        gateway_routes: [
          expect.objectContaining({ id: "docs" }),
        ],
      });
    } finally {
      getSettings.mockRestore();
      updateSettings.mockRestore();
      configureRoutes.mockRestore();
    }
  });

  test("rebuild-all clean mode defers publishing until full gateway state is generated", async () => {
    const events: string[] = [];
    const prepareCleanRebuild = spyOn(gatewayService, "prepareCleanRebuild").mockImplementation(async () => { events.push("prepare"); });
    const setupMasterRoutes = spyOn(gatewayService, "setupMasterRoutes").mockImplementation(async () => { events.push("master"); });
    const rebuildAllTenantConfigs = spyOn(gatewayService, "rebuildAllTenantConfigs").mockImplementation(async () => {
      events.push("tenants");
      return { success: true, updated: 2, errors: [] };
    });
    const reconcileGatewayRoutes = spyOn(frontendService, "reconcileGatewayRoutes").mockImplementation(async () => {
      events.push("frontend");
      return { total: 1, configured: 1, skipped: 0, errors: [] };
    });
    const setupHostedAuthRoutes = spyOn(gatewayService, "setupHostedAuthRoutes").mockImplementation(async () => {
      events.push("hosted-auth");
      return { success: true };
    });
    const withDeferredPersist = spyOn(gatewayService, "withDeferredPersist").mockImplementation(async (fn, shouldFlush) => {
      events.push("defer:start");
      const result = await fn();
      if (!shouldFlush || shouldFlush(result)) events.push("defer:flush");
      return result;
    });

    try {
      const response = await request("/v1/projects/proj123/gateway/rebuild-all?clean=true", {
        method: "POST",
        headers: masterHeaders,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        updated: 2,
        errors: [],
        frontend: { total: 1, configured: 1, skipped: 0, errors: [] },
        clean: true,
      });
      expect(events).toEqual(["defer:start", "prepare", "master", "tenants", "frontend", "hosted-auth", "defer:flush"]);
      expect(withDeferredPersist).toHaveBeenCalledTimes(1);
      expect(prepareCleanRebuild).toHaveBeenCalledTimes(1);
    } finally {
      prepareCleanRebuild.mockRestore();
      setupMasterRoutes.mockRestore();
      rebuildAllTenantConfigs.mockRestore();
      reconcileGatewayRoutes.mockRestore();
      setupHostedAuthRoutes.mockRestore();
      withDeferredPersist.mockRestore();
    }
  });

  test("rebuild-all clean mode does not flush when tenant rebuild fails", async () => {
    const events: string[] = [];
    const prepareCleanRebuild = spyOn(gatewayService, "prepareCleanRebuild").mockImplementation(async () => { events.push("prepare"); });
    const setupMasterRoutes = spyOn(gatewayService, "setupMasterRoutes").mockImplementation(async () => { events.push("master"); });
    const rebuildAllTenantConfigs = spyOn(gatewayService, "rebuildAllTenantConfigs").mockImplementation(async () => {
      events.push("tenants");
      return { success: false, updated: 0, errors: ["brokenref: missing port config"] };
    });
    const reconcileGatewayRoutes = spyOn(frontendService, "reconcileGatewayRoutes").mockImplementation(async () => {
      events.push("frontend");
      return { total: 0, configured: 0, skipped: 0, errors: [] };
    });
    const setupHostedAuthRoutes = spyOn(gatewayService, "setupHostedAuthRoutes").mockImplementation(async () => {
      events.push("hosted-auth");
      return { success: true };
    });
    const withDeferredPersist = spyOn(gatewayService, "withDeferredPersist").mockImplementation(async (fn, shouldFlush) => {
      events.push("defer:start");
      const result = await fn();
      if (!shouldFlush || shouldFlush(result)) events.push("defer:flush");
      else events.push("defer:skip-flush");
      return result;
    });

    try {
      const response = await request("/v1/projects/proj123/gateway/rebuild-all?clean=true", {
        method: "POST",
        headers: masterHeaders,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: false,
        updated: 0,
        errors: ["brokenref: missing port config"],
        frontend: { total: 0, configured: 0, skipped: 0, errors: [] },
        clean: true,
        message: "Rebuild failed",
      });
      expect(events).toEqual(["defer:start", "prepare", "master", "tenants", "frontend", "hosted-auth", "defer:skip-flush"]);
    } finally {
      prepareCleanRebuild.mockRestore();
      setupMasterRoutes.mockRestore();
      rebuildAllTenantConfigs.mockRestore();
      reconcileGatewayRoutes.mockRestore();
      setupHostedAuthRoutes.mockRestore();
      withDeferredPersist.mockRestore();
    }
  });
});
