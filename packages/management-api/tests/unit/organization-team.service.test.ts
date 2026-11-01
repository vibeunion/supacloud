// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

const organizationRepository = await import("../../src/repositories/organization.repository");
const teamRepository = await import("../../src/repositories/organization-team.repository");
const projectRepository = await import("../../src/repositories/project.repository");
const collaborator = await import("../../src/services/project-collaborator.service");
const audit = await import("../../src/services/audit.service");
const service = await import("../../src/services/organization-team.service");

const org = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  plan: "free",
  owner_id: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};
const team = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "org-1",
  name: "Platform",
  slug: "platform",
  description: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};
const member = {
  id: "membership-1",
  team_id: team.id,
  member_id: "member-1",
  role: "member",
  email: "person@example.com",
  user_id: "user-1",
  organization_role: "member",
  created_at: new Date("2026-01-01T00:00:00Z"),
};

const findBySlug = spyOn(organizationRepository.organizationRepository, "findBySlug");
const findMemberById = spyOn(organizationRepository.organizationRepository, "findMemberById");
const findMembers = spyOn(organizationRepository.organizationRepository, "findMembers");
const findTeam = spyOn(teamRepository.organizationTeamRepository, "findTeam");
const insertTeam = spyOn(teamRepository.organizationTeamRepository, "insertTeam");
const listMembers = spyOn(teamRepository.organizationTeamRepository, "listMembers");
const insertMember = spyOn(teamRepository.organizationTeamRepository, "insertMember");
const listGrants = spyOn(teamRepository.organizationTeamRepository, "listGrants");
const upsertGrant = spyOn(teamRepository.organizationTeamRepository, "upsertGrant");
const listGrantsForMember = spyOn(teamRepository.organizationTeamRepository, "listGrantsForMember");
const countTeams = spyOn(teamRepository.organizationTeamRepository, "countTeams");
const listOrganizationProjects = spyOn(teamRepository.organizationTeamRepository, "listOrganizationProjects");
const findByRef = spyOn(projectRepository.projectRepository, "findByRef");
const applyTeamProjectGrant = spyOn(collaborator, "applyTeamProjectGrant");
const releaseTeamProjectGrant = spyOn(collaborator, "releaseTeamProjectGrant");
const appendAuditEvent = spyOn(audit, "appendAuditEvent");

describe("organizationTeamService", () => {
  afterAll(() => {
    for (const spy of [
      findBySlug, findMemberById, findMembers, findTeam, insertTeam, listMembers, insertMember,
      listGrants, upsertGrant, listGrantsForMember, countTeams, listOrganizationProjects,
      findByRef, applyTeamProjectGrant, releaseTeamProjectGrant, appendAuditEvent,
    ]) spy.mockRestore();
  });

  beforeEach(() => {
    for (const spy of [
      findBySlug, findMemberById, findMembers, findTeam, insertTeam, listMembers, insertMember,
      listGrants, upsertGrant, listGrantsForMember, countTeams, listOrganizationProjects,
      findByRef, applyTeamProjectGrant, releaseTeamProjectGrant, appendAuditEvent,
    ]) spy.mockReset();
    findBySlug.mockResolvedValue(org as never);
    findTeam.mockResolvedValue(team as never);
    findMembers.mockResolvedValue([] as never);
    countTeams.mockResolvedValue(1 as never);
    listOrganizationProjects.mockResolvedValue([{ ref: "proj_1", name: "App" }] as never);
    listMembers.mockResolvedValue([member] as never);
    listGrants.mockResolvedValue([] as never);
    appendAuditEvent.mockResolvedValue({} as never);
    applyTeamProjectGrant.mockResolvedValue({ enforcement: "linked", collaborator_id: "collab-1" } as never);
  });

  test("creates a normalized team slug", async () => {
    findTeam.mockResolvedValueOnce(null as never);
    insertTeam.mockResolvedValue({ ...team, slug: "platform-team" } as never);
    const created = await service.createTeam("acme", { name: " Platform Team " });
    expect(created.slug).toBe("platform-team");
    expect(insertTeam).toHaveBeenCalledWith({
      organizationId: "org-1",
      name: "Platform Team",
      slug: "platform-team",
      description: null,
    });
  });

  test("rejects a grant capability outside the project role", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", organization_id: "org-1" } as never);
    await expect(service.upsertTeamGrant("acme", "platform", "proj_1", {
      role: "viewer",
      capabilities: ["project.manage"],
    }, { id: "master", type: "master" })).rejects.toThrow(/outside the viewer role/);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  test("applies a team grant through the collaborator seam", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", organization_id: "org-1" } as never);
    upsertGrant.mockResolvedValue({
      id: "grant-1",
      team_id: team.id,
      project_ref: "proj_1",
      role: "member",
      capability_allowlist: ["audit.read"],
    } as never);
    const grant = await service.upsertTeamGrant("acme", "platform", "proj_1", {
      role: "member",
      capabilities: ["audit.read"],
    }, { id: "master", type: "master" });
    expect(applyTeamProjectGrant).toHaveBeenCalledWith({
      ref: "proj_1",
      principalId: "user-1",
      email: "person@example.com",
      role: "member",
      teamId: team.id,
      allowlist: ["audit.read"],
    });
    expect(grant.links).toEqual([
      { member_id: "member-1", email: "person@example.com", enforcement: "linked" },
    ]);
    expect(appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      projectRef: "proj_1",
      action: "organization.team.project_grant.applied",
      actor: "master",
    }));
  });

  test("releases team-managed collaborators when an organization member is removed", async () => {
    listGrantsForMember.mockResolvedValue([{
      id: "grant-1",
      team_id: team.id,
      project_ref: "proj_1",
      role: "member",
      capability_allowlist: null,
    }] as never);
    releaseTeamProjectGrant.mockResolvedValue({ enforcement: "released" } as never);
    await service.releaseOrganizationMemberTeamAccess({
      id: "member-1",
      organization_id: "org-1",
      email: "person@example.com",
      role: "member",
      user_id: "user-1",
      invited_at: null,
      joined_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(releaseTeamProjectGrant).toHaveBeenCalledWith({
      ref: "proj_1",
      principalId: "user-1",
      teamId: team.id,
    });
  });

  test("governance snapshot includes the catalog and does not claim deployment", async () => {
    const snapshot = await service.governanceSnapshot("acme");
    expect(snapshot.counts).toEqual({ members: 0, teams: 1, projects: 1 });
    expect(snapshot.catalog.deployed).toBe(false);
    expect(snapshot.catalog.scim.reason_code).toBe("scim_not_implemented");
  });
});
