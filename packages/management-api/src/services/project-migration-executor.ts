import { getProjectDb, getProjectRoleDb, removeProjectDbCache } from "../db";
import { splitSqlStatements, stripOuterTransactionStatements } from "../db/sql-statements";
import { calculateMigrationChecksum, detectUnsupportedMigrationOperations } from "./migration-promotion";
import { ensureMigrationLedgerMetadata, reconcileMigrationLedgerVersions } from "./migration-ledger";
import { prepareProjectMigrationRole } from "./project-migration-role";
import { issueMigrationLedgerLease, releaseMigrationLedgerLease } from "./migration-ledger-lease";
import { withProjectMigrationLocks } from "./migration-lock";
import { branchReplacementJournal } from "./branch-replacement-journal";
import { notifyPostgrestSchemaReload } from "./database-schema-notify";
import { logger } from "../utils/logger";

type ProjectSql = ReturnType<typeof getProjectDb>;
type ReservedProjectSql = Awaited<ReturnType<ProjectSql["reserve"]>>;

export class MigrationRouteError extends Error {
  constructor(readonly httpStatus: 400 | 409 | 423, readonly code: string, message: string) {
    super(message);
    this.name = "MigrationRouteError";
  }
}

export interface ProjectMigrationCredentials {
  db_name: string;
  db_user: string;
  db_password: string;
}

export interface RecordedMigrationInput {
  projectRef: string;
  credentials: ProjectMigrationCredentials;
  version: string;
  name: string;
  statements: readonly string[];
  conflictOnName: boolean;
}

export interface MigrationExecutionDerivation {
  statements: string[];
  strippedTransactionWrappers: number;
}

export function deriveMigrationExecution(statements: readonly string[]): MigrationExecutionDerivation {
  const normalized = statements.flatMap(statement => splitSqlStatements(statement));
  const executionStatements = stripOuterTransactionStatements(normalized);
  if (executionStatements.length === 0) {
    throw new MigrationRouteError(400, "empty_migration", "Migration contains no executable statements");
  }
  return {
    statements: executionStatements,
    strippedTransactionWrappers: normalized.length - executionStatements.length,
  };
}

const ensuredMigrationTables = new Set<string>();
export const MIGRATION_SESSION_RESET_SQL = "RESET ALL; DISCARD TEMP; DISCARD PLANS";

export function resetEnsuredMigrationTablesForTests(): void {
  ensuredMigrationTables.clear();
}

export async function ensureMigrationTables(dbName: string, projectDb: ProjectSql): Promise<void> {
  if (!ensuredMigrationTables.has(dbName)) {
    await ensureMigrationLedgerMetadata(projectDb);
    ensuredMigrationTables.add(dbName);
    return;
  }
  await reconcileMigrationLedgerVersions(projectDb);
}

export async function ensureTasksRealtimePublication(projectDb: ProjectSql): Promise<void> {
  try {
    await projectDb`SELECT realtime.ensure_tasks_publication()`;
  } catch {
    // 历史租户和未启用逻辑 Realtime 的项目仍以迁移事务为事实源。
  }
}

function existingMigrationChecksum(
  row: Record<string, unknown>, fallback: { version: string; name: string },
): string {
  if (typeof row["checksum"] === "string") return row["checksum"];
  return calculateMigrationChecksum({
    version: String(row["version"] ?? fallback.version),
    name: typeof row["name"] === "string" ? row["name"] : fallback.name,
    statements: Array.isArray(row["statements"])
      ? row["statements"].filter((statement: unknown): statement is string => typeof statement === "string") : [],
  });
}

function normalizedMigrationStatements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((statement): statement is string => typeof statement === "string")
    .map(statement => statement.replace(/\r\n?/g, "\n").trim()).filter(Boolean);
}

