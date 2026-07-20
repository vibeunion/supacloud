import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const serviceModule = await import("../../src/services/project-organization.service");
const bffModule = await import("../../src/services/bff-proof.service");
const collaboratorModule = await import("../../src/services/project-collaborator.service");
const invitationPrincipalModule = await import("../../src/services/invitation-principal.service");
const requireAuth = spyOn(authModule, "requireProjectOrAdminAuth").mockResolvedValue(undefined);
const trustedPrincipal = spyOn(bffModule, "resolveTrustedPrincipal").mockResolvedValue({
  id: "admin",
  type: "admin",
  requestId: "req-admin",
  platformAdmin: true,
});
const requireCapability = spyOn(
  collaboratorModule.projectCollaboratorService,
  "requireCapability",
).mockResolvedValue(undefined);
const invitationPrincipal = spyOn(
  invitationPrincipalModule,
  "resolveInvitationPrincipal",
).mockResolvedValue({ id: "gotrue-user", email: "new@example.com" });
const service = serviceModule.projectOrganizationService;
const spies = {
  list: spyOn(service, "list").mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 } as never),
  create: spyOn(service, "create").mockResolvedValue({ id: "org-one", slug: "acme" } as never),
  members: spyOn(service, "listMembers").mockResolvedValue({ items: [], total: 0 } as never),
  addMember: spyOn(service, "addMember").mockResolvedValue({ id: "member-one", user_id: "user-one" } as never),
  updateMember: spyOn(service, "updateMember").mockResolvedValue({ id: "member-one", user_id: "user-one", role: "admin" } as never),
  removeMember: spyOn(service, "removeMember").mockResolvedValue({ id: "member-one", user_id: "user-one" } as never),
  invite: spyOn(service, "invite").mockResolvedValue({ id: "invite-one", token: "one-time" } as never),
  jit: spyOn(service, "update").mockResolvedValue({ id: "org-one", jit_enabled: true, jit_domains: ["example.com"] } as never),
  reconcileJit: spyOn(service, "reconcileJitMemberships").mockResolvedValue({
    items: [{ organization_id: "org-one", slug: "acme", role: "member" }],
    total: 1,
    limit: 50,
    truncated: false,
  } as never),
  apps: spyOn(service, "bindApplication").mockResolvedValue({ id: "binding-one", application_id: "app-one" } as never),
  accept: spyOn(service, "acceptInvitation").mockResolvedValue({ id: "member-one", user_id: "gotrue-user" } as never),
};
const { projectOrganizationRoutes } = await import("../../src/routes/project-organizations");
const app = new Elysia().use(projectOrganizationRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { authorization: "Bearer admin", "content-type": "application/json", ...(init.headers || {}) },
  }));
}

