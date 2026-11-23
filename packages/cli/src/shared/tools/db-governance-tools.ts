import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as ts from "@supacloud/db/typescript";
import { Type } from "typebox";
import {
    buildDatabaseManifest,
    explainObject,
    lintModule,
    normalizeOperationOwnership,
    readCatalog,
    reconcileModule,
  suggestOperationOwnership,
    type DatabaseModule,
    type LintIssue,
  type OperationOwnershipSuggestion,
    type OperationOwner,
    type QueryExecutor,
    type ReconcileReport,
    type TableOperation,
} from "@supacloud/db";
import { databaseSources } from "@supacloud/db/source-contracts";
import { runDbWorkflow, type DbWorkflowAction } from "./db-workflow";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolServer, type ToolResult } from "../tool-server";

export interface DbToolArguments {
    action: "context" | "lint" | "check" | "explain" | "module_check" | "operation-ownership" | DbWorkflowAction;
    /** Nested action for `db operation-ownership suggest|adopt`. */
    operation_action?: "suggest" | "adopt";
    module?: string;
    root?: string;
    module_file?: string;
    target?: string;
    operation?: TableOperation;
    owner?: OperationOwner;
    write?: boolean;
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
    kind: "table" | "policy" | "function" | "trigger" | "grant" | "operation";
    name: string;
    module: string;
    table?: string;
    operation?: TableOperation;
    owner?: OperationOwner;
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
    const tables = raw.tables ?? [];
    return {
        name: raw.name,
        tables,
        policies: raw.policies ?? [],
        functions: raw.functions ?? [],
        triggers: raw.triggers ?? [],
        grants: raw.grants ?? [],
        operationOwnership: normalizeOperationOwnership(raw.operationOwnership, tables),
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
        ...(module.operationOwnership ?? []).map((ownership) => ({
            kind: "operation" as const,
            name: `${ownership.table}.${ownership.operation}`,
            module: module.name,
            table: ownership.table,
            operation: ownership.operation,
            owner: ownership.owner,
            source: null,
            tests: [],
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

interface OwnershipSuggestionRecord extends OperationOwnershipSuggestion {
    module: string | null;
}

interface OwnershipSuggestionReport {
    version: 1;
    scope: "operation-ownership";
    action: "suggest";
    modules: string[];
    suggestions: OwnershipSuggestionRecord[];
    summary: {
        declared: number;
        suggested: number;
        ambiguous: number;
        unknown: number;
        adoptable: number;
    };
}

interface OwnershipAdoptionEntry {
    module: string;
    table: string;
    operation: TableOperation;
    owner: OperationOwner;
    source: "suggested" | "explicit";
    evidence: OperationOwnershipSuggestion["evidence"];
}

interface OwnershipAdoptionReport {
    version: 1;
    scope: "operation-ownership";
    action: "adopt";
    mode: "preview" | "write";
    moduleFile: string;
    sourceHash: string;
    changes: OwnershipAdoptionEntry[];
    skipped: Array<{
        table: string;
        operation: TableOperation;
        reason: string;
    }>;
}

function moduleForTable(modules: readonly DatabaseModule[], table: string): DatabaseModule | null {
    const owners = modules.filter((module) => module.tables.includes(table));
    return owners.length === 1 ? owners[0] ?? null : null;
}

function ownershipSuggestionReport(
    modules: readonly DatabaseModule[],
    selected: readonly DatabaseModule[],
): OwnershipSuggestionReport {
    const selectedNames = new Set(selected.map((module) => module.name));
    const suggestions = suggestOperationOwnership(modules)
        .filter((suggestion) => {
            const owners = modules.filter((module) => module.tables.includes(suggestion.table));
            return owners.some((module) => selectedNames.has(module.name));
        })
        .map((suggestion) => ({
            ...suggestion,
            module: moduleForTable(modules, suggestion.table)?.name ?? null,
        }));
    return {
        version: 1,
        scope: "operation-ownership",
        action: "suggest",
        modules: selected.map((module) => module.name),
        suggestions,
        summary: {
            declared: suggestions.filter((suggestion) => suggestion.status === "declared").length,
            suggested: suggestions.filter((suggestion) => suggestion.status === "suggested").length,
            ambiguous: suggestions.filter((suggestion) => suggestion.status === "ambiguous").length,
            unknown: suggestions.filter((suggestion) => suggestion.status === "unknown").length,
            adoptable: suggestions.filter((suggestion) =>
                suggestion.status === "suggested" && suggestion.owner !== null && suggestion.module !== null,
            ).length,
        },
    };
}

async function selectedDatabaseModules(
    args: DbToolArguments,
    root: string,
): Promise<{ modules: DatabaseModule[]; selected: DatabaseModule[]; modulePath: string }> {
    const modules = await loadDatabaseModules(root, args.module_file);
    const selected = args.module ? modules.filter((module) => module.name === args.module) : modules;
    if (args.module && selected.length === 0) {
        throw new Error(`未找到数据库模块: ${args.module}（可用: ${modules.map((module) => module.name).join(", ") || "none"}）`);
    }
    return {
        modules,
        selected,
        modulePath: resolve(root, args.module_file ?? "db/modules.ts"),
    };
}

function requireOwnershipAction(args: DbToolArguments): "suggest" | "adopt" {
    const action = args.operation_action;
    if (action !== "suggest" && action !== "adopt") {
        throw new Error("db operation-ownership requires suggest or adopt");
    }
    return action;
}

function explicitAdoption(
    args: DbToolArguments,
    modules: readonly DatabaseModule[],
): OwnershipAdoptionEntry | null {
    const hasExplicitOwner = args.owner !== undefined || args.operation !== undefined || args.target !== undefined;
    if (!hasExplicitOwner) return null;
    if (args.owner === undefined || args.operation === undefined || !args.target?.trim()) {
        throw new Error("显式 adopt 需要同时提供 --target、--operation 和 --owner");
    }
    const module = moduleForTable(modules, args.target.trim());
    if (module === null) {
        throw new Error(`无法唯一确定表所属模块: ${args.target.trim()}（表必须只由一个模块声明）`);
    }
    if ((module.operationOwnership ?? []).some((entry) =>
        entry.table === args.target!.trim() && entry.operation === args.operation,
    )) {
        throw new Error(`已存在 operation ownership: ${args.target.trim()}.${args.operation}`);
    }
    return {
        module: module.name,
        table: args.target.trim(),
        operation: args.operation,
        owner: args.owner,
        source: "explicit",
        evidence: [{
            kind: "declaration",
            detail: `explicit adopt: ${args.target.trim()}.${args.operation} = ${args.owner}`,
        }],
    };
}

function adoptionEntries(
    args: DbToolArguments,
    modules: readonly DatabaseModule[],
    selected: readonly DatabaseModule[],
): { changes: OwnershipAdoptionEntry[]; skipped: OwnershipAdoptionReport["skipped"] } {
    const explicit = explicitAdoption(args, modules);
    if (explicit !== null) {
        if (!selected.some((module) => module.name === explicit.module)) {
            throw new Error(`模块 ${explicit.module} 不在当前 --module 范围内`);
        }
        return { changes: [explicit], skipped: [] };
    }
    const selectedNames = new Set(selected.map((module) => module.name));
    const changes: OwnershipAdoptionEntry[] = [];
    const skipped: OwnershipAdoptionReport["skipped"] = [];
    for (const suggestion of suggestOperationOwnership(modules)) {
        const module = moduleForTable(modules, suggestion.table);
        const owners = modules.filter((candidate) => candidate.tables.includes(suggestion.table));
        if (module === null) {
            if (owners.some((candidate) => selectedNames.has(candidate.name))) {
                skipped.push({
                    table: suggestion.table,
                    operation: suggestion.operation,
                    reason: "table is declared by multiple modules; resolve module ownership first",
                });
            }
            continue;
        }
        if (!selectedNames.has(module.name)) continue;
        if (suggestion.status === "suggested" && suggestion.owner !== null) {
            changes.push({
                module: module.name,
                table: suggestion.table,
                operation: suggestion.operation,
                owner: suggestion.owner,
                source: "suggested",
                evidence: suggestion.evidence,
            });
            continue;
        }
        if (suggestion.status !== "declared") {
            skipped.push({
                table: suggestion.table,
                operation: suggestion.operation,
                reason: suggestion.status === "ambiguous"
                    ? "ambiguous evidence; choose --owner explicitly"
                    : "no ownership evidence; choose --owner explicitly",
            });
        }
    }
    return { changes, skipped };
}

interface ModuleObjectNode {
    name: string;
    object: ts.ObjectLiteralExpression;
}

function staticProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
    const properties = object.properties.filter((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        && property.name.text === name,
    );
    if (properties.length > 1) throw new Error(`数据库模块存在重复 '${name}' 属性`);
    return properties[0];
}

async function parseSource(file: string, content: string): Promise<ts.SourceFile> {
    const source = await ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics = await ts.transpileModule(content, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext },
    });
    if (diagnostics.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) {
        throw new Error(`数据库模块源文件语法无效: ${file}`);
    }
    return source;
}

async function findModuleObjects(file: string, content: string): Promise<ModuleObjectNode[]> {
    const source = await parseSource(file, content);
    const result: ModuleObjectNode[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
            const name = staticProperty(node, "name")?.initializer;
            const tables = staticProperty(node, "tables");
            if (name && ts.isStringLiteral(name) && tables && ts.isArrayLiteralExpression(tables.initializer)) {
                result.push({ name: name.text, object: node });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
}

function lineIndent(source: string, position: number): string {
    const lineStart = source.lastIndexOf("\n", position - 1) + 1;
    return source.slice(lineStart, position).match(/^[ \t]*/)?.[0] ?? "";
}

function entryText(entry: OwnershipAdoptionEntry): string {
    return `{ table: ${JSON.stringify(entry.table)}, operation: ${JSON.stringify(entry.operation)}, owner: ${JSON.stringify(entry.owner)} }`;
}

async function editOperationOwnershipSource(
    file: string,
    original: string,
    changes: readonly OwnershipAdoptionEntry[],
): Promise<string> {
    const modules = await findModuleObjects(file, original);
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const group of new Set(changes.map((change) => change.module))) {
        const moduleChanges = changes.filter((change) => change.module === group);
        const moduleNode = modules.find((module) => module.name === group);
        if (!moduleNode) throw new Error(`源文件中找不到数据库模块: ${group}`);
        const ownership = staticProperty(moduleNode.object, "operationOwnership");
        const objectIndent = lineIndent(original, moduleNode.object.getStart());
        const propertyIndent = `${objectIndent}  `;
        const values = moduleChanges.map(entryText);
        if (ownership) {
            if (!ts.isArrayLiteralExpression(ownership.initializer)) {
                throw new Error(`模块 ${group} 的 operationOwnership 必须是静态数组`);
            }
            const arrayIndent = lineIndent(original, ownership.getStart());
            const entryIndent = `${arrayIndent}  `;
            const existing = ownership.initializer.elements.map((element) =>
                original.slice(element.getStart(), element.end).trim(),
            );
            const all = [...existing, ...values];
            const replacement = `[\n${all.map((value) => `${entryIndent}${value}`).join(",\n")}\n${arrayIndent}]`;
            edits.push({
                start: ownership.initializer.getStart(),
                end: ownership.initializer.end,
                text: replacement,
            });
            continue;
        }
        const hasProperties = moduleNode.object.properties.length > 0;
        const separator = hasProperties && !moduleNode.object.properties.hasTrailingComma ? "," : "";
        const replacement = `${separator}\n${propertyIndent}operationOwnership: [\n${values
            .map((value) => `${propertyIndent}  ${value}`)
            .join(",\n")}\n${propertyIndent}]\n${objectIndent}`;
        edits.push({
            start: moduleNode.object.end - 1,
            end: moduleNode.object.end - 1,
            text: replacement,
        });
    }
    return edits
        .sort((left, right) => right.start - left.start)
        .reduce((content, edit) => content.slice(0, edit.start) + edit.text + content.slice(edit.end), original);
}

async function runOperationOwnershipSuggest(args: DbToolArguments, root: string): Promise<ToolResult> {
    const { modules, selected } = await selectedDatabaseModules(args, root);
    return textResult(JSON.stringify(ownershipSuggestionReport(modules, selected), null, 2));
}

async function runOperationOwnershipAdopt(args: DbToolArguments, root: string): Promise<ToolResult> {
    const { modules, selected, modulePath } = await selectedDatabaseModules(args, root);
    const { changes, skipped } = adoptionEntries(args, modules, selected);
    const stat = await lstat(modulePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`模块文件必须是普通文件: ${modulePath}`);
    const original = await readFile(modulePath, "utf8");
    const sourceHash = createHash("sha256").update(original).digest("hex");
    const updated = changes.length > 0
        ? await editOperationOwnershipSource(modulePath, original, changes)
        : original;
    const mode = args.write === true ? "write" : "preview";
    if (args.write === true && updated !== original) {
        if (await readFile(modulePath, "utf8") !== original) {
            throw new Error("模块文件在 adopt 期间发生变化，请重新执行 suggest");
        }
        const temporary = `${modulePath}.supacloud-ownership-${randomUUID()}`;
        try {
            await writeFile(temporary, updated, { encoding: "utf8", flag: "wx", mode: stat.mode });
            await rename(temporary, modulePath);
        } finally {
            await unlink(temporary).catch(() => {});
        }
    }
    const report: OwnershipAdoptionReport = {
        version: 1,
        scope: "operation-ownership",
        action: "adopt",
        mode,
        moduleFile: modulePath,
        sourceHash,
        changes,
        skipped,
    };
    return textResult(JSON.stringify(report, null, 2), changes.length === 0 && skipped.length > 0 ? false : undefined);
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
        operationOwnership: (module.operationOwnership ?? []).map((ownership) => ({
            table: ownership.table,
            operation: ownership.operation,
            owner: ownership.owner,
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
        "Database governance (@supacloud/db): inspect, reverse-adopt, diff, plan and apply through explicit source and migration boundaries. Actions: context, lint, check, explain, module_check, operation-ownership suggest|adopt, reverse, diff, plan, apply, role_check, role_sql",
        {
            action: withDescription(stringEnum(["context", "lint", "check", "explain", "module_check", "operation-ownership", "reverse", "diff", "plan", "apply", "role_check", "role_sql"]), "Database governance action"),
            operation_action: optional(stringEnum(["suggest", "adopt"]), "[operation-ownership] Nested action"),
            module: optional(Type.String(), "[context/lint] Only select this manifest module (default: all)"),
            root: optional(Type.String(), "[*] Project root (default: current directory)"),
            module_file: optional(Type.String(), "[*] File exporting defineDatabaseModule(...) (default: <root>/db/modules.ts)"),
            target: optional(Type.String(), "[context/explain/operation-ownership] Policy / function / table name; adopt uses a table"),
            operation: optional(stringEnum(["select", "insert", "update", "delete"]), "[operation-ownership adopt] Table operation for explicit adoption"),
            owner: optional(stringEnum(["postgrest-data-api", "durable-command", "governed-sql-rpc", "legacy-rpc"]), "[operation-ownership adopt] Explicit owner; required for ambiguous/unknown operations"),
            write: optional(Type.Boolean(), "[operation-ownership adopt] Write the previewed ownership declarations (default: preview only)"),
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
                case "operation-ownership": {
                    const operationAction = requireOwnershipAction(request);
                    return operationAction === "suggest"
                        ? runOperationOwnershipSuggest(request, root)
                        : runOperationOwnershipAdopt(request, root);
                }
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
