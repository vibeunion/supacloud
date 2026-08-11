import { sql, type Project, type CreateProjectInput, type ProjectStatus } from "../db";
import { withRetry } from "../utils/retry";
import { encryptSecretIfNeeded } from "../utils/secret-crypto";
import { hashSecretApiKey } from "../utils/api-keys";

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
      jwt_secret, anon_key, service_role_key, publishable_key, secret_key_hash, secret_key_encrypted,
      s3_bucket, s3_access_key, s3_secret_key,
      region, config,
      db_password_encrypted, jwt_secret_encrypted, service_role_key_encrypted, s3_secret_key_encrypted
    ) VALUES (
      ${input.ref},
      ${input.name},
      ${input.db_name},
      ${input.db_user},
      ${input.db_password},
      ${input.jwt_secret},
      ${input.anon_key},
      ${input.service_role_key},
      ${input.publishable_key || null},
      ${input.secret_key ? hashSecretApiKey(input.secret_key) : null},
      ${input.secret_key ? encryptSecretIfNeeded(input.secret_key) : null},
      ${input.s3_bucket},
      ${input.s3_access_key || null},
      ${input.s3_secret_key || null},
      ${input.region || "local"},
      ${input.config ? JSON.stringify(input.config) : "{}"}::jsonb,
      ${encryptSecretIfNeeded(input.db_password)},
      ${encryptSecretIfNeeded(input.jwt_secret)},
      ${encryptSecretIfNeeded(input.service_role_key)},
      ${input.s3_secret_key ? encryptSecretIfNeeded(input.s3_secret_key) : null}
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
    SET config =
          CASE jsonb_typeof(${JSON.stringify(config)}::jsonb)
            WHEN 'object' THEN ${JSON.stringify(config)}::jsonb - 'scheduled_functions'
            ELSE '{}'::jsonb
          END
          || CASE
            WHEN jsonb_typeof(projects.config) = 'object'
              AND projects.config ? 'scheduled_functions'
            THEN jsonb_build_object('scheduled_functions', projects.config -> 'scheduled_functions')
            ELSE '{}'::jsonb
          END,
        updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING *
  `;
  return project || null;
  });
  }

  // Update API keys
export async function updateApiKeys(ref: string, keys: {
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
}): Promise<Project | null> {
  return withRetry("ProjectRepository.updateApiKeys", async () => {
  const [project] = await sql`
    UPDATE projects
    SET 
      jwt_secret = ${keys.jwt_secret},
      anon_key = ${keys.anon_key},
      service_role_key = ${keys.service_role_key},
      jwt_secret_encrypted = ${encryptSecretIfNeeded(keys.jwt_secret)},
      service_role_key_encrypted = ${encryptSecretIfNeeded(keys.service_role_key)},
      updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING *
  `;
  return project || null;
  });
  }

export async function updateOpaqueApiKeys(ref: string, keys: {
  publishable_key: string;
  secret_key: string;
}): Promise<Project | null> {
  return withRetry("ProjectRepository.updateOpaqueApiKeys", async () => {
  const encryptedPublishableKey = encryptSecretIfNeeded(keys.publishable_key);
  const encryptedSecretKey = encryptSecretIfNeeded(keys.secret_key);
  return sql.begin(async (tx) => {
    const [project] = await tx`
      UPDATE projects
      SET
        publishable_key = ${keys.publishable_key},
        secret_key_hash = ${hashSecretApiKey(keys.secret_key)},
        secret_key_encrypted = ${encryptedSecretKey},
        updated_at = NOW()
      WHERE ref = ${ref} AND deleted_at IS NULL
      RETURNING *
    `;
    if (!project) return null;

    await tx`
      INSERT INTO project_secrets (project_ref, name, value)
      VALUES (${ref}, 'SUPABASE_PUBLISHABLE_KEY', ${encryptedPublishableKey})
      ON CONFLICT (project_ref, name)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    await tx`
      INSERT INTO project_secrets (project_ref, name, value)
      VALUES (${ref}, 'SUPABASE_SECRET_KEY', ${encryptedSecretKey})
      ON CONFLICT (project_ref, name)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return project;
  });
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
  updateOpaqueApiKeys,
  softDelete,
  existsByRef,
};
