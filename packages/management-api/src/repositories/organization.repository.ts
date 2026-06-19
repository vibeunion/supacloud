import { sql, type Organization, type OrganizationMember } from "../db";
import { withRetry } from "../utils/retry";

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  plan?: string | null;
  owner_id?: string | null;
}

export interface UpdateOrganizationInput {
  name?: string | null;
  slug?: string | null;
  plan?: string | null;
  owner_id?: string | null;
}

export interface UpsertOrganizationMemberInput {
  email: string;
  role: string;
  user_id?: string | null;
}

export async function findAll(): Promise<Organization[]> {
  return withRetry("OrganizationRepository.findAll", async () => {
    const results = await sql`SELECT * FROM organizations ORDER BY name ASC`;
    return results as unknown as Organization[];
  });
}

export async function findBySlug(slug: string): Promise<Organization | null> {
  return withRetry("OrganizationRepository.findBySlug", async () => {
    const [org] = await sql`SELECT * FROM organizations WHERE slug = ${slug}`;
    return (org as Organization) || null;
  });
}

export async function findById(id: string): Promise<Organization | null> {
  return withRetry("OrganizationRepository.findById", async () => {
    const [org] = await sql`SELECT * FROM organizations WHERE id = ${id}`;
    return (org as Organization) || null;
  });
}

export async function create(input: CreateOrganizationInput): Promise<Organization> {
  return withRetry("OrganizationRepository.create", async () => {
    const [org] = await sql`
      INSERT INTO organizations (name, slug, plan, owner_id)
      VALUES (${input.name}, ${input.slug}, ${input.plan ?? "free"}, ${input.owner_id ?? null})
      RETURNING *
    `;
    return org as Organization;
  });
}

export async function updateBySlug(slug: string, input: UpdateOrganizationInput): Promise<Organization | null> {
  return withRetry("OrganizationRepository.updateBySlug", async () => {
    const [org] = await sql`
      UPDATE organizations
      SET name = COALESCE(${input.name ?? null}, name),
          slug = COALESCE(${input.slug ?? null}, slug),
          plan = COALESCE(${input.plan ?? null}, plan),
          owner_id = CASE
            WHEN ${input.owner_id !== undefined} THEN ${input.owner_id ?? null}
            ELSE owner_id
          END,
          updated_at = NOW()
      WHERE slug = ${slug}
      RETURNING *
    `;
    return (org as Organization) || null;
  });
}

export async function deleteBySlug(slug: string): Promise<Organization | null> {
  return withRetry("OrganizationRepository.deleteBySlug", async () => {
    const [org] = await sql`
      DELETE FROM organizations
      WHERE slug = ${slug}
      RETURNING *
    `;
    return (org as Organization) || null;
  });
}

export async function countProjects(organizationId: string): Promise<number> {
  return withRetry("OrganizationRepository.countProjects", async () => {
    const [row] = await sql`
      SELECT COUNT(*)::int AS count
      FROM projects
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
    `;
    return Number((row as { count?: number | string } | undefined)?.count || 0);
  });
}

export async function findMembers(organizationId: string): Promise<OrganizationMember[]> {
  return withRetry("OrganizationRepository.findMembers", async () => {
    const rows = await sql`
      SELECT *
      FROM organization_members
      WHERE organization_id = ${organizationId}
      ORDER BY created_at ASC
    `;
    return rows as unknown as OrganizationMember[];
  });
}

export async function findMemberById(organizationId: string, id: string): Promise<OrganizationMember | null> {
  return withRetry("OrganizationRepository.findMemberById", async () => {
    const [member] = await sql`
      SELECT *
      FROM organization_members
      WHERE organization_id = ${organizationId}
        AND id = ${id}
    `;
    return (member as OrganizationMember) || null;
  });
}

export async function findMemberByEmail(organizationId: string, email: string): Promise<OrganizationMember | null> {
  return withRetry("OrganizationRepository.findMemberByEmail", async () => {
    const [member] = await sql`
      SELECT *
      FROM organization_members
      WHERE organization_id = ${organizationId}
        AND lower(email) = lower(${email})
    `;
    return (member as OrganizationMember) || null;
  });
}

export async function upsertMember(
  organizationId: string,
  input: UpsertOrganizationMemberInput,
): Promise<OrganizationMember> {
  return withRetry("OrganizationRepository.upsertMember", async () => {
    const existing = await findMemberByEmail(organizationId, input.email);
    if (existing) {
      const [member] = await sql`
        UPDATE organization_members
        SET role = ${input.role},
            user_id = CASE
              WHEN ${input.user_id !== undefined} THEN ${input.user_id ?? null}
              ELSE user_id
            END,
            updated_at = NOW()
        WHERE id = ${existing.id}
        RETURNING *
      `;
      return member as OrganizationMember;
    }

    const [member] = await sql`
      INSERT INTO organization_members (organization_id, email, role, user_id)
      VALUES (${organizationId}, ${input.email}, ${input.role}, ${input.user_id ?? null})
      RETURNING *
    `;
    return member as OrganizationMember;
  });
}

export async function deleteMember(organizationId: string, id: string): Promise<OrganizationMember | null> {
  return withRetry("OrganizationRepository.deleteMember", async () => {
    const [member] = await sql`
      DELETE FROM organization_members
      WHERE organization_id = ${organizationId}
        AND id = ${id}
      RETURNING *
    `;
    return (member as OrganizationMember) || null;
  });
}

export async function ensureDefaultOrganization(): Promise<Organization> {
  const existing = await findBySlug("default");
  if (existing) return existing;
  return await create({ name: "Default Organization", slug: "default" });
}

export const organizationRepository = {
  findAll,
  findBySlug,
  findById,
  create,
  updateBySlug,
  deleteBySlug,
  countProjects,
  findMembers,
  findMemberById,
  findMemberByEmail,
  upsertMember,
  deleteMember,
  ensureDefaultOrganization,
};
