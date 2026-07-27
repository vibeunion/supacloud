import { Elysia, t } from "elysia";
import type { TransactionSQL } from "bun";
import { projectService } from "../services";
import { db, getProjectDb, getProjectRoleDb, removeProjectDbCache, resolveDbName, sql as metaSql, type SqlExecutionMode } from "../db";
import { normalizeSqlForPolicy } from "../db/sql-policy";
import { splitSqlStatements } from "../db/sql-statements";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import {
  calculateMigrationChecksum,
  detectUnsupportedMigrationOperations,
} from "../services/migration-promotion";
import {
  ensureMigrationLedgerMetadata,
  MigrationLedgerDivergenceError,
  readMigrationLedger,
  reconcileMigrationLedgerVersions,
} from "../services/migration-ledger";
import {
  ProjectMigrationLockError,
  withProjectMigrationLocks,
} from "../services/migration-lock";
import { prepareProjectMigrationRole } from "../services/project-migration-role";
import {
  issueMigrationLedgerLease,
  releaseMigrationLedgerLease,
} from "../services/migration-ledger-lease";
import {
  BranchReplacementJournalActiveError,
  branchReplacementJournal,
} from "../services/branch-replacement-journal";
import { logger } from "../utils/logger";

export type MigrationBody =
  | { query: string; version?: number | string }
  | { name: string; sql?: string; statements?: string[]; version?: number | string };

type ProjectSql = ReturnType<typeof getProjectDb>;
type ReservedProjectSql = Awaited<ReturnType<ProjectSql["reserve"]>>;
type ProjectTransaction = TransactionSQL;

class MigrationRouteError extends Error {
  constructor(
    readonly httpStatus: 400 | 409 | 423,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MigrationRouteError";
  }
}

class TableDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableDefinitionError";
  }
}

export function resolveMigrationStatements(body: MigrationBody): string[] {
  if ("query" in body && typeof body.query === "string") {
    return body.query.trim() ? [body.query.trim()] : [];
  }

  if ("statements" in body && Array.isArray(body.statements) && body.statements.length > 0) {
    return body.statements
      .filter((statement: unknown): statement is string => typeof statement === "string")
      .map((statement) => statement.trim())
      .filter(Boolean);
  }

  if ("sql" in body && typeof body.sql === "string" && body.sql.trim().length > 0) {
    return [body.sql.trim()];
  }

  return [];
}

/**
 * Migration clients commonly submit a file wrapped in one outer transaction.
 * The management API already owns that transaction, so execute only the file
 * contents while retaining the original statements for checksums and history.
 */
export function migrationExecutionStatements(statements: readonly string[]): string[] {
  const normalized = statements.flatMap((statement) => splitSqlStatements(statement));
  const executionStatements = normalized.length >= 2
    && /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION)$/i.test(normalizeSqlForPolicy(normalized[0]!))
    && /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i.test(normalizeSqlForPolicy(normalized[normalized.length - 1]!))
    ? normalized.slice(1, -1)
    : normalized;
  if (executionStatements.length === 0) {
    throw new MigrationRouteError(400, "empty_migration", "Migration contains no executable statements");
  }
  return executionStatements;
}

const MAX_MIGRATION_VERSION = 9_223_372_036_854_775_807n;

export function normalizeMigrationVersion(rawVersion: unknown, now = Date.now()): string {
  if (rawVersion === undefined || rawVersion === null || rawVersion === "") {
    return String(Math.floor(now / 1000));
  }
  const normalized = typeof rawVersion === "bigint"
    ? rawVersion.toString()
    : typeof rawVersion === "number" && Number.isSafeInteger(rawVersion)
      ? String(rawVersion)
      : typeof rawVersion === "string"
        ? rawVersion.trim()
        : "";
  if (!/^\d{1,19}$/.test(normalized)) {
    throw new MigrationRouteError(400, "invalid_migration_version", "Migration version must be a positive PostgreSQL bigint value");
  }
  const version = BigInt(normalized);
  if (version < 1n || version > MAX_MIGRATION_VERSION) {
    throw new MigrationRouteError(400, "invalid_migration_version", "Migration version is outside the supported PostgreSQL bigint range");
  }
  return version.toString();
}

function normalizeMigrationName(rawName: unknown, fallback: string): string {
  if (rawName === undefined || rawName === null) return fallback;
  if (typeof rawName !== "string" || !rawName.trim()) {
    throw new MigrationRouteError(400, "invalid_migration_name", "Migration name must be a non-empty string");
  }
  const name = rawName.trim();
  if (name.length > 255) {
    throw new MigrationRouteError(400, "invalid_migration_name", "Migration name must be at most 255 characters");
  }
  return name;
}

export function sqlRouteResponse(result: Awaited<ReturnType<typeof db.executeQuery>>) {
  return {
    rows: result.rows,
    rowCount: result.rowCount,
    command: result.command,
    fields: result.fields || [],
    notices: result.notices || [],
  };
}

