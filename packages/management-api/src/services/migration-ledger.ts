import {
  createMigrationLedgerEntry,
  type MigrationLedgerEntry,
} from "./migration-promotion";

interface MigrationLedgerSql {
  unsafe(query: string): Promise<unknown>;
}

interface MigrationLedgerRow {
  version: unknown;
  name: unknown;
  statements: unknown;
  checksum?: unknown;
  applied_at?: unknown;
}

export class MigrationLedgerDivergenceError extends Error {
  readonly code = "migration_ledger_diverged" as const;

  constructor(
    readonly missingCanonicalVersions: readonly string[],
    readonly conflictingVersions: readonly string[] = [],
  ) {
    const details = [
      missingCanonicalVersions.length > 0
        ? `missing canonical versions: ${missingCanonicalVersions.join(", ")}`
        : null,
      conflictingVersions.length > 0
        ? `conflicting versions: ${conflictingVersions.join(", ")}`
        : null,
    ].filter(Boolean).join("; ");
    super(`Canonical and legacy migration ledgers diverged (${details})`);
    this.name = "MigrationLedgerDivergenceError";
  }
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function normalizeStatements(rawStatements: unknown): string[] {
  if (Array.isArray(rawStatements)) {
    return rawStatements
      .filter((statement): statement is string => typeof statement === "string")
      .map((statement) => statement.trim())
      .filter(Boolean);
  }
  if (typeof rawStatements === "string" && rawStatements.trim()) return [rawStatements.trim()];
  return [];
}

function normalizeRows(rows: unknown): MigrationLedgerEntry[] {
  if (!Array.isArray(rows)) throw new Error("Migration ledger query returned a non-array result");
  return (rows as MigrationLedgerRow[]).map((row) => createMigrationLedgerEntry({
    version: String(row.version),
    name: typeof row.name === "string" ? row.name : null,
    statements: normalizeStatements(row.statements),
    checksum: typeof row.checksum === "string" ? row.checksum : null,
    appliedAt: typeof row.applied_at === "string" ? row.applied_at : null,
  }));
}

async function readLedgerTable(
  database: MigrationLedgerSql,
  tableName: "supabase_migrations.schema_migrations" | "public.schema_migrations",
): Promise<MigrationLedgerEntry[] | null> {
  try {
    return normalizeRows(await database.unsafe(`
      SELECT version::text AS version, name, statements, checksum, inserted_at::text AS applied_at
      FROM ${tableName}
      ORDER BY version ASC
    `));
  } catch (error: unknown) {
    const code = postgresErrorCode(error);
    if (code === "42P01" || code === "3F000") return null;
    if (code !== "42703") throw error;
  }

  try {
    return normalizeRows(await database.unsafe(`
      SELECT version::text AS version, name, statements,
             NULL::text AS checksum, NULL::text AS applied_at
      FROM ${tableName}
      ORDER BY version ASC
    `));
  } catch (error: unknown) {
    const code = postgresErrorCode(error);
    if (code === "42P01" || code === "3F000") return null;
    throw error;
  }
}

function assertCanonicalIncludesLegacy(
  canonical: readonly MigrationLedgerEntry[],
  legacy: readonly MigrationLedgerEntry[],
): void {
  if (canonical.length === 0 || legacy.length === 0) return;
  const canonicalVersions = new Set(canonical.map((entry) => entry.version));
  const canonicalByVersion = new Map(canonical.map((entry) => [entry.version, entry]));
  const missing = legacy
    .map((entry) => entry.version)
    .filter((version) => !canonicalVersions.has(version));
  const conflicting = legacy
    .filter((entry) => {
      const canonicalEntry = canonicalByVersion.get(entry.version);
      return canonicalEntry !== undefined && canonicalEntry.checksum !== entry.checksum;
    })
    .map((entry) => entry.version);
  if (missing.length > 0 || conflicting.length > 0) {
    throw new MigrationLedgerDivergenceError(missing, conflicting);
  }
}

export async function readMigrationLedger(database: MigrationLedgerSql): Promise<MigrationLedgerEntry[]> {
  const canonical = await readLedgerTable(database, "supabase_migrations.schema_migrations");
  const legacy = await readLedgerTable(database, "public.schema_migrations");
  if (canonical && legacy) assertCanonicalIncludesLegacy(canonical, legacy);
  if (canonical && canonical.length > 0) return canonical;
  if (legacy && legacy.length > 0) return legacy;
  return canonical ?? legacy ?? [];
}

async function ensureCanonicalLedger(database: MigrationLedgerSql): Promise<void> {
  await database.unsafe("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
  await database.unsafe(`
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version TEXT PRIMARY KEY,
      statements TEXT[],
      name TEXT,
      checksum TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await database.unsafe("ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements TEXT[]");
  await database.unsafe("ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name TEXT");
  await database.unsafe("ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
  await database.unsafe("ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()");
}

async function ensureLegacyLedger(database: MigrationLedgerSql): Promise<void> {
  await database.unsafe(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      statements TEXT[],
      name TEXT,
      checksum TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await database.unsafe("ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS statements TEXT[]");
  await database.unsafe("ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS name TEXT");
  await database.unsafe("ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
  await database.unsafe("ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()");
}

export async function reconcileMigrationLedgerVersions(database: MigrationLedgerSql): Promise<void> {
  await database.unsafe(`
    UPDATE supabase_migrations.schema_migrations canonical
    SET statements = legacy.statements,
        name = legacy.name,
        checksum = legacy.checksum,
        inserted_at = COALESCE(legacy.inserted_at, canonical.inserted_at, now())
    FROM public.schema_migrations legacy
    WHERE canonical.version = legacy.version::text
      AND canonical.checksum IS NULL
      AND COALESCE(cardinality(canonical.statements), 0) = 0
      AND (canonical.name IS NULL OR canonical.name = canonical.version)
  `);
  await database.unsafe(`
    UPDATE public.schema_migrations legacy
    SET statements = canonical.statements,
        name = canonical.name,
        checksum = canonical.checksum,
        inserted_at = canonical.inserted_at
    FROM supabase_migrations.schema_migrations canonical
    WHERE legacy.version::text = canonical.version
      AND legacy.checksum IS NULL
      AND COALESCE(cardinality(legacy.statements), 0) = 0
      AND (legacy.name IS NULL OR legacy.name = legacy.version::text)
  `);
  await database.unsafe(`
    INSERT INTO supabase_migrations.schema_migrations
      (version, statements, name, checksum, inserted_at)
    SELECT version::text, statements, name, checksum, COALESCE(inserted_at, now())
    FROM public.schema_migrations
    ON CONFLICT (version) DO NOTHING
  `);
  await database.unsafe(`
    INSERT INTO public.schema_migrations
      (version, statements, name, checksum, inserted_at)
    SELECT version::bigint, statements, name, checksum, inserted_at
    FROM supabase_migrations.schema_migrations
    ON CONFLICT (version) DO NOTHING
  `);
}

export async function ensureMigrationLedgerMetadata(database: MigrationLedgerSql): Promise<void> {
  await ensureCanonicalLedger(database);
  await ensureLegacyLedger(database);
  await reconcileMigrationLedgerVersions(database);
}
