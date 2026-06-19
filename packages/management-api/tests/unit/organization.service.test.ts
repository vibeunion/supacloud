import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const repositoryModule = await import("../../src/repositories/organization.repository");
const serviceModule = await import("../../src/services/organization.service");

const findAll = mock(() => Promise.resolve([]));
const findBySlug = mock(() => Promise.resolve(null));
const create = mock(() => Promise.resolve(null));
const updateBySlug = mock(() => Promise.resolve(null));
const deleteBySlug = mock(() => Promise.resolve(null));
const countProjects = mock(() => Promise.resolve(0));
const findMembers = mock(() => Promise.resolve([]));
const upsertMember = mock(() => Promise.resolve(null));
const deleteMember = mock(() => Promise.resolve(null));
const ensureDefaultOrganization = mock(() => Promise.resolve(null));

const repositorySpies = [
  spyOn(repositoryModule.organizationRepository, "findAll").mockImplementation(
    findAll as typeof repositoryModule.organizationRepository.findAll,
  ),
  spyOn(repositoryModule.organizationRepository, "findBySlug").mockImplementation(
    findBySlug as typeof repositoryModule.organizationRepository.findBySlug,
  ),
  spyOn(repositoryModule.organizationRepository, "create").mockImplementation(
    create as typeof repositoryModule.organizationRepository.create,
  ),
  spyOn(repositoryModule.organizationRepository, "updateBySlug").mockImplementation(
    updateBySlug as typeof repositoryModule.organizationRepository.updateBySlug,
  ),
  spyOn(repositoryModule.organizationRepository, "deleteBySlug").mockImplementation(
    deleteBySlug as typeof repositoryModule.organizationRepository.deleteBySlug,
  ),
  spyOn(repositoryModule.organizationRepository, "countProjects").mockImplementation(
    countProjects as typeof repositoryModule.organizationRepository.countProjects,
  ),
  spyOn(repositoryModule.organizationRepository, "findMembers").mockImplementation(
    findMembers as typeof repositoryModule.organizationRepository.findMembers,
  ),
  spyOn(repositoryModule.organizationRepository, "upsertMember").mockImplementation(
    upsertMember as typeof repositoryModule.organizationRepository.upsertMember,
  ),
  spyOn(repositoryModule.organizationRepository, "deleteMember").mockImplementation(
    deleteMember as typeof repositoryModule.organizationRepository.deleteMember,
  ),
  spyOn(repositoryModule.organizationRepository, "ensureDefaultOrganization").mockImplementation(
    ensureDefaultOrganization as typeof repositoryModule.organizationRepository.ensureDefaultOrganization,
  ),
];

const org = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  plan: "free",
  owner_id: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

const member = {
  id: "member-1",
  organization_id: "org-1",
  email: "owner@example.com",
  role: "owner",
  user_id: null,
  invited_at: new Date("2026-01-01T00:00:00Z"),
  joined_at: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

describe("organizationService", () => {
  afterAll(() => {
    for (const spy of repositorySpies) spy.mockRestore();
  });

  beforeEach(() => {
    findAll.mockReset();
    findBySlug.mockReset();
    create.mockReset();
    updateBySlug.mockReset();
    deleteBySlug.mockReset();
    countProjects.mockReset();
    findMembers.mockReset();
    upsertMember.mockReset();
    deleteMember.mockReset();
    ensureDefaultOrganization.mockReset();

    findBySlug.mockResolvedValue(null);
    create.mockResolvedValue(org as never);
    updateBySlug.mockResolvedValue(org as never);
    deleteBySlug.mockResolvedValue(org as never);
    countProjects.mockResolvedValue(0);
    findMembers.mockResolvedValue([member] as never);
    upsertMember.mockResolvedValue(member as never);
    deleteMember.mockResolvedValue(member as never);
    ensureDefaultOrganization.mockResolvedValue(org as never);
  });

  test("createOrganization normalizes name-derived slug and default plan", async () => {
    const result = await serviceModule.createOrganization({ name: " Acme Team! " });

    expect(result).toBe(org);
    expect(create).toHaveBeenCalledWith({
      name: "Acme Team!",
      slug: "acme-team",
      plan: "free",
      owner_id: null,
    });
  });

  test("createOrganization rejects duplicate slug", async () => {
    findBySlug.mockResolvedValueOnce(org as never);

    await expect(serviceModule.createOrganization({ name: "Acme", slug: "acme" })).rejects.toMatchObject({
      status: 409,
      code: "409",
      message: "Organization slug already exists",
    });
  });

  test("deleteOrganization protects default and organizations with active projects", async () => {
    findBySlug.mockResolvedValueOnce({ ...org, slug: "default" } as never);
    await expect(serviceModule.deleteOrganization("default")).rejects.toMatchObject({
      status: 409,
      message: "Default organization cannot be deleted",
    });

    findBySlug.mockResolvedValueOnce(org as never);
    countProjects.mockResolvedValueOnce(2);
    await expect(serviceModule.deleteOrganization("acme")).rejects.toMatchObject({
      status: 409,
      message: "Organization has active projects and cannot be deleted",
    });
  });

  test("addMember normalizes email and role before upsert", async () => {
    findBySlug.mockResolvedValueOnce(org as never);
    const result = await serviceModule.addMember("acme", {
      email: " OWNER@Example.COM ",
      role: "Owner",
    });

    expect(result).toBe(member);
    expect(upsertMember).toHaveBeenCalledWith("org-1", {
      email: "owner@example.com",
      role: "owner",
      user_id: null,
    });
  });

  test("addMember rejects invalid roles", async () => {
    findBySlug.mockResolvedValueOnce(org as never);

    await expect(serviceModule.addMember("acme", {
      email: "owner@example.com",
      role: "superuser",
    })).rejects.toMatchObject({
      status: 400,
      message: "Member role must be one of owner, admin, member, viewer",
    });
  });
});
