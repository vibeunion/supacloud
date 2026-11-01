// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireAdminAuth = mock(() => Promise.resolve(undefined));
const getVerifiedRequestPrincipal = mock(() => Promise.resolve({ id: "master", type: "master" }));
const governanceSnapshot = mock(() => Promise.resolve({ catalog: { deployed: false } }));
const listOrganizationProjects = mock(() => Promise.resolve([]));
const upsertTeamGrant = mock(() => Promise.resolve({ id: "grant-1" }));
const listProjectSsoProviders = mock(() => Promise.resolve({ status: 200, body: { items: [] } }));
const createProjectAuditExport = mock(() => Promise.resolve({ id: "export-1", status: "completed" }));
const findByRef = mock(() => Promise.resolve(null));

const auth = await import("../../src/middleware/auth");
const team = await import("../../src/services/organization-team.service");
const sso = await import("../../src/routes/auth-sso");
const auditRoutes = await import("../../src/routes/project-audit");
const projects = await import("../../src/repositories/project.repository");

const spies = [
  spyOn(auth, "requireAdminAuth").mockImplementation(requireAdminAuth as typeof auth.requireAdminAuth),
  spyOn(auth, "getVerifiedRequestPrincipal").mockImplementation(
    getVerifiedRequestPrincipal as typeof auth.getVerifiedRequestPrincipal,
  ),
  spyOn(team.organizationTeamService, "governanceSnapshot").mockImplementation(
    governanceSnapshot as typeof team.organizationTeamService.governanceSnapshot,
  ),
  spyOn(team.organizationTeamService, "listOrganizationProjects").mockImplementation(
    listOrganizationProjects as typeof team.organizationTeamService.listOrganizationProjects,
  ),
  spyOn(team.organizationTeamService, "upsertTeamGrant").mockImplementation(
    upsertTeamGrant as typeof team.organizationTeamService.upsertTeamGrant,
  ),
  spyOn(sso, "listProjectSsoProviders").mockImplementation(
    listProjectSsoProviders as typeof sso.listProjectSsoProviders,
  ),
  spyOn(auditRoutes, "createProjectAuditExport").mockImplementation(
    createProjectAuditExport as typeof auditRoutes.createProjectAuditExport,
  ),
  spyOn(projects.projectRepository, "findByRef").mockImplementation(
    findByRef as typeof projects.projectRepository.findByRef,
  ),
];

const { organizationGovernanceRoutes } = await import("../../src/routes/organization-governance");
const app = new Elysia().use(organizationGovernanceRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer dev-master-token",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }));
}

describe("organization governance routes", () => {
  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
  });

  beforeEach(() => {
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(undefined);
    getVerifiedRequestPrincipal.mockReset();
    getVerifiedRequestPrincipal.mockResolvedValue({ id: "master", type: "master" });
    governanceSnapshot.mockReset();
    listOrganizationProjects.mockReset();
    upsertTeamGrant.mockReset();
    listProjectSsoProviders.mockReset();
    createProjectAuditExport.mockReset();
    findByRef.mockReset();
  });

  test("requires admin auth", async () => {
    requireAdminAuth.mockResolvedValue({ status: 403, body: { error: "Admin privileges required" } });
    const response = await request("/v1/organizations/acme/governance");
    expect(response.status).toBe(403);
  });

  test("returns the governance snapshot", async () => {
    governanceSnapshot.mockResolvedValue({ catalog: { deployed: false, scim: { available: false } } });
    const response = await request("/v1/organizations/acme/governance");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ catalog: { deployed: false } });
  });

  test("SCIM is an explicit stub", async () => {
    const response = await request("/v1/organizations/acme/scim", { method: "POST", body: "{}" });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ reason_code: "scim_not_implemented", available: false });
  });

  test("SSO provider list is limited to organization projects", async () => {
    listOrganizationProjects.mockResolvedValue([]);
    const missing = await request("/v1/organizations/acme/projects/proj_1/sso/providers");
    expect(missing.status).toBe(404);
    expect(listProjectSsoProviders).not.toHaveBeenCalled();

    listOrganizationProjects.mockResolvedValue([{ ref: "proj_1", name: "App", sso_providers_route: "/v1/projects/proj_1/auth/sso/providers" }]);
    listProjectSsoProviders.mockResolvedValue({ status: 200, body: { items: [{ id: "saml-1" }] } });
    const listed = await request("/v1/organizations/acme/projects/proj_1/sso/providers");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ items: [{ id: "saml-1" }] });
  });

  test("audit export delegates to the project export for an owned project", async () => {
    listOrganizationProjects.mockResolvedValue([{ ref: "proj_1", name: "App" }]);
    createProjectAuditExport.mockResolvedValue({ id: "export-1", status: "completed" });
    const response = await request("/v1/organizations/acme/audit/exports", {
      method: "POST",
      body: JSON.stringify({ project_ref: "proj_1", format: "jsonl" }),
    });
    expect(response.status).toBe(201);
    expect(createProjectAuditExport).toHaveBeenCalledWith("proj_1", expect.objectContaining({
      project_ref: "proj_1",
      format: "jsonl",
    }), "master");
    expect(await response.json()).toMatchObject({
      download_url: "/v1/projects/proj_1/audit/exports/export-1/download",
      scope: "project",
    });
  });

  test("key custody does not return the stored ARN", async () => {
    listOrganizationProjects.mockResolvedValue([{ ref: "proj_1", name: "App" }]);
    const arn = "arn:aws:kms:us-east-1:123456789012:key/hidden";
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: { auth: { oauth_server: { jwt_keys: [{ "aws:kms:arn": arn, d: "private-material" }] } } },
    });
    const response = await request("/v1/organizations/acme/projects/proj_1/key-custody");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.custody.aws_kms_arn_references).toBe(1);
    expect(body.custody.provider_call).toBe(false);
    expect(JSON.stringify(body)).not.toContain(arn);
    expect(JSON.stringify(body)).not.toContain("private-material");
  });
});
