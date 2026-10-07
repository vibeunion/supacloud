import type { SQL } from "bun";
import type { Project } from "../db";
import type { StoredApplicationPreview } from "../services/application-preview-contract";
import { normalizeProjectConfig } from "../utils/project-config";

export class ApplicationPreviewConflictError extends Error {
  readonly code = "APPLICATION_PREVIEW_CHANGED";
  constructor() { super("APPLICATION_PREVIEW_CHANGED"); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function storedConfig(value: unknown): Record<string, unknown> {
  let decoded = value;
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded); }
    catch { throw new Error("APPLICATION_PREVIEW_CONFIG_INVALID"); }
  }
  if (decoded === null || decoded === undefined) return {};
  if (!object(decoded)) throw new Error("APPLICATION_PREVIEW_CONFIG_INVALID");
  return decoded;
}

/** Read and update one preview under the project row lock, with a per-preview CAS.
 * Other previews and unrelated project fields always come from the locked row.
 * A stale worker must never overwrite a newer receipt (including cleanup).
 */
export async function persistApplicationPreview(
  database: SQL,
  projectRef: string,
  input: StoredApplicationPreview,
  expectedUpdatedAt: string | null,
): Promise<StoredApplicationPreview> {
  const receipt = structuredClone(input);
  if (receipt.schema !== "supacloud.application-preview.v1"
    || receipt.project_ref !== projectRef
    || typeof receipt.preview_id !== "string"
    || !/^[a-f0-9-]{8,64}$/.test(receipt.preview_id)
    || !timestamp(receipt.created_at) || !timestamp(receipt.updated_at)
    || (expectedUpdatedAt !== null && !timestamp(expectedUpdatedAt))) {
    throw new Error("APPLICATION_PREVIEW_RECEIPT_INVALID");
  }
  return database.begin(async tx => {
    const rows = await tx`SELECT config FROM projects
      WHERE ref = ${projectRef} AND deleted_at IS NULL FOR UPDATE`;
    if (rows.length !== 1) throw new Error("APPLICATION_PREVIEW_PROJECT_NOT_FOUND");
    const config = storedConfig(rows[0].config);
    const previews: unknown = config.application_previews ?? [];
    if (!Array.isArray(previews)) throw new Error("APPLICATION_PREVIEW_CONFIG_INVALID");
    const ids = new Set<string>();
    for (const item of previews) {
      if (!object(item) || item.schema !== "supacloud.application-preview.v1"
        || typeof item.preview_id !== "string" || item.project_ref !== projectRef
        || !timestamp(item.updated_at) || ids.has(item.preview_id)) {
        throw new Error("APPLICATION_PREVIEW_CONFIG_INVALID");
      }
      ids.add(item.preview_id);
    }
    const index = previews.findIndex(item => item.preview_id === receipt.preview_id);
    const current = index < 0 ? undefined : previews[index];
    if (expectedUpdatedAt === null ? current !== undefined : current?.updated_at !== expectedUpdatedAt) {
      throw new ApplicationPreviewConflictError();
    }
    if (current && (current.application_id !== receipt.application_id
      || current.environment_id !== receipt.environment_id
      || current.release_id !== receipt.release_id
      || current.created_at !== receipt.created_at
      || (current.status === "cleaned" && receipt.status !== "cleaned"))) {
      throw new ApplicationPreviewConflictError();
    }
    // Millisecond clocks can repeat or move backwards. Every successful write
    // still receives a strictly newer CAS token without a public schema change.
    receipt.updated_at = new Date(Math.max(Date.now(),
      expectedUpdatedAt === null ? Date.parse(receipt.updated_at) : Date.parse(expectedUpdatedAt) + 1,
    )).toISOString();
    const next = index < 0 ? [...previews, receipt]
      : previews.map((item, position) => position === index ? receipt : item);
    const updated = { ...config, application_previews: next };
    await tx`UPDATE projects SET config = ${updated}::jsonb, updated_at = NOW()
      WHERE ref = ${projectRef} AND deleted_at IS NULL`;
    return receipt;
  });
}

/** Generic config writers cannot replace independently managed state with a
 * stale snapshot. PostgreSQL evaluates these fields from the row being updated.
 */
export async function replaceProjectConfig(
  database: SQL, ref: string, config: Record<string, unknown>,
): Promise<Project | null> {
  const nextConfig = normalizeProjectConfig(config);
  const [project] = await database`
    UPDATE projects
    SET config =
          (${nextConfig}::jsonb - 'scheduled_functions' - 'application_previews')
          || CASE
            WHEN jsonb_typeof(projects.config) = 'object'
              AND projects.config ? 'scheduled_functions'
            THEN jsonb_build_object('scheduled_functions', projects.config -> 'scheduled_functions')
            ELSE '{}'::jsonb
          END
          || CASE
            WHEN jsonb_typeof(projects.config) = 'object'
              AND projects.config ? 'application_previews'
            THEN jsonb_build_object('application_previews', projects.config -> 'application_previews')
            ELSE '{}'::jsonb
          END,
        updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING *
  `;
  return project || null;
}
