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
            break;
        } else {
            end += 1;
        }
    }
    return { masked: " ".repeat(end - start), end };
}

function maskDoubleQuotedIdentifier(sql: string, start: number): { masked: string; end: number } {
    let end = start + 1;
    while (end < sql.length) {
        if (sql[end] === '"' && sql[end + 1] === '"') {
            end += 2;
        } else if (sql[end] === '"') {
            end += 1;
            break;
        } else {
            end += 1;
        }
    }
    return { masked: `"${"_".repeat(Math.max(0, end - start - 2))}"`, end };
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
    return cursor;
}

function maskDollarQuotedString(sql: string, start: number): { masked: string; end: number } | null {
    const tag = dollarQuoteTagAt(sql, start);
    if (!tag) return null;
    const closingTag = sql.indexOf(tag, start + tag.length);
    if (closingTag === -1) return null;
    const end = closingTag + tag.length;
    return { masked: " ".repeat(end - start), end };
}

function maskSqlSpan(sql: string, start: number): { masked: string; end: number } | null {
    if (sql.startsWith("--", start)) {
        const end = lineCommentEnd(sql, start);
        return { masked: " ".repeat(end - start), end };
    }
    if (sql.startsWith("/*", start)) {
        const end = blockCommentEnd(sql, start);
        return { masked: " ".repeat(end - start), end };
    }
    if (sql[start] === "'") return maskSingleQuotedString(sql, start);
    if (sql[start] === '"') return maskDoubleQuotedIdentifier(sql, start);
    if (sql[start] === "$") return maskDollarQuotedString(sql, start);
    return null;
}

export function maskSqlNoise(sql: string): string {
    let masked = "";
    let cursor = 0;
    while (cursor < sql.length) {
        const protectedSpan = maskSqlSpan(sql, cursor);
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
        type: "manual_review_do_block",
        level: "HIGH",
        pattern: /^\s*DO\b/i,
        description: "DO blocks can execute dynamic or procedural DDL that static rules cannot inspect safely.",
        recommendation: "Move schema changes into explicit SQL statements; push_migrations rejects opaque procedural SQL.",
        blocksTransactionalPush: true,
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
        type: "locking_not_null_no_default",
        level: "MEDIUM",
        pattern: /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+(?!CONSTRAINT\b)(?:COLUMN\s+)?[a-z0-9_"]+\s+[^;]+?\bNOT\s+NULL\b(?!\s+DEFAULT\b)/i,
        excludePattern: /\bADD\s+(?:COLUMN\s+)?[a-z0-9_"]+\s+[\s\S]*?\bDEFAULT\b[\s\S]*?\bNOT\s+NULL\b/i,
        description: "Adding a NOT NULL column without a DEFAULT value requires full table verification and will fail if the table contains existing rows.",
        recommendation: "Follow Expand-Contract: Add column as nullable or with a DEFAULT value first, backfill data if necessary, then add NOT NULL constraint.",
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

export function analyzeMigrationSql(sql: string): MigrationRiskItem[] {
    const statements = splitSqlStatements(sql);
    const risks: MigrationRiskItem[] = [];

    for (const rawStatement of statements) {
        const masked = maskSqlNoise(rawStatement);
        for (const rule of RISK_RULES) {
            if (rule.pattern.test(masked) && !rule.excludePattern?.test(masked)) {
                const snippet = rawStatement.replace(/\s+/g, " ").slice(0, 100);
                risks.push({
                    level: rule.level,
                    type: rule.type,
                    description: rule.description,
                    recommendation: rule.recommendation,
                    statementSnippet: snippet,
                    ...(rule.blocksTransactionalPush ? { blocksTransactionalPush: true as const } : {}),
                });
            }
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
