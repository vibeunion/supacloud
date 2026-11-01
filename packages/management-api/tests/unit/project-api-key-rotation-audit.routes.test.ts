// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireAdminAuth = spyOn(
  (await import("../../src/middleware/auth")),
  "requireAdminAuth",
);
const services = await import("../../src/services");
const audit = await import("../../src/services/audit.service");
const rotateApiKeys = spyOn(services.projectService, "rotateApiKeys");
const rotateOpaqueApiKeys = spyOn(services.projectService, "rotateOpaqueApiKeys");
const logAuditEvent = spyOn(audit, "logAuditEvent");
const markRequestAuditCommitted = spyOn(audit, "markRequestAuditCommitted");

const { projectConfigRoutes } = await import("../../src/routes/project-config");
const app = new Elysia().use(projectConfigRoutes);

function rotate(path: string) {
  return app.handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-master-token" },
  }));
}

describe("project API key rotation audit", () => {
  afterAll(() => {
    requireAdminAuth.mockRestore();
    rotateApiKeys.mockRestore();
    rotateOpaqueApiKeys.mockRestore();
    logAuditEvent.mockRestore();
    markRequestAuditCommitted.mockRestore();
  });

  beforeEach(() => {
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(undefined);
    rotateApiKeys.mockReset();
    rotateOpaqueApiKeys.mockReset();
    logAuditEvent.mockReset();
    logAuditEvent.mockResolvedValue(undefined);
    markRequestAuditCommitted.mockReset();
  });

  test("legacy JWT rotation records the kind and not the new keys", async () => {
    rotateApiKeys.mockResolvedValue({ anon_key: "anon-secret", service_role_key: "service-secret" });
    const response = await rotate("/v1/projects/proj_1/api-keys/rotate");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ anon_key: "anon-secret", service_role_key: "********" });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.api_keys.rotate",
      status: 200,
      metadata: expect.objectContaining({
        resource_id: "proj_1",
        rotation_kind: "legacy_jwt",
        restarts_runtime: true,
        material_recorded: false,
      }),
    }));
    expect(JSON.stringify(logAuditEvent.mock.calls[0]?.[0])).not.toContain("anon-secret");
    expect(JSON.stringify(logAuditEvent.mock.calls[0]?.[0])).not.toContain("service-secret");
    expect(markRequestAuditCommitted).toHaveBeenCalledTimes(1);
  });

  test("opaque rotation does not claim a runtime restart or record key material", async () => {
    rotateOpaqueApiKeys.mockResolvedValue({ publishable_key: "pub-secret", secret_key: "sec-secret" });
    const response = await rotate("/v1/projects/proj_1/api-keys/rotate-opaque");
    expect(response.status).toBe(200);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.api_keys.rotate_opaque",
      metadata: expect.objectContaining({
        rotation_kind: "opaque",
        restarts_runtime: false,
        invalidates_user_sessions: false,
        material_recorded: false,
      }),
    }));
    expect(JSON.stringify(logAuditEvent.mock.calls[0]?.[0])).not.toContain("pub-secret");
    expect(JSON.stringify(logAuditEvent.mock.calls[0]?.[0])).not.toContain("sec-secret");
  });
});
