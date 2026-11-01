import type { OrganizationMember } from "../db";
import { organizationRepository } from "../repositories/organization.repository";
import {
  organizationTeamRepository,
  type OrganizationTeamGrantRecord,
  type OrganizationTeamMemberRecord,
  type OrganizationTeamRecord,
} from "../repositories/organization-team.repository";
import { projectRepository } from "../repositories/project.repository";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { appendAuditEvent } from "./audit.service";
import { normalizeCapabilityAllowlist } from "./collaborator-capabilities";
import { enterpriseGovernanceCatalog } from "./enterprise-governance";
import {
  applyTeamProjectGrant,
  releaseTeamProjectGrant,
  type TeamGrantEnforcement,
} from "./project-collaborator.service";

const TEAM_ROLES = new Set(["maintainer", "member"]);
const GRANT_ROLES = new Set(["admin", "member", "viewer"]);

function normalizeName(name: string | undefined): string {
  const normalized = name?.trim() ?? "";
  if (!normalized || normalized.length > 100) {
    throw new ValidationError("Team name is required and must be at most 100 characters");
  }
  return normalized;
}

function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 100) {
    throw new ValidationError("Team slug is required and must be at most 100 characters");
  }
  return slug;
}

function normalizeTeamRole(role: string | undefined): string {
  const normalized = (role ?? "member").trim().toLowerCase();
  if (!TEAM_ROLES.has(normalized)) throw new ValidationError("Team role must be maintainer or member");
  return normalized;
}

function normalizeGrantRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (!GRANT_ROLES.has(normalized)) {
    throw new ValidationError("Project grant role must be admin, member, or viewer");
  }
  return normalized;
}

async function organizationOrThrow(slug: string) {
  const org = await organizationRepository.findBySlug(slug);
  if (!org) throw new NotFoundError("Organization", slug);
  return org;
}

async function teamOrThrow(organizationId: string, teamSlug: string): Promise<OrganizationTeamRecord> {
  const team = await organizationTeamRepository.findTeam(organizationId, teamSlug);
  if (!team) throw new NotFoundError("Organization team", teamSlug);
  return team;
}

async function projectInOrganization(organizationId: string, ref: string) {
  const project = await projectRepository.findByRef(ref);
  if (!project || project.organization_id !== organizationId) throw new NotFoundError("Project", ref);
  return project;
}

function publicTeam(team: OrganizationTeamRecord) {
  return {
    id: team.id,
    organization_id: team.organization_id,
    name: team.name,
    slug: team.slug,
    description: team.description,
    created_at: team.created_at,
    updated_at: team.updated_at,
  };
}

function publicMembership(member: OrganizationTeamMemberRecord) {
  return {
    id: member.id,
    team_id: member.team_id,
    member_id: member.member_id,
    email: member.email,
    user_id: member.user_id,
    team_role: member.role,
    organization_role: member.organization_role,
    created_at: member.created_at,
  };
}

async function auditGrant(
  actor: { id: string; type: string },
  projectRef: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await appendAuditEvent({
    projectRef,
    actor: actor.id,
    actorType: actor.type,
    action,
    method: "EVENT",
    path: `/v1/projects/${projectRef}/collaborators`,
    status: 200,
    requestId: crypto.randomUUID(),
    metadata,
    source: "organization-team",
  });
}

async function syncMemberGrant(
  team: OrganizationTeamRecord,
  member: OrganizationTeamMemberRecord,
  grant: OrganizationTeamGrantRecord,
): Promise<{ member_id: string; email: string; enforcement: TeamGrantEnforcement }> {
  if (!member.user_id) {
    return { member_id: member.member_id, email: member.email, enforcement: "principal_missing" };
  }
  const linked = await applyTeamProjectGrant({
    ref: grant.project_ref,
    principalId: member.user_id,
    email: member.email,
    role: grant.role,
    teamId: team.id,
    allowlist: grant.capability_allowlist,
  });
  return { member_id: member.member_id, email: member.email, enforcement: linked.enforcement };
}

