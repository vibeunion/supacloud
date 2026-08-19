export const WRITE_SQL_PATTERN = /^\s*(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|REINDEX|VACUUM|ANALYZE|REFRESH|CALL|DO|COPY|SET|RESET|LOCK)\b/i;
export const MULTI_STATEMENT_PATTERN = /;\s*\S/;

interface SqlPattern {
  label: string;
  pattern: RegExp;
}

const TRANSACTION_CONTROL_PATTERN = /(?:^|;)\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE\s+SAVEPOINT|PREPARE\s+TRANSACTION)\b/i;

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
  + String.raw`(?=[^;]*\b(?:TO|FROM)\b)|ALL\s+TABLES\s+IN\s+SCHEMA\s+"?(?:supabase_migrations|public)"?(?=$|[\s,;]))`,
  "i",
);

const PRIVILEGED_MIGRATION_PATTERNS: readonly SqlPattern[] = [
  { label: "database management", pattern: /\b(?:CREATE|ALTER|DROP)\s+DATABASE\b/i },
  { label: "public schema removal", pattern: /\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(?:[^;]*,\s*)?"?public"?(?=\s*(?:,|CASCADE\b|RESTRICT\b|$))/i },
  { label: "public schema alteration", pattern: /\bALTER\s+SCHEMA\s+"?public"?\b/i },
  { label: "migration ledger schema management", pattern: /\b(?:(?:CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+SCHEMA\s+)"?supabase_migrations"?|DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(?:[^;]*,\s*)?"?supabase_migrations"?(?=\s*(?:,|CASCADE\b|RESTRICT\b|$)))/i },
  { label: "unicode escaped identifier", pattern: /\bU&"/i },
  { label: "cluster ownership management", pattern: /\b(?:DROP|REASSIGN)\s+OWNED\b/i },
  { label: "cluster role management", pattern: /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b/i },
  { label: "server configuration", pattern: /\bALTER\s+SYSTEM\b/i },
  { label: "server copy access", pattern: /(?:^|;)\s*COPY\b/i },
  { label: "server-side program execution", pattern: /\bCOPY\b[\s\S]*?\b(?:TO|FROM)\s+PROGRAM\b/i },
  { label: "server file access", pattern: /\b(?:lo_import|lo_export|pg_read_file|pg_write_file|pg_ls_dir|pg_stat_file|pg_execute_server_program)\s*\(/i },
  { label: "server file access", pattern: /"(?:lo_import|lo_export|pg_read_file|pg_write_file|pg_ls_dir|pg_stat_file|pg_execute_server_program)"\s*\(/ },
  { label: "backend control", pattern: /\bpg_(?:terminate|cancel)_backend\s*\(/i },
  { label: "backend control", pattern: /"pg_(?:terminate|cancel)_backend"\s*\(/ },
  { label: "external database access", pattern: /\bdblink(?:_[a-z_]+)?\s*\(|\b(?:CREATE|ALTER|DROP)\s+(?:SERVER|USER\s+MAPPING|FOREIGN\s+DATA\s+WRAPPER)\b|\bIMPORT\s+FOREIGN\s+SCHEMA\b|\bCREATE\s+FOREIGN\s+TABLE\b/i },
  { label: "external database access", pattern: /"dblink(?:_[a-z_]+)?"\s*\(/ },
  { label: "tablespace management", pattern: /\b(?:CREATE|DROP)\s+TABLESPACE\b/i },
  { label: "subscription management", pattern: /\b(?:CREATE|ALTER|DROP)\s+SUBSCRIPTION\b/i },
  { label: "dynamic library loading", pattern: /\bLOAD\b/i },
  { label: "opaque procedural SQL", pattern: /(?:^|;)\s*DO\b/i },
  { label: "transaction control", pattern: TRANSACTION_CONTROL_PATTERN },
  { label: "session role control", pattern: /\b(?:SET\s+(?:(?:LOCAL|SESSION)\s+)?(?:ROLE|SESSION\s+AUTHORIZATION)|RESET\s+(?:ROLE|SESSION\s+AUTHORIZATION)|DISCARD\s+ALL)\b/i },
  { label: "advisory lock control", pattern: /\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?\s*\(/i },
  { label: "advisory lock control", pattern: /"pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?"\s*\(/ },
  {
    label: "migration ledger modification",
    pattern: MIGRATION_LEDGER_MODIFICATION_PATTERN,
  },
  {
    label: "migration ledger privilege modification",
    pattern: MIGRATION_LEDGER_PRIVILEGE_PATTERN,
  },
  {
    label: "migration ledger recorder access",
    pattern: /"?supabase_migrations"?\s*\.\s*"?record_schema_migration"?\s*\(/i,
  },
];

const LEGACY_DANGEROUS_SQL_PATTERNS: readonly RegExp[] = [
  /\bDROP\s+DATABASE\b/i,
  /\bDROP\s+SCHEMA\s+public\b/i,
  /\bDROP\s+OWNED\b/i,
  /\bDROP\s+(TABLE|ROLE|USER)\b/i,
  /\bREASSIGN\s+OWNED\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bALTER\s+(ROLE|USER|SYSTEM)\b/i,
  /\bCREATE\s+(FUNCTION|PROCEDURE|RULE)\b/i,
  /\bDO\s+\$[^$]*\$/i,
  /\bCOPY\s+.*\bTO\s+PROGRAM\b/i,
  /\bCOPY\s+.*\bFROM\s+PROGRAM\b/i,
  /\bdblink_(connect|exec|open|fetch|send_query)\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bLOAD\b/i,
  /\bpg_execute_server_program\b/i,
  /\bpg_read_file\b/i,
  /\bpg_write_file\b/i,
  /\bpg_ls_dir\b/i,
  /\bpg_stat_file\b/i,
  /\bpg_terminate_backend\b/i,
  /\bpg_cancel_backend\b/i,
  /\bpg_catalog\b.*\bpg_read_file\b/i,
  /\bpg_catalog\b.*\bpg_write_file\b/i,
  /\bpg_catalog\b.*\bpg_execute_server_program\b/i,
];

function startsEscapeString(sql: string, quoteIndex: number): boolean {
  const prefixIndex = quoteIndex - 1;
  const prefix = sql[prefixIndex] || "";
  const preceding = sql[prefixIndex - 1] || "";
  return /[eE]/.test(prefix) && !/[A-Za-z0-9_$]/.test(preceding);
}

function singleQuotedLiteralEnd(sql: string, start: number): number {
  const usesBackslashEscapes = startsEscapeString(sql, start);
  let cursor = start + 1;
  while (cursor < sql.length) {
    if (usesBackslashEscapes && sql[cursor] === "\\" && cursor + 1 < sql.length) cursor += 2;
    else if (sql[cursor] === "'" && sql[cursor + 1] === "'") cursor += 2;
    else if (sql[cursor] === "'") return cursor + 1;
    else cursor += 1;
  }
  return sql.length;
}

function doubleQuotedIdentifierEnd(sql: string, start: number): number {
  let cursor = start + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === '"' && sql[cursor + 1] === '"') cursor += 2;
    else if (sql[cursor] === '"') return cursor + 1;
    else cursor += 1;
  }
  return sql.length;
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
      depth += 1;
      cursor += 2;
    } else if (sql.startsWith("*/", cursor)) {
      depth -= 1;
      cursor += 2;
    } else cursor += 1;
  }
  return cursor;
}

function dollarQuoteTagAt(sql: string, index: number): string {
  if (/[A-Za-z0-9_$]/.test(sql[index - 1] || "")) return "";
  return sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0] || "";
}

function maskSqlPolicyNoise(sql: string): string {
  let maskedSql = "";
  let cursor = 0;
  while (cursor < sql.length) {
    let protectedEnd = 0;
    if (sql.startsWith("--", cursor)) protectedEnd = lineCommentEnd(sql, cursor);
    else if (sql.startsWith("/*", cursor)) protectedEnd = blockCommentEnd(sql, cursor);
    else if (sql[cursor] === "'") protectedEnd = singleQuotedLiteralEnd(sql, cursor);
    else if (sql[cursor] === '"') {
      protectedEnd = doubleQuotedIdentifierEnd(sql, cursor);
      maskedSql += sql.slice(cursor, protectedEnd);
      cursor = protectedEnd;
      continue;
    }
    if (protectedEnd > 0) {
      maskedSql += " ".repeat(protectedEnd - cursor);
      cursor = protectedEnd;
      continue;
    }

    const tag = sql[cursor] === "$" ? dollarQuoteTagAt(sql, cursor) : "";
    if (!tag) {
      maskedSql += sql[cursor]!;
      cursor += 1;
      continue;
    }
    const end = sql.indexOf(tag, cursor + tag.length);
    if (end === -1) return maskedSql + sql.slice(cursor);
    maskedSql += tag + " ".repeat(end - cursor - tag.length) + tag;
    cursor = end + tag.length;
  }
  return maskedSql;
}

export function normalizeSqlForPolicy(sqlQuery: string): string {
  return maskSqlPolicyNoise(sqlQuery).replace(/\s+/g, " ").trim();
}

export function isDangerousSQL(sqlQuery: string): boolean {
  const normalized = normalizeSqlForPolicy(sqlQuery);
  return LEGACY_DANGEROUS_SQL_PATTERNS.some((pattern) => pattern.test(normalized))
    || PRIVILEGED_MIGRATION_PATTERNS.some(({ pattern }) => pattern.test(normalized));
}

export function sqlContainsTransactionControl(sqlQuery: string): boolean {
  return TRANSACTION_CONTROL_PATTERN.test(normalizeSqlForPolicy(sqlQuery));
}

export function projectMigrationSqlViolations(statements: readonly string[]): string[] {
  const normalized = statements.map(normalizeSqlForPolicy).join("; ");
  return [...new Set(PRIVILEGED_MIGRATION_PATTERNS
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ label }) => label))];
}
