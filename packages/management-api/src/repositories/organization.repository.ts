import { sql, type Organization } from "../db";
import { withRetry } from "../utils/retry";

export class OrganizationRepository {
  async findAll(): Promise<Organization[]> {
    return withRetry("OrganizationRepository.findAll", async () => {
      const results = await sql`
        SELECT * FROM organizations
        ORDER BY name ASC
      `;
      return results as any as Organization[];
    });
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    return withRetry("OrganizationRepository.findBySlug", async () => {
      const [org] = await sql`
        SELECT * FROM organizations
        WHERE slug = ${slug}
      `;
      return org as Organization || null;
    });
  }

  async findById(id: string): Promise<Organization | null> {
    return withRetry("OrganizationRepository.findById", async () => {
      const [org] = await sql`
        SELECT * FROM organizations
        WHERE id = ${id}
      `;
      return org as Organization || null;
    });
  }

  async create(name: string, slug: string): Promise<Organization> {
    return withRetry("OrganizationRepository.create", async () => {
      const [org] = await sql`
        INSERT INTO organizations (name, slug)
        VALUES (${name}, ${slug})
        RETURNING *
      `;
      return org as Organization;
    });
  }

  async ensureDefaultOrganization(): Promise<Organization> {
    const existing = await this.findBySlug("default");
    if (existing) return existing;
    return await this.create("Default Organization", "default");
  }
}

export const organizationRepository = new OrganizationRepository();
