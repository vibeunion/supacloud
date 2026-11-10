import { sql, type Project, type CreateProjectInput, type ProjectStatus } from "../db";
import { withRetry } from "../utils/retry";
import { encryptSecretIfNeeded } from "../utils/secret-crypto";
import { hashSecretApiKey } from "../utils/api-keys";
import { revealProjectSecrets, sealProjectSecrets, sealRotatedApiKeys } from "./project-secret-at-rest";
import { normalizeProjectConfig } from "../utils/project-config";
import { projectDatabaseLockKey } from "../services/project-database-lock";
import type { StoredApplicationPreview } from "../services/application-preview-contract";
import { persistApplicationPreview, replaceProjectConfig } from "./project-config-writes";

const PROJECT_COLUMNS = [
  "id", "ref", "organization_id", "name", "db_name", "db_user", "db_password",
  "db_password_encrypted", "jwt_secret", "jwt_secret_encrypted", "anon_key",
  "service_role_key", "service_role_key_encrypted", "publishable_key", "secret_key_hash",
  "secret_key_encrypted", "s3_bucket", "s3_access_key", "s3_secret_key", "s3_secret_key_encrypted",
  "anon_key_encrypted", "anon_key_hash", "service_role_key_hash",
  "region", "status", "postgrest_desired", "postgrest_actual", "postgrest_health",
  "postgrest_port", "postgrest_last_error", "postgrest_updated_at", "postgrest_last_reconciled_at",
  "config", "created_at", "updated_at", "deleted_at",
] as const;
export const projectColumns = PROJECT_COLUMNS.join(", ");

function asProject(row: Project | undefined | null): Project | null {
  return row ? revealProjectSecrets(row) : null;
}

export async function findAll(): Promise<Project[]> {
  return withRetry("ProjectRepository.findAll", async () => {
  const results = await sql`
    SELECT ${sql.unsafe(projectColumns)} FROM projects
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
  `;
  // Bugfix: ensure returning array
  return (results as unknown as Project[]).map((row) => revealProjectSecrets(row));
  });
  }

  // Find project by ref
export async function findByRef(ref: string): Promise<Project | null> {
  return withRetry("ProjectRepository.findByRef", async () => {
  const [project] = await sql`
    SELECT ${sql.unsafe(projectColumns)} FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
  `;
  return asProject(project);
  });
  }

  // Find project by id
export async function findById(id: string): Promise<Project | null> {
  return withRetry("ProjectRepository.findById", async () => {
  const [project] = await sql`
    SELECT ${sql.unsafe(projectColumns)} FROM projects
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  return asProject(project);
  });
  }

  // Create project
export async function create(input: CreateProjectInput): Promise<Project> {
  const initialConfig = normalizeProjectConfig(input.config);
  const sealed = sealProjectSecrets(input);
  return withRetry("ProjectRepository.create", async () => {
  const [project] = await sql`
    INSERT INTO projects (
      ref, name, db_name, db_user, db_password,
      jwt_secret, anon_key, service_role_key, publishable_key, secret_key_hash, secret_key_encrypted,
      s3_bucket, s3_access_key, s3_secret_key,
      region, config,
      db_password_encrypted, jwt_secret_encrypted, service_role_key_encrypted, s3_secret_key_encrypted,
      anon_key_encrypted, anon_key_hash, service_role_key_hash
    ) VALUES (
      ${input.ref},
      ${input.name},
      ${input.db_name},
      ${input.db_user},
      NULL,
      NULL,
      NULL,
      NULL,
      ${input.publishable_key || null},
      ${input.secret_key ? hashSecretApiKey(input.secret_key) : null},
      ${input.secret_key ? encryptSecretIfNeeded(input.secret_key) : null},
      ${input.s3_bucket},
      ${input.s3_access_key || null},
      NULL,
      ${input.region || "local"},
      ${initialConfig}::jsonb,
      ${sealed.db_password_encrypted},
      ${sealed.jwt_secret_encrypted},
      ${sealed.service_role_key_encrypted},
      ${sealed.s3_secret_key_encrypted},
      ${sealed.anon_key_encrypted},
      ${sealed.anon_key_hash},
      ${sealed.service_role_key_hash}
    )
    RETURNING ${sql.unsafe(projectColumns)}
  `;
  const created = asProject(project);
  if (!created) throw new Error("Project insert did not return a row");
  return created;
  });
  }

  // Update project status
export async function updateStatus(ref: string, status: ProjectStatus): Promise<Project | null> {
  return withRetry("ProjectRepository.updateStatus", async () => {
  const [project] = await sql`
    UPDATE projects
    SET status = ${status}, updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING ${sql.unsafe(projectColumns)}
  `;
  return asProject(project);
  });
  }

export async function activateCreatingProject(ref: string): Promise<Project | null> {
  const lockKey = projectDatabaseLockKey(ref);
  return sql.begin(async (tx) => {
    const [lock] = await tx<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS locked
    `;
    if (lock?.locked !== true) return null;
    const [project] = await tx`
      UPDATE projects
      SET status = 'active', updated_at = NOW()
      WHERE ref = ${ref} AND status = 'creating' AND deleted_at IS NULL
      RETURNING ${sql.unsafe(projectColumns)}
    `;
    return asProject(project);
  });
}

  // Update project config; separately managed state is read from the live row.
export async function updateConfig(ref: string, config: Record<string, unknown>): Promise<Project | null> {
  const nextConfig = normalizeProjectConfig(config);
  return withRetry("ProjectRepository.updateConfig", () => replaceProjectConfig(sql, ref, nextConfig));
}

export async function saveApplicationPreview(
  ref: string, receipt: StoredApplicationPreview, expectedUpdatedAt: string | null,
): Promise<StoredApplicationPreview> {
  // Do not replay an ambiguous commit. Read back the current receipt instead.
  return persistApplicationPreview(sql, ref, receipt, expectedUpdatedAt);
}

  // Update API keys
export async function updateApiKeys(ref: string, keys: {
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
}): Promise<Project | null> {
  const sealed = sealRotatedApiKeys(keys);
  return withRetry("ProjectRepository.updateApiKeys", async () => {
  const [project] = await sql`
    UPDATE projects
    SET
      jwt_secret = NULL,
      anon_key = NULL,
      service_role_key = NULL,
      jwt_secret_encrypted = ${sealed.jwt_secret_encrypted},
      anon_key_encrypted = ${sealed.anon_key_encrypted},
      service_role_key_encrypted = ${sealed.service_role_key_encrypted},
      anon_key_hash = ${sealed.anon_key_hash},
      service_role_key_hash = ${sealed.service_role_key_hash},
      updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING ${sql.unsafe(projectColumns)}
  `;
  return asProject(project);
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
      RETURNING ${sql.unsafe(projectColumns)}
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
    return asProject(project);
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
    RETURNING ${sql.unsafe(projectColumns)}
  `;
  return asProject(project);
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
  activateCreatingProject,
  updateConfig,
  saveApplicationPreview,
  updateApiKeys,
  updateOpaqueApiKeys,
  softDelete,
  existsByRef,
};
