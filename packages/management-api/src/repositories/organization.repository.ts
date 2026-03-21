import { sql, type Organization } from "../db";
import { withRetry } from "../utils/retry";

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

export async function create(name: string, slug: string): Promise<Organization> {
  return withRetry("OrganizationRepository.create", async () => {
    const [org] = await sql`
      INSERT INTO organizations (name, slug)
      VALUES (${name}, ${slug})
      RETURNING *
    `;
    return org as Organization;
  });
}

export async function ensureDefaultOrganization(): Promise<Organization> {
  const existing = await findBySlug("default");
  if (existing) return existing;
  return await create("Default Organization", "default");
}

export const organizationRepository = {
  findAll,
  findBySlug,
  findById,
  create,
  ensureDefaultOrganization,
};