describe("project business organization routes", () => {
  afterAll(() => {
    requireAuth.mockRestore();
    trustedPrincipal.mockRestore();
    requireCapability.mockRestore();
    invitationPrincipal.mockRestore();
    Object.values(spies).forEach((spy) => spy.mockRestore());
  });
  beforeEach(() => {
    requireAuth.mockResolvedValue(undefined);
    requireAuth.mockClear();
    trustedPrincipal.mockResolvedValue({ id: "admin", type: "admin", requestId: "req-admin", platformAdmin: true });
    trustedPrincipal.mockClear();
    requireCapability.mockResolvedValue(undefined);
    requireCapability.mockClear();
    invitationPrincipal.mockResolvedValue({ id: "gotrue-user", email: "new@example.com" });
    invitationPrincipal.mockClear();
    Object.values(spies).forEach((spy) => spy.mockClear());
  });

  test("keeps business organizations project-scoped and paged", async () => {
    const response = await request("/v1/projects/proj_1/organizations?page=2&limit=10");
    expect(await response.json()).toMatchObject({ total: 0, page: 1 });
    expect(spies.list).toHaveBeenCalledWith("proj_1", {
      page: 2,
      limit: 10,
      search: undefined,
      application_id: undefined,
    });
    expect(requireCapability).toHaveBeenCalledWith(
      "proj_1",
      expect.objectContaining({ id: "admin" }),
      "organizations.read",
    );
  });

  test("filters organizations by bound application", async () => {
    await request("/v1/projects/proj_1/organizations?application_id=app-one");
    expect(spies.list).toHaveBeenCalledWith("proj_1", expect.objectContaining({
      application_id: "app-one",
    }));
  });

  test("supports member enrollment through GoTrue user ids", async () => {
    const response = await request("/v1/projects/proj_1/organizations/org-one/members", {
      method: "POST",
      body: JSON.stringify({ user_id: "user-one", role: "member" }),
    });
    expect(response.status).toBe(201);
    expect(spies.addMember).toHaveBeenCalledWith("proj_1", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });
    expect(requireCapability).toHaveBeenCalledWith(
      "proj_1",
      expect.objectContaining({ id: "admin" }),
      "organizations.manage",
    );
  });

  test("updates and removes members using either row id or GoTrue user id", async () => {
    const updated = await request("/v1/projects/proj_1/organizations/org-one/members/user-one", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });
    expect(updated.status).toBe(200);
    expect(spies.updateMember).toHaveBeenCalledWith("proj_1", "org-one", "user-one", {
      role: "admin",
      actor: "admin",
    });

    const removed = await request("/v1/projects/proj_1/organizations/org-one/members/user-one", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(spies.removeMember).toHaveBeenCalledWith("proj_1", "org-one", "user-one", "admin");
  });

  test("supports invitation, JIT and application binding subresources", async () => {
    const invitation = await request("/v1/projects/proj_1/organizations/org-one/invitations", {
      method: "POST",
      body: JSON.stringify({ email: "new@example.com", role: "member" }),
    });
    expect(invitation.status).toBe(201);
    expect(await invitation.json()).toMatchObject({ token: "one-time" });
    expect(spies.invite).toHaveBeenCalledWith({
      ref: "proj_1",
      organizationId: "org-one",
      email: "new@example.com",
      role: "member",
      actor: "admin",
      ttlHours: undefined,
    });

    const jit = await request("/v1/projects/proj_1/organizations/org-one/jit", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, domains: ["example.com"] }),
    });
    expect(await jit.json()).toMatchObject({ enabled: true, domains: ["example.com"] });
    expect(spies.jit).toHaveBeenCalledWith("proj_1", "org-one", { jit_enabled: true, jit_domains: ["example.com"] });

    const reconciled = await request("/v1/projects/proj_1/organizations/jit/reconcile", {
      method: "POST",
      body: JSON.stringify({ user_id: "gotrue-user" }),
    });
    expect(await reconciled.json()).toMatchObject({ total: 1, truncated: false });
    expect(spies.reconcileJit).toHaveBeenCalledWith("proj_1", "gotrue-user");

    const binding = await request("/v1/projects/proj_1/organizations/org-one/applications", {
      method: "POST",
      body: JSON.stringify({ application_id: "app-one" }),
    });
    expect(binding.status).toBe(201);
    expect(spies.apps).toHaveBeenCalledWith("proj_1", "org-one", "app-one", "admin");
  });

  test("returns 403 before service access when collaborator capability is missing", async () => {
    const { ForbiddenError } = await import("../../src/utils/errors");
    requireCapability.mockRejectedValueOnce(new ForbiddenError("Missing collaborator capability: organizations.manage"));

    const response = await request("/v1/projects/proj_1/organizations", {
      method: "POST",
      body: JSON.stringify({ name: "Denied organization" }),
    });

    expect(response.status).toBe(403);
    expect(spies.create).not.toHaveBeenCalled();
  });

  test("accepts invitations with a real GoTrue principal without requiring prior organization access", async () => {
    const response = await request(
      "/v1/projects/proj_1/organizations/org-one/invitations/invite-one/accept",
      {
        method: "POST",
        headers: { authorization: "Bearer gotrue-user-token" },
        body: JSON.stringify({ token: "one-time" }),
      },
    );

    expect(response.status).toBe(200);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(requireCapability).not.toHaveBeenCalled();
    expect(invitationPrincipal).toHaveBeenCalledWith(expect.any(Request), "proj_1");
    expect(spies.accept).toHaveBeenCalledWith(expect.objectContaining({
      principal: { id: "gotrue-user", email: "new@example.com" },
    }));
  });
});
