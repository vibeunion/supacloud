import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const bffModule = await import("../../src/services/bff-proof.service");
const collaboratorModule = await import("../../src/services/project-collaborator.service");
const controlModule = await import("../../src/services/project-control-secrets.service");
const { ValidationError } = await import("../../src/utils/errors");
const requireAuth = spyOn(authModule, "requireProjectOrAdminAuth").mockResolvedValue(undefined);
const trustedPrincipal = spyOn(bffModule, "resolveTrustedPrincipal").mockResolvedValue({
  id: "admin-one",
  type: "admin",
  requestId: "request-one",
  platformAdmin: false,
});
const requireCapability = spyOn(collaboratorModule, "requireCapability").mockResolvedValue(undefined);
const project = spyOn(servicesModule.projectService, "getProject").mockResolvedValue({ ref: "proj_1" } as never);
const list = spyOn(controlModule.projectControlSecretsService, "listStatuses").mockResolvedValue([]);
const get = spyOn(controlModule.projectControlSecretsService, "getStatus").mockResolvedValue({
  scope: "captcha",
  name: "hcaptcha",
  configured: false,
  value: "********",
  updated_at: null,
});
const upsert = spyOn(controlModule.projectControlSecretsService, "upsert").mockResolvedValue({
  scope: "connector",
  name: "github",
  configured: true,
  value: "********",
  updated_at: "2026-07-19T00:00:00.000Z",
});
const remove = spyOn(controlModule.projectControlSecretsService, "remove").mockResolvedValue({
  scope: "auth-hook",
  name: "custom_access_token_hook",
  configured: false,
  value: "********",
  updated_at: null,
});

const { projectControlSecretsRoutes } = await import("../../src/routes/project-control-secrets");
const app = new Elysia().use(projectControlSecretsRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { authorization: "Bearer dev-master-token", "content-type": "application/json", ...(init.headers || {}) },
  }));
}

describe("project control secret routes", () => {
  afterAll(() => {
    requireAuth.mockRestore();
    trustedPrincipal.mockRestore();
    requireCapability.mockRestore();
    project.mockRestore();
    list.mockRestore();
    get.mockRestore();
    upsert.mockRestore();
    remove.mockRestore();
  });

  beforeEach(() => {
    requireAuth.mockResolvedValue(undefined);
    trustedPrincipal.mockResolvedValue({
      id: "admin-one",
      type: "admin",
      requestId: "request-one",
      platformAdmin: false,
    });
    requireCapability.mockResolvedValue(undefined);
    project.mockResolvedValue({ ref: "proj_1" } as never);
    list.mockResolvedValue([]);
    get.mockResolvedValue({ scope: "captcha", name: "hcaptcha", configured: false, value: "********", updated_at: null });
    upsert.mockResolvedValue({ scope: "connector", name: "github", configured: true, value: "********", updated_at: "2026-07-19T00:00:00.000Z" });
    remove.mockResolvedValue({ scope: "auth-hook", name: "custom_access_token_hook", configured: false, value: "********", updated_at: null });
  });

  test("upsert and read APIs only return masked status", async () => {
    const response = await request("/v1/projects/proj_1/control-secrets/connector/github", {
      method: "PUT",
      body: JSON.stringify({ value: "ghs_plain_secret" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ configured: true, value: "********", name: "github" });
    expect(JSON.stringify(body)).not.toContain("ghs_plain_secret");
    expect(upsert).toHaveBeenCalledWith("proj_1", "connector", "github", "ghs_plain_secret");
    expect(requireCapability).toHaveBeenCalledWith(
      "proj_1",
      expect.objectContaining({ id: "admin-one" }),
      "security.manage",
    );

    const read = await request("/v1/projects/proj_1/control-secrets/connector/github");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ value: "********" });
    expect(requireCapability).toHaveBeenLastCalledWith(
      "proj_1",
      expect.objectContaining({ id: "admin-one" }),
      "security.read",
    );
  });

  test("rejects unsupported scopes and invalid names", async () => {
    const scope = await request("/v1/projects/proj_1/control-secrets/pat/token");
    expect(scope.status).toBe(400);
    get.mockRejectedValueOnce(new ValidationError("Secret name must be lowercase"));
    const name = await request("/v1/projects/proj_1/control-secrets/captcha/BadName");
    expect(name.status).toBe(400);
  });

  test("does not misreport storage failures as invalid input", async () => {
    get.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await request("/v1/projects/proj_1/control-secrets/captcha/hcaptcha");
    expect(response.status).toBe(500);
  });

  test("deletes a secret without exposing its previous value", async () => {
    const response = await request("/v1/projects/proj_1/control-secrets/auth-hook/custom_access_token_hook", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false, value: "********" });
    expect(remove).toHaveBeenCalledWith("proj_1", "auth-hook", "custom_access_token_hook");
  });
});
