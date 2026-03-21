import { sql, type Project, type CreateProjectInput, type ProjectStatus } from "../db";
import { withRetry } from "../utils/retry";

export async function findAll(): Promise<Project[]> {
  return withRetry("ProjectRepository.findAll", async () => {
  const results = await sql`
    SELECT * FROM projects
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
  `;
  // Bugfix: ensure returning array
  return results as unknown as Project[];
  });
  }

  // Find project by ref
export async function findByRef(ref: string): Promise<Project | null> {
  return withRetry("ProjectRepository.findByRef", async () => {
  const [project] = await sql`
    SELECT * FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
  `;
  return project || null;
  });
  }

  // Find project by id
export async function findById(id: string): Promise<Project | null> {
  return withRetry("ProjectRepository.findById", async () => {
  const [project] = await sql`
    SELECT * FROM projects
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  return project || null;
  });
  }

  // Create project
export async function create(input: CreateProjectInput): Promise<Project> {
  return withRetry("ProjectRepository.create", async () => {
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
  });
  }

  // Update project status
export async function updateStatus(ref: string, status: ProjectStatus): Promise<Project | null> {
  return withRetry("ProjectRepository.updateStatus", async () => {
  const [project] = await sql`
    UPDATE projects
    SET status = ${status}, updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING *
  `;
  return project || null;
  });
  }

  // Update project config
export async function updateConfig(ref: string, config: Record<string, unknown>): Promise<Project | null> {
  return withRetry("ProjectRepository.updateConfig", async () => {
  const [project] = await sql`
    UPDATE projects
    SET config = ${config}, updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING *
  `;
  return project || null;
  });
  }

  // Update API keys
export async function updateApiKeys(ref: string, keys: { jwt_secret: string, anon_key: string, service_role_key: string }): Promise<Project | null> {
  return withRetry("ProjectRepository.updateApiKeys", async () => {
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
  });
  }

  // Soft delete project
export async function softDelete(ref: string): Promise<Project | null> {
  return withRetry("ProjectRepository.softDelete", async () => {
  const [project] = await sql`
    UPDATE projects
    SET deleted_at = NOW(), status = 'deleted', updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING *
  `;
  return project || null;
  });
  }

  // Check if ref already exists
export async function existsByRef(ref: string): Promise<boolean> {
  return withRetry("ProjectRepository.existsByRef", async () => {
  const [result] = await sql`
    SELECT 1 FROM projects WHERE ref = ${ref}
  `;
  return !!result;
  });
  }

export const projectRepository = {
  findAll,
  findByRef,
  findById,
  create,
  updateStatus,
  updateConfig,
  updateApiKeys,
  softDelete,
  existsByRef,
};
