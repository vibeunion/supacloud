import { createHash } from "node:crypto";
import { projectMigrationSqlViolations } from "../db/sql-policy";

export interface MigrationLedgerEntryInput {
  version: string | number | bigint;
  name?: string | null;
  statements: readonly string[];
  checksum?: string | null;
  appliedAt?: string | null;
}

export interface MigrationLedgerEntry {
  version: string;
  name: string | null;
  statements: string[];
  checksum: string;
  stored_checksum: string | null;
  applied_at: string | null;
}

export interface MigrationPromotionSummary {
  version: string;
  name: string | null;
  checksum: string;
  statement_count: number;
  statements: string[];
  destructive: boolean;
}

export type MigrationPromotionBlockCode =
  | "parent_ahead"
  | "checksum_mismatch"
  | "stored_checksum_mismatch"
  | "name_conflict"
  | "out_of_order_migration"
  | "empty_migration"
  | "non_transactional_sql"
  | "unsupported_sql";

export interface MigrationPromotionBlock {
  code: MigrationPromotionBlockCode;
  version: string;
  name: string | null;
  message: string;
}

export interface BranchMigrationPromotionPlan {
  mode: "migrations";
  parent_ref: string;
  branch_ref: string;
  safe_to_apply: boolean;
  plan_checksum: string;
  pending: MigrationPromotionSummary[];
  applied: MigrationPromotionSummary[];
  blocked: MigrationPromotionBlock[];
  warnings: string[];
  requires_destructive_confirmation: boolean;
  ignored_branch_data: true;
}

interface BuildPromotionPlanInput {
  parentRef: string;
  branchRef: string;
  parent: readonly MigrationLedgerEntry[];
  branch: readonly MigrationLedgerEntry[];
}

const GENERIC_MIGRATION_NAMES = new Set(["cli_push"]);

const NON_TRANSACTIONAL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "CREATE INDEX CONCURRENTLY", pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i },
  { label: "DROP INDEX CONCURRENTLY", pattern: /\bDROP\s+INDEX\s+CONCURRENTLY\b/i },
  { label: "REINDEX CONCURRENTLY", pattern: /\bREINDEX\b[\s\S]*?\bCONCURRENTLY\b/i },
  { label: "VACUUM", pattern: /\bVACUUM\b/i },
  { label: "CREATE DATABASE", pattern: /\bCREATE\s+DATABASE\b/i },
  { label: "DROP DATABASE", pattern: /\bDROP\s+DATABASE\b/i },
  { label: "CREATE TABLESPACE", pattern: /\bCREATE\s+TABLESPACE\b/i },
  { label: "DROP TABLESPACE", pattern: /\bDROP\s+TABLESPACE\b/i },
  { label: "CREATE SUBSCRIPTION", pattern: /\bCREATE\s+SUBSCRIPTION\b/i },
  { label: "DROP SUBSCRIPTION", pattern: /\bDROP\s+SUBSCRIPTION\b/i },
  { label: "ALTER SYSTEM", pattern: /\bALTER\s+SYSTEM\b/i },
];

const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "DO block (manual review required)", pattern: /\bDO\b/i },
  { label: "CREATE FUNCTION or PROCEDURE (manual review required)", pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i },
  { label: "CALL (manual review required)", pattern: /\bCALL\b/i },
  { label: "DROP object", pattern: /\bDROP\b/i },
  { label: "DROP COLUMN", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i },
  { label: "DROP CONSTRAINT", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+CONSTRAINT\b/i },
  { label: "DISABLE ROW LEVEL SECURITY", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i },
  { label: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { label: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/i },
];

function normalizeStatement(statement: string): string {
  return statement.replace(/\r\n?/g, "\n").trim();
}

function hashJson(serializable: unknown): string {
  return createHash("sha256").update(JSON.stringify(serializable)).digest("hex");
}

export function calculateMigrationChecksum(input: {
  version: string | number | bigint;
  name?: string | null;
  statements: readonly string[];
}): string {
  return hashJson({
    version: String(input.version).trim(),
    name: input.name?.trim() || null,
    statements: input.statements.map(normalizeStatement),
  });
}

export function createMigrationLedgerEntry(input: MigrationLedgerEntryInput): MigrationLedgerEntry {
  const version = String(input.version).trim();
  if (!version) throw new Error("Migration version is required");
  const name = input.name?.trim() || null;
  const statements = input.statements
    .filter((statement): statement is string => typeof statement === "string")
    .map(normalizeStatement)
    .filter(Boolean);
  return {
    version,
    name,
    statements,
    checksum: calculateMigrationChecksum({ version, name, statements }),
    stored_checksum: input.checksum?.trim() || null,
    applied_at: input.appliedAt?.trim() || null,
  };
}

function lineCommentEnd(sql: string, start: number): number {
  const end = sql.indexOf("\n", start + 2);
  return end === -1 ? sql.length : end;
}