/** 保持历史 raw SHA ledger 的精确 SQL 比较，不能将内容不同的迁移视为已执行。 */
export function migrationLedgerEntryMatches(
  row: Record<string, unknown>,
  input: Pick<RecordedMigrationInput, "version" | "name" | "statements">,
): boolean {
  return String(row["version"] ?? "").trim() === input.version
    && (typeof row["name"] === "string" ? row["name"].trim() : "") === input.name
    && JSON.stringify(normalizedMigrationStatements(row["statements"]))
      === JSON.stringify(normalizedMigrationStatements(input.statements));
}

async function resetMigrationSession(connection: ReservedProjectSql, dbName: string): Promise<boolean> {
  try {
    await connection.unsafe(MIGRATION_SESSION_RESET_SQL);
    return true;
  } catch (error: unknown) {
    logger.warn(`[database] failed to reset migration session for ${dbName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function withMigrationRoleSession<T>(
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

async function executeMigrationTransaction(
  connection: ReservedProjectSql,
  adminDb: ProjectSql,
  input: RecordedMigrationInput,
  execution: { checksum: string; statements: readonly string[] },
): Promise<boolean> {
  const leaseHolder: { current?: Awaited<ReturnType<typeof issueMigrationLedgerLease>> } = {};
  try {
    return await connection.begin(async tx => {
      const existing = input.conflictOnName
        ? await tx<Record<string, unknown>[]>`
            SELECT version, statements, name, checksum FROM supabase_migrations.schema_migrations
            WHERE version::text = ${input.version} OR name = ${input.name}
          `
        : await tx<Record<string, unknown>[]>`
            SELECT version, statements, name, checksum FROM supabase_migrations.schema_migrations
            WHERE version::text = ${input.version}
          `;
      if (existing.length > 0) {
        const alreadyApplied = existing.some(row => migrationLedgerEntryMatches(row, input));
        if (!alreadyApplied && existingMigrationChecksum(existing[0]!, input) !== execution.checksum) {
          throw new MigrationRouteError(
            409, "migration_checksum_conflict",
            `Migration ${input.name} conflicts with an existing version, name, or checksum`,
          );
        }
        await notifyPostgrestSchemaReload(tx, input.projectRef);
        return true;
      }
      const unsupported = detectUnsupportedMigrationOperations(execution.statements);
      if (unsupported.length > 0) {
        throw new MigrationRouteError(
          400, "unsupported_migration_sql",
          `Migration contains SQL outside the project-scoped path: ${unsupported.join(", ")}`,
        );
      }
      for (const statement of execution.statements) await tx.unsafe(statement);
      const issuedLease = await issueMigrationLedgerLease(adminDb, input.version, execution.checksum);
      leaseHolder.current = issuedLease;
      const statementArray = tx.array([...input.statements], "TEXT");
      await tx`
        SELECT supabase_migrations.record_schema_migration(
          ${input.version}, ${statementArray}, ${input.name}, ${execution.checksum}, ${issuedLease.token}
        )
      `;
      await notifyPostgrestSchemaReload(tx, input.projectRef);
      return false;
    });
  } finally {
    const lease = leaseHolder.current;
    if (lease) {
      try { await releaseMigrationLedgerLease(adminDb, lease.tokenHash); }
      catch (error: unknown) {
        logger.warn(`[database] failed to clean migration ledger lease for ${input.projectRef}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** 路由与发布编排共用项目角色事务；SQL 与 ledger 写入在同一事务内提交。 */
export async function applyRecordedMigration(input: RecordedMigrationInput): Promise<{
  checksum: string;
  alreadyApplied: boolean;
  strippedTransactionWrappers: number;
}> {
  const checksum = calculateMigrationChecksum(input);
  const execution = deriveMigrationExecution(input.statements);
  return withProjectMigrationLocks({ projectRefs: [input.projectRef] }, async () => {
    await branchReplacementJournal.assertInactive([input.projectRef]);
    return withMigrationRoleSession(input, async (connection, adminDb) => {
      const alreadyApplied = await executeMigrationTransaction(
        connection, adminDb, input, { checksum, statements: execution.statements },
      );
      await ensureTasksRealtimePublication(adminDb);
      return { checksum, alreadyApplied, strippedTransactionWrappers: execution.strippedTransactionWrappers };
    });
  });
}