async function syncGrant(
  team: OrganizationTeamRecord,
  grant: OrganizationTeamGrantRecord,
  actor: { id: string; type: string },
): Promise<Array<{ member_id: string; email: string; enforcement: TeamGrantEnforcement }>> {
  const members = await organizationTeamRepository.listMembers(team.id);
  const links = [];
  for (const member of members) links.push(await syncMemberGrant(team, member, grant));
  await auditGrant(actor, grant.project_ref, "organization.team.project_grant.applied", {
    resource_type: "project_collaborator",
    resource_id: grant.project_ref,
    team_id: team.id,
    role: grant.role,
    capability_allowlist: grant.capability_allowlist,
    links,
  });
  return links;
}

export async function listTeams(slug: string) {
  const org = await organizationOrThrow(slug);
  const teams = await organizationTeamRepository.listTeams(org.id);
  return teams.map(publicTeam);
}

export async function createTeam(slug: string, input: { name: string; slug?: string; description?: string | null }) {
  const org = await organizationOrThrow(slug);
  const name = normalizeName(input.name);
  const teamSlug = normalizeSlug(input.slug ?? name);
  if (await organizationTeamRepository.findTeam(org.id, teamSlug)) {
    throw new ConflictError("Team slug already exists");
  }
  const description = input.description?.trim() || null;
  return publicTeam(await organizationTeamRepository.insertTeam({
    organizationId: org.id,
    name,
    slug: teamSlug,
    description,
  }));
}

export async function getTeam(slug: string, teamSlug: string) {
  const org = await organizationOrThrow(slug);
  return publicTeam(await teamOrThrow(org.id, normalizeSlug(teamSlug)));
}

export async function updateTeam(
  slug: string,
  teamSlug: string,
  input: { name?: string; slug?: string; description?: string | null },
) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  const nextSlug = input.slug === undefined ? undefined : normalizeSlug(input.slug);
  if (nextSlug && nextSlug !== team.slug && await organizationTeamRepository.findTeam(org.id, nextSlug)) {
    throw new ConflictError("Team slug already exists");
  }
  const updated = await organizationTeamRepository.updateTeam(team.id, {
    name: input.name === undefined ? undefined : normalizeName(input.name),
    slug: nextSlug,
    description: input.description === undefined ? undefined : input.description?.trim() || null,
  });
  if (!updated) throw new NotFoundError("Organization team", teamSlug);
  return publicTeam(updated);
}

export async function deleteTeam(slug: string, teamSlug: string) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  const [members, grants] = await Promise.all([
    organizationTeamRepository.listMembers(team.id),
    organizationTeamRepository.listGrants(team.id),
  ]);
  const released = [];
  for (const grant of grants) {
    for (const member of members) {
      if (!member.user_id) continue;
      released.push({
        project_ref: grant.project_ref,
        member_id: member.member_id,
        ...(await releaseTeamProjectGrant({
          ref: grant.project_ref,
          principalId: member.user_id,
          teamId: team.id,
        })),
      });
    }
  }
  const deleted = await organizationTeamRepository.deleteTeam(team.id);
  if (!deleted) throw new NotFoundError("Organization team", teamSlug);
  return { deleted: true, team: publicTeam(deleted), released };
}

export async function listTeamMembers(slug: string, teamSlug: string) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  const members = await organizationTeamRepository.listMembers(team.id);
  return members.map(publicMembership);
}

export async function addTeamMember(
  slug: string,
  teamSlug: string,
  input: { member_id: string; role?: string },
  actor: { id: string; type: string },
) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  const member = await organizationRepository.findMemberById(org.id, input.member_id);
  if (!member) throw new NotFoundError("Organization member", input.member_id);
  const role = normalizeTeamRole(input.role);
  let membership: OrganizationTeamMemberRecord;
  try {
    membership = await organizationTeamRepository.insertMember({ teamId: team.id, memberId: member.id, role });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      throw new ConflictError("Organization member is already on this team");
    }
    throw error;
  }
  const grants = await organizationTeamRepository.listGrants(team.id);
  const links = [];
  for (const grant of grants) {
    const link = await syncMemberGrant(team, membership, grant);
    links.push({ project_ref: grant.project_ref, ...link });
    await auditGrant(actor, grant.project_ref, "organization.team.member.linked", {
      resource_type: "project_collaborator",
      resource_id: membership.member_id,
      team_id: team.id,
      enforcement: link.enforcement,
    });
  }
  return { ...publicMembership(membership), links };
}

