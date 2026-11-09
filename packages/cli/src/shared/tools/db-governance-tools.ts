import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
    buildDatabaseManifest,
    explainObject,
    lintModule,
    readCatalog,
    reconcileModule,
    type DatabaseModule,
    type LintIssue,
    type QueryExecutor,
    type ReconcileReport,
} from "@supacloud/db";
import { databaseSources } from "@supacloud/db/source-contracts";
import { runDbWorkflow, type DbWorkflowAction } from "./db-workflow";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolServer, type ToolResult } from "../tool-server";

export interface DbToolArguments {
    action: "context" | "lint" | "check" | "explain" | "module_check" | DbWorkflowAction;
    module?: string;
    root?: string;
    module_file?: string;
    target?: string;
    database_url?: string;
    schema?: string;
    lite?: boolean;
    remote?: boolean;
    project_dir?: string;
    schema_dir?: string;
    db_major_version?: number;
    out?: string;
    dir?: string;
    ref?: string;
    approved_digest?: string;
    application_role?: string;
    migration_role?: string;
    database?: string;
}

export interface DatabaseAiContextObject {
    kind: "table" | "policy" | "function" | "trigger" | "grant";
    name: string;
    module: string;
    table?: string;
    source: string | null;
    tests: string[];
    security?: string;
    permission?: string;
    transaction?: string;
    audit?: string;
    idempotency?: string;
}

export interface DatabaseAiContext {
    version: 1;
    scope: "database-ai-context";
    root: string;
    selectedModules: string[];
    target: string | null;
    objects: DatabaseAiContextObject[];
    maintenance: {
        structureSource: "zmodel" | "declarative-sql";
        behaviorSource: "sql";
        generatedPaths: string[];
        protectedPaths: string[];
        forwardMigrationPath: string;
        rules: string[];
    };
    verification: string[];
}

export interface DbGovernanceToolOptions {
    environment?: NodeJS.ProcessEnv;
    currentWorkingDirectory?: string;
    liteSpawn?: LiteSpawn;
    /** Overrides the supacloud-lite binary lookup; null simulates a missing binary (tests). */
    liteBinary?: string | null;
    projectRef?: string;
    apiUrl?: string;
    runDatabase?: () => ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
}

function textResult(text: string, isError = false): ToolResult {
    return { isError, content: [{ type: "text" as const, text }] };
}

/** Normalize dynamically imported module declaration: fill defaults for empty arrays so lint/reconcile does not fail. */
function normalizeModule(candidate: unknown, sourcePath: string): DatabaseModule {
    if (typeof candidate !== "object" || candidate === null || typeof (candidate as { name?: unknown }).name !== "string") {
        throw new Error(`Invalid database module export in ${sourcePath}（应导出 defineDatabaseModule(...) 结果）`);
    }
    const raw = candidate as Partial<DatabaseModule> & { name: string };
    return {
        name: raw.name,
        tables: raw.tables ?? [],
        policies: raw.policies ?? [],
        functions: raw.functions ?? [],
        triggers: raw.triggers ?? [],
        grants: raw.grants ?? [],
    };
}

/**
 * Load database governance module declarations:
 * --module_file points to a file exporting `default defineDatabaseModule(...)` (or an array);
 * defaults to <root>/db/modules.ts (default or named "modules" export, single or array).
 */
