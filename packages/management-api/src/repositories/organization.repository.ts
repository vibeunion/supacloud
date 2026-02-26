import { sql, type Organization } from "../db";

export class OrganizationRepository {
  async findAll(): Promise<Organization[]> {
    let retries = 3;
    while (retries > 0) {
      try {
        return await sql`
          SELECT * FROM organizations
          ORDER BY name ASC
        `;
      } catch (err: any) {
        if (err.message.includes("closed") && retries > 1) {
          retries--;
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        throw err;
      }
    }
    return [];
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const [org] = await sql`
      SELECT * FROM organizations
      WHERE slug = ${slug}
    `;
    return org || null;
  }

  async findById(id: string): Promise<Organization | null> {
    const [org] = await sql`
      SELECT * FROM organizations
      WHERE id = ${id}
    `;
    return org || null;
  }

  async create(name: string, slug: string): Promise<Organization> {
    const [org] = await sql`
      INSERT INTO organizations (name, slug)
      VALUES (${name}, ${slug})
      RETURNING *
    `;
    return org;
  }

  async ensureDefaultOrganization(): Promise<Organization> {
    const existing = await this.findBySlug("default");
    if (existing) return existing;
    return await this.create("Default Organization", "default");
  }
}

export const organizationRepository = new OrganizationRepository();