export async function removeTeamMember(slug: string, teamSlug: string, memberId: string) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  const removed = await organizationTeamRepository.deleteMember(team.id, memberId);
  if (!removed) throw new NotFoundError("Organization team member", memberId);
  const grants = await organizationTeamRepository.listGrants(team.id);
  const released = [];
  for (const grant of grants) {
    if (!removed.user_id) continue;
    released.push({
      project_ref: grant.project_ref,
      ...(await releaseTeamProjectGrant({
        ref: grant.project_ref,
        principalId: removed.user_id,
        teamId: team.id,
      })),
    });
  }
  return { deleted: true, member: publicMembership(removed), released };
}

export async function listTeamGrants(slug: string, teamSlug: string) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  return organizationTeamRepository.listGrants(team.id);
}

export async function upsertTeamGrant(
  slug: string,
  teamSlug: string,
  projectRef: string,
  input: { role: string; capabilities?: string[] | null },
  actor: { id: string; type: string },
) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  await projectInOrganization(org.id, projectRef);
  const role = normalizeGrantRole(input.role);
  const allowlist = normalizeCapabilityAllowlist(role as "admin" | "member" | "viewer", input.capabilities);
  const grant = await organizationTeamRepository.upsertGrant({
    teamId: team.id,
    projectRef,
    role,
    allowlist,
  });
  const links = await syncGrant(team, grant, actor);
  return { ...grant, links };
}

export async function deleteTeamGrant(slug: string, teamSlug: string, projectRef: string) {
  const org = await organizationOrThrow(slug);
  const team = await teamOrThrow(org.id, normalizeSlug(teamSlug));
  await projectInOrganization(org.id, projectRef);
  const members = await organizationTeamRepository.listMembers(team.id);
  const removed = await organizationTeamRepository.deleteGrant(team.id, projectRef);
  if (!removed) throw new NotFoundError("Organization team project grant", projectRef);
  const released = [];
  for (const member of members) {
    if (!member.user_id) continue;
    released.push({
      member_id: member.member_id,
      ...(await releaseTeamProjectGrant({ ref: projectRef, principalId: member.user_id, teamId: team.id })),
    });
  }
  return { deleted: true, grant: removed, released };
}

export async function releaseOrganizationMemberTeamAccess(member: OrganizationMember): Promise<void> {
  if (!member.user_id) return;
  const grants = await organizationTeamRepository.listGrantsForMember(member.id);
  for (const grant of grants) {
    await releaseTeamProjectGrant({
      ref: grant.project_ref,
      principalId: member.user_id,
      teamId: grant.team_id,
    });
  }
}

export async function governanceSnapshot(slug: string) {
  const org = await organizationOrThrow(slug);
  const [members, teamCount, projects] = await Promise.all([
    organizationRepository.findMembers(org.id),
    organizationTeamRepository.countTeams(org.id),
    organizationTeamRepository.listOrganizationProjects(org.id),
  ]);
  return {
    organization: { id: org.id, slug: org.slug, name: org.name },
    counts: {
      members: members.length,
      teams: teamCount,
      projects: projects.length,
    },
    projects: projects.map((project) => ({ ref: project.ref, name: project.name })),
    catalog: enterpriseGovernanceCatalog(),
  };
}

export async function listOrganizationProjects(slug: string) {
  const org = await organizationOrThrow(slug);
  const projects = await organizationTeamRepository.listOrganizationProjects(org.id);
  return projects.map((project) => ({
    ref: project.ref,
    name: project.name,
    sso_providers_route: `/v1/projects/${project.ref}/auth/sso/providers`,
  }));
}

export const organizationTeamService = {
  listTeams,
  createTeam,
  getTeam,
  updateTeam,
  deleteTeam,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
  listTeamGrants,
  upsertTeamGrant,
  deleteTeamGrant,
  releaseOrganizationMemberTeamAccess,
  governanceSnapshot,
  listOrganizationProjects,
};
