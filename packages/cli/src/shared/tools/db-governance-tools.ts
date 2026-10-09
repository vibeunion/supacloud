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
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (requestArguments: DbToolArguments) => Promise<unknown>,
    ) => void;
};

export interface DbToolArguments {
    action: "context" | "lint" | "explain" | "module_check";
    module?: string;
    root?: string;
    module_file?: string;
    target?: string;
    database_url?: string;
    schema?: string;
    lite?: boolean;
    project_dir?: string;
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
        structureSource: "drizzle";
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
}

interface ToolResult {
    isError: boolean;
    content: Array<{ type: "text"; text: string }>;
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
    return {
        version: 1,
        scope: "database-ai-context",
        root,
        selectedModules: selected.map((module) => module.name),
        target: target ?? null,
        objects,
        maintenance: {
            structureSource: "drizzle",
            behaviorSource: "sql",
            generatedPaths: ["generated/", "bootstrap/schema.sql", "output/database-audit/"],
            protectedPaths: ["migrations/", "supabase/migrations/", "generated/"],
            forwardMigrationPath: "migrations/<timestamp>_<intent>.sql",
            rules: [
                "Edit the selected maintained source, not a generated snapshot.",
                "Keep RPC, RLS, trigger and grant behavior in explicit SQL sources.",
                "Create a new forward migration; never rewrite an applied migration.",
                "Run lint, focused behavior tests and catalog reconciliation after edits.",
            ],
        },
        verification: [
            "supacloud-cli db lint --module_file db/modules.ts",
            "supacloud-cli db explain --target <object>",
            "supacloud-cli db module_check --module_file db/modules.ts --database_url \"$DATABASE_URL\"",
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

async function runLint(args: DbToolArguments, root: string): Promise<ToolResult> {
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
    const hasError = issues.some((issue) => issue.severity === "error");
    const header = `linted ${selected.length} module(s): ${selected.map((module) => module.name).join(", ")}`;
    const body = issues.length > 0 ? issues.map(formatLintIssue).join("\n") : "no issues";
    return textResult(`${header}\n${body}`, hasError);
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

async function runModuleCheckAction(
    args: DbToolArguments,
    root: string,
    environment: NodeJS.ProcessEnv,
    spawn: LiteSpawn,
    liteBinary?: string | null,
): Promise<ToolResult> {
    if (args.lite) return runModuleCheckLite(args, root, spawn, liteBinary);
    const databaseUrl = args.database_url?.trim() || environment.DATABASE_URL?.trim();
    if (!databaseUrl) {
        throw new Error("db module_check requires --database_url、环境变量 DATABASE_URL 或 --lite");
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
    server.tool(
        "db",
        "Local database governance (@supacloud/db): provide bounded AI context, lint declared modules, explain objects, reconcile against a live catalog or a local SupaCloud Lite project. Actions: context, lint, explain, module_check",
        {
            action: withDescription(stringEnum(["context", "lint", "explain", "module_check"]), "Database governance action"),
            module: optional(Type.String(), "[context/lint] Only select this manifest module (default: all)"),
            root: optional(Type.String(), "[*] Project root (default: current directory)"),
            module_file: optional(Type.String(), "[*] File exporting defineDatabaseModule(...) (default: <root>/db/modules.ts)"),
            target: optional(Type.String(), "[context/explain] Policy / function / table name to explain"),
            database_url: optional(Type.String(), "[module_check] Postgres connection URL (default: DATABASE_URL)"),
            schema: optional(Type.String(), "[module_check] Comma-separated schemas to inspect (default: public)"),
            lite: optional(Type.Boolean(), "[module_check] Reconcile against a local SupaCloud Lite project (runs supacloud-lite db check)"),
            project_dir: optional(Type.String(), "[module_check] Lite project directory (with --lite; default: --root)"),
        },
        async (request) => {
            const root = resolve(request.root || fallbackRoot);
            switch (request.action) {
                case "context": return runContext(request, root);
                case "lint": return runLint(request, root);
                case "explain": return runExplain(request, root);
                case "module_check": return runModuleCheckAction(request, root, environment, liteSpawn, options.liteBinary);
                default:
                    return textResult(`Unknown db action: ${String(request.action)}`, true);
            }
        },
    );
}
