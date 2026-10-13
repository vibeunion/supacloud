import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  lintModule,
  readCatalog,
  reconcileModule,
  type DatabaseModule,
  type QueryExecutor,
} from "@supacloud/db";
import { databaseSources } from "@supacloud/db/source-contracts";
import type { DatabaseGovernanceOptions, Diagnostic } from "./types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const texts = (value: unknown): value is string[] => Array.isArray(value) && Array.from(value).every(text);
const declarations = (value: unknown, required: string[], check: (entry: Record<string, unknown>) => boolean): boolean =>
  Array.isArray(value) && Array.from(value).every(entry => record(entry) && required.every(key => text(entry[key])) && check(entry));

function normalizeModule(value: unknown, file: string): DatabaseModule {
  if (!record(value) || !text(value.name) || !texts(value.tables)
    || !declarations(value.policies, ["name", "table", "source"], entry =>
      ["select", "insert", "update", "delete", "all"].includes(String(entry.operation))
      && texts(entry.roles) && entry.roles.length > 0
      && [entry.usingExpr, entry.checkExpr].every(expr => expr === undefined || expr === null || typeof expr === "string")
      && (entry.tests === undefined || texts(entry.tests)))
    || !declarations(value.functions, ["name", "source"], entry =>
      ["invoker", "definer"].includes(String(entry.security))
      && (entry.signature === undefined || text(entry.signature))
      && (entry.tests === undefined || texts(entry.tests)))
    || !declarations(value.triggers, ["name", "table", "source"], entry =>
      entry.enabled === undefined || typeof entry.enabled === "boolean")
    || !declarations(value.grants, ["object", "privilege", "role", "source"], () => true)) {
    throw new Error(`Invalid database module: ${file}`);
  }
  return value as unknown as DatabaseModule;
}

async function loadModules(projectRoot: string, moduleFile: string): Promise<DatabaseModule[]> {
  const file = await withinRoot(projectRoot, moduleFile);
  const imported = await import(pathToFileURL(file).href) as { default?: unknown; modules?: unknown };
  const exported = imported.default ?? imported.modules;
  if (exported === undefined) throw new Error(`Database module file ${moduleFile} must export default or modules`);
  return (Array.isArray(exported) ? exported : [exported]).map((value) => normalizeModule(value, moduleFile));
}

function governanceDiagnostic(message: string, code = "database-governance"): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    suggestion: "Fix the database source contract, module manifest or live catalog before compiling.",
  };
}

export async function enforceDatabaseGovernance(
  options: DatabaseGovernanceOptions,
): Promise<{ diagnostics: Diagnostic[] }> {
  const projectRoot = await realpath(options.projectRoot ?? ".");
  const sourceReport = await databaseSources(projectRoot, "check");
  const diagnostics = sourceReport.findings.map((finding) => governanceDiagnostic(
    `${finding.file}: ${finding.message}`,
    "database-source-contract",
  ));
  if (!sourceReport.ok && diagnostics.length === 0) {
    diagnostics.push(governanceDiagnostic("Database source contract check failed without findings."));
  }
  if (diagnostics.length > 0) return { diagnostics };

  const modules = await loadModules(projectRoot, options.moduleFile ?? "db/modules.ts");
  if (!modules.length || new Set(modules.map(module => module.name)).size !== modules.length
    || modules.some(module => !module.tables.length && !module.functions.length)) {
    return { diagnostics: [governanceDiagnostic("Enforced governance requires nonempty, uniquely named database modules.")] };
  }
  const readSql = async (path: string): Promise<string> =>
    readFile(await withinRoot(projectRoot, path), "utf8");
  for (const module of modules) {
    for (const issue of await lintModule(module, readSql)) {
      diagnostics.push(governanceDiagnostic(
        `${issue.file}${issue.line ? `:${issue.line}` : ""}: ${issue.message}`,
        "database-sql-contract",
      ));
    }
    for (const entry of [...module.functions, ...module.policies]) {
      for (const path of entry.tests ?? []) await readSql(path);
    }
  }
  if (diagnostics.length) return { diagnostics };

  const databaseUrlEnv = options.databaseUrlEnv ?? "DATABASE_URL";
  const databaseUrl = options.databaseUrl ?? process.env[databaseUrlEnv];
  if (!databaseUrl) {
    diagnostics.push(governanceDiagnostic(
      `Database governance mode "enforce" requires ${databaseUrlEnv} for live Catalog reconciliation.`,
      "database-catalog-unavailable",
    ));
    return { diagnostics };
  }
  if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") {
    diagnostics.push(governanceDiagnostic(
      "Database governance requires a Bun runtime for Catalog reconciliation.",
      "database-catalog-unavailable",
    ));
    return { diagnostics };
  }

  const client = new Bun.SQL(databaseUrl);
  const executor: QueryExecutor = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return await client.unsafe(sql, params ?? []) as T[];
    },
  };
  try {
    const catalog = await readCatalog(executor, options.schemas ?? ["public"]);
    for (const module of modules) {
      for (const issue of reconcileModule(module, catalog).issues) {
        diagnostics.push(governanceDiagnostic(
          `${module.name}:${issue.object}: ${issue.message}`,
          `database-catalog-${issue.code}`,
        ));
      }
    }
  } catch {
    diagnostics.push(governanceDiagnostic(
      "Live Catalog reconciliation failed. Check the selected read-only database connection.",
      "database-catalog-unavailable",
    ));
  } finally {
    await client.close({ timeout: 0 }).catch(() => {});
  }
  return { diagnostics };
}

async function withinRoot(root: string, path: string): Promise<string> {
  const file = await realpath(resolve(root, path));
  const local = relative(root, file);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("Database path escapes project root.");
  return file;
}
