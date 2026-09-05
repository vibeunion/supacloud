import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface SqlTableDefinition {
  file: string;
  name: string;
  body: string;
}

export interface BusinessInvariantIssue {
  code: string;
  file: string;
  table?: string;
  message: string;
}

export const DEFAULT_SQL_FILES = [
  "scripts/001_initial_schema.sql",
  "scripts/002_tasks_queue_schema_patch.sql",
  "scripts/004_background_task_mirror_migration.sql",
] as const;

export async function discoverSqlFiles(root: string): Promise<string[]> {
  const scriptsDir = join(root, "scripts");
  const entries = await readdir(scriptsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^\d+[_-].+\.sql$/i.test(entry.name))
    .map((entry) => join("scripts", entry.name))
    .sort();
}

function normalizeIdentifier(value: string): string {
  return value
    .split(".")
    .map((part) => part.trim().replace(/^"|"$/g, "").toLowerCase())
    .join(".");
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*(?:\n|$)/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function findMatchingParen(sql: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = openIndex; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function extractCreateTables(sql: string, file: string): SqlTableDefinition[] {
  const source = stripSqlComments(sql);
  const tables: SqlTableDefinition[] = [];
  const pattern = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w$]+(?:\s*\.\s*[\w$]+)?)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const openIndex = source.indexOf("(", match.index + match[0].length - 1);
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex < 0) continue;
    tables.push({
      file,
      name: normalizeIdentifier(match[1]!),
      body: source.slice(openIndex + 1, closeIndex),
    });
    pattern.lastIndex = closeIndex + 1;
  }
  return tables;
}

function hasRlsEnabled(sql: string, table: string): boolean {
  const escaped = table.split(".").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*\\.\\s*");
  return new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${escaped}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY\\b`, "i").test(sql);
}

function hasUserForeignKey(body: string): boolean {
  return /\buser_id\b[\s\S]{0,180}\bREFERENCES\s+(?:[\w$]+\s*\.\s*)?(?:profiles|users)\b/i.test(body);
}

export function checkBusinessInvariants(
  files: Array<{ path: string; sql: string }>,
): BusinessInvariantIssue[] {
  const issues: BusinessInvariantIssue[] = [];
  const versions = new Map<string, string>();
  const tables: SqlTableDefinition[] = [];

  for (const file of files) {
    const fileName = basename(file.path);
    const version = /^(\d+)[_-]/.exec(fileName)?.[1];
    if (!version) {
      issues.push({
        code: "migration-version-invalid",
        file: file.path,
        message: `Migration ${fileName} must start with a numeric version followed by '_' or '-'.`,
      });
    } else if (versions.has(version)) {
      issues.push({
        code: "migration-version-duplicate",
        file: file.path,
        message: `Migration version ${version} is already used by ${versions.get(version)}.`,
      });
    } else {
      versions.set(version, file.path);
    }
    tables.push(...extractCreateTables(file.sql, file.path));
  }

  const tableFiles = new Map<string, string>();
  for (const table of tables) {
    if (tableFiles.has(table.name)) {
      issues.push({
        code: "table-duplicate-definition",
        file: table.file,
        table: table.name,
        message: `Table ${table.name} is created more than once; use an ALTER TABLE migration for follow-up changes.`,
      });
      continue;
    }
    tableFiles.set(table.name, table.file);

    if (!/\bPRIMARY\s+KEY\b/i.test(table.body)) {
      issues.push({ code: "table-missing-primary-key", file: table.file, table: table.name, message: `Table ${table.name} must declare a primary key.` });
    }
    if (!hasRlsEnabled(files.find((file) => file.path === table.file)?.sql ?? "", table.name)) {
      issues.push({ code: "table-missing-rls", file: table.file, table: table.name, message: `Table ${table.name} must enable row-level security in the same migration.` });
    }
    if (/\bstatus\b/i.test(table.body) && !/\bCHECK\s*\([\s\S]*\bstatus\b/i.test(table.body)) {
      issues.push({ code: "status-missing-check", file: table.file, table: table.name, message: `Table ${table.name} has a status column without a database CHECK constraint.` });
    }
    if (/\buser_id\b/i.test(table.body) && !hasUserForeignKey(table.body)) {
      issues.push({ code: "user-id-missing-foreign-key", file: table.file, table: table.name, message: `Table ${table.name} has user_id without a foreign key to profiles or users.` });
    }
  }

  return issues;
}

async function main() {
  const root = resolve(import.meta.dir, "..");
  const relativePaths = await discoverSqlFiles(root);
  const files = await Promise.all(relativePaths.map(async (relativePath) => ({
    path: relativePath,
    sql: await readFile(join(root, relativePath), "utf8"),
  })));
  const issues = checkBusinessInvariants(files);
  if (issues.length > 0) {
    for (const issue of issues) {
      const subject = issue.table ? `${issue.file}:${issue.table}` : issue.file;
      console.error(`ERROR [${issue.code}] ${subject}: ${issue.message}`);
    }
    console.error(`\nFound ${issues.length} business invariant issue(s).`);
    process.exit(1);
  }
  console.log(`✔ Business invariants passed for ${files.length} migration files and ${files.flatMap((file) => extractCreateTables(file.sql, file.path)).length} tables.`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Failed to check business invariants:", error);
    process.exit(1);
  });
}