function blockCommentEnd(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length && depth > 0) {
    if (sql.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

function quotedValueEnd(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
    } else if (sql[index + 1] === quote) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return index;
}

function dollarQuotedValueEnd(sql: string, start: number): number | null {
  const tag = sql.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
  if (!tag) return null;
  const end = sql.indexOf(tag, start + tag.length);
  return end === -1 ? sql.length : end + tag.length;
}

function maskSqlNoise(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    let maskedEnd: number | null = null;
    if (sql.startsWith("--", index)) maskedEnd = lineCommentEnd(sql, index);
    else if (sql.startsWith("/*", index)) maskedEnd = blockCommentEnd(sql, index);
    else if (sql[index] === "'" || sql[index] === '"') maskedEnd = quotedValueEnd(sql, index, sql[index]!);
    else if (sql[index] === "$") maskedEnd = dollarQuotedValueEnd(sql, index);

    if (maskedEnd !== null) {
      output += " ".repeat(maskedEnd - index);
      index = maskedEnd;
    } else {
      output += sql[index];
      index += 1;
    }
  }
  return output;
}

function matchingOperations(
  statements: readonly string[],
  patterns: ReadonlyArray<{ label: string; pattern: RegExp }>,
): string[] {
  const normalizedSql = statements.map(maskSqlNoise).join("\n");
  return patterns.filter(({ pattern }) => pattern.test(normalizedSql)).map(({ label }) => label);
}

export function detectNonTransactionalMigrationOperations(statements: readonly string[]): string[] {
  return matchingOperations(statements, NON_TRANSACTIONAL_PATTERNS);
}

export function detectDestructiveMigrationOperations(statements: readonly string[]): string[] {
  return matchingOperations(statements, DESTRUCTIVE_PATTERNS);
}

export function detectUnsupportedMigrationOperations(statements: readonly string[]): string[] {
  return projectMigrationSqlViolations(statements);
}

export function projectMigrationLockKey(projectRef: string): string {
  return `supacloud:migrations:${projectRef}`;
}

function compareVersions(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  return left.localeCompare(right);
}

function meaningfulMigrationName(name: string | null): string | null {
  if (!name || GENERIC_MIGRATION_NAMES.has(name)) return null;
  return name;
}

export function summarizeMigrationLedgerEntry(entry: MigrationLedgerEntry): MigrationPromotionSummary {
  return {
    version: entry.version,
    name: entry.name,
    checksum: entry.checksum,
    statement_count: entry.statements.length,
    statements: [...entry.statements],
    destructive: detectDestructiveMigrationOperations(entry.statements).length > 0,
  };
}

function storedChecksumBlock(entry: MigrationLedgerEntry): MigrationPromotionBlock | null {
  if (!entry.stored_checksum || entry.stored_checksum === entry.checksum) return null;
  return {
    code: "stored_checksum_mismatch",
    version: entry.version,
    name: entry.name,
    message: `Stored checksum differs from the migration SQL for version ${entry.version}`,
  };
}

function parentComparisonBlock(
  entry: MigrationLedgerEntry,
  branchEntry: MigrationLedgerEntry | undefined,
): MigrationPromotionBlock | null {
  if (!branchEntry) {
    return {
      code: "parent_ahead",
      version: entry.version,
      name: entry.name,
      message: `Parent migration ${entry.version} is missing from the branch; rebase or recreate the preview branch`,
    };
  }
  if (branchEntry.checksum === entry.checksum) return null;
  return {
    code: "checksum_mismatch",
    version: entry.version,
    name: branchEntry.name,
    message: `Migration ${entry.version} has different SQL in the parent and branch ledgers`,
  };
}

function inspectParentLedger(
  parent: readonly MigrationLedgerEntry[],
  branchByVersion: ReadonlyMap<string, MigrationLedgerEntry>,
): { parentNames: Map<string, MigrationLedgerEntry>; blocked: MigrationPromotionBlock[] } {
  const parentNames = new Map<string, MigrationLedgerEntry>();
  const blocked: MigrationPromotionBlock[] = [];
  for (const entry of parent) {
    const meaningfulName = meaningfulMigrationName(entry.name);
    if (meaningfulName) parentNames.set(meaningfulName, entry);
    const checksumBlock = storedChecksumBlock(entry);
    if (checksumBlock) blocked.push(checksumBlock);
    const comparisonBlock = parentComparisonBlock(entry, branchByVersion.get(entry.version));
    if (comparisonBlock) blocked.push(comparisonBlock);
  }
  return { parentNames, blocked };
}

function operationBlock(
  entry: MigrationLedgerEntry,
  code: "non_transactional_sql" | "unsupported_sql",
  operations: readonly string[],
  description: string,
): MigrationPromotionBlock | null {
  if (operations.length === 0) return null;
  return {
    code,
    version: entry.version,
    name: entry.name,
    message: `Migration ${entry.version} ${description}: ${operations.join(", ")}`,
  };
}

