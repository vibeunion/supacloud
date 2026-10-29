import { getProjectDb, resolveDbName, sql as metaSql } from "../db";
import { StorageService } from "./storage.service";
import { logger } from "../utils/logger";
import { isRecord } from "../utils/record";

export const STORAGE_VERSION_BUCKET = ".supacloud_versions";

export type StorageVersioningStatus = "DISABLED" | "ENABLED" | "SUSPENDED";
export type StorageLifecycleStatus = "Enabled" | "Disabled";

export type NoncurrentVersionExpiration = {
  noncurrentDays: number;
  newerNoncurrentVersions?: number;
};

export type StorageLifecycleRule = {
  id: string;
  status: StorageLifecycleStatus;
  filter: Record<string, never>;
  noncurrentVersionExpiration: NoncurrentVersionExpiration;
};

export type StorageLifecycleConfiguration = {
  rules: StorageLifecycleRule[];
};

export type StoredObjectVersion = {
  id: string;
  bucket_id: string;
  name: string;
  version_id: string;
  owner?: string | null;
  metadata: Record<string, unknown>;
  is_delete_marker: boolean;
  created_at: string;
  archived_at: string;
};

const VERSION_COLUMNS = `
  id, bucket_id, name, version_id, owner, metadata,
  is_delete_marker, created_at, archived_at
`;

const schemaReady = new Set<string>();
const schemaPromises = new Map<string, Promise<void>>();
const versionBucketReady = new Set<string>();

export function isInternalStorageBucket(bucketId: string): boolean {
  return bucketId === STORAGE_VERSION_BUCKET;
}

export function normalizeVersioningStatus(value: unknown, mode: "create" | "update" | "stored"): StorageVersioningStatus {
  if (value === undefined || value === null) return mode === "stored" ? "DISABLED" : "DISABLED";
  if (typeof value !== "string") throw new Error("Invalid versioning status");
  const status = value.toUpperCase();
  if (status === "DISABLED" && (mode === "create" || mode === "stored")) return status;
  if (status === "ENABLED") return status;
  if (status === "SUSPENDED" && (mode === "update" || mode === "stored")) return status;
  throw new Error(
    mode === "update"
      ? "versioningStatus must be ENABLED or SUSPENDED"
      : "versioningStatus must be DISABLED or ENABLED",
  );
}

export function validateLifecycleConfiguration(value: unknown): StorageLifecycleConfiguration {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Lifecycle configuration is not valid JSON");
    }
  }
  if (!isRecord(value) || !Array.isArray(value["rules"]) || value["rules"].length === 0) {
    throw new Error("Lifecycle configuration must contain at least one rule");
  }
  if (value["rules"].length > 100) throw new Error("Lifecycle configuration supports at most 100 rules");

  const seen = new Set<string>();
  const rules = value["rules"].map((raw, index): StorageLifecycleRule => {
    if (!isRecord(raw)) throw new Error(`rules[${index}] must be an object`);
    const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
    if (!id || id.length > 255) throw new Error(`rules[${index}].id is required`);
    if (seen.has(id)) throw new Error(`Duplicate lifecycle rule id: ${id}`);
    seen.add(id);

    const status = raw["status"];
    if (status !== "Enabled" && status !== "Disabled") {
      throw new Error(`rules[${index}].status must be Enabled or Disabled`);
    }
    if (raw["filter"] !== undefined && (!isRecord(raw["filter"]) || Object.keys(raw["filter"]).length !== 0)) {
      throw new Error("Only an empty lifecycle filter is supported");
    }
    const expiration = raw["noncurrentVersionExpiration"];
    if (!isRecord(expiration)) throw new Error(`rules[${index}].noncurrentVersionExpiration is required`);
    const days = Number(expiration["noncurrentDays"]);
    if (!Number.isInteger(days) || days < 1 || days > 36500) {
      throw new Error(`rules[${index}].noncurrentVersionExpiration.noncurrentDays must be an integer between 1 and 36500`);
    }
    const newerRaw = expiration["newerNoncurrentVersions"];
    let newer: number | undefined;
    if (newerRaw !== undefined && newerRaw !== null) {
      newer = Number(newerRaw);
      if (!Number.isInteger(newer) || newer < 1 || newer > 100) {
        throw new Error(`rules[${index}].noncurrentVersionExpiration.newerNoncurrentVersions must be between 1 and 100`);
      }
    }
    return {
      id,
      status,
      filter: {},
      noncurrentVersionExpiration: {
        noncurrentDays: days,
        ...(newer !== undefined ? { newerNoncurrentVersions: newer } : {}),
      },
    };
  });
  return { rules };
}

