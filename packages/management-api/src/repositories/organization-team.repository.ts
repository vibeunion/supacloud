import { sql } from "../db";
import { withRetry } from "../utils/retry";

export interface OrganizationTeamRecord {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface OrganizationTeamMemberRecord {
  id: string;
  team_id: string;
  member_id: string;
  role: string;
  email: string;
  user_id: string | null;
  organization_role: string;
  created_at: Date | string;
}

export interface OrganizationTeamGrantRecord {
  id: string;
  team_id: string;
  project_ref: string;
  role: string;
  capability_allowlist: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export async function listTeams(organizationId: string): Promise<OrganizationTeamRecord[]> {
  return withRetry("OrganizationTeamRepository.listTeams", async () => {
    const rows = await sql`
      SELECT * FROM organization_teams
      WHERE organization_id = ${organizationId}
      ORDER BY name ASC
    `;
    return rows as unknown as OrganizationTeamRecord[];
  });
}

export async function findTeam(organizationId: string, slug: string): Promise<OrganizationTeamRecord | null> {
  return withRetry("OrganizationTeamRepository.findTeam", async () => {
    const [row] = await sql`
      SELECT * FROM organization_teams
      WHERE organization_id = ${organizationId} AND slug = ${slug}
    `;
    return (row as OrganizationTeamRecord) || null;
  });
}

export async function insertTeam(input: {
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
}): Promise<OrganizationTeamRecord> {
  return withRetry("OrganizationTeamRepository.insertTeam", async () => {
    const [row] = await sql`
      INSERT INTO organization_teams (organization_id, name, slug, description)
      VALUES (${input.organizationId}, ${input.name}, ${input.slug}, ${input.description})
      RETURNING *
    `;
    return row as OrganizationTeamRecord;
  });
}

export async function updateTeam(
  teamId: string,
  input: { name?: string; slug?: string; description?: string | null },
): Promise<OrganizationTeamRecord | null> {
  return withRetry("OrganizationTeamRepository.updateTeam", async () => {
    const [row] = await sql`
      UPDATE organization_teams
      SET name = COALESCE(${input.name ?? null}, name),
          slug = COALESCE(${input.slug ?? null}, slug),
          description = CASE
            WHEN ${input.description !== undefined} THEN ${input.description ?? null}
            ELSE description
          END,
          updated_at = NOW()
      WHERE id = ${teamId}
      RETURNING *
    `;
    return (row as OrganizationTeamRecord) || null;
  });
}

export async function deleteTeam(teamId: string): Promise<OrganizationTeamRecord | null> {
  return withRetry("OrganizationTeamRepository.deleteTeam", async () => {
    const [row] = await sql`
      DELETE FROM organization_teams WHERE id = ${teamId} RETURNING *
    `;
    return (row as OrganizationTeamRecord) || null;
  });
}

export async function listMembers(teamId: string): Promise<OrganizationTeamMemberRecord[]> {
  return withRetry("OrganizationTeamRepository.listMembers", async () => {
    const rows = await sql`
      SELECT membership.id, membership.team_id, membership.member_id, membership.role,
             membership.created_at, member.email, member.user_id, member.role AS organization_role
      FROM organization_team_members membership
      JOIN organization_members member ON member.id = membership.member_id
      WHERE membership.team_id = ${teamId}
      ORDER BY member.email ASC
    `;
    return rows as unknown as OrganizationTeamMemberRecord[];
  });
}

export async function insertMember(input: {
  teamId: string;
  memberId: string;
  role: string;
}): Promise<OrganizationTeamMemberRecord> {
  return withRetry("OrganizationTeamRepository.insertMember", async () => {
    const [row] = await sql`
      INSERT INTO organization_team_members (team_id, member_id, role)
      VALUES (${input.teamId}, ${input.memberId}, ${input.role})
      RETURNING id, team_id, member_id, role, created_at
    `;
    const [hydrated] = await sql`
      SELECT membership.id, membership.team_id, membership.member_id, membership.role,
             membership.created_at, member.email, member.user_id, member.role AS organization_role
      FROM organization_team_members membership
      JOIN organization_members member ON member.id = membership.member_id
      WHERE membership.id = ${(row as { id: string }).id}
    `;
    return hydrated as OrganizationTeamMemberRecord;
  });
}

export async function deleteMember(teamId: string, memberId: string): Promise<OrganizationTeamMemberRecord | null> {
  return withRetry("OrganizationTeamRepository.deleteMember", async () => {
    const [existing] = await sql`
      SELECT membership.id, membership.team_id, membership.member_id, membership.role,
             membership.created_at, member.email, member.user_id, member.role AS organization_role
      FROM organization_team_members membership
      JOIN organization_members member ON member.id = membership.member_id
      WHERE membership.team_id = ${teamId} AND membership.member_id = ${memberId}
    `;
    if (!existing) return null;
    await sql`
      DELETE FROM organization_team_members
      WHERE team_id = ${teamId} AND member_id = ${memberId}
    `;
    return existing as OrganizationTeamMemberRecord;
  });
}

export async function listGrants(teamId: string): Promise<OrganizationTeamGrantRecord[]> {
  return withRetry("OrganizationTeamRepository.listGrants", async () => {
    const rows = await sql`
      SELECT * FROM organization_team_project_grants
      WHERE team_id = ${teamId}
      ORDER BY project_ref ASC
    `;
    return rows as unknown as OrganizationTeamGrantRecord[];
  });
}

export async function upsertGrant(input: {
  teamId: string;
  projectRef: string;
  role: string;
  allowlist: string[] | null;
}): Promise<OrganizationTeamGrantRecord> {
  return withRetry("OrganizationTeamRepository.upsertGrant", async () => {
    const [row] = await sql`
      INSERT INTO organization_team_project_grants (
        team_id, project_ref, role, capability_allowlist
      ) VALUES (
        ${input.teamId}, ${input.projectRef}, ${input.role}, ${input.allowlist}::text[]
      )
      ON CONFLICT (team_id, project_ref) DO UPDATE SET
        role = EXCLUDED.role,
        capability_allowlist = EXCLUDED.capability_allowlist,
        updated_at = NOW()
      RETURNING *
    `;
    return row as OrganizationTeamGrantRecord;
  });
}

export async function deleteGrant(teamId: string, projectRef: string): Promise<OrganizationTeamGrantRecord | null> {
  return withRetry("OrganizationTeamRepository.deleteGrant", async () => {
    const [row] = await sql`
      DELETE FROM organization_team_project_grants
      WHERE team_id = ${teamId} AND project_ref = ${projectRef}
      RETURNING *
    `;
    return (row as OrganizationTeamGrantRecord) || null;
  });
}

export async function listGrantsForMember(memberId: string): Promise<OrganizationTeamGrantRecord[]> {
  return withRetry("OrganizationTeamRepository.listGrantsForMember", async () => {
    const rows = await sql`
      SELECT grant.*
      FROM organization_team_project_grants grant
      JOIN organization_team_members membership ON membership.team_id = grant.team_id
      WHERE membership.member_id = ${memberId}
    `;
    return rows as unknown as OrganizationTeamGrantRecord[];
  });
}

export async function listOrganizationProjects(organizationId: string): Promise<Array<{ ref: string; name: string }>> {
  return withRetry("OrganizationTeamRepository.listOrganizationProjects", async () => {
    const rows = await sql`
      SELECT ref, name FROM projects
      WHERE organization_id = ${organizationId} AND deleted_at IS NULL
      ORDER BY name ASC
    `;
    return rows as unknown as Array<{ ref: string; name: string }>;
  });
}

export async function countTeams(organizationId: string): Promise<number> {
  return withRetry("OrganizationTeamRepository.countTeams", async () => {
    const [row] = await sql`
      SELECT COUNT(*)::int AS count FROM organization_teams
      WHERE organization_id = ${organizationId}
    `;
    return Number((row as { count?: number } | undefined)?.count || 0);
  });
}

export const organizationTeamRepository = {
  listTeams,
  findTeam,
  insertTeam,
  updateTeam,
  deleteTeam,
  listMembers,
  insertMember,
  deleteMember,
  listGrants,
  upsertGrant,
  deleteGrant,
  listGrantsForMember,
  listOrganizationProjects,
  countTeams,
};