export async function loadDatabaseModules(root: string, moduleFile?: string): Promise<DatabaseModule[]> {
    const filePath = moduleFile
        ? resolve(root, moduleFile)
        : join(root, "db", "modules.ts");
    if (!existsSync(filePath)) {
        throw new Error(moduleFile
            ? `Module file not found: ${filePath}`
            : `Module file not found: ${filePath}（用 --module_file 指定一个导出 defineDatabaseModule(...) 的文件）`);
    }
    let imported: Record<string, unknown>;
    try {
        // Note: use absolute path instead of file:// URL — Bun caches file:// imports by directory,
        // which can falsely report Cannot find module for files written in the same directory during runtime.
        imported = await import(filePath);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to import module file ${filePath}: ${message}`);
    }
    const exported = imported.default ?? imported.modules;
    if (exported === undefined) {
        throw new Error(`Module file ${filePath} must have a default export or a named export "modules"`);
    }
    const list = Array.isArray(exported) ? exported : [exported];
    return list.map((entry) => normalizeModule(entry, filePath));
}

function formatLintIssue(issue: LintIssue): string {
    const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
    return `${issue.severity} ${issue.code} ${location} ${issue.message}`;
}

function formatReconcileReport(report: ReconcileReport): string {
    const lines = [`module: ${report.module} (${report.ok ? "ok" : "FAILED"})`];
    for (const issue of report.issues) {
        lines.push(`  ${issue.severity} ${issue.code} ${issue.object} ${issue.message}`);
    }
    if (report.issues.length === 0) lines.push("  no issues");
    return lines.join("\n");
}

function moduleObjects(module: DatabaseModule): DatabaseAiContextObject[] {
    return [
        ...module.tables.map((table) => ({
            kind: "table" as const, name: table, module: module.name,
            source: null, tests: [],
        })),
        ...module.policies.map((policy) => ({
            kind: "policy" as const, name: policy.name, module: module.name,
            table: policy.table, source: policy.source, tests: policy.tests ?? [],
        })),
        ...module.functions.map((fn) => ({
            kind: "function" as const, name: fn.name, module: module.name,
            source: fn.source, tests: fn.tests ?? [], security: fn.security,
            permission: fn.permission, transaction: fn.transaction,
            audit: fn.audit, idempotency: fn.idempotency,
        })),
        ...module.triggers.map((trigger) => ({
            kind: "trigger" as const, name: trigger.name, module: module.name,
            table: trigger.table, source: trigger.source, tests: [],
        })),
        ...module.grants.map((grant) => ({
            kind: "grant" as const, name: `${grant.object}:${grant.privilege}:${grant.role}`,
            module: module.name, source: grant.source, tests: [],
        })),
    ];
}

function objectMatchesTarget(object: DatabaseAiContextObject, target: string): boolean {
    return object.name === target
        || object.table === target
        || (object.kind === "policy" && `${object.table}.${object.name}` === target)
        || (object.kind === "grant" && object.name.startsWith(`${target}:`));
}

export function buildDatabaseAiContext(
    modules: readonly DatabaseModule[],
    root: string,
    moduleName?: string,
    target?: string,
): DatabaseAiContext {
    const selected = moduleName
        ? modules.filter((module) => module.name === moduleName)
        : [...modules];
    if (moduleName && selected.length === 0) {
        throw new Error(`未找到数据库模块: ${moduleName}（可用: ${modules.map((module) => module.name).join(", ") || "none"}）`);
    }
    const allObjects = selected.flatMap(moduleObjects);
    const objects = target ? allObjects.filter((object) => objectMatchesTarget(object, target)) : allObjects;
    if (target && objects.length === 0) throw new Error(`未找到数据库对象: ${target}`);
    const sqlFirst = !existsSync(join(root, "zenstack/schema.zmodel")) && existsSync(join(root, "supabase/schemas"));
    return {
        version: 1,
        scope: "database-ai-context",
        root,
        selectedModules: selected.map((module) => module.name),
        target: target ?? null,
        objects,
        maintenance: {
            structureSource: sqlFirst ? "declarative-sql" : "zmodel",
            behaviorSource: "sql",
            generatedPaths: [...(sqlFirst ? ["db/schema.ts"] : ["zenstack/generated/"]), "generated/", "bootstrap/schema.sql", "output/database-audit/"],
            protectedPaths: ["migrations/", "supabase/migrations/", "generated/"],
            forwardMigrationPath: sqlFirst ? "supabase/migrations/<timestamp>_<intent>.sql" : "migrations/<timestamp>_<intent>.sql",
            rules: [
                "Edit the selected maintained source, not a generated snapshot.",
                ...(sqlFirst ? ["Author structure in supabase/schemas SQL; derive query models, never run a second migration generator."] : []),
                "Keep RPC, RLS, trigger and grant behavior in explicit SQL sources.",
                "Adopt an existing database from a generated candidate: pull a model candidate, review policies, then promote it to the maintained source; never build from unreviewed introspection.",
                "Create a new forward migration; never rewrite an applied migration.",
                "Run lint, focused behavior tests and catalog reconciliation after edits.",
            ],
        },
        verification: [
            "supacloud db lint --module_file db/modules.ts",
            "supacloud db explain --target <object>",
            "supacloud db module_check --module_file db/modules.ts --database_url \"$DATABASE_URL\"",
        ],
    };
}

/** Testable orchestration point: inject executor, read catalog, and reconcile against declared modules. */
export async function runModuleCheck(
    module: DatabaseModule,
    executor: QueryExecutor,
    schemas: string[] = ["public"],
): Promise<ReconcileReport> {
    const catalog = await readCatalog(executor, schemas);
    return reconcileModule(module, catalog);
}

function parseSchemas(schema: string | undefined): string[] {
    const schemas = schema?.split(",").map((entry) => entry.trim()).filter(Boolean);
    return schemas && schemas.length > 0 ? schemas : ["public"];
}

async function collectLintIssues(
    args: DbToolArguments,
    root: string,
): Promise<{ selected: DatabaseModule[]; issues: LintIssue[] }> {
    const modules = await loadDatabaseModules(root, args.module_file);
    const selected = args.module ? modules.filter((module) => module.name === args.module) : modules;
    if (args.module && selected.length === 0) {
        throw new Error(`未找到数据库模块: ${args.module}（可用: ${modules.map((module) => module.name).join(", ") || "none"}）`);
    }
    const issues: LintIssue[] = [];
    for (const module of selected) {
        const readSqlFile = async (path: string): Promise<string> => {
            const absolute = resolve(root, path);
            try {
                return await Bun.file(absolute).text();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`SQL 源文件不可读: ${absolute}（声明于模块 ${module.name}）: ${message}`);
            }
        };
        issues.push(...await lintModule(module, readSqlFile));
    }
    return { selected, issues };
}

async function runLint(args: DbToolArguments, root: string): Promise<ToolResult> {
    const { selected, issues } = await collectLintIssues(args, root);
    const hasError = issues.some((issue) => issue.severity === "error");
    const header = `linted ${selected.length} module(s): ${selected.map((module) => module.name).join(", ")}`;
    const body = issues.length > 0 ? issues.map(formatLintIssue).join("\n") : "no issues";
    return textResult(`${header}\n${body}`, hasError);
}

interface DatabaseCheckEntry {
    name: "source-contract" | "module-lint" | "catalog";
    ok?: boolean;
    skipped?: boolean;
    reason?: string;
    error?: string;
    findings?: unknown;
    issues?: string[];
    modules?: string[];
    output?: string;
}

async function runCheck(
    args: DbToolArguments,
    root: string,
    environment: NodeJS.ProcessEnv,
    spawn: LiteSpawn,
    liteBinary: string | null | undefined,
    options: DbGovernanceToolOptions,
): Promise<ToolResult> {
    const checks: DatabaseCheckEntry[] = [];
    let ok = true;

    if (existsSync(join(root, "database.sources.json"))) {
        try {
            const source = await databaseSources(root, "check");
            checks.push({ name: "source-contract", ok: source.ok, findings: source.findings });
            if (!source.ok) ok = false;
        } catch (error) {
            checks.push({ name: "source-contract", ok: false, error: error instanceof Error ? error.message : String(error) });
            ok = false;
        }
    } else {
        checks.push({ name: "source-contract", skipped: true, reason: "database.sources.json not found" });
    }

    const modulePath = args.module_file ? resolve(root, args.module_file) : join(root, "db/modules.ts");
    if (existsSync(modulePath)) {
        try {
            const { selected, issues } = await collectLintIssues(args, root);
            const lintOk = !issues.some((issue) => issue.severity === "error");
            checks.push({
                name: "module-lint",
                ok: lintOk,
                modules: selected.map((module) => module.name),
                ...(issues.length === 0 ? {} : { issues: issues.map(formatLintIssue) }),
            });
            if (!lintOk) ok = false;
        } catch (error) {
            checks.push({ name: "module-lint", ok: false, error: error instanceof Error ? error.message : String(error) });
            ok = false;
        }
    } else {
        checks.push({ name: "module-lint", skipped: true, reason: "db/modules.ts not found" });
    }

    const selectedDatabase = args.database_url?.trim() || environment.DATABASE_URL?.trim();
    if (selectedDatabase || args.lite || args.remote) {
        try {
            const catalog = await runModuleCheckAction(args, root, environment, spawn, liteBinary, options);
            checks.push({
                name: "catalog",
                ok: !catalog.isError,
                output: catalog.content.map((entry) => entry.text).join("\n"),
            });
            if (catalog.isError) ok = false;
        } catch (error) {
            checks.push({ name: "catalog", ok: false, error: error instanceof Error ? error.message : String(error) });
            ok = false;
        }
    } else {
        checks.push({ name: "catalog", skipped: true, reason: "no --database_url, DATABASE_URL, --lite or --remote" });
    }

    return textResult(JSON.stringify({
        version: 1,
        scope: "database-check",
        root,
        ok,
        checks,
    }, null, 2), !ok);
}

async function runExplain(args: DbToolArguments, root: string): Promise<ToolResult> {
    const target = args.target?.trim();
    if (!target) throw new Error("db explain requires --target（策略名 / 函数名 / 表名等）");
    const modules = await loadDatabaseModules(root, args.module_file);
    const manifest = buildDatabaseManifest(modules);
    const text = explainObject(manifest, target);
    return textResult(text, text.startsWith("未找到对象"));
}

async function runContext(args: DbToolArguments, root: string): Promise<ToolResult> {
    const modules = await loadDatabaseModules(root, args.module_file);
    return textResult(JSON.stringify(
        buildDatabaseAiContext(modules, root, args.module, args.target),
        null,
        2,
    ));
}

interface LiteSubprocessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

type LiteSpawn = (command: string[], cwd: string) => Promise<LiteSubprocessResult>;

const defaultLiteSpawn: LiteSpawn = async (command, cwd) => {
    const proc = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
};

async function runModuleCheckLite(
    args: DbToolArguments,
    root: string,
    spawn: LiteSpawn,
    liteBinary?: string | null,
): Promise<ToolResult> {
    const projectDir = resolve(args.project_dir?.trim() || root);
    const binary = liteBinary === undefined ? Bun.which("supacloud-lite") : liteBinary;
    if (!binary) {
        throw new Error("db module_check --lite 需要本机可用的 supacloud-lite（npm i -g @supacloud/lite，或加入 PATH）");
    }
    const command = [binary, "db", "check", "--project-dir", projectDir];
    if (args.module_file?.trim()) command.push("--module-file", resolve(root, args.module_file.trim()));
    const result = await spawn(command, projectDir);
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    return textResult(output || "lite db check 无输出", result.exitCode !== 0);
}

function remoteModuleManifest(modules: readonly DatabaseModule[]): Array<Record<string, unknown>> {
    return modules.map((module) => ({
        name: module.name,
        tables: module.tables,
        policies: module.policies.map((policy) => ({
            name: policy.name,
            table: policy.table,
            operation: policy.operation,
            roles: policy.roles,
            ...(policy.usingExpr === undefined ? {} : { usingExpr: policy.usingExpr }),
            ...(policy.checkExpr === undefined ? {} : { checkExpr: policy.checkExpr }),
        })),
        functions: module.functions.map((fn) => ({
            name: fn.name,
            security: fn.security,
            ...(fn.signature === undefined ? {} : { signature: fn.signature }),
        })),
        triggers: module.triggers.map((trigger) => ({
            name: trigger.name,
            table: trigger.table,
            ...(trigger.enabled === undefined ? {} : { enabled: trigger.enabled }),
        })),
        grants: module.grants.map((grant) => ({
            object: grant.object,
            privilege: grant.privilege,
            role: grant.role,
        })),
    }));
}

async function runModuleCheckRemote(
    args: DbToolArguments,
    root: string,
    options: DbGovernanceToolOptions,
): Promise<ToolResult> {
    const run = options.runDatabase?.();
    if (!run) throw new Error("db module_check --remote 需要 Management API context（SUPACLOUD_API_URL + SUPACLOUD_API_TOKEN）");
    const ref = args.ref?.trim() || options.projectRef?.trim();
    if (!ref) throw new Error("db module_check --remote 需要 --ref 或 SUPACLOUD_PROJECT_REF");
    const modules = await loadDatabaseModules(root, args.module_file);
    const schemas = args.schema?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? ["public"];
    return await run({
        action: "governance_check",
        ref,
        modules: remoteModuleManifest(modules),
        schemas,
    });
}

async function runRoleCheckRemote(
    args: DbToolArguments,
    options: DbGovernanceToolOptions,
): Promise<ToolResult> {
    const run = options.runDatabase?.();
    if (!run) throw new Error("db role_check --remote 需要 Management API context（SUPACLOUD_API_URL + SUPACLOUD_API_TOKEN）");
    const ref = args.ref?.trim() || options.projectRef?.trim();
    if (!ref) throw new Error("db role_check --remote 需要 --ref 或 SUPACLOUD_PROJECT_REF");
    const schemas = args.schema?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? ["public"];
    return await run({ action: "role_check", ref, schemas });
}

async function runModuleCheckAction(
    args: DbToolArguments,
    root: string,
    environment: NodeJS.ProcessEnv,
    spawn: LiteSpawn,
    liteBinary: string | null | undefined,
    options: DbGovernanceToolOptions,
): Promise<ToolResult> {
    if (args.lite && args.remote) throw new Error("db module_check 只能选择 --lite 或 --remote");
    if (args.remote) return runModuleCheckRemote(args, root, options);
    if (args.lite) return runModuleCheckLite(args, root, spawn, liteBinary);
    const databaseUrl = args.database_url?.trim() || environment.DATABASE_URL?.trim();
    if (!databaseUrl) {
        throw new Error("db module_check requires --database_url、环境变量 DATABASE_URL、--lite 或 --remote");
    }
    const modules = await loadDatabaseModules(root, args.module_file);
    const schemas = parseSchemas(args.schema);

    const client = new Bun.SQL(databaseUrl);
    const executor: QueryExecutor = {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
            return await client.unsafe(sql, params ?? []) as T[];
        },
    };
    try {
        const reports: ReconcileReport[] = [];
        for (const module of modules) {
            reports.push(await runModuleCheck(module, executor, schemas));
        }
        const hasError = reports.some((report) => !report.ok);
        return textResult(reports.map(formatReconcileReport).join("\n"), hasError);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`db module_check 无法读取数据库 catalog（${databaseUrl.replace(/\/\/[^@/]*@/, "//***@")}）: ${message}`);
    } finally {
        await client.close({ timeout: 0 }).catch(() => {});
    }
}

export function registerDbGovernanceTools(server: ToolServer, options: DbGovernanceToolOptions = {}): void {
    const environment = options.environment || process.env;
    const fallbackRoot = options.currentWorkingDirectory || process.cwd();
    const liteSpawn = options.liteSpawn || defaultLiteSpawn;
    registerTool(server,
        "db",
        "Database governance (@supacloud/db): inspect, reverse-adopt, diff, plan and apply through explicit source and migration boundaries. Actions: context, lint, explain, module_check, reverse, diff, plan, apply, role_check, role_sql",
        {
            action: withDescription(stringEnum(["context", "lint", "check", "explain", "module_check", "reverse", "diff", "plan", "apply", "role_check", "role_sql"]), "Database governance action"),
            module: optional(Type.String(), "[context/lint] Only select this manifest module (default: all)"),
            root: optional(Type.String(), "[*] Project root (default: current directory)"),
            module_file: optional(Type.String(), "[*] File exporting defineDatabaseModule(...) (default: <root>/db/modules.ts)"),
            target: optional(Type.String(), "[context/explain] Policy / function / table name to explain"),
            database_url: optional(Type.String(), "[module_check] Postgres connection URL (default: DATABASE_URL)"),
            schema: optional(Type.String(), "[module_check] Comma-separated schemas to inspect (default: public)"),
            lite: optional(Type.Boolean(), "[module_check] Reconcile against a local SupaCloud Lite project (runs supacloud-lite db check)"),
            remote: optional(Type.Boolean(), "[module_check/role_check] Use Management API without a local database URL"),
            project_dir: optional(Type.String(), "[module_check] Lite project directory (with --lite; default: --root)"),
            schema_dir: optional(Type.String(), "[diff] Maintained declarative SQL directory (default: supabase/schemas)"),
            db_major_version: optional(Type.Number(), "[reverse/diff] PostgreSQL shadow major version (default: 18); set only when matching a non-18 source"),
            out: optional(Type.String(), "[reverse/diff] Candidate output path (reverse requires a new directory)"),
            dir: optional(Type.String(), "[diff/plan/apply] Reviewed forward migration directory"),
            ref: optional(Type.String(), "[module_check/role_check/plan/apply] Target project ref (remote checks default to SUPACLOUD_PROJECT_REF)"),
            approved_digest: optional(Type.String(), "[apply] Exact digest returned by db plan"),
            application_role: optional(Type.String(), "[role_sql] Application database role"),
            migration_role: optional(Type.String(), "[role_sql] Privileged migration role"),
            database: optional(Type.String(), "[role_sql] PostgreSQL database name"),
        },
        async (request) => {
            const root = resolve(request.root || fallbackRoot);
            switch (request.action) {
                case "context": return runContext(request, root);
                case "lint": return runLint(request, root);
                case "check": return runCheck(request, root, environment, liteSpawn, options.liteBinary, options);
                case "explain": return runExplain(request, root);
                case "module_check": return runModuleCheckAction(request, root, environment, liteSpawn, options.liteBinary, options);
                case "role_check":
                    if (request.remote) return runRoleCheckRemote(request, options);
                    return runDbWorkflow({ ...request, action: request.action }, root, {
                        environment,
                        projectRef: options.projectRef,
                        apiUrl: options.apiUrl,
                        runDatabase: options.runDatabase,
                    });
                case "reverse":
                case "diff":
                case "plan":
                case "apply":
                case "role_sql":
                    return runDbWorkflow({ ...request, action: request.action }, root, {
                        environment,
                        projectRef: options.projectRef,
                        apiUrl: options.apiUrl,
                        runDatabase: options.runDatabase,
                    });
                default:
                    return textResult(`Unknown db action: ${String(request.action)}`, true);
            }
        },
    );
}
