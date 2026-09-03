/**
 * Migration Risk Analysis Engine
 *
 * Statically analyzes SQL migrations for Expand-Contract violations, destructive DDL,
 * and lock-heavy operations (e.g. non-concurrent index creation, non-null additions without default).
 */

export type MigrationRiskLevel = "HIGH" | "MEDIUM" | "LOW";

export interface MigrationRiskItem {
    level: MigrationRiskLevel;
    type: string;
    description: string;
    recommendation: string;
    statementSnippet?: string;
    blocksTransactionalPush?: true;
}

export interface MigrationFileRisk {
    file: string;
    overallRisk: MigrationRiskLevel;
    risks: MigrationRiskItem[];
}

export interface MigrationRiskAnalysis {
    overallRisk: MigrationRiskLevel;
    highRiskCount: number;
    mediumRiskCount: number;
    lowRiskCount: number;
    transactionalPushBlockerCount: number;
    files: MigrationFileRisk[];
}

function startsEscapeString(sql: string, quoteIndex: number): boolean {
    const prefixIndex = quoteIndex - 1;
    const prefix = sql[prefixIndex] || "";
    const preceding = sql[prefixIndex - 1] || "";
    return /[eE]/.test(prefix) && !/[A-Za-z0-9_$]/.test(preceding);
}

function dollarQuoteTagAt(sql: string, index: number): string {
    const previous = sql[index - 1] || "";
    if (/[A-Za-z0-9_$]/.test(previous)) return "";
    return sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0] || "";
}

function maskSingleQuotedString(sql: string, start: number): { masked: string; end: number } {
    const usesBackslashEscapes = startsEscapeString(sql, start);
    let end = start + 1;
    while (end < sql.length) {
        if (usesBackslashEscapes && sql[end] === "\\" && sql[end + 1]) {
            end += 2;
        } else if (sql[end] === "'" && sql[end + 1] === "'") {
            end += 2;
        } else if (sql[end] === "'") {
            end += 1;
            return { masked: " ".repeat(end - start), end };
        } else {
            end += 1;
        }
    }
    throw new Error("Unterminated SQL single-quoted string");
}

function maskDoubleQuotedIdentifier(sql: string, start: number): { masked: string; end: number } {
    let end = start + 1;
    while (end < sql.length) {
        if (sql[end] === '"' && sql[end + 1] === '"') {
            end += 2;
        } else if (sql[end] === '"') {
            end += 1;
            return { masked: `"${"_".repeat(Math.max(0, end - start - 2))}"`, end };
        } else {
            end += 1;
        }
    }
    throw new Error("Unterminated SQL double-quoted identifier");
}

function preserveDoubleQuotedIdentifier(sql: string, start: number): { masked: string; end: number } {
    const identifier = maskDoubleQuotedIdentifier(sql, start);
    return { masked: sql.slice(start, identifier.end), end: identifier.end };
}

function lineCommentEnd(sql: string, start: number): number {
    const end = sql.indexOf("\n", start + 2);
    return end === -1 ? sql.length : end;
}

function blockCommentEnd(sql: string, start: number): number {
    let depth = 1;
    let cursor = start + 2;
    while (cursor < sql.length && depth > 0) {
        if (sql.startsWith("/*", cursor)) {
            depth++;
            cursor += 2;
        } else if (sql.startsWith("*/", cursor)) {
            depth--;
            cursor += 2;
        } else {
            cursor++;
        }
    }
    if (depth > 0) throw new Error("Unterminated SQL block comment");
    return cursor;
}

function maskDollarQuotedString(sql: string, start: number): { masked: string; end: number } | null {
    const tag = dollarQuoteTagAt(sql, start);
    if (!tag) return null;
    const closingTag = sql.indexOf(tag, start + tag.length);
    if (closingTag === -1) throw new Error("Unterminated SQL dollar-quoted body");
    const end = closingTag + tag.length;
    return { masked: " ".repeat(end - start), end };
}

function maskSqlSpan(
    sql: string,
    start: number,
    quotedIdentifier: typeof maskDoubleQuotedIdentifier,
): { masked: string; end: number } | null {
    if (sql.startsWith("--", start)) {
        const end = lineCommentEnd(sql, start);
        return { masked: " ".repeat(end - start), end };
    }
    if (sql.startsWith("/*", start)) {
        const end = blockCommentEnd(sql, start);
        return { masked: " ".repeat(end - start), end };
    }
    if (sql[start] === "'") return maskSingleQuotedString(sql, start);
    if (sql[start] === '"') return quotedIdentifier(sql, start);
    if (sql[start] === "$") return maskDollarQuotedString(sql, start);
    return null;
}