async function getProjectDatabaseCredentials(ref: string) {
  const [project] = await metaSql`
    SELECT db_name, db_user, db_password
    FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!project) return null;
  return {
    db_name: String(project.db_name),
    db_user: String(project.db_user),
    db_password: String(project.db_password),
  };
}

async function getProjectSql(ref: string) {
  const credentials = await getProjectDatabaseCredentials(ref);
  if (!credentials) return null;
  return getProjectRoleDb(credentials.db_name, credentials.db_user, credentials.db_password);
}

function resolveSqlMode(body: Record<string, unknown>): SqlExecutionMode {
  const mode = typeof body.mode === "string" ? body.mode : "read";
  if (mode === "migration" || mode === "admin") return mode;
  return "read";
}

function requireAdminMode(body: Record<string, unknown>): boolean {
  return body.mode === "admin" && body.admin === true;
}

const ensuredMigrationTables = new Set<string>();

export function resetEnsuredMigrationTablesForTests(): void {
  ensuredMigrationTables.clear();
}

const PG_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertPgIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!PG_IDENTIFIER_PATTERN.test(normalized)) {
    throw new TableDefinitionError(`${label} must be a PostgreSQL identifier`);
  }
  if (normalized.length > 63) throw new TableDefinitionError(`${label} must not exceed 63 characters`);
  return normalized;
}

export function quotePgIdentifier(identifier: string, label = "identifier"): string {
  return `"${assertPgIdentifier(identifier, label).replace(/"/g, '""')}"`;
}

export function normalizeMaterializedViewDefinition(definition: string): string {
  const normalized = definition.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("Materialized view definition must start with SELECT or WITH");
  }
  if (normalized.includes(";")) {
    throw new Error("Materialized view definition must contain a single query");
  }
  return normalized;
}

export function buildMaterializedViewName(schema: string | undefined, name: string): string {
  return buildQualifiedPgName(schema, name);
}

function buildQualifiedPgName(schema: string | undefined, name: string): string {
  const safeSchema = quotePgIdentifier(schema || "public", "schema");
  const safeName = quotePgIdentifier(name, "name");
  return `${safeSchema}.${safeName}`;
}

export function buildCreateMaterializedViewSql(input: {
  schema?: string;
  name: string;
  definition: string;
  withData?: boolean;
}): string {
  const qualifiedName = buildMaterializedViewName(input.schema, input.name);
  const definition = normalizeMaterializedViewDefinition(input.definition);
  return `CREATE MATERIALIZED VIEW ${qualifiedName} AS ${definition} WITH ${input.withData === false ? "NO DATA" : "DATA"}`;
}

export function buildRefreshMaterializedViewSql(input: {
  schema?: string;
  name: string;
  concurrently?: boolean;
}): string {
  const qualifiedName = buildMaterializedViewName(input.schema, input.name);
  return `REFRESH MATERIALIZED VIEW${input.concurrently ? " CONCURRENTLY" : ""} ${qualifiedName}`;
}

export function buildDropMaterializedViewSql(input: {
  schema?: string;
  name: string;
  ifExists?: boolean;
}): string {
  const qualifiedName = buildMaterializedViewName(input.schema, input.name);
  return `DROP MATERIALIZED VIEW ${input.ifExists ? "IF EXISTS " : ""}${qualifiedName}`;
}

export const TABLE_COLUMN_TYPES = [
  "bigint",
  "boolean",
  "date",
  "double precision",
  "integer",
  "jsonb",
  "numeric",
  "real",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
] as const;

export type TableColumnType = typeof TABLE_COLUMN_TYPES[number];

export interface TableColumnDefinition {
  name: string;
  type: TableColumnType;
  nullable?: boolean;
  primaryKey?: boolean;
  identity?: boolean;
}

export interface CreateTableInput {
  schema?: string;
  name: string;
  columns: readonly TableColumnDefinition[];
}

function isTableColumnType(candidateType: unknown): candidateType is TableColumnType {
  return typeof candidateType === "string" && TABLE_COLUMN_TYPES.includes(candidateType as TableColumnType);
}

function buildTableColumnSql(column: TableColumnDefinition): string {
  const quotedName = quotePgIdentifier(column.name, "column name");
  if (!isTableColumnType(column.type)) {
    throw new TableDefinitionError("Column type is not supported");
  }
  if (column.identity && column.type !== "integer" && column.type !== "bigint") {
    throw new TableDefinitionError("Identity columns must use integer or bigint");
  }

  const constraints = [
    column.identity ? "GENERATED BY DEFAULT AS IDENTITY" : "",
    column.primaryKey ? "PRIMARY KEY" : "",
    !column.primaryKey && column.nullable === false ? "NOT NULL" : "",
  ].filter(Boolean);
  return [quotedName, column.type, ...constraints].join(" ");
}

