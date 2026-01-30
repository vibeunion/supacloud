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

  // 根据 ref 查找项目
  async findByRef(ref: string): Promise<Project | null> {
    const [project] = await sql`
      SELECT * FROM projects
      WHERE ref = ${ref} AND deleted_at IS NULL
    `;
    return project || null;
  }

  // 根据 id 查找项目
  async findById(id: string): Promise<Project | null> {
    const [project] = await sql`
      SELECT * FROM projects
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    return project || null;
  }

  // 创建项目
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
        ${JSON.stringify(input.config || {})}
      )
      RETURNING *
    `;
    return project;
  }

  // 更新项目状态
  async updateStatus(ref: string, status: ProjectStatus): Promise<Project | null> {
    const [project] = await sql`
      UPDATE projects
      SET status = ${status}, updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    return project || null;
  }

  // 更新项目配置
  async updateConfig(ref: string, config: Record<string, unknown>): Promise<Project | null> {
    const [project] = await sql`
      UPDATE projects
      SET config = ${JSON.stringify(config)}, updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    return project || null;
  }

  // 软删除项目
  async softDelete(ref: string): Promise<Project | null> {
    const [project] = await sql`
      UPDATE projects
      SET deleted_at = NOW(), status = 'deleted', updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    return project || null;
  }

  // 检查 ref 是否已存在
  async existsByRef(ref: string): Promise<boolean> {
    const [result] = await sql`
      SELECT 1 FROM projects WHERE ref = ${ref}
    `;
    return !!result;
  }
}

export const projectRepository = new ProjectRepository();
