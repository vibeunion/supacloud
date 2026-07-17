import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { projectService } from "../../src/services";

const app = new Elysia().use(projectConfigRoutes);
const authHeaders = { Authorization: "Bearer dev-master-token" };
const originalOwnerRef = config.authRuntimeOwnerRef;
const originalGetProjectSettings = projectService.getProjectSettings;
const originalUpdateProjectSettings = projectService.updateProjectSettings;

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers || {}) },
  }));
}

afterEach(() => {
  config.authRuntimeOwnerRef = originalOwnerRef;
  projectService.getProjectSettings = originalGetProjectSettings;
  projectService.updateProjectSettings = originalUpdateProjectSettings;
});

describe("SupAuth auth config boundary", () => {
  test("requires authentication for auth config reads", async () => {
    const response = await app.handle(new Request("http://localhost/v1/projects/tenant-a/config/auth"));
    expect(response.status).toBe(401);
  });

  test("blocks dependent auth config reads and writes", async () => {
    config.authRuntimeOwnerRef = "auth-owner";

    const getResponse = await request("/v1/projects/tenant-a/config/auth");
    expect(getResponse.status).toBe(409);
    expect((await getResponse.json()).code).toBe("AUTH_RUNTIME_MANAGED_BY_OWNER");

    const patchResponse = await request("/v1/projects/tenant-a/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ EXTERNAL_EMAIL_ENABLED: false }),
    });
    expect(patchResponse.status).toBe(409);
  });

  test("allowlists owner auth config fields and masks hook secrets", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getProjectSettings = async () => ({
      auth: {
        jwt_secret: "must-not-leak",
        hooks: {
          custom_access_token_hook: {
            enabled: true,
            uri: "pg-functions://postgrest/auth_hook",
            secrets: "must-mask",
          },
        },
        smtp: { pass: "must-mask" },
        saml: { private_key: "must-not-leak" },
      },
    } as never);

    const response = await request("/v1/projects/auth-owner/config/auth");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.jwt_secret).toBeUndefined();
    expect(body.saml).toBeUndefined();
    expect(body.hook_custom_access_token_secrets).toBe("********");
    expect(body.smtp_pass).toBe("********");
  });

  test("shared settings alias hides auth config and rejects auth writes", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getProjectSettings = async () => ({
      auth: { jwt_secret: "dependent-secret" },
      api_domain: "tenant-a.api.example.com",
    });
    let updateCalls = 0;
    projectService.updateProjectSettings = async () => {
      updateCalls += 1;
      return {
        auth: { smtp: { pass: "dependent-secret" } },
        api_domain: "updated.api.example.com",
      } as never;
    };

    const getResponse = await request("/v1/projects/tenant-a/settings");
    const body = await getResponse.json();
    expect(getResponse.status).toBe(200);
    expect(body.auth).toBeUndefined();
    expect(body.auth_runtime).toEqual({
      mode: "shared",
      authority_project_ref: "auth-owner",
      configuration_management: "owner_only",
    });

    const putResponse = await request("/v1/projects/tenant-a/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { enable_signup: false } }),
    });
    expect(putResponse.status).toBe(409);
    expect(updateCalls).toBe(0);

    const safePutResponse = await request("/v1/projects/tenant-a/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_domain: "updated.api.example.com" }),
    });
    const safePutBody = await safePutResponse.json();
    expect(safePutResponse.status).toBe(200);
    expect(safePutBody.auth).toBeUndefined();
    expect(safePutBody.auth_runtime).toEqual({
      mode: "shared",
      authority_project_ref: "auth-owner",
      configuration_management: "owner_only",
    });
    expect(updateCalls).toBe(1);
  });
});