export function buildCreateTableSql(input: CreateTableInput): string {
  if (!Array.isArray(input.columns) || input.columns.length === 0 || input.columns.length > 64) {
    throw new TableDefinitionError("A table must have between 1 and 64 columns");
  }

  const columnNames = new Set<string>();
  let primaryKeyCount = 0;
  for (const column of input.columns) {
    const normalizedName = assertPgIdentifier(column.name, "column name").toLowerCase();
    if (columnNames.has(normalizedName)) throw new TableDefinitionError("Column names must be unique");
    columnNames.add(normalizedName);
    if (column.primaryKey) primaryKeyCount += 1;
  }
  if (primaryKeyCount > 1) throw new TableDefinitionError("Only one primary key column is supported");

  const qualifiedName = buildQualifiedPgName(input.schema, input.name);
  const columns = input.columns.map(buildTableColumnSql).join(",\n  ");
  return `CREATE TABLE ${qualifiedName} (\n  ${columns}\n)`;
}

export async function ensureMigrationTables(dbName: string, projectDb: ReturnType<typeof getProjectDb>): Promise<void> {
  if (!ensuredMigrationTables.has(dbName)) {
    await ensureMigrationLedgerMetadata(projectDb);
    ensuredMigrationTables.add(dbName);
    return;
  }
  await reconcileMigrationLedgerVersions(projectDb);
}

export async function ensureTasksRealtimePublication(projectDb: ReturnType<typeof getProjectDb>): Promise<void> {
  try {
    await projectDb`SELECT realtime.ensure_tasks_publication()`;
  } catch {
    // Older tenants may not have the helper yet, and some deployments run without
    // logical Realtime enabled. Migrations must remain authoritative even then.
  }
}

interface ProjectMigrationCredentials {
  db_name: string;
  db_user: string;
  db_password: string;
}

interface RecordedMigrationInput {
  projectRef: string;
  credentials: ProjectMigrationCredentials;
  version: string;
  name: string;
  statements: readonly string[];
  conflictOnName: boolean;
}

interface MigrationExecutionPlan {
  checksum: string;
  statements: readonly string[];
}

export const MIGRATION_SESSION_RESET_SQL = "RESET ALL; DISCARD TEMP; DISCARD PLANS";

function existingMigrationChecksum(
  row: Record<string, unknown>,
  fallback: { version: string; name: string },
): string {
  if (typeof row.checksum === "string") return row.checksum;
  return calculateMigrationChecksum({
    version: String(row.version ?? fallback.version),
    name: typeof row.name === "string" ? row.name : fallback.name,
    statements: Array.isArray(row.statements)
      ? row.statements.filter((statement: unknown): statement is string => typeof statement === "string")
      : [],
  });
}

function normalizedMigrationStatements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((statement): statement is string => typeof statement === "string")
    .map((statement) => statement.replace(/\r\n?/g, "\n").trim())
    .filter(Boolean);
}

/**
 * Legacy ledgers stored a raw file SHA-256 in `checksum`, while the current
 * route stores a structured checksum over version/name/statements. When the
 * identity and exact normalized SQL both match, the migration is already
 * applied even though those checksum formats differ.
 */
export function migrationLedgerEntryMatches(
  row: Record<string, unknown>,
  input: Pick<RecordedMigrationInput, "version" | "name" | "statements">,
): boolean {
  return String(row.version ?? "").trim() === input.version
    && (typeof row.name === "string" ? row.name.trim() : "") === input.name
    && JSON.stringify(normalizedMigrationStatements(row.statements))
      === JSON.stringify(normalizedMigrationStatements(input.statements));
}

