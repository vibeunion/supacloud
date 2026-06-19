import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireAdminAuth = mock(() => Promise.resolve(undefined));

const listOrganizations = mock(() => Promise.resolve([]));
const getOrganizationBySlug = mock(() => Promise.resolve(null));
const createOrganization = mock(() => Promise.resolve(null));
const updateOrganization = mock(() => Promise.resolve(null));
const deleteOrganization = mock(() => Promise.resolve(null));
const listMembers = mock(() => Promise.resolve([]));
const addMember = mock(() => Promise.resolve(null));
const removeMember = mock(() => Promise.resolve(null));

const authModule = await import("../../src/middleware/auth");
const serviceModule = await import("../../src/services/organization.service");

const requireAdminAuthSpy = spyOn(authModule, "requireAdminAuth").mockImplementation(
  requireAdminAuth as typeof authModule.requireAdminAuth,
);
const serviceSpies = [
  spyOn(serviceModule.organizationService, "listOrganizations").mockImplementation(
    listOrganizations as typeof serviceModule.organizationService.listOrganizations,
  ),
  spyOn(serviceModule.organizationService, "getOrganizationBySlug").mockImplementation(
    getOrganizationBySlug as typeof serviceModule.organizationService.getOrganizationBySlug,
  ),
  spyOn(serviceModule.organizationService, "createOrganization").mockImplementation(
    createOrganization as typeof serviceModule.organizationService.createOrganization,
  ),
  spyOn(serviceModule.organizationService, "updateOrganization").mockImplementation(
    updateOrganization as typeof serviceModule.organizationService.updateOrganization,
  ),
  spyOn(serviceModule.organizationService, "deleteOrganization").mockImplementation(
    deleteOrganization as typeof serviceModule.organizationService.deleteOrganization,
  ),
  spyOn(serviceModule.organizationService, "listMembers").mockImplementation(
    listMembers as typeof serviceModule.organizationService.listMembers,
  ),
  spyOn(serviceModule.organizationService, "addMember").mockImplementation(
    addMember as typeof serviceModule.organizationService.addMember,
  ),
  spyOn(serviceModule.organizationService, "removeMember").mockImplementation(
    removeMember as typeof serviceModule.organizationService.removeMember,
  ),
];

const { organizationRoutes } = await import("../../src/routes/organizations");
const app = new Elysia().use(organizationRoutes);

const org = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  plan: "team",
  owner_id: "user-1",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

const member = {
  id: "member-1",
  organization_id: "org-1",
  email: "admin@example.com",
  role: "admin",
  user_id: "user-1",
  invited_at: new Date("2026-01-01T00:00:00Z"),
  joined_at: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        authorization: "Bearer dev-master-token",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("organizationRoutes", () => {
  afterAll(() => {
    requireAdminAuthSpy.mockRestore();
    for (const spy of serviceSpies) spy.mockRestore();
  });

  beforeEach(() => {
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(undefined);
    listOrganizations.mockReset();
    getOrganizationBySlug.mockReset();
    createOrganization.mockReset();
    updateOrganization.mockReset();
    deleteOrganization.mockReset();
    listMembers.mockReset();
    addMember.mockReset();
    removeMember.mockReset();

    listOrganizations.mockResolvedValue([org] as never);
    getOrganizationBySlug.mockResolvedValue(org as never);
    createOrganization.mockResolvedValue(org as never);
    updateOrganization.mockResolvedValue(org as never);
    deleteOrganization.mockResolvedValue(org as never);
    listMembers.mockResolvedValue([member] as never);
    addMember.mockResolvedValue(member as never);
    removeMember.mockResolvedValue(member as never);
  });

  test("POST creates an organization instead of returning the old 501 stub", async () => {
    const res = await request("/v1/organizations/", {
      method: "POST",
      body: JSON.stringify({ name: "Acme", slug: "acme", plan: "team", owner_id: "user-1" }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "org-1", slug: "acme", plan: "team", owner_id: "user-1" });
    expect(createOrganization).toHaveBeenCalledWith({ name: "Acme", slug: "acme", plan: "team", owner_id: "user-1" });
  });

  test("PATCH updates an organization", async () => {
    const res = await request("/v1/organizations/acme", {
      method: "PATCH",
      body: JSON.stringify({ name: "Acme Inc", slug: "acme-inc" }),
    });

    expect(res.status).toBe(200);
    expect(updateOrganization).toHaveBeenCalledWith("acme", { name: "Acme Inc", slug: "acme-inc" });
  });

  test("DELETE removes an organization", async () => {
    const res = await request("/v1/organizations/acme", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, organization: { slug: "acme" } });
    expect(deleteOrganization).toHaveBeenCalledWith("acme");
  });

  test("member endpoints list, add, and remove members", async () => {
    const list = await request("/v1/organizations/acme/members");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject([{ id: "member-1", email: "admin@example.com", role: "admin" }]);

    const add = await request("/v1/organizations/acme/members", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", role: "admin", user_id: "user-1" }),
    });
    expect(add.status).toBe(201);
    expect(await add.json()).toMatchObject({ id: "member-1", email: "admin@example.com", role: "admin" });
    expect(addMember).toHaveBeenCalledWith("acme", { email: "admin@example.com", role: "admin", user_id: "user-1" });

    const remove = await request("/v1/organizations/acme/members/member-1", { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toMatchObject({ deleted: true, member: { id: "member-1" } });
    expect(removeMember).toHaveBeenCalledWith("acme", "member-1");
  });

  test("admin auth failure blocks organization writes", async () => {
    requireAdminAuth.mockResolvedValueOnce({ status: 403, body: { error: "Admin privileges required" } });

    const res = await request("/v1/organizations/", {
      method: "POST",
      body: JSON.stringify({ name: "Acme" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admin privileges required" });
    expect(createOrganization).not.toHaveBeenCalled();
  });
});
