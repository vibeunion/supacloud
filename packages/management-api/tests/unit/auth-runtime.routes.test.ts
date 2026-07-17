import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { authRuntimeRoutes } from "../../src/routes/auth-runtime";
import { userManagementRoutes } from "../../src/routes/auth-users";
import { projectServiceRoutes } from "../../src/routes/project-services";
import { projectService } from "../../src/services";

const app = new Elysia()
  .use(authRuntimeRoutes)
  .use(userManagementRoutes)
  .use(projectServiceRoutes);
const authHeaders = { Authorization: "Bearer dev-master-token" };
const originalOwnerRef = config.authRuntimeOwnerRef;
const originalGetProject = projectService.getProject;
const originalRestartProject = projectService.restartProject;

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...authHeaders, ...(init.headers || {}) },
    }),
  );
}

afterEach(() => {
  config.authRuntimeOwnerRef = originalOwnerRef;
  projectService.getProject = originalGetProject;
  projectService.restartProject = originalRestartProject;
});

describe("SupAuth management boundaries", () => {
  test("reports owner and dependent runtime modes", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getProject = async (ref: string) => ({ ref }) as never;

    const ownerResponse = await request("/v1/projects/auth-owner/auth/runtime");
    const owner = await ownerResponse.json();
    expect(ownerResponse.status).toBe(200);
    expect(owner.mode).toBe("owner");
    expect(owner.local_gotrue_enabled).toBe(true);

    const dependentResponse = await request("/v1/projects/tenant-a/auth/runtime");
    const dependent = await dependentResponse.json();
    expect(dependentResponse.status).toBe(200);
    expect(dependent.mode).toBe("shared");
    expect(dependent.authority_project_ref).toBe("auth-owner");
    expect(dependent.public_auth_route).toBe("owner_proxy");
    expect(dependent.local_gotrue_enabled).toBe(false);
  });

  test("blocks dependent Studio user management before contacting GoTrue", async () => {
    config.authRuntimeOwnerRef = "auth-owner";

    const response = await request("/v1/projects/tenant-a/auth/users");
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("AUTH_RUNTIME_MANAGED_BY_OWNER");
    expect(body.authority_project_ref).toBe("auth-owner");
    expect(body.owner_management_path).toBe("/project/auth-owner/auth");
  });

  test("blocks dependent GoTrue service control", async () => {
    config.authRuntimeOwnerRef = "auth-owner";

    const response = await request("/v1/projects/tenant-a/services/gotrue/restart", {
      method: "POST",
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("AUTH_RUNTIME_MANAGED_BY_OWNER");
    expect(body.public_auth_route).toBe("owner_proxy");
  });

  test("reports owner restart fan-out failures instead of returning success", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.restartProject = async () => {
      throw new Error("dependent refresh failed");
    };

    const response = await request("/v1/projects/auth-owner/restart", { method: "POST" });
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.code).toBe("PROJECT_RESTART_FAILED");
    expect(body.message).toContain("dependent refresh failed");
  });
});