async function resetMigrationSession(connection: ReservedProjectSql, dbName: string): Promise<boolean> {
  try {
    // Keep the driver's prepared-statement cache valid across pooled requests.
    await connection.unsafe(MIGRATION_SESSION_RESET_SQL);
    return true;
  } catch (error: unknown) {
    logger.warn(`[database] failed to reset migration session for ${dbName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function findExistingMigration(
  tx: ProjectTransaction,
  input: RecordedMigrationInput,
): Promise<Record<string, unknown>[]> {
  if (input.conflictOnName) {
    return tx<Record<string, unknown>[]>`
      SELECT version, statements, name, checksum
      FROM supabase_migrations.schema_migrations
      WHERE version = ${input.version} OR name = ${input.name}
    `;
  }
  return tx<Record<string, unknown>[]>`
    SELECT version, statements, name, checksum
    FROM supabase_migrations.schema_migrations
    WHERE version = ${input.version}
  `;
}

async function insertMigrationLedger(
  tx: ProjectTransaction,
  input: RecordedMigrationInput,
  checksum: string,
  leaseToken: string,
): Promise<void> {
  const statementArray = tx.array([...input.statements], "TEXT");
  await tx`
    SELECT supabase_migrations.record_schema_migration(
      ${input.version},
      ${statementArray},
      ${input.name},
      ${checksum},
      ${leaseToken}
    )
  `;
}

async function executeMigrationTransaction(
  connection: ReservedProjectSql,
  adminDb: ProjectSql,
  input: RecordedMigrationInput,
  execution: MigrationExecutionPlan,
): Promise<boolean> {
  const leaseHolder: { current?: Awaited<ReturnType<typeof issueMigrationLedgerLease>> } = {};
  try {
    return await connection.begin(async (tx) => {
      const existing = await findExistingMigration(tx, input);
      if (existing.length > 0) {
        const alreadyApplied = existing.some((row) => migrationLedgerEntryMatches(row, input));
        if (!alreadyApplied && existingMigrationChecksum(existing[0]!, input) !== execution.checksum) {
          throw new MigrationRouteError(
            409,
            "migration_checksum_conflict",
            `Migration ${input.name} conflicts with an existing version, name, or checksum`,
          );
        }
        return true;
      }
      const unsupported = detectUnsupportedMigrationOperations(execution.statements);
      if (unsupported.length > 0) {
        throw new MigrationRouteError(
          400,
          "unsupported_migration_sql",
          `Migration contains SQL outside the project-scoped path: ${unsupported.join(", ")}`,
        );
      }
      for (const statement of execution.statements) await tx.unsafe(statement);
      const issuedLease = await issueMigrationLedgerLease(adminDb, input.version, execution.checksum);
      leaseHolder.current = issuedLease;
      await insertMigrationLedger(tx, input, execution.checksum, issuedLease.token);
      return false;
    });
  } finally {
    const lease = leaseHolder.current;
    if (lease) {
      try {
        await releaseMigrationLedgerLease(adminDb, lease.tokenHash);
      } catch (error: unknown) {
        logger.warn(`[database] failed to clean migration ledger lease for ${input.projectRef}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function withMigrationRoleSession<T>(
  input: RecordedMigrationInput,
  operation: (connection: ReservedProjectSql, adminDb: ProjectSql) => Promise<T>,
): Promise<T> {
  const adminDb = getProjectDb(input.credentials.db_name);
  await ensureMigrationTables(input.credentials.db_name, adminDb);
  await prepareProjectMigrationRole(adminDb, input.credentials.db_name, input.credentials.db_user);
  const roleDb = getProjectRoleDb(input.credentials.db_name, input.credentials.db_user, input.credentials.db_password);
  const connection = await roleDb.reserve();
  try {
    return await operation(connection, adminDb);
  } finally {
    const reset = await resetMigrationSession(connection, input.credentials.db_name);
    connection.release();
    if (!reset) await removeProjectDbCache(input.credentials.db_name);
  }
}

async function applyRecordedMigration(input: RecordedMigrationInput): Promise<{
  checksum: string;
  alreadyApplied: boolean;
}> {
  const checksum = calculateMigrationChecksum(input);
  const executionStatements = migrationExecutionStatements(input.statements);

  return withProjectMigrationLocks({ projectRefs: [input.projectRef] }, async () => {
    await branchReplacementJournal.assertInactive([input.projectRef]);
    return withMigrationRoleSession(input, async (connection, adminDb) => {
      const alreadyApplied = await executeMigrationTransaction(
        connection,
        adminDb,
        input,
        { checksum, statements: executionStatements },
      );
      await ensureTasksRealtimePublication(adminDb);
      return { checksum, alreadyApplied };
    });
  });
}

function projectAuthResponse(authError: { status: number; body: { error: string } }, set: { status?: number | string }) {
  set.status = authError.status;
  return { message: authError.body.error, code: String(authError.status), status: authError.status };
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizePagination(
  query: Record<string, unknown>,
  defaultLimit = 50,
  maxLimit = Number.MAX_SAFE_INTEGER,
) {
  const limit = normalizePositiveInteger(query._limit ?? query.limit, defaultLimit, 1, maxLimit);
  const page = normalizePositiveInteger(query._page, 1, 1, Number.MAX_SAFE_INTEGER);
  const defaultSkip = (page - 1) * limit;
  const skip = normalizePositiveInteger(query.skip, defaultSkip, 0, Number.MAX_SAFE_INTEGER);
  return { limit, page, skip };
}

function databaseErrorDetails(error: unknown) {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : {};
  const rawCode = typeof candidate.code === "string" ? candidate.code : "unknown";
  const errorCode = /^[A-Za-z0-9_-]{1,64}$/.test(rawCode) ? rawCode : "unknown";
  const rawMessage = typeof candidate.message === "string" ? candidate.message : "Unknown database error";
  const errorMessage = rawMessage
    .replace(/(postgres(?:ql)?:\/\/)([^@\s]+)@/gi, "$1[REDACTED]@")
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*=\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 512);

  return { errorCode, errorMessage };
}

async function createProjectTable(projectRef: string, input: CreateTableInput) {
  const schema = (input.schema || "public").trim();
  const name = input.name.trim();
  const statement = buildCreateTableSql({ schema, name, columns: input.columns });
  const credentials = await getProjectDatabaseCredentials(projectRef);
  if (!credentials) return null;

  const version = String(Date.now());
  const migration = await applyRecordedMigration({
    projectRef,
    credentials,
    version,
    name: `create_${schema}_${name}_${version}`,
    statements: [statement],
    conflictOnName: false,
  });
  if (migration.alreadyApplied) {
    throw new MigrationRouteError(409, "table_creation_conflict", "Table creation migration already applied");
  }
  return { schema, name, version, checksum: migration.checksum };
}

function createTableFailure(error: unknown, projectRef: string) {
  if (error instanceof TableDefinitionError) {
    return { message: error.message, code: "invalid_table_definition", status: 400 as const };
  }
  if (error instanceof MigrationRouteError) {
    return { message: error.message, code: error.code, status: error.httpStatus };
  }
  const { errorCode, errorMessage } = databaseErrorDetails(error);
  if (errorCode === "42P07") {
    return { message: "Table already exists", code: "table_already_exists", status: 409 as const };
  }
  logger.error("[database] failed to create table", { projectRef, errorCode, errorMessage });
  return { message: "Failed to create table", code: "500", status: 500 as const };
}

export const databaseRoutes = new Elysia({ prefix: "/v1/projects/:ref/database" })
    .get(
        "/tables",
        async ({ params, query, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const { limit, skip } = normalizePagination(query as Record<string, unknown>);
                const search = query.q ? String(query.q) : (query.query ? String(query.query) : "");

                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                      c.relname AS table_name,
                      n.nspname AS table_schema,
                      'BASE TABLE' AS table_type,
                      c.reltuples::bigint AS row_estimate
                    FROM pg_class AS c
                    JOIN pg_namespace AS n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND c.relkind IN ('r', 'p')
                      AND c.relname ILIKE ${'%' + search + '%'}
                    ORDER BY c.relname
                `;

                return {
                    data: rows.slice(skip, skip + limit),
                    total: rows.length
                };
            } catch (error: unknown) {
                const { errorCode, errorMessage } = databaseErrorDetails(error);
                logger.error("[database] failed to list tables", {
                    projectRef: params.ref,
                    errorCode,
                    errorMessage,
                });
                set.status = 500;
                return {
                    message: "Failed to list tables",
                    code: "500",
                    status: 500,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            query: t.Object({
                skip: t.Optional(t.String()),
                limit: t.Optional(t.String()),
                _page: t.Optional(t.String()),
                _limit: t.Optional(t.String()),
                _sort: t.Optional(t.String()),
                _order: t.Optional(t.String()),
                query: t.Optional(t.String()),
                q: t.Optional(t.String()),
            }, { additionalProperties: true }),
            detail: { tags: ["projects"], summary: "List database tables" },
        }
    )
    .post(
        "/tables",
        async ({ params, body, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const createdTable = await createProjectTable(params.ref, body);
                if (!createdTable) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                set.status = 201;
                return createdTable;
            } catch (error: unknown) {
                const failure = createTableFailure(error, params.ref);
                set.status = failure.status;
                return failure;
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Object({
                schema: t.Optional(t.String({ minLength: 1 })),
                name: t.String({ minLength: 1 }),
                columns: t.Array(t.Object({
                    name: t.String({ minLength: 1 }),
                    type: t.Union(TABLE_COLUMN_TYPES.map((type) => t.Literal(type))),
                    nullable: t.Optional(t.Boolean()),
                    primaryKey: t.Optional(t.Boolean()),
                    identity: t.Optional(t.Boolean()),
                }), { minItems: 1, maxItems: 64 }),
            }),
            detail: { tags: ["projects"], summary: "Create a database table through the migration ledger" },
        },
    )
    .get(
        "/tables/:schema/:table/columns",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const regex = /^[a-zA-Z_0-9]+$/;
                if (!regex.test(params.schema) || !regex.test(params.table)) {
                     set.status = 400;
                     return { message: "Invalid schema or table name format", code: "400", status: 400 };
                }

                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_schema = ${params.schema} AND table_name = ${params.table}
                    ORDER BY ordinal_position
                `;

                return { data: rows };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    message: "Failed to list columns",
                    code: "500",
                    status: 500,
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
                schema: t.String({ minLength: 1 }),
                table: t.String({ minLength: 1 }),
            }),
            detail: { tags: ["projects"], summary: "List columns for a database table" },
        }
    )
    .get(
        "/tables/:schema/:table/rows",
        async ({ params, query, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const { limit, skip } = normalizePagination(query as Record<string, unknown>, 50, 500);

                const regex = /^[a-zA-Z_0-9]+$/;
                if (!regex.test(params.schema) || !regex.test(params.table)) {
                     set.status = 400;
                     return { message: "Invalid schema or table name format", code: "400", status: 400 };
                }

                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb.unsafe(`SELECT * FROM "${params.schema}"."${params.table}" LIMIT ${limit} OFFSET ${skip}`);
                const countResult = await projectDb.unsafe(`SELECT count(*) as count FROM "${params.schema}"."${params.table}"`);

                return {
                    data: rows || [],
                    total: parseInt(countResult?.[0]?.count || "0")
                };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    message: "Failed to fetch rows",
                    code: "500",
                    status: 500,
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
                schema: t.String({ minLength: 1 }),
                table: t.String({ minLength: 1 }),
            }),
            query: t.Object({
                skip: t.Optional(t.String()),
                limit: t.Optional(t.String()),
                _page: t.Optional(t.String()),
                _limit: t.Optional(t.String()),
                _sort: t.Optional(t.String()),
                _order: t.Optional(t.String()),
                q: t.Optional(t.String()),
            }, { additionalProperties: true }),
            detail: { tags: ["projects"], summary: "List rows in a database table" },
        }
    )
    .get(
        "/materialized-views",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            const projectDb = await getProjectSql(params.ref);
            if (!projectDb) {
                set.status = 404;
                return { message: "Project database credentials not found", code: "404", status: 404 };
            }

            const rows = await projectDb`
                SELECT
                    schemaname,
                    matviewname,
                    matviewowner,
                    tablespace,
                    hasindexes,
                    ispopulated,
                    definition,
                    pg_total_relation_size(format('%I.%I', schemaname, matviewname)::regclass)::bigint AS total_bytes
                FROM pg_matviews
                WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                ORDER BY schemaname, matviewname
            `;
            return rows;
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            detail: { tags: ["projects"], summary: "List materialized views" },
        }
    )
    .post(
        "/materialized-views",
        async ({ params, body, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            const projectDb = await getProjectSql(params.ref);
            if (!projectDb) {
                set.status = 404;
                return { message: "Project database credentials not found", code: "404", status: 404 };
            }

            try {
                const sql = buildCreateMaterializedViewSql(body);
                await projectDb.unsafe(sql);
                set.status = 201;
                return {
                    schema: body.schema || "public",
                    name: body.name,
                    refreshed: body.withData !== false,
                };
            } catch (error: unknown) {
                set.status = 400;
                return {
                    message: error instanceof Error ? error.message : String(error),
                    code: "400",
                    status: 400,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Object({
                schema: t.Optional(t.String()),
                name: t.String({ minLength: 1 }),
                definition: t.String({ minLength: 1 }),
                withData: t.Optional(t.Boolean()),
            }),
            detail: { tags: ["projects"], summary: "Create materialized view" },
        }
    )
    .post(
        "/materialized-views/:schema/:name/refresh",
        async ({ params, body, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            const projectDb = await getProjectSql(params.ref);
            if (!projectDb) {
                set.status = 404;
                return { message: "Project database credentials not found", code: "404", status: 404 };
            }

            try {
                await projectDb.unsafe(buildRefreshMaterializedViewSql({
                    schema: params.schema,
                    name: params.name,
                    concurrently: body.concurrently,
                }));
                return { schema: params.schema, name: params.name, refreshed: true };
            } catch (error: unknown) {
                set.status = 400;
                return {
                    message: error instanceof Error ? error.message : String(error),
                    code: "400",
                    status: 400,
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
                schema: t.String({ minLength: 1 }),
                name: t.String({ minLength: 1 }),
            }),
            body: t.Object({
                concurrently: t.Optional(t.Boolean()),
            }),
            detail: { tags: ["projects"], summary: "Refresh materialized view" },
        }
    )
    .delete(
        "/materialized-views/:schema/:name",
        async ({ params, query, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            const projectDb = await getProjectSql(params.ref);
            if (!projectDb) {
                set.status = 404;
                return { message: "Project database credentials not found", code: "404", status: 404 };
            }

            try {
                await projectDb.unsafe(buildDropMaterializedViewSql({
                    schema: params.schema,
                    name: params.name,
                    ifExists: query.if_exists === "true" || query.if_exists === "1",
                }));
                return { schema: params.schema, name: params.name, deleted: true };
            } catch (error: unknown) {
                set.status = 400;
                return {
                    message: error instanceof Error ? error.message : String(error),
                    code: "400",
                    status: 400,
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
                schema: t.String({ minLength: 1 }),
                name: t.String({ minLength: 1 }),
            }),
            query: t.Object({
                if_exists: t.Optional(t.String()),
            }),
            detail: { tags: ["projects"], summary: "Drop materialized view" },
        }
    )
    .post(
        "/query",
        async ({ params, body, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const credentials = await getProjectDatabaseCredentials(params.ref);
                if (!credentials) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const result = await db.executeQuery(credentials.db_name, body.query, {
                    mode: "read",
                    username: credentials.db_user,
                    password: credentials.db_password,
                });
                return sqlRouteResponse(result);
            } catch (error: unknown) {
                set.status = 400;
                const pgErr = error as Record<string, unknown>;
                return {
                    code: pgErr.code || "42601",
                    message: pgErr.message || "SQL execution failed",
                    details: pgErr.details || null,
                    hint: pgErr.hint || null,
                    status: 400,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Object({
                query: t.String(),
            }),
            detail: { tags: ["projects"], summary: "Execute a read-only SQL query" },
        }
    )
    .post(
        "/sql",
        async ({ params, body, set, request }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const sqlQuery = body.query || body.sql;
                if (!sqlQuery) {
                    set.status = 400;
                    return { message: "query or sql is required", code: "400", status: 400 };
                }
                const mode = resolveSqlMode(body as Record<string, unknown>);
                const authError = await requireProjectOrAdminAuth(request, params.ref);
                if (authError) return projectAuthResponse(authError, set);

                if (mode === "admin") {
                    if (!requireAdminMode(body as Record<string, unknown>)) {
                        set.status = 403;
                        return { message: "Admin SQL requires mode=admin and admin=true", code: "403", status: 403 };
                    }
                    const authError = await requireAdminAuth(request);
                    if (authError) {
                        set.status = authError.status;
                        return { message: authError.body.error, code: String(authError.status), status: authError.status };
                    }
                }
                const credentials = await getProjectDatabaseCredentials(params.ref);
                if (!credentials) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const useRoleConnection = mode !== "admin";
                const execute = async () => {
                  if (mode === "migration") {
                    await branchReplacementJournal.assertInactive([params.ref]);
                  }
                  return db.executeQuery(credentials.db_name, sqlQuery, {
                    mode,
                    ...(useRoleConnection ? { username: credentials.db_user, password: credentials.db_password } : {}),
                  });
                };
                const result = mode === "migration"
                  ? await withProjectMigrationLocks({ projectRefs: [params.ref] }, execute)
                  : await execute();
                return sqlRouteResponse(result);
            } catch (error: unknown) {
                if (error instanceof ProjectMigrationLockError) {
                    set.status = error.httpStatus;
                    return { message: error.message, code: error.code, status: error.httpStatus };
                }
                if (error instanceof BranchReplacementJournalActiveError) {
                    set.status = error.httpStatus;
                    return { message: error.message, code: error.code, status: error.httpStatus };
                }
                set.status = 400;
                const pgErr = error as Record<string, unknown>;
                return {
                    code: pgErr.code || "42601",
                    message: pgErr.message || "SQL execution failed",
                    details: pgErr.details || null,
                    hint: pgErr.hint || null,
                    status: 400,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Object({
                sql: t.Optional(t.String()),
                query: t.Optional(t.String()),
                mode: t.Optional(t.Union([t.Literal("read"), t.Literal("migration"), t.Literal("admin")])),
                admin: t.Optional(t.Boolean()),
            }),
            detail: { tags: ["projects"], summary: "Execute a SQL statement with mode control" },
        }
    )
    .post(
        "/migrations",
        async ({ params, body, request, set }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) {
                set.status = authError.status;
                return { message: authError.body.error, code: String(authError.status), status: authError.status };
            }

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const rawBody = body as Record<string, unknown>;
                const isCliFormat = typeof rawBody.query === "string";
                const isStructuredFormat = typeof rawBody.name === "string"
                    && (typeof rawBody.sql === "string" || Array.isArray(rawBody.statements));
                if (!isCliFormat && !isStructuredFormat) {
                    throw new MigrationRouteError(400, "invalid_migration_body", "Body must contain {query} or {name, sql/statements}");
                }

                const statements = resolveMigrationStatements(body as MigrationBody);
                if (statements.length === 0) {
                    throw new MigrationRouteError(400, "empty_migration", "Migration contains no executable statements");
                }
                const version = normalizeMigrationVersion(rawBody.version);
                const name = isCliFormat ? "cli_push" : normalizeMigrationName(rawBody.name, "cli_push");
                const credentials = await getProjectDatabaseCredentials(params.ref);
                if (!credentials) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const result = await applyRecordedMigration({
                    projectRef: params.ref,
                    credentials,
                    version,
                    name,
                    statements,
                    conflictOnName: isStructuredFormat,
                });
                if (result.alreadyApplied) {
                    set.status = 409;
                    return { message: "Migration already applied", code: "409", version, name, checksum: result.checksum };
                }
                return { version, ...(isStructuredFormat ? { name } : {}), statements, checksum: result.checksum };
            } catch (error: unknown) {
                if (error instanceof MigrationRouteError) {
                    set.status = error.httpStatus;
                    return { message: error.message, code: error.code, status: error.httpStatus };
                }
                if (error instanceof ProjectMigrationLockError) {
                    set.status = error.httpStatus;
                    return { message: error.message, code: error.code, status: error.httpStatus };
                }
                if (error instanceof BranchReplacementJournalActiveError) {
                    set.status = error.httpStatus;
                    return { message: error.message, code: error.code, status: error.httpStatus };
                }
                set.status = 500;
                const detail = error instanceof Error ? error.message : String(error);
                return {
                    message: "Migration failed",
                    detail,
                    code: "500",
                    status: 500,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            body: t.Record(t.String(), t.Unknown()),
            detail: { tags: ["projects"], summary: "Apply a database migration" },
        }
    )
    .get(
        "/migrations",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }

            try {
                const dbName = await resolveDbName(params.ref);
                const projectDb = getProjectDb(dbName);
                await ensureMigrationTables(dbName, projectDb);
                const rows = await readMigrationLedger(projectDb);
                return rows.map((row) => ({
                    version: row.version,
                    statements: row.statements,
                    statement_count: row.statements.length,
                    name: row.name,
                    checksum: row.checksum,
                    applied_at: row.applied_at,
                }));
            } catch (error: unknown) {
                if (error instanceof MigrationLedgerDivergenceError) {
                    set.status = 409;
                    return { message: error.message, code: error.code, status: 409 };
                }
                set.status = 503;
                return {
                    message: "Migration ledger is temporarily unavailable; retry without assuming it is empty",
                    code: "migration_ledger_unavailable",
                    status: 503,
                };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            detail: { tags: ["projects"], summary: "List applied database migrations" },
        }
    )
    .get(
        "/constraints",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        c.oid as id,
                        con.conname as name,
                        con.contype as type,
                        nsp.nspname as schema,
                        rel.relname as table_name,
                        con.conkey as column_indices,
                        fnsp.nspname as foreign_table_schema,
                        frel.relname as foreign_table_name,
                        con.confkey as foreign_column_indices
                    FROM pg_constraint con
                    JOIN pg_class rel ON rel.oid = con.conrelid
                    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
                    LEFT JOIN pg_class frel ON frel.oid = con.confrelid
                    LEFT JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
                    WHERE nsp.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                    ORDER BY nsp.nspname, rel.relname, con.conname
                `;
                return rows.map((r: Record<string, unknown>) => ({
                    id: r.id,
                    name: r.name,
                    type: r.type,
                    schema: r.schema,
                    table_name: r.table_name,
                    column_indices: r.column_indices,
                    foreign_table_schema: r.foreign_table_schema,
                    foreign_table_name: r.foreign_table_name,
                    foreign_column_indices: r.foreign_column_indices,
                }));
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database constraints" } }
    )
    .get(
        "/functions",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        p.oid as id,
                        p.proname as name,
                        n.nspname as schema,
                        pg_get_functiondef(p.oid) as definition,
                        l.lanname as language,
                        pg_get_function_result(p.oid) as return_type,
                        p.provolatile as volatility,
                        p.proisstrict as is_strict,
                        p.prosecdef as security_definer
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    JOIN pg_language l ON l.oid = p.prolang
                    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY n.nspname, p.proname
                `;
                return rows.map((r: Record<string, unknown>) => ({
                    id: r.id,
                    name: r.name,
                    schema: r.schema,
                    definition: r.definition,
                    language: r.language,
                    return_type: r.return_type,
                    volatility: r.volatility,
                    is_strict: r.is_strict,
                    security_definer: r.security_definer,
                }));
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database functions" } }
    )
    .get(
        "/triggers",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        t.oid as id,
                        t.tgname as name,
                        n.nspname as schema,
                        c.relname as table_name,
                        p.proname as function_name,
                        CASE t.tgtype
                            WHEN 1 THEN 'BEFORE'
                            WHEN 2 THEN 'AFTER'
                            WHEN 3 THEN 'INSTEAD OF'
                        END as timing,
                        CASE
                            WHEN t.tgtype & 4 = 4 THEN 'INSERT'
                            WHEN t.tgtype & 8 = 8 THEN 'DELETE'
                            WHEN t.tgtype & 16 = 16 THEN 'UPDATE'
                            WHEN t.tgtype & 32 = 32 THEN 'TRUNCATE'
                            ELSE 'UNKNOWN'
                        END as event,
                        t.tgenabled as enabled
                    FROM pg_trigger t
                    JOIN pg_class c ON c.oid = t.tgrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE NOT t.tgisinternal
                    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY n.nspname, c.relname, t.tgname
                `;
                return rows.map((r: Record<string, unknown>) => ({
                    id: r.id,
                    name: r.name,
                    schema: r.schema,
                    table_name: r.table_name,
                    function_name: r.function_name,
                    timing: r.timing,
                    event: r.event,
                    enabled: r.enabled === 'O' || r.enabled === 'D',
                }));
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database triggers" } }
    )
    .get(
        "/publications",
        async ({ params, set, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return projectAuthResponse(authError, set);

            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { message: "Project not found", code: "404", status: 404 };
            }
            try {
                const projectDb = await getProjectSql(params.ref);
                if (!projectDb) {
                    set.status = 404;
                    return { message: "Project database credentials not found", code: "404", status: 404 };
                }
                const rows = await projectDb`
                    SELECT
                        p.oid as id,
                        p.pubname as name,
                        p.pubinsert as publish_insert,
                        p.pubupdate as publish_update,
                        p.pubdelete as publish_delete,
                        p.pubtruncate as publish_truncate,
                        p.puballtables as all_tables
                    FROM pg_publication p
                    ORDER BY p.pubname
                `;
                const result = [];
                for (const row of rows) {
                    const r = row as Record<string, unknown>;
                    let tables: Array<Record<string, unknown>> = [];
                    try {
                        tables = await projectDb`
                            SELECT schemaname as schema, tablename as name
                            FROM pg_publication_tables
                            WHERE pubname = ${r.name as string}
                        ` as Array<Record<string, unknown>>;
                    } catch {}
                    result.push({
                        id: r.id,
                        name: r.name,
                        publish_insert: r.publish_insert,
                        publish_update: r.publish_update,
                        publish_delete: r.publish_delete,
                        publish_truncate: r.publish_truncate,
                        all_tables: r.all_tables,
                        tables: tables.map((t: Record<string, unknown>) => ({ schema: t.schema, name: t.name })),
                    });
                }
                return result;
            } catch {
                return [];
            }
        },
        { params: t.Object({ ref: t.String({ minLength: 1 }) }), detail: { tags: ["projects"], summary: "List database publications" } }
    );