export function objectVersionStorageKey(bucketId: string, name: string, versionId: string): string {
  return `${bucketId}/${name}/${versionId}`;
}

export async function ensureStorageVersioningSchema(ref: string): Promise<void> {
  if (ref === "test_mock") return;
  if (schemaReady.has(ref)) return;
  let pending = schemaPromises.get(ref);
  if (!pending) {
    pending = (async () => {
      const dbName = await resolveDbName(ref);
      const db = getProjectDb(dbName);
      await db.unsafe(`
        ALTER TABLE storage.buckets
          ADD COLUMN IF NOT EXISTS versioning_status TEXT NOT NULL DEFAULT 'DISABLED';
        ALTER TABLE storage.buckets
          ADD COLUMN IF NOT EXISTS lifecycle_rules JSONB;
        CREATE TABLE IF NOT EXISTS storage.object_versions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          bucket_id TEXT NOT NULL REFERENCES storage.buckets(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          version_id TEXT NOT NULL,
          owner UUID,
          owner_id TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          is_delete_marker BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (bucket_id, name, version_id)
        );
        CREATE INDEX IF NOT EXISTS object_versions_bucket_name_idx
          ON storage.object_versions (bucket_id, name, archived_at DESC);
        CREATE INDEX IF NOT EXISTS object_versions_archive_idx
          ON storage.object_versions (bucket_id, archived_at);
        ALTER TABLE storage.object_versions ENABLE ROW LEVEL SECURITY;
        DO $$ BEGIN
          CREATE POLICY "Allow public read on storage.object_versions" ON storage.object_versions
            FOR SELECT USING (bucket_id IN (SELECT id FROM storage.buckets WHERE public = true));
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE POLICY "Allow authenticated read on storage.object_versions" ON storage.object_versions
            FOR SELECT TO authenticated USING (auth.uid() = owner);
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE POLICY "Allow authenticated insert on storage.object_versions" ON storage.object_versions
            FOR INSERT TO authenticated WITH CHECK (bucket_id IN (SELECT id FROM storage.buckets) AND auth.uid() = owner);
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN
          CREATE POLICY "Allow authenticated delete on storage.object_versions" ON storage.object_versions
            FOR DELETE TO authenticated USING (auth.uid() = owner);
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        GRANT ALL ON storage.object_versions TO service_role;
        GRANT SELECT, INSERT, DELETE ON storage.object_versions TO authenticated;
      `);
    })();
    schemaPromises.set(ref, pending);
  }
  try {
    await pending;
    schemaReady.add(ref);
  } catch (error) {
    schemaPromises.delete(ref);
    throw error;
  }
}

export async function ensureVersionBucket(ref: string): Promise<boolean> {
  if (versionBucketReady.has(ref)) return true;
  const result = await StorageService.createBucket(ref, STORAGE_VERSION_BUCKET);
  if (!result.success) {
    logger.error("[StorageVersioning] Failed to create internal version bucket", { ref, error: result.error });
    return false;
  }
  versionBucketReady.add(ref);
  return true;
}

export async function getBucketVersioningStatus(ref: string, bucketId: string): Promise<StorageVersioningStatus> {
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const rows = await db`
    SELECT versioning_status FROM storage.buckets WHERE id = ${bucketId} LIMIT 1
  `;
  return normalizeVersioningStatus(rows[0]?.["versioning_status"], "stored");
}

export async function getLifecycleConfiguration(ref: string, bucketId: string): Promise<StorageLifecycleConfiguration | null> {
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const rows = await db`
    SELECT lifecycle_rules FROM storage.buckets WHERE id = ${bucketId} LIMIT 1
  `;
  if (rows.length === 0) throw new Error("BUCKET_NOT_FOUND");
  const value = rows[0]?.["lifecycle_rules"];
  return value ? validateLifecycleConfiguration(value) : null;
}

