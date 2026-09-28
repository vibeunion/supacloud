import type { SQL } from "bun";
import type { StorageDriver } from "./storage.adapter";
import {
  PROJECT_STORAGE_SECRET, PROJECT_STORAGE_ADOPTION_MAX_OBJECTS, ProjectStorageError, assertProjectRef, assertProjectS3Origin,
  parseProjectS3Settings, parseStoredProjectS3, publicProjectStorage, sameStorageNamespace, overlappingStorageNamespace,
  type ProjectS3Configuration, type ProjectStorageAdoptionPlan, type ProjectStorageInventory,
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
  /** Read-only inventory of a project's current (platform) objects. */
  inventory?: (ref: string, source: StorageDriver) => Promise<ProjectStorageInventory>;
  /** Copy + verify every inventoried object from the platform backend to the project backend. Idempotent. */
  migrate?: (ref: string, source: StorageDriver, target: StorageDriver, inventory: ProjectStorageInventory) => Promise<void>;
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

  async function assertActiveProject(database: SQL, ref: string): Promise<{ ref: string; db_name: string }> {
    const [project] = await database`
      SELECT ref, db_name FROM projects WHERE ref = ${ref} AND deleted_at IS NULL
        AND lower(status) IN ('active', 'creating') FOR UPDATE
    ` as Array<{ ref: string; db_name: string }>;
    if (!project) throw new ProjectStorageError("STORAGE_CONFIG_INVALID", 400);
    return project;
  }

  async function assertNoNamespaceOverlap(
    database: SQL,
    ref: string,
    parsed: Readonly<ReturnType<typeof parseProjectS3Settings>>,
  ): Promise<void> {
    const others = await database`
      SELECT project_ref, value_encrypted FROM project_control_secrets
      WHERE scope = ${scope} AND name = ${name} AND project_ref <> ${ref}
    ` as Array<{ project_ref: string; value_encrypted: string }>;
    for (const row of others) {
      // Unknown namespaces remain reserved: restored keys can make an
      // unreadable binding usable again without another registration.
      const other = parseStoredProjectS3(row.project_ref, JSON.parse(decryptSecret(row.value_encrypted)));
      if (overlappingStorageNamespace(other, parsed)) throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
    }
  }

  async function writeBinding(database: SQL, ref: string, configuration: ProjectS3Configuration): Promise<void> {
    const encrypted = encryptSecret(JSON.stringify(configuration));
    await database`
      INSERT INTO project_control_secrets (project_ref, scope, name, value_encrypted)
      VALUES (${ref}, ${scope}, ${name}, ${encrypted})
      ON CONFLICT (project_ref, scope, name) DO UPDATE
        SET value_encrypted = EXCLUDED.value_encrypted, updated_at = NOW()
    `;
  }

  /** Read-only migration plan for an existing project. Never mutates storage. */
  async function plan(ref: string, source: StorageDriver): Promise<ProjectStorageAdoptionPlan> {
    assertProjectRef(ref);
    if (!dependencies.inventory) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
    try {
      const inventory = await dependencies.inventory(ref, source);
      return { buckets: inventory.buckets, objects: inventory.objects, fingerprint: inventory.fingerprint };
    } catch (error) {
      if (error instanceof ProjectStorageError) throw error;
      throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
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
    plan,
    async put(ref: string, settings: unknown, expectedRevision: string | null) {
      assertProjectRef(ref);
      const parsed = parseProjectS3Settings(settings);
      assertProjectS3Origin(parsed, allowedOrigins());
      try {
        return await sql.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended('supacloud:project-storage:registry', 0))`;
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockName(ref)}, 0))`;
          const project = await assertActiveProject(transaction, ref);
          const current = await readConfig(transaction, ref);
          if ((current?.revision ?? null) !== expectedRevision
            || (current && !sameStorageNamespace(current, parsed))) {
            throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
          }
          if (!current) {
            await assertUnusedProject(transaction, ref, project.db_name);
            await assertNoNamespaceOverlap(transaction, ref, parsed);
          }
          const configuration: ProjectS3Configuration = { ...parsed, version: 1, projectRef: ref, revision: crypto.randomUUID() };
          await writeBinding(transaction, ref, configuration);
          return publicProjectStorage(configuration);
        });
      } catch (error) {
        if (error instanceof ProjectStorageError) throw error;
        throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
      }
    },
    /**
     * Adopt an already-used project into its own backend. Copies and verifies
     * every current platform object, then binds atomically. The source objects
     * are never deleted, so the cutover is inspectable and reversible at the
     * storage layer. Adoption is a first binding: an existing binding conflicts.
     */
    async adopt(
      ref: string,
      settings: unknown,
      expectedRevision: string | null,
      source: StorageDriver,
    ) {
      assertProjectRef(ref);
      if (expectedRevision !== null) throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
      const parsed = parseProjectS3Settings(settings);
      assertProjectS3Origin(parsed, allowedOrigins());
      const inventory = dependencies.inventory;
      const migrate = dependencies.migrate;
      if (!inventory || !migrate) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
      try {
        // Copy outside the database transaction so a large project does not hold
        // a transaction (or the exclusive lock) for the whole transfer. A
        // concurrent legacy write is detected by the fingerprint re-check below
        // and aborts without writing the binding.
        const before = await inventory(ref, source);
        if (before.objects > PROJECT_STORAGE_ADOPTION_MAX_OBJECTS) {
          throw new ProjectStorageError("STORAGE_ADOPTION_LIMIT", 413);
        }
        const draft: ProjectS3Configuration = { ...parsed, version: 1, projectRef: ref, revision: crypto.randomUUID() };
        const target = configuredDriver(draft);
        await migrate(ref, source, target, before);

        return await sql.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended('supacloud:project-storage:registry', 0))`;
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockName(ref)}, 0))`;
          await assertActiveProject(transaction, ref);
          if (await readConfig(transaction, ref)) throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
          await assertNoNamespaceOverlap(transaction, ref, parsed);
          // Re-inventory under the exclusive lock: a legacy op that committed
          // before the lock is visible here, and a legacy op that starts after
          // is blocked until the binding exists. Any drift aborts the cutover.
          const after = await inventory(ref, source);
          if (after.fingerprint !== before.fingerprint) {
            throw new ProjectStorageError("STORAGE_ADOPTION_SOURCE_CHANGED", 409);
          }
          const configuration: ProjectS3Configuration = { ...parsed, version: 1, projectRef: ref, revision: crypto.randomUUID() };
          await writeBinding(transaction, ref, configuration);
          return {
            ...publicProjectStorage(configuration),
            adopted: { buckets: before.buckets, objects: before.objects, fingerprint: before.fingerprint },
          };
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