function pendingEntryBlocks(
  entry: MigrationLedgerEntry,
  parentNames: ReadonlyMap<string, MigrationLedgerEntry>,
  latestParent: MigrationLedgerEntry | undefined,
): MigrationPromotionBlock[] {
  const blocked: MigrationPromotionBlock[] = [];
  if (entry.statements.length === 0) {
    blocked.push({
      code: "empty_migration",
      version: entry.version,
      name: entry.name,
      message: `Migration ${entry.version} has no executable statements`,
    });
  }
  const meaningfulName = meaningfulMigrationName(entry.name);
  const nameMatch = meaningfulName ? parentNames.get(meaningfulName) : undefined;
  if (nameMatch) {
    blocked.push({
      code: "name_conflict",
      version: entry.version,
      name: entry.name,
      message: `Migration name ${meaningfulName} already exists in the parent at version ${nameMatch.version}`,
    });
  }
  if (latestParent && compareVersions(entry.version, latestParent.version) <= 0) {
    blocked.push({
      code: "out_of_order_migration",
      version: entry.version,
      name: entry.name,
      message: `Migration ${entry.version} sorts at or before the latest parent migration ${latestParent.version}`,
    });
  }
  const transactionBlock = operationBlock(
    entry,
    "non_transactional_sql",
    detectNonTransactionalMigrationOperations(entry.statements),
    "requires a non-transactional maintenance path",
  );
  const unsupportedBlock = operationBlock(
    entry,
    "unsupported_sql",
    detectUnsupportedMigrationOperations(entry.statements),
    "contains SQL outside the project-scoped migration path",
  );
  if (transactionBlock) blocked.push(transactionBlock);
  if (unsupportedBlock) blocked.push(unsupportedBlock);
  return blocked;
}

function classifyBranchLedger(
  branch: readonly MigrationLedgerEntry[],
  parentByVersion: ReadonlyMap<string, MigrationLedgerEntry>,
  parentNames: ReadonlyMap<string, MigrationLedgerEntry>,
  latestParent: MigrationLedgerEntry | undefined,
): { pending: MigrationPromotionSummary[]; applied: MigrationPromotionSummary[]; blocked: MigrationPromotionBlock[] } {
  const pending: MigrationPromotionSummary[] = [];
  const applied: MigrationPromotionSummary[] = [];
  const blocked: MigrationPromotionBlock[] = [];

  for (const entry of branch) {
    const checksumBlock = storedChecksumBlock(entry);
    if (checksumBlock) blocked.push(checksumBlock);

    const parentEntry = parentByVersion.get(entry.version);
    if (parentEntry) {
      if (parentEntry.checksum === entry.checksum) applied.push(summarizeMigrationLedgerEntry(entry));
      continue;
    }
    const entryBlocks = pendingEntryBlocks(entry, parentNames, latestParent);
    if (entryBlocks.length > 0 || checksumBlock) {
      blocked.push(...entryBlocks);
      continue;
    }
    pending.push(summarizeMigrationLedgerEntry(entry));
  }
  return { pending, applied, blocked };
}

function promotionWarnings(requiresDestructiveConfirmation: boolean): string[] {
  const warnings = [
    "Only migrations recorded in supabase_migrations.schema_migrations are promoted.",
    "The promotion pipeline does not automatically copy branch rows, Auth users, Storage metadata, or untracked schema changes.",
    "Migration SQL runs with the parent project's scoped database role; review the SQL because it can still modify parent data.",
  ];
  if (requiresDestructiveConfirmation) {
    warnings.push("One or more pending migrations contain destructive SQL and require explicit confirmation.");
  }
  return warnings;
}

function promotionPlanChecksum(
  input: BuildPromotionPlanInput,
  parent: readonly MigrationLedgerEntry[],
  branch: readonly MigrationLedgerEntry[],
): string {
  return hashJson({
    mode: "migrations",
    parent_ref: input.parentRef,
    branch_ref: input.branchRef,
    parent: parent.map(({ version, name, checksum }) => ({ version, name, checksum })),
    branch: branch.map(({ version, name, checksum }) => ({ version, name, checksum })),
  });
}

export function buildBranchMigrationPromotionPlan(input: BuildPromotionPlanInput): BranchMigrationPromotionPlan {
  const parent = [...input.parent].sort((left, right) => compareVersions(left.version, right.version));
  const branch = [...input.branch].sort((left, right) => compareVersions(left.version, right.version));
  const parentByVersion = new Map(parent.map((entry) => [entry.version, entry]));
  const branchByVersion = new Map(branch.map((entry) => [entry.version, entry]));
  const parentState = inspectParentLedger(parent, branchByVersion);
  const branchState = classifyBranchLedger(branch, parentByVersion, parentState.parentNames, parent.at(-1));
  const blocked = [...parentState.blocked, ...branchState.blocked];
  const requiresDestructiveConfirmation = branchState.pending.some((entry) => entry.destructive);

  return {
    mode: "migrations",
    parent_ref: input.parentRef,
    branch_ref: input.branchRef,
    safe_to_apply: blocked.length === 0,
    plan_checksum: promotionPlanChecksum(input, parent, branch),
    pending: branchState.pending,
    applied: branchState.applied,
    blocked,
    warnings: promotionWarnings(requiresDestructiveConfirmation),
    requires_destructive_confirmation: requiresDestructiveConfirmation,
    ignored_branch_data: true,
  };
}