export async function setLifecycleConfiguration(ref: string, bucketId: string, value: unknown): Promise<StorageLifecycleConfiguration> {
  const rules = validateLifecycleConfiguration(value);
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const updated = await db`
    UPDATE storage.buckets
    SET lifecycle_rules = ${JSON.stringify(rules)}::jsonb, updated_at = now()
    WHERE id = ${bucketId}
    RETURNING id
  `;
  if (updated.length === 0) throw new Error("BUCKET_NOT_FOUND");
  return rules;
}

export async function deleteLifecycleConfiguration(ref: string, bucketId: string): Promise<void> {
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const updated = await db`
    UPDATE storage.buckets SET lifecycle_rules = NULL, updated_at = now()
    WHERE id = ${bucketId} RETURNING id
  `;
  if (updated.length === 0) throw new Error("BUCKET_NOT_FOUND");
}

export async function listObjectVersions(
  ref: string,
  bucketId: string,
  options: { prefix?: string; limit?: number; offset?: number; search?: string; sortBy?: { column?: string; order?: string } } = {},
): Promise<StoredObjectVersion[]> {
  if (ref === "test_mock") return [];
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const prefix = options.prefix || "";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const sortColumn = options.sortBy?.column === "created_at" ? "created_at" : "archived_at";
  const direction = (options.sortBy?.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const rows = await db.unsafe(
    `SELECT ${VERSION_COLUMNS}
     FROM storage.object_versions
     WHERE bucket_id = $1 AND name LIKE $2
       AND ($3::text = '' OR name ILIKE $3)
     ORDER BY ${sortColumn} ${direction}, name ASC
     LIMIT $4 OFFSET $5`,
    [bucketId, `${prefix}%`, options.search ? `%${options.search}%` : "", limit, offset],
  );
  return rows.map(mapVersionRow);
}

export async function getObjectVersion(
  ref: string,
  bucketId: string,
  name: string,
  versionId: string,
): Promise<StoredObjectVersion | null> {
  if (ref === "test_mock") return null;
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const rows = await db`
    SELECT id, bucket_id, name, version_id, owner, metadata, is_delete_marker, created_at, archived_at
    FROM storage.object_versions
    WHERE bucket_id = ${bucketId} AND name = ${name} AND version_id = ${versionId}
    LIMIT 1
  `;
  return rows.length > 0 ? mapVersionRow(rows[0] as Record<string, unknown>) : null;
}

export async function getVersionInfo(
  ref: string,
  bucketId: string,
  name: string,
  versionId: string,
): Promise<Record<string, unknown> | null> {
  const version = await getObjectVersion(ref, bucketId, name, versionId);
  if (!version || version.is_delete_marker) return null;
  return versionInfo(version);
}

export async function getVersionDownloadResponse(
  ref: string,
  bucketId: string,
  name: string,
  versionId: string,
): Promise<Response | null> {
  const version = await getObjectVersion(ref, bucketId, name, versionId);
  if (!version || version.is_delete_marker) return null;
  return await StorageService.getDownloadResponse(
    ref,
    STORAGE_VERSION_BUCKET,
    objectVersionStorageKey(bucketId, name, version.version_id),
  );
}

export function versionInfo(version: StoredObjectVersion): Record<string, unknown> {
  const meta = isRecord(version.metadata) ? version.metadata : {};
  const size = Number(meta["size"] ?? 0);
  const contentType = String(meta["mimetype"] || "application/octet-stream");
  return {
    id: version.id,
    name: version.name,
    bucket_id: version.bucket_id,
    owner: version.owner ?? undefined,
    size: Number.isFinite(size) ? size : 0,
    cache_control: String(meta["cacheControl"] || meta["cache_control"] || "3600").replace(/^max-age=/, ""),
    content_type: contentType,
    content_encoding: typeof meta["contentEncoding"] === "string" ? meta["contentEncoding"] : undefined,
    created_at: version.created_at,
    updated_at: version.created_at,
    last_modified: version.created_at,
    version: version.version_id,
    etag: String(meta["eTag"] || meta["etag"] || `"${version.id}"`),
    metadata: {
      eTag: String(meta["eTag"] || meta["etag"] || `"${version.id}"`),
      size: Number.isFinite(size) ? size : 0,
      mimetype: contentType,
      cacheControl: String(meta["cacheControl"] || meta["cache_control"] || "3600").replace(/^max-age=/, ""),
      ...(typeof meta["contentEncoding"] === "string" ? { contentEncoding: meta["contentEncoding"] } : {}),
      lastModified: version.created_at,
      contentLength: Number.isFinite(size) ? size : 0,
      httpStatusCode: 200,
      ...(isRecord(meta["userMetadata"]) ? meta["userMetadata"] : {}),
    },
  };
}

export async function deleteExactVersion(
  ref: string,
  bucketId: string,
  name: string,
  versionId: string,
): Promise<boolean> {
  if (ref === "test_mock") return false;
  await ensureStorageVersioningSchema(ref);
  const version = await getObjectVersion(ref, bucketId, name, versionId);
  if (!version) return false;

  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);

  if (version.is_delete_marker) {
    const newer = await db`
      SELECT id FROM storage.object_versions
      WHERE bucket_id = ${bucketId} AND name = ${name} AND id <> ${version.id}
        AND archived_at > ${version.archived_at}
      LIMIT 1
    `;
    if (newer.length > 0) {
      await db`DELETE FROM storage.object_versions WHERE id = ${version.id}`;
      return true;
    }
    return await restorePreviousVersion(ref, db, version);
  }

  await db`DELETE FROM storage.object_versions WHERE id = ${version.id}`;
  await StorageService.deleteFile(ref, STORAGE_VERSION_BUCKET, objectVersionStorageKey(bucketId, name, versionId));
  return true;
}