function maskSql(
    sql: string,
    quotedIdentifier: typeof maskDoubleQuotedIdentifier,
): string {
    let masked = "";
    let cursor = 0;
    while (cursor < sql.length) {
        const protectedSpan = maskSqlSpan(sql, cursor, quotedIdentifier);
        if (protectedSpan) {
            masked += protectedSpan.masked;
            cursor = protectedSpan.end;
        } else {
            masked += sql[cursor];
            cursor++;
        }
    }
    return masked;
}

export function maskSqlNoise(sql: string): string {
    return maskSql(sql, maskDoubleQuotedIdentifier);
}

function maskSqlPolicyNoise(sql: string): string {
    return maskSql(sql, preserveDoubleQuotedIdentifier);
}

export function splitSqlStatements(sql: string): string[] {
    const masked = maskSqlNoise(sql);
    const statements: string[] = [];
    let lastIndex = 0;
    let cursor = 0;

    while (cursor < masked.length) {
        if (masked[cursor] === ";") {
            const rawStatement = sql.slice(lastIndex, cursor).trim();
            if (rawStatement.length > 0) {
                statements.push(rawStatement);
            }
            lastIndex = cursor + 1;
        }
        cursor++;
    }

    const trailing = sql.slice(lastIndex).trim();
    if (trailing.length > 0) {
        statements.push(trailing);
    }

    return statements;
}

function normalizedTransactionStatement(statement: string): string {
    return maskSqlNoise(statement).replace(/\s+/g, " ").trim();
}

function migrationExecutionStatements(statements: readonly string[]): string[] {
    if (statements.length < 2) return [...statements];
    const first = normalizedTransactionStatement(statements[0]);
    const last = normalizedTransactionStatement(statements[statements.length - 1]);
    const hasOuterTransaction = /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION)$/i.test(first)
        && /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i.test(last);
    return hasOuterTransaction ? statements.slice(1, -1) : [...statements];
}

function skipSqlTrivia(sql: string, start: number): number {
    let cursor = start;
    for (;;) {
        while (cursor < sql.length && /\s/.test(sql[cursor])) cursor++;
        if (sql.startsWith("--", cursor)) {
            cursor = lineCommentEnd(sql, cursor);
            continue;
        }
        if (sql.startsWith("/*", cursor)) {
            cursor = blockCommentEnd(sql, cursor);
            continue;
        }
        return cursor;
    }
}

/**
 * Extract the source body of a top-level `DO [LANGUAGE lang] body` statement
 * whose DO keyword ends at `keywordEnd`. Returns null when the statement does
 * not carry a recognizable dollar-quoted or single-quoted body.
 */
function doStatementBody(sql: string, keywordEnd: number): string | null {
    let cursor = skipSqlTrivia(sql, keywordEnd);
    if (/^LANGUAGE\b/i.test(sql.slice(cursor))) {
        cursor += "LANGUAGE".length;
        cursor = skipSqlTrivia(sql, cursor);
        if (sql[cursor] === "'") cursor = maskSingleQuotedString(sql, cursor).end;
        else if (sql[cursor] === '"') cursor = maskDoubleQuotedIdentifier(sql, cursor).end;
        else {
            const languageName = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(cursor));
            if (!languageName) return null;
            cursor += languageName[0].length;
        }
        cursor = skipSqlTrivia(sql, cursor);
    }
    if (sql[cursor] === "'") {
        const end = maskSingleQuotedString(sql, cursor).end;
        return sql.slice(cursor + 1, Math.max(cursor + 1, end - 1));
    }
    const tag = sql[cursor] === "$" ? dollarQuoteTagAt(sql, cursor) : "";
    if (!tag) return null;
    const bodyEnd = sql.indexOf(tag, cursor + tag.length);
    return bodyEnd === -1 ? null : sql.slice(cursor + tag.length, bodyEnd);
}

function topLevelDoBodies(sql: string): string[] {
    const masked = maskSqlPolicyNoise(sql);
    const doKeywordPattern = /(?:^|;)\s*DO\b/gi;
    const bodies: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = doKeywordPattern.exec(masked)) !== null) {
        const body = doStatementBody(sql, doKeywordPattern.lastIndex);
        if (body !== null) bodies.push(body);
    }
    return bodies;
}

