import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { projectService } from "../../src/services/project.service";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";
import { projectCrudRoutes } from "../../src/routes/project-crud";

const originalOwnerRef = config.authRuntimeOwnerRef;

afterEach(() => {
  config.authRuntimeOwnerRef = originalOwnerRef;
});

describe("shared project response boundary", () => {
  const app = new Elysia().use(projectCrudRoutes);

  function request(path: string) {
    return app.handle(new Request(`http://localhost${path}`, {
      headers: { Authorization: "Bearer dev-master-token" },
    }));
  }

  function project(ref: string) {
    return {
      id: `${ref}-id`,
      ref,
      name: ref,
      status: "active",
      region: "local",
      organization_id: "org_1",
      created_at: new Date(),
      updated_at: new Date(),
      database: { host: "localhost", name: `supa_${ref}`, user: `role_${ref}` },
      api: { url: `https://${ref}.api.example.com` },
      studio: { url: `https://${ref}.studio.example.com` },
      config: {
        api_url: `https://${ref}.api.example.com`,
        auth: {
          smtp: { pass: "private" },
          oauth_server: { jwt_keys: [{ d: "private" }] },
        },
      },
    };
  }

  test("redacts dependent auth config from project detail and studio metrics routes", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    const getProjectSpy = spyOn(projectService, "getProject").mockResolvedValue(project("tenant-a") as never);
    const statusesSpy = spyOn(tenantRuntimeService, "getProjectServiceStatuses").mockResolvedValue([] as never);

    try {
      const detail = await request("/v1/projects/tenant-a");
      const metrics = await request("/v1/projects/tenant-a/studio-metrics");

      expect(detail.status).toBe(200);
      expect((await detail.json()).config.auth).toBeUndefined();
      expect(metrics.status).toBe(200);
      expect((await metrics.json()).config.auth).toBeUndefined();
      expect(getProjectSpy).toHaveBeenCalledWith("tenant-a");
      expect(statusesSpy).toHaveBeenCalled();
    } finally {
      getProjectSpy.mockRestore();
      statusesSpy.mockRestore();
    }
  });

  test("preserves owner auth config in the public detail route", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    const owner = project("auth-owner");
    const getProjectSpy = spyOn(projectService, "getProject").mockResolvedValue(owner as never);
    const statusesSpy = spyOn(tenantRuntimeService, "getProjectServiceStatuses").mockResolvedValue([] as never);

    try {
      const response = await request("/v1/projects/auth-owner");
      expect(response.status).toBe(200);
      expect((await response.json()).config.auth).toEqual(owner.config.auth);
    } finally {
      getProjectSpy.mockRestore();
      statusesSpy.mockRestore();
    }
  });
});
