import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

let organizationSchemaAvailable = true;
let organizationJitAvailable = true;
let sharedRuntime = false;
let authorityProjectAvailable = true;
const projectDb = mock((strings: TemplateStringsArray) => {
  const query = strings.join("?");
  if (query.includes("auth.oauth_consents")) {
    return Promise.resolve([{ consents: true, clients: true, oauth_sessions: true }]);
  }
  return Promise.resolve([]);
});
const controlDb = mock((strings: TemplateStringsArray) => {
  const query = strings.join("?");
  if (query.includes("project_business_organizations")) {
    return Promise.resolve([{
      organizations: organizationSchemaAvailable,
      members: organizationSchemaAvailable,
      invitations: organizationSchemaAvailable,
    }]);
  }
  return Promise.resolve([]);
});

mock.module("../../src/db", () => ({
  sql: controlDb,
  resolveDbName: async () => "supa_proj_1",
  getProjectDb: () => projectDb,
}));
mock.module("../../src/services/organization-jit-capability.service", () => ({
  detectOrganizationJitCapability: async () => {
    if (sharedRuntime && !authorityProjectAvailable) {
      return { available: false, version: null, reason_code: "gotrue_custom_access_token_hook_authority_project_unavailable" };
    }
    return organizationJitAvailable
      ? { available: true, version: "gotrue-standard-webhooks-v1", reason_code: null }
      : { available: false, version: null, reason_code: "gotrue_custom_access_token_hook_not_enabled" };
  },
}));
mock.module("../../src/services/auth-runtime.service", () => ({
  getAuthRuntimeDescriptor: (ref: string) => ({
    project_ref: ref,
    mode: sharedRuntime ? "shared" : "local",
    authority_project_ref: sharedRuntime ? "owner_ref" : ref,
  }),
}));

const authModule = await import("../../src/middleware/auth");
const repository = await import("../../src/repositories/project.repository");
const requireAuth = spyOn(authModule, "requireProjectOrAdminAuth").mockResolvedValue(undefined);
const findProject = spyOn(repository.projectRepository, "findByRef").mockResolvedValue({ ref: "proj_1" } as never);
const runtimeFetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
const { projectCapabilityRoutes } = await import("../../src/routes/project-capabilities");
const app = new Elysia().use(projectCapabilityRoutes);

function request(path: string) {
  return app.handle(new Request(`http://localhost${path}`, { headers: { authorization: "Bearer admin" } }));
}

describe("project capability negotiation", () => {
  afterAll(() => {
    requireAuth.mockRestore(); findProject.mockRestore(); runtimeFetch.mockRestore();
  });
  beforeEach(() => {
    requireAuth.mockResolvedValue(undefined);
    findProject.mockImplementation(async (ref: string) => (
      ref === "owner_ref" && !authorityProjectAvailable
        ? null
        : { ref, config: {} } as never
    ));
    organizationSchemaAvailable = true;
    organizationJitAvailable = true;
    sharedRuntime = false;
    authorityProjectAvailable = true;
    runtimeFetch.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  test("advertises only negotiable GoTrue-compatible capabilities", async () => {
    const response = await request("/v1/projects/proj_1/capabilities");
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.auth_runtime).toBe("gotrue");
    expect(body.capabilities.webhook_delivery_v2).toMatchObject({ available: true, source: "supacloud" });
    expect(body.capabilities.business_organizations_v1).toMatchObject({
      available: true,
      source: "supacloud",
      version: "v1",
      reason_code: null,
    });
    expect(body.capabilities.business_organizations_v1.reason_code)
      .not.toBe("organization_runtime_consumption_not_implemented");
    expect(body.capabilities.business_organization_jit_v1).toMatchObject({
      available: true,
      source: "gotrue",
      version: "gotrue-standard-webhooks-v1",
    });
    expect(body.capabilities).not.toHaveProperty("external_oidc_issuer_v1");
    expect(body.capabilities).not.toHaveProperty("token_exchange_v1");
    expect(body.capabilities.gotrue_auth_hooks_v1.source).toBe("gotrue");
    if (body.capabilities.gotrue_auth_hooks_v1.available) {
      expect(body.capabilities.gotrue_auth_hooks_v1).toMatchObject({ version: "stock", reason_code: null });
    } else {
      expect(body.capabilities.gotrue_auth_hooks_v1.reason_code).toBeTruthy();
    }
  });

  test("does not advertise organization runtime materialization before its schema exists", async () => {
    organizationSchemaAvailable = false;

    const response = await request("/v1/projects/proj_1/capabilities");
    const body = await response.json() as any;

    expect(body.capabilities.business_organizations_v1).toMatchObject({
      available: false,
      reason_code: "business_organization_schema_incomplete",
    });
  });

  test("keeps JIT unavailable when the stock GoTrue hook has no runtime evidence", async () => {
    organizationJitAvailable = false;

    const response = await request("/v1/projects/proj_1/capabilities");
    const body = await response.json() as any;

    expect(body.capabilities.business_organization_jit_v1).toMatchObject({
      available: false,
      source: "gotrue",
      version: null,
      reason_code: "gotrue_custom_access_token_hook_not_enabled",
    });
  });

  test("reports shared GoTrue and JIT capabilities from the reachable authority project", async () => {
    sharedRuntime = true;

    const response = await request("/v1/projects/proj_1/capabilities");
    const body = await response.json() as any;

    expect(body.capabilities.gotrue_auth_hooks_v1).toMatchObject({
      available: true,
      source: "gotrue",
      authority_project_ref: "owner_ref",
      managed_by_owner: true,
    });
    expect(body.capabilities.business_organization_jit_v1).toMatchObject({
      available: true,
      authority_project_ref: "owner_ref",
      managed_by_owner: true,
    });
  });

  test("keeps shared capabilities unavailable when the authority project is missing", async () => {
    sharedRuntime = true;
    authorityProjectAvailable = false;

    const response = await request("/v1/projects/proj_1/capabilities");
    const body = await response.json() as any;

    expect(body.capabilities.gotrue_auth_hooks_v1).toMatchObject({
      available: false,
      reason_code: "auth_runtime_owner_project_unavailable",
      authority_project_ref: "owner_ref",
      managed_by_owner: true,
    });
    expect(body.capabilities.business_organization_jit_v1).toMatchObject({
      available: false,
      reason_code: "gotrue_custom_access_token_hook_authority_project_unavailable",
      authority_project_ref: "owner_ref",
      managed_by_owner: true,
    });
  });
});