function splitTopLevelClauses(sql: string): string[] {
    const masked = maskSqlNoise(sql);
    const clauses: string[] = [];
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let clauseStart = 0;
    for (let cursor = 0; cursor < masked.length; cursor += 1) {
        const character = masked[cursor];
        if (character === "(") parenthesisDepth += 1;
        else if (character === ")") parenthesisDepth -= 1;
        else if (character === "[") bracketDepth += 1;
        else if (character === "]") bracketDepth -= 1;
        if (parenthesisDepth < 0 || bracketDepth < 0) throw new Error("Unbalanced SQL delimiters");
        if (character === "," && parenthesisDepth === 0 && bracketDepth === 0) {
            clauses.push(sql.slice(clauseStart, cursor).trim());
            clauseStart = cursor + 1;
        }
    }
    if (parenthesisDepth !== 0 || bracketDepth !== 0) throw new Error("Unbalanced SQL delimiters");
    clauses.push(sql.slice(clauseStart).trim());
    return clauses.filter(Boolean);
}

interface RiskRule {
    type: string;
    level: MigrationRiskLevel;
    pattern: RegExp;
    excludePattern?: RegExp;
    description: string;
    recommendation: string;
    blocksTransactionalPush?: true;
}

const RISK_RULES: readonly RiskRule[] = [
    {
        type: "destructive_drop_database",
        level: "HIGH",
        pattern: /\bDROP\s+DATABASE\b/i,
        description: "Drops entire database.",
        recommendation: "Never drop databases in automated migrations.",
        blocksTransactionalPush: true,
    },
    {
        type: "destructive_drop_schema",
        level: "HIGH",
        pattern: /\bDROP\s+SCHEMA\b/i,
        description: "Drops entire schema and all contained objects.",
        recommendation: "Ensure schema objects are migrated or deleted in contract phase before dropping schema.",
    },
    {
        type: "destructive_drop_table",
        level: "HIGH",
        pattern: /\bDROP\s+TABLE\b/i,
        description: "Drops table and permanently removes data. Old code referencing this table will break.",
        recommendation: "Follow Expand-Contract: Deprecate usage in application code before dropping table.",
    },
    {
        type: "destructive_drop_column",
        level: "HIGH",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+(?:COLUMN\s+)?[a-z0-9_"]+/i,
        excludePattern: /\bDROP\s+CONSTRAINT\b|\bALTER\s+(?:COLUMN\s+)?[a-z0-9_"]+\s+DROP\s+(?:DEFAULT|NOT\s+NULL|IDENTITY|EXPRESSION)\b/i,
        description: "Drops column. Running application code selecting or writing this column will fail immediately.",
        recommendation: "Follow Expand-Contract: Ensure all running application versions have stopped accessing this column before dropping.",
    },
    {
        type: "destructive_drop_constraint",
        level: "HIGH",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+CONSTRAINT\b/i,
        description: "Drops constraint. Dropping constraints may break uniqueness guarantees or foreign key integrity.",
        recommendation: "Ensure application code and data no longer depend on this constraint before dropping.",
    },
    {
        type: "destructive_drop_view",
        level: "HIGH",
        pattern: /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b/i,
        description: "Drops view or materialized view. Queries or API endpoints selecting from this view will break.",
        recommendation: "Follow Expand-Contract: Deprecate client/API dependencies on this view before dropping.",
    },
    {
        type: "destructive_truncate",
        level: "HIGH",
        pattern: /\bTRUNCATE(?:\s+TABLE)?\b/i,
        description: "Truncates table data permanently.",
        recommendation: "Avoid TRUNCATE in schema migrations; use soft deletes or targeted archived data cleanup.",
    },
    {
        type: "destructive_rename_column",
        level: "HIGH",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+(?:COLUMN\s+)?[a-z0-9_"]+\s+TO\b/i,
        description: "Renames column. Causes immediate downtime for old application code expecting the previous column name.",
        recommendation: "Follow Expand-Contract: Add new column, dual-write, backfill, migrate reads, then drop old column.",
    },
    {
        type: "destructive_rename_table",
        level: "HIGH",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+TO\b/i,
        description: "Renames table. Causes immediate downtime for application code.",
        recommendation: "Follow Expand-Contract: Create a view or alias table during transition.",
    },
    {
        type: "manual_review_procedural_definition",
        level: "HIGH",
        pattern: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i,
        description: "Defines procedural SQL whose body can hide data, privilege, or schema side effects from static rules.",
        recommendation: "Review the complete function or procedure body and require strict migration approval.",
    },
    {
        type: "manual_review_procedure_call",
        level: "HIGH",
        pattern: /^\s*CALL\b/i,
        description: "Calls a stored procedure whose side effects cannot be determined statically.",
        recommendation: "Replace the call with explicit migration SQL or require strict manual approval.",
    },
    {
        type: "locking_vacuum_full",
        level: "HIGH",
        pattern: /^\s*VACUUM\b/i,
        description: "VACUUM cannot run inside the transactional migration executor; VACUUM FULL also locks and rewrites the table.",
        recommendation: "Run VACUUM through an approved non-transactional maintenance path; do not place it in push_migrations files.",
        blocksTransactionalPush: true,
    },
    {
        type: "locking_cluster",
        level: "HIGH",
        pattern: /^\s*CLUSTER\s+[a-z0-9_"]+/i,
        description: "CLUSTER acquires an ACCESS EXCLUSIVE lock on the table, blocking all concurrent access.",
        recommendation: "Avoid CLUSTER on active production tables; consider pg_repack for online table reordering.",
    },
    {
        type: "unsupported_concurrent_index_migration",
        level: "HIGH",
        pattern: /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|REINDEX\b[\s\S]*?)\s+CONCURRENTLY\b/i,
        description: "CONCURRENTLY operations cannot run inside the transactional migration executor.",
        recommendation: "Run the concurrent index operation through an approved non-transactional maintenance path, outside push_migrations.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_non_transactional_migration",
        level: "HIGH",
        pattern: /\b(?:CREATE\s+DATABASE|CREATE\s+TABLESPACE|DROP\s+TABLESPACE|CREATE\s+SUBSCRIPTION|DROP\s+SUBSCRIPTION|ALTER\s+SYSTEM)\b/i,
        description: "This operation cannot run inside the transactional, project-scoped migration executor.",
        recommendation: "Use an approved platform maintenance path instead of push_migrations.",
        blocksTransactionalPush: true,
    },
    {
        type: "locking_non_concurrent_index",
        level: "MEDIUM",
        pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)/i,
        description: "Creates index non-concurrently. Acquires SHARE lock and blocks concurrent writes (INSERT/UPDATE/DELETE) on the table until index build completes.",
        recommendation: "For a live large table, use the approved non-transactional maintenance path for CREATE INDEX CONCURRENTLY; push_migrations cannot execute it.",
    },
    {
        type: "locking_drop_index_non_concurrent",
        level: "MEDIUM",
        pattern: /\bDROP\s+INDEX\s+(?!CONCURRENTLY\b)/i,
        description: "Drops index non-concurrently. Acquires ACCESS EXCLUSIVE lock on the table, blocking concurrent reads and writes.",
        recommendation: "For a live table, use the approved non-transactional maintenance path for DROP INDEX CONCURRENTLY; push_migrations cannot execute it.",
    },
    {
        type: "locking_alter_column_set_not_null",
        level: "MEDIUM",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+(?:COLUMN\s+)?[a-z0-9_"]+\s+SET\s+NOT\s+NULL\b/i,
        description: "Setting NOT NULL on an existing column scans the entire table under an ACCESS EXCLUSIVE lock unless a validated CHECK constraint already exists.",
        recommendation: "Add a CHECK (column IS NOT NULL) NOT VALID constraint first, validate it with VALIDATE CONSTRAINT, then SET NOT NULL.",
    },
    {
        type: "locking_alter_type",
        level: "MEDIUM",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+(?:COLUMN\s+)?[a-z0-9_"]+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
        description: "Altering column type acquires ACCESS EXCLUSIVE lock and may trigger a full table rewrite.",
        recommendation: "Add a new column with the target type, dual-write, copy data, switch reads, then drop old column.",
    },
    {
        type: "locking_unique_constraint_without_index",
        level: "MEDIUM",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+CONSTRAINT\b[\s\S]*?\bUNIQUE\b/i,
        excludePattern: /\bUNIQUE\s+USING\s+INDEX\b/i,
        description: "Adding UNIQUE constraint directly acquires an ACCESS EXCLUSIVE lock while creating the index.",
        recommendation: "Build the unique index through the approved non-transactional maintenance path, then attach it with ADD CONSTRAINT ... UNIQUE USING INDEX in a migration.",
    },
    {
        type: "locking_foreign_key_without_not_valid",
        level: "MEDIUM",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+CONSTRAINT\b[\s\S]*?\bFOREIGN\s+KEY\b(?!\s*[^;]*?\bNOT\s+VALID\b)/i,
        description: "Adding a FOREIGN KEY constraint without NOT VALID locks the table for a full scan to validate existing rows.",
        recommendation: "Add foreign key constraint with 'NOT VALID' first, then run 'ALTER TABLE ... VALIDATE CONSTRAINT' separately.",
    },
    {
        type: "locking_check_constraint_without_not_valid",
        level: "MEDIUM",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+CONSTRAINT\b[\s\S]*?\bCHECK\b(?!\s*[^;]*?\bNOT\s+VALID\b)/i,
        description: "Adding a CHECK constraint without NOT VALID scans the entire table under an ACCESS EXCLUSIVE lock.",
        recommendation: "Add constraint with 'NOT VALID' first, then validate with 'ALTER TABLE ... VALIDATE CONSTRAINT'.",
    },
];

const MIGRATION_LEDGER_RELATION = String.raw`(?:(?:"?(?:supabase_migrations|public)"?)\s*\.\s*)?"?schema_migrations"?`;
const MIGRATION_LEDGER_RELATION_END = String.raw`(?=$|[\s,;(*])`;
const MIGRATION_LEDGER_DDL_OR_MAINTENANCE_PREFIX = String.raw`(?:CREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*\bON\s+(?:ONLY\s+)?|CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b[^;]*\bON\s+|DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?[^;]*\bON\s+|CREATE\s+RULE\b[^;]*\bTO\s+|DROP\s+RULE\s+(?:IF\s+EXISTS\s+)?[^;]*\bON\s+|CREATE\s+POLICY\b[^;]*\bON\s+|ALTER\s+POLICY\b[^;]*\bON\s+|DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?[^;]*\bON\s+|COMMENT\s+ON\s+TABLE\s+|SECURITY\s+LABEL(?:\s+FOR\s+[^;\s]+)?\s+ON\s+TABLE\s+|REINDEX(?:\s*\([^;)]*\))?\s+TABLE\s+(?:CONCURRENTLY\s+)?|CLUSTER(?:\s+VERBOSE)?\s+|VACUUM(?:\s*\([^;)]*\))?(?:\s+(?:FULL|FREEZE|VERBOSE|ANALYZE))*\s+|ANALYZE(?:\s*\([^;)]*\))?(?:\s+VERBOSE)?\s+)`;
const MIGRATION_LEDGER_MODIFICATION_PATTERN = new RegExp(
    String.raw`\b(?:(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|INSERT\s+INTO\s+(?:ONLY\s+)?|UPDATE\s+(?:ONLY\s+)?|DELETE\s+FROM\s+(?:ONLY\s+)?|MERGE\s+INTO\s+(?:ONLY\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?|COPY\s+)`
    + MIGRATION_LEDGER_RELATION
    + MIGRATION_LEDGER_RELATION_END
    + String.raw`|(?:DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?|TRUNCATE(?:\s+TABLE)?\s+|LOCK\s+(?:TABLE\s+)?)[^;]*`
    + MIGRATION_LEDGER_RELATION
    + MIGRATION_LEDGER_RELATION_END
    + String.raw`|`
    + MIGRATION_LEDGER_DDL_OR_MAINTENANCE_PREFIX
    + MIGRATION_LEDGER_RELATION
    + MIGRATION_LEDGER_RELATION_END
    + String.raw`)`,
    "i",
);
const NON_TABLE_PRIVILEGE_TARGET = String.raw`(?:ALL\s+(?:FUNCTIONS|PROCEDURES|ROUTINES|SEQUENCES)\s+IN\s+SCHEMA|DATABASE|DOMAIN|FOREIGN\s+DATA\s+WRAPPER|FOREIGN\s+SERVER|FUNCTION|LANGUAGE|LARGE\s+OBJECT|PARAMETER|PROCEDURE|ROUTINE|SCHEMA|SEQUENCE|TABLESPACE|TYPE)\b`;
const MIGRATION_LEDGER_PRIVILEGE_PATTERN = new RegExp(
    String.raw`\b(?:GRANT|REVOKE)\b[^;]*\bON\s+(?:(?:TABLE\s+)?(?!`
    + NON_TABLE_PRIVILEGE_TARGET
    + String.raw`)(?:(?!\b(?:TO|FROM)\b)[^;])*?`
    + MIGRATION_LEDGER_RELATION
    + MIGRATION_LEDGER_RELATION_END
    + String.raw`(?=[^;]*\b(?:TO|FROM)\b)|ALL\s+TABLES\s+IN\s+SCHEMA\s+"?supabase_migrations"?(?=$|[\s,;]))`,
    "i",
);

const PUSH_BLOCKER_RULES: readonly RiskRule[] = [
    {
        type: "unsupported_project_scope_management",
        level: "HIGH",
        pattern: /\b(?:ALTER\s+DATABASE|DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(?:[^;]*,\s*)?public(?=\s*(?:,|CASCADE\b|RESTRICT\b|$))|(?:DROP|REASSIGN)\s+OWNED\b|(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b|ALTER\s+SUBSCRIPTION\b)\b/i,
        description: "Attempts cluster-wide or platform-owned database management outside the project migration boundary.",
        recommendation: "Use an approved platform administration path instead of push_migrations.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_platform_schema_management",
        level: "HIGH",
        pattern: /\b(?:ALTER\s+SCHEMA\s+"?public"?|(?:CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+SCHEMA\s+)"?supabase_migrations"?|DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(?:[^;]*,\s*)?"?supabase_migrations"?(?=\s*(?:,|CASCADE\b|RESTRICT\b|$)))\b/i,
        description: "Attempts to rename or re-own the public API schema, or to manage the platform migration schema.",
        recommendation: "Keep public and supabase_migrations under platform ownership; change project-owned schemas instead.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_unicode_escaped_identifier",
        level: "HIGH",
        pattern: /\bU&"/i,
        description: "Uses a Unicode-escaped identifier that cannot be safely canonicalized by the migration policy.",
        recommendation: "Use a plain or directly quoted PostgreSQL identifier in controlled migrations.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_server_access",
        level: "HIGH",
        pattern: /^\s*COPY\b|\b(?:(?:lo_import|lo_export|pg_read_file|pg_write_file|pg_ls_dir|pg_stat_file|pg_execute_server_program)\s*\(|pg_(?:terminate|cancel)_backend\s*\(|LOAD\b)/i,
        description: "Attempts server file, process, backend, or dynamic-library access from a project migration.",
        recommendation: "Run host-level maintenance through an approved platform administration path.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_external_database_access",
        level: "HIGH",
        pattern: /\bdblink(?:_[a-z_]+)?\s*\(|\b(?:CREATE|ALTER|DROP)\s+(?:SERVER|USER\s+MAPPING|FOREIGN\s+DATA\s+WRAPPER)\b|\bIMPORT\s+FOREIGN\s+SCHEMA\b|\bCREATE\s+FOREIGN\s+TABLE\b/i,
        description: "Attempts external database or foreign-data-wrapper access outside the project migration boundary.",
        recommendation: "Provision external connectivity through an approved platform administration path.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_transaction_control",
        level: "HIGH",
        pattern: /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE\s+SAVEPOINT|PREPARE\s+TRANSACTION)\b/i,
        description: "Contains transaction control inside a migration whose atomic transaction is owned by the platform.",
        recommendation: "Remove internal transaction control; one matching outer BEGIN/COMMIT wrapper is stripped automatically.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_session_control",
        level: "HIGH",
        pattern: /\b(?:SET\s+(?:(?:LOCAL|SESSION)\s+)?(?:ROLE|SESSION\s+AUTHORIZATION)|RESET\s+(?:ROLE|SESSION\s+AUTHORIZATION)|DISCARD\s+ALL)\b/i,
        description: "Attempts to change the database session identity or discard platform-managed session state.",
        recommendation: "Keep migrations within the delegated project role and remove session identity control.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_advisory_lock_control",
        level: "HIGH",
        pattern: /\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?\s*\(/i,
        description: "Attempts advisory lock control that can conflict with the platform migration lock.",
        recommendation: "Remove custom advisory lock operations; push_migrations already serializes project migrations.",
        blocksTransactionalPush: true,
    },
];

const QUOTED_FUNCTION_BLOCKER_RULES: readonly RiskRule[] = [
    {
        type: "unsupported_server_access",
        level: "HIGH",
        pattern: /"(?:lo_import|lo_export|pg_read_file|pg_write_file|pg_ls_dir|pg_stat_file|pg_execute_server_program|pg_terminate_backend|pg_cancel_backend)"\s*\(/,
        description: "Attempts server file, process, backend, or dynamic-library access from a project migration.",
        recommendation: "Run host-level maintenance through an approved platform administration path.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_external_database_access",
        level: "HIGH",
        pattern: /"dblink(?:_[a-z_]+)?"\s*\(/,
        description: "Attempts external database or foreign-data-wrapper access outside the project migration boundary.",
        recommendation: "Provision external connectivity through an approved platform administration path.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_advisory_lock_control",
        level: "HIGH",
        pattern: /"pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?"\s*\(/,
        description: "Attempts advisory lock control that can conflict with the platform migration lock.",
        recommendation: "Remove custom advisory lock operations; push_migrations already serializes project migrations.",
        blocksTransactionalPush: true,
    },
];

const MIGRATION_LEDGER_BLOCKER_RULES: readonly RiskRule[] = [
    {
        type: "unsupported_public_schema_removal",
        level: "HIGH",
        pattern: /\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(?:[^;]*,\s*)?"?public"?(?=\s*(?:,|CASCADE\b|RESTRICT\b|$))/i,
        description: "Attempts to remove the platform-required public schema.",
        recommendation: "Drop project objects individually through an approved contract migration; do not remove public.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_migration_ledger_access",
        level: "HIGH",
        pattern: MIGRATION_LEDGER_MODIFICATION_PATTERN,
        description: "Attempts to modify or bypass the platform-owned migration ledger.",
        recommendation: "Let push_migrations record the ledger entry after the migration transaction commits.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_migration_ledger_privileges",
        level: "HIGH",
        pattern: MIGRATION_LEDGER_PRIVILEGE_PATTERN,
        description: "Attempts to change privileges on the platform-owned migration ledger.",
        recommendation: "Keep migration ledger privileges under platform control.",
        blocksTransactionalPush: true,
    },
    {
        type: "unsupported_migration_ledger_recorder_access",
        level: "HIGH",
        pattern: /"?supabase_migrations"?\s*\.\s*"?record_schema_migration"?\s*\(/i,
        description: "Attempts to call or redefine the platform migration ledger recorder.",
        recommendation: "Let push_migrations invoke the recorder with a platform-issued lease.",
        blocksTransactionalPush: true,
    },
];

/**
 * A DO body is PL/pgSQL source, so BEGIN/END keywords are block structure, not
 * transaction control. Every other push blocker is re-applied to the body
 * (depth 1) so a DO block cannot smuggle server access, dblink calls, session
 * control, or ledger modifications past static analysis.
 */
const DO_BODY_BLOCKER_RULES: readonly RiskRule[] = PUSH_BLOCKER_RULES
    .filter((rule) => rule.type !== "unsupported_transaction_control");

function matchingRisks(
    rawStatement: string,
    maskedStatement: string,
    rules: readonly RiskRule[],
): MigrationRiskItem[] {
    return rules
        .filter((rule) => rule.pattern.test(maskedStatement) && !rule.excludePattern?.test(maskedStatement))
        .map((rule) => ({
            level: rule.level,
            type: rule.type,
            description: rule.description,
            recommendation: rule.recommendation,
            statementSnippet: rawStatement.replace(/\s+/g, " ").slice(0, 100),
            ...(rule.blocksTransactionalPush ? { blocksTransactionalPush: true as const } : {}),
        }));
}

function defaultExpression(maskedClause: string): string {
    const defaultIndex = maskedClause.search(/\bDEFAULT\b/i);
    if (defaultIndex === -1) return "";
    const expression = maskedClause.slice(defaultIndex + "DEFAULT".length);
    const constraintIndex = expression.search(/\b(?:COLLATE|CONSTRAINT|GENERATED|NOT\s+NULL|NULL|PRIMARY\s+KEY|REFERENCES|UNIQUE|CHECK)\b/i);
    return (constraintIndex === -1 ? expression : expression.slice(0, constraintIndex)).trim();
}

function defaultMayRequireTableRewrite(maskedClause: string): boolean {
    const expression = defaultExpression(maskedClause);
    if (!expression) return false;
    const withoutKnownStableCalls = expression.replace(
        /\b(?:now|transaction_timestamp|statement_timestamp)\s*\(\s*\)/gi,
        "",
    );
    return /\b[A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)?\s*\(/.test(withoutKnownStableCalls);
}

function addedNotNullColumnRisks(rawStatement: string): MigrationRiskItem[] {
    const maskedStatement = maskSqlNoise(rawStatement);
    if (!/^\s*ALTER\s+TABLE\b/i.test(maskedStatement)) return [];
    const risks: MigrationRiskItem[] = [];
    for (const clause of splitTopLevelClauses(rawStatement)) {
        const maskedClause = maskSqlNoise(clause);
        if (!/\bADD\s+(?!CONSTRAINT\b)(?:COLUMN\s+)?[a-z0-9_"]+\s+[\s\S]*\bNOT\s+NULL\b/i.test(maskedClause)) continue;
        const snippet = clause.replace(/\s+/g, " ").slice(0, 100);
        if (!/\bDEFAULT\b/i.test(maskedClause)) {
            risks.push({
                level: "MEDIUM",
                type: "locking_not_null_no_default",
                description: "Adding a NOT NULL column without a DEFAULT value requires full table verification and fails when existing rows cannot satisfy it.",
                recommendation: "Follow Expand-Contract: add the column as nullable, backfill it, then add NOT NULL separately.",
                statementSnippet: snippet,
            });
        } else if (defaultMayRequireTableRewrite(maskedClause)) {
            risks.push({
                level: "MEDIUM",
                type: "locking_not_null_expression_default",
                description: "Adding a NOT NULL column with a function-based DEFAULT may rewrite the table while holding a strong lock.",
                recommendation: "Use a literal or known stable default, or add the column nullable and backfill in a separate step.",
                statementSnippet: snippet,
            });
        }
    }
    return risks;
}

export function analyzeMigrationSql(sql: string): MigrationRiskItem[] {
    const statements = migrationExecutionStatements(splitSqlStatements(sql));
    if (statements.length === 0) {
        return [{
            level: "HIGH",
            type: "unsupported_empty_migration",
            description: "Contains no executable SQL after removing the platform-managed outer transaction wrapper.",
            recommendation: "Remove the empty migration file or add the intended project-scoped SQL statement.",
            statementSnippet: sql.replace(/\s+/g, " ").slice(0, 100),
            blocksTransactionalPush: true,
        }];
    }
    const risks: MigrationRiskItem[] = [];

    for (const rawStatement of statements) {
        const masked = maskSqlNoise(rawStatement);
        const policyMasked = maskSqlPolicyNoise(rawStatement);
        risks.push(...matchingRisks(rawStatement, masked, RISK_RULES));
        risks.push(...addedNotNullColumnRisks(rawStatement));
        risks.push(...matchingRisks(rawStatement, masked, PUSH_BLOCKER_RULES));
        risks.push(...matchingRisks(rawStatement, policyMasked, QUOTED_FUNCTION_BLOCKER_RULES));
        risks.push(...matchingRisks(rawStatement, policyMasked, MIGRATION_LEDGER_BLOCKER_RULES));
        for (const body of topLevelDoBodies(rawStatement)) {
            const maskedBody = maskSqlNoise(body);
            const policyMaskedBody = maskSqlPolicyNoise(body);
            risks.push(...matchingRisks(body, maskedBody, DO_BODY_BLOCKER_RULES));
            risks.push(...matchingRisks(body, policyMaskedBody, QUOTED_FUNCTION_BLOCKER_RULES));
            risks.push(...matchingRisks(body, policyMaskedBody, MIGRATION_LEDGER_BLOCKER_RULES));
        }
    }

    return risks;
}

export function analyzeMigrationFiles(
    files: Array<{ file: string; sql: string }>,
): MigrationRiskAnalysis {
    const fileRisks: MigrationFileRisk[] = [];
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let transactionalPushBlockerCount = 0;

    for (const { file, sql } of files) {
        const risks = analyzeMigrationSql(sql);
        transactionalPushBlockerCount += risks.filter((risk) => risk.blocksTransactionalPush).length;
        let fileLevel: MigrationRiskLevel = "LOW";

        for (const risk of risks) {
            if (risk.level === "HIGH") {
                fileLevel = "HIGH";
                highCount++;
            } else if (risk.level === "MEDIUM") {
                if (fileLevel !== "HIGH") fileLevel = "MEDIUM";
                mediumCount++;
            }
        }

        if (fileLevel === "LOW") {
            lowCount++;
        }

        fileRisks.push({
            file,
            overallRisk: fileLevel,
            risks,
        });
    }

    let overallRisk: MigrationRiskLevel = "LOW";
    if (highCount > 0) overallRisk = "HIGH";
    else if (mediumCount > 0) overallRisk = "MEDIUM";

    return {
        overallRisk,
        highRiskCount: highCount,
        mediumRiskCount: mediumCount,
        lowRiskCount: lowCount,
        transactionalPushBlockerCount,
        files: fileRisks,
    };
}

export function formatMigrationRiskReport(analysis: MigrationRiskAnalysis): string {
    const lines: string[] = [];
    const riskIcon = analysis.overallRisk === "HIGH" ? "🔴" : analysis.overallRisk === "MEDIUM" ? "🟡" : "🟢";
    lines.push(`${riskIcon} Migration Risk Level: ${analysis.overallRisk}`);
    lines.push(`Total issues detected: ${analysis.highRiskCount} High (Destructive), ${analysis.mediumRiskCount} Medium (Locking/Constraint)`);

    const filesWithRisks = analysis.files.filter((fileRisk) => fileRisk.risks.length > 0);
    if (!filesWithRisks.length) {
        lines.push("", "✅ All migrations follow safe, non-blocking Expand-Contract patterns.");
        return lines.join("\n");
    }

    lines.push("", "Detailed Findings:");
    for (const { file, overallRisk, risks } of filesWithRisks) {
        const fileIcon = overallRisk === "HIGH" ? "🔴" : "🟡";
        lines.push(`  ${fileIcon} ${file} [${overallRisk}]`);
        for (const risk of risks) {
            lines.push(`    - [${risk.level}] ${risk.description}`);
            if (risk.statementSnippet) {
                lines.push(`      Snippet: ${risk.statementSnippet}`);
            }
            lines.push(`      💡 Suggestion: ${risk.recommendation}`);
        }
    }

    return lines.join("\n");
}
