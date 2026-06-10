import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { gatewayService } from "../../src/services/gateway.service";
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
});