async function restorePreviousVersion(
  ref: string,
  db: ReturnType<typeof getProjectDb>,
  marker: StoredObjectVersion,
): Promise<boolean> {
  await ensureVersionBucket(ref);
  const previous = await db`
    SELECT id, bucket_id, name, version_id, owner, metadata, is_delete_marker, created_at, archived_at
    FROM storage.object_versions
    WHERE bucket_id = ${marker.bucket_id} AND name = ${marker.name}
      AND archived_at < ${marker.archived_at} AND is_delete_marker = false
    ORDER BY archived_at DESC
    LIMIT 1
  `;
  if (previous.length === 0) {
    await db`DELETE FROM storage.object_versions WHERE id = ${marker.id}`;
    return true;
  }
  const version = mapVersionRow(previous[0] as Record<string, unknown>);
  const copied = await StorageService.copyFile(
    ref,
    STORAGE_VERSION_BUCKET,
    objectVersionStorageKey(version.bucket_id, version.name, version.version_id),
    version.bucket_id,
    version.name,
  );
  if (!copied) return false;

  await db.begin(async (tx) => {
    await tx`
      INSERT INTO storage.objects (bucket_id, name, owner, metadata)
      VALUES (${version.bucket_id}, ${version.name}, ${version.owner || null}, ${version.metadata})
      ON CONFLICT (bucket_id, name)
      DO UPDATE SET metadata = EXCLUDED.metadata, owner = EXCLUDED.owner, updated_at = now(), version = ${version.version_id}
    `;
    await tx`DELETE FROM storage.object_versions WHERE id = ${version.id}`;
    await tx`DELETE FROM storage.object_versions WHERE id = ${marker.id}`;
  });
  return true;
}

export async function purgeBucketVersions(ref: string, bucketId: string): Promise<number> {
  if (ref === "test_mock") return 0;
  await ensureStorageVersioningSchema(ref);
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const versions = await db`
    SELECT version_id, name FROM storage.object_versions WHERE bucket_id = ${bucketId}
  `;
  let deleted = 0;
  for (const row of versions) {
    const versionId = String(row["version_id"]);
    const name = String(row["name"]);
    await StorageService.deleteFile(
      ref,
      STORAGE_VERSION_BUCKET,
      objectVersionStorageKey(bucketId, name, versionId),
    );
    deleted++;
  }
  if (versions.length > 0) {
    await db`DELETE FROM storage.object_versions WHERE bucket_id = ${bucketId}`;
  }
  return deleted;
}

export type LifecycleCleanupStats = {
  projects: number;
  versionsDeleted: number;
  markersDeleted: number;
  errors: number;
};

