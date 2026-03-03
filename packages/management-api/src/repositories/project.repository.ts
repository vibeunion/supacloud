import { sql, type Project, type CreateProjectInput, type ProjectStatus } from "../db";

export class ProjectRepository {
  async findAll(): Promise<Project[]> {
    let retries = 3;
    while (retries > 0) {
      try {
        return await sql`
          SELECT * FROM projects
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC
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

  // Find project by ref
  async findByRef(ref: string): Promise<Project | null> {
    const [project] = await sql`
      SELECT * FROM projects
      WHERE ref = ${ref} AND deleted_at IS NULL
    `;
    return project || null;
  }

  // Find project by id
  async findById(id: string): Promise<Project | null> {
    const [project] = await sql`
      SELECT * FROM projects
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    return project || null;
  }

  // Create project
  async create(input: CreateProjectInput): Promise<Project> {
    const [project] = await sql`
      INSERT INTO projects (
        ref, name, db_name, db_user, db_password,
        jwt_secret, anon_key, service_role_key,
        s3_bucket, s3_access_key, s3_secret_key,
        region, config
      ) VALUES (
        ${input.ref},
        ${input.name},
        ${input.db_name},
        ${input.db_user},
        ${input.db_password},
        ${input.jwt_secret},
        ${input.anon_key},
        ${input.service_role_key},
        ${input.s3_bucket},
        ${input.s3_access_key || null},
        ${input.s3_secret_key || null},
        ${input.region || "local"},
        ${input.config || sql`'{}'::jsonb`}
      )
      RETURNING *
    `;
    return project;
  }

  // Update project status
  async updateStatus(ref: string, status: ProjectStatus): Promise<Project | null> {
    const [project] = await sql`
      UPDATE projects
      SET status = ${status}, updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    return project || null;
  }

  // Update project config
  async updateConfig(ref: string, config: Record<string, unknown>): Promise<Project | null> {
    const [project] = await sql`
      UPDATE projects
      SET config = ${config}, updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    return project || null;
  }

  // Update API keys
  async updateApiKeys(ref: string, keys: { jwt_secret: string, anon_key: string, service_role_key: string }): Promise<Project | null> {
    const [project] = await sql`
      UPDATE projects
      SET 
        jwt_secret = ${keys.jwt_secret},
        anon_key = ${keys.anon_key},
        service_role_key = ${keys.service_role_key},
        updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    return project || null;
  }

  // Soft delete project
  async softDelete(ref: string): Promise<Project | null> {
    const [project] = await sql`
      UPDATE projects
      SET deleted_at = NOW(), status = 'deleted', updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    return project || null;
  }

  // Check if ref already exists
  async existsByRef(ref: string): Promise<boolean> {
    const [result] = await sql`
      SELECT 1 FROM projects WHERE ref = ${ref}
    `;
    return !!result;
  }
}

export const projectRepository = new ProjectRepository();
