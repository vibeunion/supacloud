import type { SQL } from "bun";
import type { StorageDriver } from "./storage.adapter";
import {
  PROJECT_STORAGE_SECRET, ProjectStorageError, assertProjectRef, assertProjectS3Origin,
  parseProjectS3Settings, parseStoredProjectS3, publicProjectStorage, sameStorageNamespace, overlappingStorageNamespace,
  type ProjectS3Configuration,
} from "./project-storage-contract";


export interface ProjectStorageDependencies {
  database: SQL;
  getProjectDb: (name: string) => SQL;
  encryptSecret: (value: string) => string;
  decryptSecret: (value: string) => string;
  allowedOrigins: () => string;
  defaultBackend: () => string;
  createDriver: (configuration: ProjectS3Configuration) => StorageDriver;
  probe: (configuration: ProjectS3Configuration) => Promise<{ backend: "s3"; reachable: boolean; listable: boolean; writable: "not_tested" }>;
}

/** The same registry is used by runtime routing and the management API. */
export function createProjectStorageRegistry(dependencies: ProjectStorageDependencies) {
  const { database: sql, getProjectDb, encryptSecret, decryptSecret } = dependencies;
  const { scope, name } = PROJECT_STORAGE_SECRET;
  const lockName = (ref: string) => `supacloud:project-storage:${ref}`;
  const allowedOrigins = dependencies.allowedOrigins;

  async function readConfig(database: SQL, ref: string): Promise<Readonly<ProjectS3Configuration> | null> {
    try {
      const [row] = await database`
        SELECT value_encrypted FROM project_control_secrets
        WHERE project_ref = ${ref} AND scope = ${scope} AND name = ${name}
      ` as Array<{ value_encrypted: string }>;
      if (!row) return null;
      return parseStoredProjectS3(ref, JSON.parse(decryptSecret(row.value_encrypted)));
    } catch { throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE"); }
  }

  function configuredDriver(config: ProjectS3Configuration): StorageDriver {
    if (!config.enabled) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
    assertProjectS3Origin(config, allowedOrigins());
    try { return dependencies.createDriver(config); }
    catch { throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE"); }
  }

  /** A missing row preserves the legacy layout; lookup/decryption failures NEVER fall back. */
  async function withDriver<T>(ref: string, fallback: StorageDriver, operation: (driver: StorageDriver) => Promise<T>): Promise<T> {
    assertProjectRef(ref);
    const configured = await readConfig(sql, ref);
    if (configured) return operation(configuredDriver(configured));
    // Only the legacy path holds a shared lock while doing IO. The first binding takes
    // the exclusive lock, so it cannot overtake a request already using legacy storage.
    try {
      return await sql.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockName(ref)}, 0))`;
        const latest = await readConfig(transaction, ref);
        return operation(latest ? configuredDriver(latest) : fallback);
      });
    } catch (error) {
      if (error instanceof ProjectStorageError) throw error;
      // Sanitize transport errors, but never retry on a different backend.
      throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    }
  }

  async function assertUnusedProject(database: SQL, ref: string, dbName: string): Promise<void> {
    if (typeof dbName !== "string" || !dbName) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
    const projectDb = getProjectDb(dbName);
    const [objects] = await projectDb`
      SELECT EXISTS (SELECT 1 FROM storage.buckets)
        OR EXISTS (SELECT 1 FROM storage.objects)
        OR EXISTS (SELECT 1 FROM storage.s3_multipart_uploads) AS occupied
    ` as Array<{ occupied: boolean }>;
    const [uploads] = await database`
      SELECT EXISTS (SELECT 1 FROM system_tus_uploads WHERE ref = ${ref})
        OR EXISTS (SELECT 1 FROM system_signed_uploads WHERE ref = ${ref}) AS occupied
    ` as Array<{ occupied: boolean }>;
    if (!objects || !uploads || objects.occupied || uploads.occupied) {
      throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
    }
  }

  return {
    withDriver,
    async describe(ref: string) {
      try {
        const configuration = await readConfig(sql, ref);
        if (!configuration) return { backend: dependencies.defaultBackend(), available: true, reason: null };
        assertProjectS3Origin(configuration, allowedOrigins());
        return { backend: "s3", available: configuration.enabled, reason: configuration.enabled ? null : "storage_disabled" };
      } catch { return { backend: "unknown", available: false, reason: "storage_configuration_unavailable" }; }
    },
    async get(ref: string) {
      assertProjectRef(ref);
      return publicProjectStorage(await readConfig(sql, ref));
    },
    async put(ref: string, settings: unknown, expectedRevision: string | null) {
      assertProjectRef(ref);
      const parsed = parseProjectS3Settings(settings);
      assertProjectS3Origin(parsed, allowedOrigins());
      try {
        return await sql.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended('supacloud:project-storage:registry', 0))`;
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockName(ref)}, 0))`;
          const [project] = await transaction`
            SELECT ref, db_name FROM projects WHERE ref = ${ref} AND deleted_at IS NULL
              AND lower(status) IN ('active', 'creating') FOR UPDATE
          `;
          if (!project) throw new ProjectStorageError("STORAGE_CONFIG_INVALID", 400);
          const current = await readConfig(transaction, ref);
          if ((current?.revision ?? null) !== expectedRevision
            || (current && !sameStorageNamespace(current, parsed))) {
            throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
          }
          if (!current) {
            await assertUnusedProject(transaction, ref, project.db_name);
            const others = await transaction`
              SELECT project_ref, value_encrypted FROM project_control_secrets
              WHERE scope = ${scope} AND name = ${name} AND project_ref <> ${ref}
            ` as Array<{ project_ref: string; value_encrypted: string }>;
            for (const row of others) {
              // An unreadable binding cannot serve storage, so it cannot leak an
              // overlapping namespace in practice. Skipping it keeps one corrupt
              // project from bricking every unrelated first binding; a later
              // repair still re-runs this same overlap check.
              let other: Readonly<ProjectS3Configuration>;
              try {
                other = parseStoredProjectS3(row.project_ref, JSON.parse(decryptSecret(row.value_encrypted)));
              } catch {
                continue;
              }
              if (overlappingStorageNamespace(other, parsed)) throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
            }
          }
          const configuration: ProjectS3Configuration = { ...parsed, version: 1, projectRef: ref, revision: crypto.randomUUID() };
          const encrypted = encryptSecret(JSON.stringify(configuration));
          await transaction`
            INSERT INTO project_control_secrets (project_ref, scope, name, value_encrypted)
            VALUES (${ref}, ${scope}, ${name}, ${encrypted})
            ON CONFLICT (project_ref, scope, name) DO UPDATE
              SET value_encrypted = EXCLUDED.value_encrypted, updated_at = NOW()
          `;
          return publicProjectStorage(configuration);
        });
      } catch (error) {
        if (error instanceof ProjectStorageError) throw error;
        throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
      }
    },
    async probe(ref: string) {
      assertProjectRef(ref);
      const config = await readConfig(sql, ref);
      if (!config) throw new ProjectStorageError("STORAGE_CONFIG_INVALID", 400);
      if (!config.enabled) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
      assertProjectS3Origin(config, allowedOrigins());
      try { return await dependencies.probe(config); }
      catch { throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE"); }
    },
  };
}