export async function cleanupProjectVersions(ref: string): Promise<{ versionsDeleted: number; markersDeleted: number }> {
  await ensureStorageVersioningSchema(ref);
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  const buckets = await db`
    SELECT id, lifecycle_rules
    FROM storage.buckets
    WHERE lifecycle_rules IS NOT NULL
      AND versioning_status IN ('ENABLED', 'SUSPENDED')
  `;
  let versionsDeleted = 0;
  let markersDeleted = 0;

  for (const bucket of buckets) {
    const bucketId = String(bucket["id"]);
    let config: StorageLifecycleConfiguration;
    try {
      config = validateLifecycleConfiguration(bucket["lifecycle_rules"]);
    } catch (e) {
      logger.warn("[StorageLifecycle] Ignoring invalid lifecycle configuration", {
        ref, bucketId, error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    for (const rule of config.rules) {
      if (rule.status !== "Enabled") continue;
      const days = rule.noncurrentVersionExpiration.noncurrentDays;
      const keepNewest = rule.noncurrentVersionExpiration.newerNoncurrentVersions ?? 0;
      const candidates = await db`
        SELECT id, bucket_id, name, version_id, owner, metadata, is_delete_marker, created_at, archived_at
        FROM storage.object_versions
        WHERE bucket_id = ${bucketId}
          AND archived_at < now() - (${days} * interval '1 day')
        ORDER BY name ASC, archived_at DESC
      `;
      const grouped = new Map<string, StoredObjectVersion[]>();
      for (const row of candidates) {
        const version = mapVersionRow(row as Record<string, unknown>);
        const list = grouped.get(version.name) || [];
        list.push(version);
        grouped.set(version.name, list);
      }
      for (const versions of grouped.values()) {
        for (const version of versions.slice(keepNewest)) {
          try {
            await db`DELETE FROM storage.object_versions WHERE id = ${version.id}`;
            await StorageService.deleteFile(
              ref,
              STORAGE_VERSION_BUCKET,
              objectVersionStorageKey(version.bucket_id, version.name, version.version_id),
            );
            if (version.is_delete_marker) markersDeleted++;
            else versionsDeleted++;
          } catch (e) {
            logger.warn("[StorageLifecycle] Failed to delete expired version", {
              ref, bucketId, name: version.name, versionId: version.version_id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }
  }
  return { versionsDeleted, markersDeleted };
}

export async function runStorageLifecycleCleanup(): Promise<LifecycleCleanupStats> {
  const stats: LifecycleCleanupStats = { projects: 0, versionsDeleted: 0, markersDeleted: 0, errors: 0 };
  const projects = await metaSql`SELECT ref FROM projects WHERE status = 'active'`;
  for (const project of projects) {
    const ref = String(project["ref"]);
    stats.projects++;
    try {
      const result = await cleanupProjectVersions(ref);
      stats.versionsDeleted += result.versionsDeleted;
      stats.markersDeleted += result.markersDeleted;
    } catch (e) {
      stats.errors++;
      logger.error("[StorageLifecycle] Project cleanup failed", {
        ref, error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return stats;
}

let lifecycleTimer: Timer | null = null;
let lifecycleInitialTimer: Timer | null = null;

export function startStorageLifecycleWorker(intervalMs = 6 * 60 * 60 * 1000): void {
  if (lifecycleTimer) return;
  logger.info(`[StorageLifecycle] Worker started (interval: ${Math.round(intervalMs / 3600000)}h)`);
  lifecycleInitialTimer = setTimeout(() => {
    lifecycleInitialTimer = null;
    runStorageLifecycleCleanup().catch((e) =>
      logger.error("[StorageLifecycle] Unhandled error", { error: e instanceof Error ? e.message : String(e) }),
    );
  }, 10 * 60 * 1000);
  lifecycleTimer = setInterval(() => {
    runStorageLifecycleCleanup().catch((e) =>
      logger.error("[StorageLifecycle] Unhandled error", { error: e instanceof Error ? e.message : String(e) }),
    );
  }, intervalMs);
}

export function stopStorageLifecycleWorker(): void {
  if (lifecycleInitialTimer) clearTimeout(lifecycleInitialTimer);
  if (lifecycleTimer) clearInterval(lifecycleTimer);
  lifecycleInitialTimer = null;
  lifecycleTimer = null;
}

function mapVersionRow(row: Record<string, unknown>): StoredObjectVersion {
  return {
    id: String(row["id"]),
    bucket_id: String(row["bucket_id"]),
    name: String(row["name"]),
    version_id: String(row["version_id"]),
    owner: row["owner"] ? String(row["owner"]) : null,
    metadata: isRecord(row["metadata"]) ? row["metadata"] : {},
    is_delete_marker: row["is_delete_marker"] === true,
    created_at: toIsoTimestamp(row["created_at"]),
    archived_at: toIsoTimestamp(row["archived_at"]),
  };
}

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}