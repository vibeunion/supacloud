import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ApplicationActivationHistorySchema, parseApplicationActivationHistory } from "@supacloud/delivery";
import { parseApplicationDeployPlan } from "@supacloud/delivery";
import { parseApplicationReleaseTransferPlan, parseApplicationReleaseTransferResult, parseApplicationPromotionPlan } from "@supacloud/delivery";
import {
    applyDiagnosticFix,
    buildDeliveryProject,
    checkProject,
    compileProject,
    compileOptionsFromConfig,
    createContextPack,
    createDiagnosticRepairPlan,
    doctorProject,
    loadSupacloudConfig,
    formatDeliveryPlan,
    planDeliveryProject,
    resolveSupacloudConfig,
    watchProject,
    type Diagnostic,
    type ModuleNode,
} from "@supacloud/compiler";
import { optional, stringEnum, validateToolArguments, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolServer } from "../tool-server";
import { buildToolDefinitions, type AppManifest } from "./app-tool-export";
import { initializeAppProject } from "./app-starter";
import { checkAppDatabaseSources } from "./app-database-check";
import { APPLICATION_TOOL_SCHEMA } from "./application-tools";
import { RELEASE_CONTROL_RESPONSE_SCHEMA, releaseControlFailure } from "./release-control-response";
import { resourceScaffold } from "./app-resource";
import { runLocalDevelopment } from "./app-local-dev";
import { createVerificationPlan } from "./app-verification-plan";
import { applyScaffoldWrites, planScaffoldWrites, scaffoldPath, ScaffoldError, type ScaffoldWrite } from "./app-scaffold-writes";

const REMOTE_APP_ACTIONS = {
    upload: "upload_release",
    "transfer-plan": "get_release_transfer_plan",
    "promote-plan": "get_promotion_plan",
    transfer: "transfer_release",
    configure: "put_configuration",
    deploy: "deploy_release",
    "deploy-plan": "get_deploy_plan",
    diff: "get_deploy_plan",
    status: "get_runtime",
    rollback: "rollback_release",
    "rollback-plan": "get_rollback_snapshot",
    history: "get_history",
    reconcile: "reconcile_activation",
    retire: "retire_activation",
    logs: "logs",
    "preview-plan": "get_preview_plan",
    preview: "create_preview",
    previews: "list_previews",
    "preview-status": "get_preview",
    "preview-cleanup": "cleanup_preview",
} as const;

export interface AppToolOptions {
    getApplications?: () => ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
    projectRef?: string;
    /** Abort signal for long-running local actions (`app dev` watch), used for cancellation and tests. */
    signal?: AbortSignal;
    /** Watch progress only. The caller owns its transport; the final result is returned separately. */
    onDevProgress?: (result: ToolResult) => void;
}

const REMOTE_APP_DESCRIPTIONS: Record<string, string> = {
    ref: "[upload/configure/transfer-plan/transfer/promote-plan/deploy/deploy-plan/diff/status/rollback/rollback-plan/history/reconcile/retire/preview-plan/preview/previews/preview-status/preview-cleanup] Project ref (defaults to context)",
    id: "[upload/configure/transfer-plan/transfer/promote-plan/deploy/deploy-plan/diff/status/rollback/rollback-plan/history/reconcile/retire/preview-plan/preview/previews/preview-status/preview-cleanup] Application ID",
    environment_id: "[configure/promote-plan/deploy/deploy-plan/diff/status/rollback/rollback-plan/history/reconcile/retire/preview-plan/preview/previews/preview-status/preview-cleanup] Target environment ID",
    configuration_id: "[promote-plan/deploy/deploy-plan/diff/rollback/preview] Immutable target configuration revision; required for deployment/preview; platform selects for default rollback",
    activation_id: "[deploy/rollback/reconcile/retire] Stable activation ID; auto-generated for deploy/rollback if omitted",
    expected_activation_id: "[deploy/rollback] Auto-selected from verified state; supply with activation_id for an exact retry",
    configuration_path: "[configure] Configuration write JSON including revision and expected revision",
    manifest_path: "[upload] Local delivery.manifest.json",
    release_id: "[deploy/deploy-plan/diff/rollback/reconcile/preview-plan/preview] Required for deployment/preview; defaults to journal-selected previous for rollback",
    source_ref: "[transfer-plan/transfer/promote-plan] Source project ref",
    source_release_id: "[transfer-plan/transfer/promote-plan] Source immutable release ID",
    source_environment_id: "[promote-plan] Source environment ID",
    preview_id: "[preview-status/preview-cleanup] Preview receipt ID",
    branch_ref: "[preview-plan] Proposed branch ref; preview assigns its own",
    branch_name: "[preview] Branch display name",
    data_mode: "[preview-plan/preview] Default schema_only; full_clone copies rows",
    ttl_seconds: "[preview-plan/preview] Lifetime from 300 to 604800 seconds; creation defaults to the platform TTL",
    wait: "[preview/preview-status] Wait for verified readiness of the selected preview",
    timeout_seconds: "[preview/preview-status] Observation budget with --wait, from 1 to 3600 seconds (default 300)",
    cursor: "[history] Returned page cursor",
    limit: "[history] Page size, default 20 (1-100)",
};

const { action: _remoteAction, ...remoteFields } = APPLICATION_TOOL_SCHEMA;
const REMOTE_APP_SCHEMA = Type.Partial(Type.Object(remoteFields)).properties;
for (const [name, schema] of Object.entries(REMOTE_APP_SCHEMA)) {
    const description = REMOTE_APP_DESCRIPTIONS[name];
    if (description !== undefined) Object.assign(schema, { description });
}

export interface AppToolArguments {
    action: "init" | "generate" | "dev" | "watch" | "verify-plan" | "compile" | "check" | "graph" | "explain" | "export-tools" | "context" | "doctor" | "fix"
        | "plan" | "build" | keyof typeof REMOTE_APP_ACTIONS;
    ref?: string;
    id?: string;
    environment_id?: string;
    configuration_id?: string;
    activation_id?: string;
    expected_activation_id?: string | null;
    configuration_path?: string;
    manifest_path?: string;
    release_id?: string;
    source_ref?: string;
    source_release_id?: string;
    source_environment_id?: string;
    cursor?: string;
    limit?: number;
    preview_id?: string;
    branch_ref?: string;
    branch_name?: string;
    data_mode?: "schema_only" | "full_clone";
    ttl_seconds?: number;
    wait?: boolean;
    timeout_seconds?: number;
    kind?: "module" | "command" | "query" | "controller" | "job" | "contract" | "resource";
    template?: "minimal" | "http" | "command" | "edge";
    name?: string;
    module?: string;
    dir?: string;
    force?: boolean;
    dry_run?: boolean;
    register_in?: string;
    "dry-run"?: boolean;
    "register-in"?: string;
    root?: string;
    include?: string;
    out_dir?: string;
    strict?: boolean;
    format?: "text" | "json";
    json?: boolean;
    target?: string;
    fix?: string;
    write?: boolean;
    /** `app dev` local profile. `fast` is local/ephemeral; `integration` requires an explicit database URL. */
    profile?: "fast" | "integration";
    /** `app dev`: validate and report once without watching. */
    once?: boolean;
    /** `app dev`: watch for changes (default true; `--once` disables). */
    watch?: boolean;
    /** Integration dev verifies an explicit loopback database before running dev:integration. */
    database_url?: string;
    "database-url"?: string;
    offset?: number;
    service?: string;
    search?: string;
    start?: string;
    end?: string;
}

async function initProject(args: AppToolArguments): Promise<ToolResult> {
    if (args.force) throw new Error("app init never overwrites files; choose an empty directory");
    const template = args.template ?? "minimal";
    const { root, name, files } = await initializeAppProject({ root: args.root, name: args.name, template });
    return textResult([
        `Initialized ${name} in ${root} (${files.length} files, template: ${template}).`,
        `cd '${root.replaceAll("'", "'\\''")}'`,
        "bun install",
        ...(template === "command" ? ["bun run db:generate"] : []),
        "bun run check",
        "bun run dev",
        "Local demo only. Production requires persistent governance and identity adapters; see README.md.",
    ].join("\n"));
}

export interface ToolResult {
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
}

function textResult(text: string, isError = false): ToolResult {
    return { isError, content: [{ type: "text" as const, text }] };
}

/** kebab/snake/space-separated name -> PascalCase (class name for generate). */
function pascalName(name: string): string {
    const joined = name
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
    return joined || "App";
}

/** kebab-case -> camelCase (semantic name suffix for command/query). */
function camelName(name: string): string {
    const pascal = pascalName(name);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function requireIdentifier(value: string | undefined, flag: string): string {
    const trimmed = value?.trim();
    if (!trimmed) throw new Error(`app generate requires --${flag}`);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) {
        throw new Error(`Invalid --${flag} value: ${value}`);
    }
    return trimmed;
}

function moduleScaffold(name: string): string {
    return `import { Module } from "@supacloud/app";

@Module({
    name: ${JSON.stringify(name)},
    tags: ["type:feature"],
    providers: [],
})
export class ${pascalName(name)}Module {}
`;
}

function commandScaffold(moduleName: string, name: string): string {
    return `import { Command, Injectable } from "@supacloud/app";

@Injectable()
@Command({
    name: ${JSON.stringify(`${moduleName}.${camelName(name)}`)},
    permission: ${JSON.stringify(`${moduleName}.${camelName(name)}`)},
})
export class ${pascalName(name)}Command {
    execute(): void {
        throw new Error("Implement ${pascalName(name)}Command.execute before exposing this command");
    }
}
`;
}

function queryScaffold(moduleName: string, name: string): string {
    return `import { Injectable, Query } from "@supacloud/app";

@Injectable()
@Query({ name: ${JSON.stringify(`${moduleName}.${camelName(name)}`)} })
export class ${pascalName(name)}Query {}
`;
}

function controllerScaffold(moduleName: string): string {
    return `import { Controller } from "@supacloud/app";

@Controller("/${moduleName}")
export class ${pascalName(moduleName)}Controller {}
`;
}

function jobScaffold(moduleName: string, name: string): string {
    return `import { Injectable, Job } from "@supacloud/app";

@Injectable()
@Job({
    name: ${JSON.stringify(`${moduleName}.${camelName(name)}`)},
    mode: "task",
    // Optional: declare input/output TypeBox schemas for a validated, typed job boundary.
})
export class ${pascalName(name)}Job {
    run(): Promise<void> {
        throw new Error("Implement ${pascalName(name)}Job.run before dispatching this job");
    }
}
`;
}

function contractScaffold(moduleName: string, name: string): string {
    const prefix = pascalName(name);
    return `import { t } from "elysia";

/**
 * Input/output contract for ${moduleName}.${camelName(name)}.
 * Keep these shapes explicit and reuse them in route schemas and command decoders;
 * never widen them to unknown just to accept unvalidated request data.
 */
export const ${prefix}Body = t.Object({});
export const ${prefix}Response = t.Object({});
`;
}

async function generateScaffold(args: AppToolArguments): Promise<ToolResult> {
    const kind = args.kind;
    if (!kind || !["module", "command", "query", "controller", "job", "contract", "resource"].includes(kind)) {
        throw new ScaffoldError("SCAFFOLD_KIND_INVALID", "app generate requires --kind (module|command|query|controller|job|contract|resource)");
    }
    for (const flag of ["dry_run", "force"] as const) {
        if (args[flag] !== undefined && typeof args[flag] !== "boolean") {
            throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", `--${flag.replaceAll("_", "-")} must be boolean`);
        }
    }
    const root = resolve(args.root || process.cwd());
    const dir = args.dir ?? "src/features";
    if (dir !== ".") scaffoldPath(root, dir);
    if (args.register_in !== undefined && kind !== "resource" && kind !== "module") {
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "--register-in is only supported for a new module or resource");
    }
    if (kind === "resource" && (args.force || args.module !== undefined)) {
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "resource creates its own module; use --name and optionally --register-in, never --force or --module");
    }
    const writes: ScaffoldWrite[] = [];
    let modulePath: string | undefined;
    let moduleSymbol: string | undefined;
    let contractName: string | undefined;
    if (kind === "module" || kind === "resource") {
        const name = requireIdentifier(args.name, "name");
        modulePath = join(dir, name, `${name}.module.ts`).replaceAll("\\", "/");
        moduleSymbol = `${pascalName(name)}Module`;
        if (kind === "module") writes.push({ path: modulePath, content: moduleScaffold(name), overwrite: args.force === true });
        else for (const [file, content] of Object.entries(resourceScaffold(name, pascalName(name)))) {
            writes.push({ path: join(dir, name, file).replaceAll("\\", "/"), content });
        }
    } else {
        const moduleName = requireIdentifier(args.module, "module");
        const name = kind === "controller" ? moduleName : requireIdentifier(args.name, "name");
        const subdir = kind === "command" ? "commands" : kind === "query" ? "queries" : kind === "job" ? "jobs" : kind === "contract" ? "contracts" : "";
        const path = join(dir, moduleName, subdir, `${name}.${kind}.ts`).replaceAll("\\", "/");
        if (kind === "controller" && existsSync(scaffoldPath(root, path))) {
            throw new ScaffoldError("SCAFFOLD_EXISTS", `Controller already exists: ${path}（请手工合并路由到现有 controller）`);
        }
        const content = kind === "command" ? commandScaffold(moduleName, name)
            : kind === "query" ? queryScaffold(moduleName, name)
            : kind === "job" ? jobScaffold(moduleName, name)
            : kind === "contract" ? contractScaffold(moduleName, name)
            : controllerScaffold(moduleName);
        writes.push({ path, content, overwrite: args.force === true });
        if (kind === "contract") contractName = name;
    }
    if (args.register_in !== undefined && modulePath && moduleSymbol) {
        await planScaffoldWrites(root, writes);
        // Reuse the compiler's AST edit; never regex-edit a user's module or
        // execute application code to discover where a new module belongs.
        const target = scaffoldPath(root, args.register_in);
        const checked = await planScaffoldWrites(root, [{ path: args.register_in, content: "", overwrite: true }]);
        const original = checked.writes[0]?.before?.content;
        if (original === undefined) throw new ScaffoldError("SCAFFOLD_REGISTRATION_INVALID", "--register-in must name an existing module file");
        if (new RegExp(`\\b${moduleSymbol}\\b`).test(original)) {
            throw new ScaffoldError("SCAFFOLD_REGISTRATION_CONFLICT", `Registration target already references ${moduleSymbol}; review the import manually`);
        }
        let importPath = relative(dirname(target), resolve(root, modulePath)).replaceAll("\\", "/").replace(/\.ts$/, "");
        if (!importPath.startsWith(".")) importPath = `./${importPath}`;
        const edit = await applyDiagnosticFix({
            type: "add_module_import", targetFile: args.register_in, module: requireIdentifier(args.name, "name"), importPath, symbol: moduleSymbol,
        }, { rootDir: root, dryRun: true });
        if (await readFile(target, "utf8") !== original) throw new ScaffoldError("SCAFFOLD_CHANGED", "Registration source changed during planning");
        writes.push({ path: args.register_in, content: edit.content, expected: original });
    }
    const plan = await planScaffoldWrites(root, writes);
    if (!args.dry_run) await applyScaffoldWrites(plan);
    const changes = plan.writes.map((write) => ({
        path: write.path.replaceAll("\\", "/"),
        action: write.before ? "overwritten" : "created",
        ...(args.dry_run ? { content: write.content } : {}),
    }));
    if (args.format === "json") return textResult(JSON.stringify({
        version: 1, ok: true, kind, root: plan.root, written: !args.dry_run, changes,
    }, null, 2));
    const lines = changes.map((change) => `${args.dry_run ? "PREVIEW" : "✅"} ${change.action}: ${join(plan.root, change.path)}`);
    if (args.dry_run) lines.push("No files written. Omit --dry-run to apply this generation.");
    if (kind === "resource") lines.push(
        "Service and controller are registered in the generated module. No root module is guessed.",
        "Use --register-in <module.ts> to add an explicit parent import. Implement the read port before exposing the resource.",
        "Run app compile, app check --format json and your tests. No writes, permissions or persistence are inferred.",
    );
    if (contractName) {
        const prefix = pascalName(contractName);
        lines.push("", "Next, bind the contract to a route so the compiler can check route/schema drift:",
            `  import { ${prefix}Body, ${prefix}Response } from "./contracts/${contractName}.contract";`,
            `  @Post("/", { body: ${prefix}Body, responses: { 200: ${prefix}Response } })`,
            "Fill in the schema fields and reuse them in command decoders; never widen them to unknown.");
    }
    return textResult(lines.join("\n"));
}

function formatDiagnostic(diagnostic: Diagnostic): string {
    const code = diagnostic.errorCode && diagnostic.errorCode !== diagnostic.code
        ? `${diagnostic.code} (${diagnostic.errorCode})`
        : diagnostic.code;
    const location = diagnostic.file
        ? ` ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`
        : "";
    const lines = [`${diagnostic.severity} ${code}${location} ${diagnostic.message}`];
    if (diagnostic.suggestion) lines.push(`  hint: ${diagnostic.suggestion}`);
    if (diagnostic.docsUrl) lines.push(`  docs: ${diagnostic.docsUrl}`);
    if (diagnostic.fix) lines.push(`  fixable: ${diagnostic.fix.type}; apply with \`supacloud app fix --fix <file.json> --write\``);
    return lines.join("\n");
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) return "no diagnostics";
    return diagnostics.map(formatDiagnostic).join("\n");
}

function parseInclude(include: string | undefined): string[] | undefined {
    const patterns = include?.split(",").map((entry) => entry.trim()).filter(Boolean);
    return patterns && patterns.length > 0 ? patterns : undefined;
}

function sourceRoot(args: AppToolArguments, root: string, configured: string | undefined): string | undefined {
    const hasConfig = ["ts", "mts", "js", "mjs"].some((extension) =>
        existsSync(join(root, `supacloud.config.${extension}`)));
    // Preserve the legacy explicit source-directory form in unconfigured projects.
    return args.root && !hasConfig ? "." : configured;
}

/** Resolves project root/config and runs a no-write check to obtain the current graph. */
async function projectCompileConfig(args: AppToolArguments): Promise<{
    root: string;
    sourceDir: string;
    configFile: string | null;
    outDir: string;
    result: Awaited<ReturnType<typeof checkProject>>;
}> {
    const root = resolve(args.root || process.cwd());
    const configFile = ["ts", "mts", "js", "mjs"]
        .map((extension) => join(root, `supacloud.config.${extension}`))
        .find((candidate) => existsSync(candidate)) ?? null;
    const loadedConfig = await loadSupacloudConfig(root);
    const defaults = resolveSupacloudConfig(loadedConfig, root);
    const configuredRoot = sourceRoot(args, root, loadedConfig.root);
    const include = parseInclude(args.include) ?? loadedConfig.include;
    const outDir = args.out_dir ? resolve(root, args.out_dir) : defaults.outDir;
    const compileOptions = compileOptionsFromConfig({
        ...loadedConfig,
        ...(configuredRoot === undefined ? {} : { root: configuredRoot }),
        outDir,
        ...(include === undefined ? {} : { include }),
        strict: args.strict ?? loadedConfig.strict ?? false,
    }, root);
    const result = await checkProject(compileOptions);
    return { root, sourceDir: compileOptions.rootDir, configFile, outDir, result };
}

interface ProjectContextPack {
    version: 1;
    root: string;
    configFile: string | null;
    generatedDir: string;
    modules: ModuleNode[];
    externalTokens: string[];
    diagnostics: Diagnostic[];
    allowedDependencies: { dependencies: string[]; devDependencies: string[] };
    commands: Record<string, string>;
}

/** Declared package dependencies, so an agent can tell allowed imports from new packages. */
async function readAllowedDependencies(root: string): Promise<{ dependencies: string[]; devDependencies: string[] }> {
    const path = join(root, "package.json");
    if (!existsSync(path)) return { dependencies: [], devDependencies: [] };
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        return {
            dependencies: Object.keys(parsed.dependencies ?? {}).sort(),
            devDependencies: Object.keys(parsed.devDependencies ?? {}).sort(),
        };
    } catch {
        return { dependencies: [], devDependencies: [] };
    }
}

function formatModuleContextPack(pack: ReturnType<typeof createContextPack>): string {
    return [
        `CONTEXT ${pack.subject}`,
        `  modules: ${pack.modules.map((module) => module.name).join(", ") || "-"}`,
        `  files: ${pack.files.join(", ") || "-"}`,
        `  external tokens: ${pack.externalTokens.join(", ") || "-"}`,
        `  imports: ${pack.relatedModules.imports.join(", ") || "-"}`,
        `  imported by: ${pack.relatedModules.importedBy.join(", ") || "-"}`,
        ...(pack.graphql ? [
            `  graphql schema: ${pack.graphql.schema}`,
            `  graphql queries: ${pack.graphql.operations.map((operation) => operation.name).join(", ") || "-"}`,
        ] : []),
        ...pack.executionPlans.map((plan) => `  execution ${plan.name}: ${plan.stages.join(" -> ")}`),
        ...pack.diagnostics.map(formatDiagnostic),
    ].join("\n");
}

/**
 * `app context` is the AI entry point: the compiled graph and diagnostics as
 * structured data, so an agent does not need to scan the repository. A
 * `--target <name>` resolves a module or owned symbol to its module neighborhood.
 */
async function runContext(args: AppToolArguments): Promise<ToolResult> {
    const { root, configFile, outDir, result } = await projectCompileConfig(args);
    const subject = args.target?.trim();
    if (subject) {
        const pack = createContextPack({ ...result.graph, diagnostics: result.diagnostics }, subject);
        return textResult(args.format === "json" ? JSON.stringify(pack, null, 2) : formatModuleContextPack(pack));
    }
    const project: ProjectContextPack = {
        version: 1,
        root,
        configFile,
        generatedDir: outDir,
        modules: result.graph.modules,
        externalTokens: result.graph.externalTokens,
        diagnostics: result.diagnostics,
        allowedDependencies: await readAllowedDependencies(root),
        commands: {
            check: "supacloud app check",
            compile: "supacloud app compile",
            context: "supacloud app context --format json",
            doctor: "supacloud app doctor",
            fix: "supacloud app fix --fix <fix.json>",
            graph: "supacloud app graph --format json",
            explain: "supacloud app explain --target <name>",
        },
    };
    if (args.format === "json") return textResult(JSON.stringify(project, null, 2));
    return textResult([
        `CONTEXT ${root}`,
        `  config: ${configFile ?? "(none)"}`,
        `  generated: ${outDir}`,
        `  modules: ${project.modules.map((module) => module.name).join(", ") || "-"}`,
        `  external tokens: ${project.externalTokens.join(", ") || "-"}`,
        `  dependencies: ${project.allowedDependencies.dependencies.join(", ") || "-"}`,
        ...project.diagnostics.map(formatDiagnostic),
    ].join("\n"));
}

function doctorFixPlan(doctor: ReturnType<typeof doctorProject>) {
    return createDiagnosticRepairPlan(doctor.diagnostics ?? [])
        .map((repair) => ({
            ...repair,
            command: "supacloud app fix --fix <fix.json>",
        }));
}

interface UnwiredContract {
    file: string;
    symbols: string[];
}

/**
 * Detects generated `*.contract.ts` schemas that no controller or barrel imports.
 * A contract that is never referenced is either dead code or a missing route
 * binding; both are worth surfacing before an agent trusts it as a boundary.
 */
async function findUnwiredContracts(rootDir: string): Promise<UnwiredContract[]> {
    const files: string[] = [];
    const skip = new Set(["node_modules", "dist", "generated", ".git", ".svelte-kit", "coverage"]);
    async function walk(directory: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (skip.has(entry.name)) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
        }
    }
    await walk(rootDir);
    const contracts = files.filter((file) => file.endsWith(".contract.ts"));
    if (contracts.length === 0) return [];
    const otherSources = await Promise.all(files
        .filter((file) => !contracts.includes(file))
        .map(async (file) => await readFile(file, "utf8").catch(() => "")));
    const unwired: UnwiredContract[] = [];
    for (const contract of contracts) {
        const source = await readFile(contract, "utf8").catch(() => "");
        const symbols = [...source.matchAll(/export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)]
            .map((match) => match[1]!);
        if (symbols.length === 0) continue;
        const moduleName = basename(contract).replace(/\.ts$/, "");
        const wired = otherSources.some((text) =>
            text.includes(moduleName)
            || symbols.some((symbol) => new RegExp(`\\b${symbol}\\b`).test(text)));
        if (!wired) unwired.push({ file: relative(rootDir, contract), symbols });
    }
    return unwired;
}

async function runDoctor(args: AppToolArguments): Promise<ToolResult> {
    const { root, outDir, result } = await projectCompileConfig(args);
    const doctor = doctorProject(root, outDir, result.graph, result.upToDate, result.diagnostics);
    const database = checkAppDatabaseSources(root);
    if (database) {
        doctor.checks.push(database);
        if (!database.ok) doctor.errors += 1;
    }
    const fixPlan = doctorFixPlan(doctor);
    const autoFixable = fixPlan.filter((repair) => repair.readiness === "preview").length;
    const inputRequired = fixPlan.filter((repair) => repair.readiness === "input-required").length;
    const manualFixes = fixPlan.filter((repair) => repair.readiness === "manual").length;
    const unwiredContracts = await findUnwiredContracts(root);
    if (args.format === "json") {
        return textResult(
            JSON.stringify({ ok: doctor.errors === 0, autoFixable, inputRequired, manualFixes, fixPlan, unwiredContracts, ...doctor }, null, 2),
            doctor.errors > 0,
        );
    }
    const lines = doctor.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
    for (const diagnostic of doctor.diagnostics ?? []) {
        lines.push(formatDiagnostic(diagnostic));
    }
    lines.push("");
    lines.push(doctor.errors === 0
        ? "No blocking issues. Run `supacloud app compile` to refresh generated artifacts."
        : `${doctor.errors} blocking issue(s). Run \`supacloud app check\` for the full diagnostic list.`);
    if (autoFixable > 0) {
        lines.push(`${autoFixable} preview-ready fix(es): run \`supacloud app doctor --format json\`, save each \`fix\`, then preview with \`supacloud app fix --fix <fix.json>\`. Add --write only after review.`);
    }
    if (inputRequired > 0 || manualFixes > 0) {
        lines.push(`${inputRequired} fix(es) require explicit input; ${manualFixes} require manual implementation.`);
        for (const repair of fixPlan.filter((entry) => entry.readiness !== "preview")) {
            lines.push(`  ${repair.code}: ${repair.reason}`);
        }
    }
    if (unwiredContracts.length > 0) {
        lines.push(`${unwiredContracts.length} unwired contract file(s): ${unwiredContracts.map((contract) => contract.file).join(", ")}. Import their schemas into a controller route or remove them.`);
    }
    return textResult(lines.join("\n"), doctor.errors > 0);
}

/**
 * `app fix` applies one machine-readable DiagnosticFix (from `doctor --format
 * json`). It previews by default and only writes with `--write`, so an agent can
 * inspect the exact change before mutating source.
 */
async function runFix(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const fixPath = args.fix?.trim();
    if (!fixPath) throw new Error("app fix requires --fix <path-to-diagnostic-fix.json>");
    const parsed = JSON.parse(await readFile(resolve(root, fixPath), "utf8")) as unknown;
    const write = args.write === true;
    const applied = await applyDiagnosticFix(parsed as Parameters<typeof applyDiagnosticFix>[0], { rootDir: root, dryRun: !write });
    return textResult(JSON.stringify({
        ok: true,
        written: write,
        file: applied.file,
        changed: applied.changed,
        ...(write ? {} : { preview: applied.content }),
    }, null, 2));
}

type DevProfile = "fast" | "integration";

const DEV_NOT_VERIFIED: Record<DevProfile, string[]> = {
    fast: [
        "external database transaction and concurrency semantics",
        "real queue, object storage and external adapter behavior",
    ],
    integration: [
        "this command does not connect to, migrate or seed the integration database",
        "real queue and object storage behavior unless the project configures them",
    ],
};

/** Validate the supported URL shape before reporting only its non-credential components. */
function devDatabase(profile: DevProfile, explicit: string | undefined) {
    if (profile === "fast") {
        if (explicit !== undefined) {
            throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "--database-url applies only to app dev --profile integration");
        }
        // An ambient integration setting must not make the fast report claim an external binding.
        return { mode: "local", configured: false, url: null };
    }
    const value = (explicit ?? process.env.SUPACLOUD_DEV_DATABASE_URL)?.trim();
    if (!value) {
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID",
            "app dev --profile integration requires an explicit database URL via --database-url or SUPACLOUD_DEV_DATABASE_URL");
    }
    try {
        const parsed = new URL(value);
        if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || !parsed.hostname
            || /[\x00-\x20\x7f]/.test(value)) throw new Error("Invalid database URL");
        return { mode: "explicit", configured: true, url: `${parsed.protocol}//${parsed.host}${parsed.pathname}` };
    } catch {
        // URL parser errors can contain the entire credential-bearing input. Never propagate them.
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "Integration database URL must be a valid postgres:// or postgresql:// URL with a host");
    }
}

function readManifestModules(outDir: string): string[] {
    try {
        const parsed = JSON.parse(readFileSync(join(outDir, "app.manifest.json"), "utf8")) as AppManifest;
        return Array.isArray(parsed.modules) ? parsed.modules.map((module) => module.name) : [];
    } catch {
        return [];
    }
}

function shutdownWaiter(signal: AbortSignal | undefined) {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>(resolvePromise => { resolveDone = resolvePromise; });
    const dispose = () => {
        signal?.removeEventListener("abort", stop);
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
    };
    const stop = () => { dispose(); resolveDone(); };
    // Install before initial compilation, not after it, so shutdown during startup is retained.
    signal?.addEventListener("abort", stop, { once: true });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (signal?.aborted) stop();
    return { done, stop, dispose };
}

/** Launch the project dev loop, or preserve explicit compile-only inspection. */
async function runAppDev(args: AppToolArguments, options: AppToolOptions): Promise<ToolResult> {
    if (args.action === "dev" && args.once !== true && args.watch !== false) {
        const result = await runLocalDevelopment({
            root: args.root || process.cwd(),
            profile: args.profile,
            databaseUrl: args.database_url,
            signal: options.signal,
            onOutput: (text) => options.onDevProgress?.(textResult(
                args.format === "json" ? JSON.stringify({ version: 1, source: "application", output: text }) : text,
            )),
        });
        return textResult(JSON.stringify({ version: 1, ok: result.exitCode === 0, ...result }), result.exitCode !== 0);
    }
    const profile = args.profile ?? "fast";
    if (profile !== "fast" && profile !== "integration") {
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "app dev --profile must be fast or integration");
    }
    const database = devDatabase(profile, args.database_url);
    const root = resolve(args.root || process.cwd());
    const loadedConfig = await loadSupacloudConfig(root);
    const defaults = resolveSupacloudConfig(loadedConfig, root);
    const configuredRoot = sourceRoot(args, root, loadedConfig.root);
    const include = parseInclude(args.include) ?? loadedConfig.include;
    const outDir = args.out_dir ? resolve(root, args.out_dir) : defaults.outDir;
    const watch = args.once !== true && args.watch !== false;
    const compileOptions = compileOptionsFromConfig({
        ...loadedConfig,
        ...(configuredRoot === undefined ? {} : { root: configuredRoot }),
        outDir,
        ...(include === undefined ? {} : { include }),
        strict: args.strict ?? loadedConfig.strict ?? false,
    }, root);

    type DevCompilation = { diagnostics: Diagnostic[]; written: string[] };
    const report = (event: DevCompilation, state: "once" | "watching" | "stopped", progress = false): ToolResult => {
        const hasError = event.diagnostics.some((diagnostic) => diagnostic.severity === "error");
        // writeOnError preserves previous successful artifacts, not the current graph's modules.
        const modules = hasError ? [] : readManifestModules(outDir);
        const artifacts = hasError ? "not-current" : "current";
        const notVerified = DEV_NOT_VERIFIED[profile];
        if (args.format === "json") {
            return textResult(JSON.stringify({
                version: 1, ok: !hasError, profile, root, outDir, watch, state, artifacts,
                database, modules, diagnostics: event.diagnostics, written: event.written, notVerified,
            }, null, progress ? undefined : 2), hasError);
        }
        return textResult([
            `app watch (compile-only, profile: ${profile}, watch: ${watch ? "on" : "off"}, state: ${state})`,
            `  root:     ${root}`,
            `  outDir:   ${outDir}`,
            `  database: ${profile === "fast" ? "local profile (no database provisioned or connected)" : `explicit ${database.url} (credentials omitted; not connected)`}`,
            `  modules:  ${hasError ? "(current compile failed; any previous artifacts are retained)" : modules.length > 0 ? modules.join(", ") : "(none)"}`,
            `  written:  ${event.written.length} file(s)`,
            "", formatDiagnostics(event.diagnostics), "",
            state === "watching" ? "Watching for changes. Press Ctrl+C to stop. Remote test-server sync remains `supacloud dev sync`."
                : state === "stopped" ? "Watch stopped."
                : "Single validation pass. Omit --once and --watch=false to watch for changes.",
            `Not verified in this profile: ${notVerified.join("; ")}.`,
        ].join("\n"), hasError);
    };

    if (!watch) {
        // --once must not create filesystem watchers or install process signal handlers.
        const result = await compileProject({ ...compileOptions, writeOnError: false });
        return report(result, "once");
    }

    const shutdown = shutdownWaiter(options.signal);
    let lastEvent: DevCompilation = { diagnostics: [], written: [] };
    let progressFailure: { error: unknown } | undefined;
    const publish = (event: DevCompilation) => {
        try { options.onDevProgress?.(report(event, "watching", true)); }
        catch (error) { progressFailure = { error }; shutdown.stop(); }
    };
    let watcher: ReturnType<typeof watchProject> | undefined;
    try {
        watcher = watchProject({
            ...compileOptions,
            writeOnError: false,
            onEvent: (event) => {
                if (event.type === "compile-start") return;
                lastEvent = event;
                if (!event.initial) publish(event);
            },
        });
        lastEvent = await watcher.ready;
        // Initial progress means the watcher has actually been installed and can observe edits.
        publish(lastEvent);
        await shutdown.done;
    } finally {
        shutdown.dispose();
        await watcher?.close();
    }
    if (progressFailure) throw progressFailure.error;
    return report(lastEvent, "stopped");
}

async function runCompile(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const loadedConfig = await loadSupacloudConfig(root);
    const defaults = resolveSupacloudConfig(loadedConfig, root);
    const configuredRoot = sourceRoot(args, root, loadedConfig.root);
    const include = parseInclude(args.include) ?? loadedConfig.include;
    const result = await compileProject({
        ...compileOptionsFromConfig({
            ...loadedConfig,
            ...(configuredRoot === undefined ? {} : { root: configuredRoot }),
            outDir: args.out_dir ? resolve(root, args.out_dir) : defaults.outDir,
            ...(include === undefined ? {} : { include }),
            strict: args.strict ?? loadedConfig.strict ?? false,
        }, root),
        writeOnError: false,
    });
    const hasError = result.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    if (args.format === "json") return textResult(JSON.stringify({
        version: 1, ok: !hasError, diagnostics: result.diagnostics, written: result.written,
    }, null, 2), hasError);
    const text = [
        formatDiagnostics(result.diagnostics),
        "",
        `written (${result.written.length}):`,
        ...result.written.map((path) => `  ${path}`),
    ].join("\n");
    return textResult(text, hasError);
}

async function runCheck(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const database = checkAppDatabaseSources(root);
    const loadedConfig = await loadSupacloudConfig(root);
    const defaults = resolveSupacloudConfig(loadedConfig, root);
    const configuredRoot = sourceRoot(args, root, loadedConfig.root);
    const include = parseInclude(args.include) ?? loadedConfig.include;
    const config = compileOptionsFromConfig({
        ...loadedConfig,
        ...(configuredRoot === undefined ? {} : { root: configuredRoot }),
        outDir: args.out_dir ? resolve(root, args.out_dir) : defaults.outDir,
        ...(include === undefined ? {} : { include }),
        strict: args.strict ?? loadedConfig.strict ?? false,
    }, root);
    const result = await checkProject(config);
    const hasError = result.diagnostics.some((diagnostic) => diagnostic.severity === "error")
        || result.mismatches.length > 0 || database?.ok === false;
    if (args.format === "json") return textResult(JSON.stringify({
        version: 1, ok: !hasError, source: "declaration", diagnostics: result.diagnostics,
        mismatches: result.mismatches, upToDate: result.upToDate, written: [],
        modules: result.graph.modules.map((module) => module.name),
        ...(database ? { database } : {}),
    }, null, 2), hasError);
    const summary = `checked ${result.graph.modules.length} module(s), no files written`;
    return textResult([
        formatDiagnostics(result.diagnostics),
        ...result.mismatches.map((path) => `generated artifact mismatch: ${path}`),
        ...(database ? [`${database.ok ? "OK" : "FAIL"} ${database.name}: ${database.detail}`] : []),
        "", summary,
    ].join("\n"), hasError);
}

async function readManifest(root: string, args: AppToolArguments): Promise<AppManifest> {
    const config = await loadSupacloudConfig(root);
    const outDir = args.out_dir ? resolve(root, args.out_dir) : resolveSupacloudConfig(config, root).outDir;
    const manifestPath = join(outDir, "app.manifest.json");
    if (!existsSync(manifestPath)) {
        throw new Error(`Manifest not found: ${manifestPath}（先运行 app compile 生成）`);
    }
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as AppManifest;
    if (!Array.isArray(parsed.modules)) {
        throw new Error(`Invalid manifest: ${manifestPath}`);
    }
    return parsed;
}

function formatGraphText(manifest: AppManifest): string {
    const lines: string[] = [`application (${manifest.modules.length} module(s))`];
    for (const module of manifest.modules) {
        lines.push(`└─ ${module.name} (${module.file}:${module.line})`);
        if (module.imports.length > 0) lines.push(`   imports: ${module.imports.join(", ")}`);
        for (const provider of module.providers) {
            lines.push(`   provider: ${provider.token} (${provider.kind}, scope=${provider.scope})`);
        }
        for (const controller of module.controllers) {
            lines.push(`   controller: ${controller.className} ${controller.path} (scope=${controller.scope})`);
            for (const route of controller.routes) {
                lines.push(`     route: ${route.method} ${route.path} -> ${route.handler}`);
            }
        }
        for (const command of module.commands) {
            lines.push(`   command: ${command.name} (${command.className})`);
        }
        for (const query of module.queries) {
            lines.push(`   query: ${query.name} (${query.className})`);
        }
        for (const job of module.jobs ?? []) {
            lines.push(`   job: ${job.name} (${job.className})`);
        }
        if (module.exports.length > 0) lines.push(`   exports: ${module.exports.join(", ")}`);
    }
    if (manifest.externalTokens.length > 0) {
        lines.push(`externalTokens: ${manifest.externalTokens.join(", ")}`);
    }
    return lines.join("\n");
}

async function runGraph(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const manifest = await readManifest(root, args);
    if (args.format === "json") return textResult(JSON.stringify(manifest, null, 2));
    return textResult(formatGraphText(manifest));
}

/** token -> dependent provider/controller module and name (reverse index). */
function reverseDependencies(manifest: AppManifest, token: string): string[] {
    const dependents: string[] = [];
    for (const module of manifest.modules) {
        for (const provider of module.providers) {
            if (provider.token !== token && provider.deps.includes(token)) {
                dependents.push(`${module.name}/${provider.token}`);
            }
        }
        for (const controller of module.controllers) {
            if (controller.deps.includes(token)) {
                dependents.push(`${module.name}/${controller.className}`);
            }
        }
    }
    return dependents;
}

function explainProvider(manifest: AppManifest, module: ModuleNode, index: number): string {
    const provider = module.providers[index];
    if (!provider) throw new Error("Provider does not exist in the manifest");
    const lines = [
        `对象: ${provider.token}`,
        `类型: provider (${provider.kind})`,
        `所属模块: ${module.name}`,
        `scope: ${provider.scope}`,
        `位置: ${provider.file}:${provider.line}`,
        `deps: ${provider.deps.length > 0 ? provider.deps.join(", ") : "(none)"}`,
    ];
    if (provider.useClass) lines.push(`useClass: ${provider.useClass}`);
    if (provider.useFactoryName) lines.push(`useFactory: ${provider.useFactoryName}`);
    if (provider.useExisting) lines.push(`useExisting: ${provider.useExisting}`);
    lines.push(`exported: ${provider.exported}`);
    const dependents = reverseDependencies(manifest, provider.token);
    lines.push(`被依赖: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`);
    return lines.join("\n");
}

function explainController(manifest: AppManifest, module: ModuleNode, index: number): string {
    const controller = module.controllers[index];
    if (!controller) throw new Error("Controller does not exist in the manifest");
    const lines = [
        `对象: ${controller.className}`,
        "类型: controller",
        `所属模块: ${module.name}`,
        `路径: ${controller.path}`,
        `scope: ${controller.scope}`,
        `deps: ${controller.deps.length > 0 ? controller.deps.join(", ") : "(none)"}`,
    ];
    for (const route of controller.routes) {
        lines.push(`路由: ${route.method} ${controller.path}${route.path} -> ${route.handler}`);
    }
    return lines.join("\n");
}

async function runExplain(args: AppToolArguments): Promise<ToolResult> {
    const target = args.target?.trim();
    if (!target) throw new Error("app explain requires --target（provider 类名 / token 名 / command 名 / job 名）");
    const root = resolve(args.root || process.cwd());
    const manifest = await readManifest(root, args);

    for (const module of manifest.modules) {
        const job = module.jobs?.find(
            (entry) => entry.name === target || entry.className === target,
        );
        if (job) {
            const lines = [
                `对象: ${job.name}`,
                "类型: job",
                `所属模块: ${module.name}`,
                `类: ${job.className}`,
                `scope: ${job.scope}`,
            ];
            if (job.mode) lines.push(`mode: ${job.mode}`);
            if (job.timeoutSec !== undefined) lines.push(`timeoutSec: ${job.timeoutSec}`);
            if (job.maxAttempts !== undefined) lines.push(`maxAttempts: ${job.maxAttempts}`);
            if (job.idempotency) lines.push(`idempotency: ${job.idempotency}`);
            const dependents = reverseDependencies(manifest, job.className);
            lines.push(`被依赖: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`);
            return textResult(lines.join("\n"));
        }

        const providerIndex = module.providers.findIndex(
            (provider) => provider.token === target || provider.useClass === target,
        );
        if (providerIndex >= 0) return textResult(explainProvider(manifest, module, providerIndex));

        const controllerIndex = module.controllers.findIndex(
            (controller) => controller.className === target,
        );
        if (controllerIndex >= 0) return textResult(explainController(manifest, module, controllerIndex));

        const command = module.commands.find(
            (entry) => entry.name === target || entry.className === target,
        );
        if (command) {
            const lines = [
                `对象: ${command.name}`,
                "类型: command",
                `所属模块: ${module.name}`,
                `类: ${command.className}`,
            ];
            if (command.permission) lines.push(`permission: ${command.permission}`);
            if (command.transaction) lines.push(`transaction: ${command.transaction}`);
            if (command.audit) lines.push(`audit: ${command.audit}`);
            if (command.idempotency) lines.push(`idempotency: ${command.idempotency}`);
            const dependents = reverseDependencies(manifest, command.className);
            lines.push(`被依赖: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`);
            return textResult(lines.join("\n"));
        }

        const query = module.queries.find(
            (entry) => entry.name === target || entry.className === target,
        );
        if (query) {
            return textResult([
                `对象: ${query.name}`,
                "类型: query",
                `所属模块: ${module.name}`,
                `类: ${query.className}`,
            ].join("\n"));
        }
    }

    if (manifest.externalTokens.includes(target)) {
        const dependents = reverseDependencies(manifest, target);
        return textResult([
            `对象: ${target}`,
            "类型: externalToken（平台注入，无模块提供）",
            `被依赖: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`,
        ].join("\n"));
    }

    return textResult(`未找到对象: ${target}`, true);
}

async function runExportTools(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const manifest = await readManifest(root, { ...args, out_dir: undefined });
    const definitions = buildToolDefinitions(manifest);

    const outDir = resolve(args.out_dir || join(root, "generated"));
    if (args.format === "json") {
        // JSON mode returns the combined contract on stdout without writing artifacts.
        return textResult(JSON.stringify(definitions, null, 2));
    }

    await mkdir(outDir, { recursive: true });
    const openaiPath = join(outDir, "tool-definitions.openai.json");
    const mcpPath = join(outDir, "tool-definitions.mcp.json");
    await writeFile(openaiPath, JSON.stringify(definitions.openai, null, 2), "utf8");
    await writeFile(mcpPath, JSON.stringify(definitions.mcp, null, 2), "utf8");

    const summary = [
        `exported ${definitions.openai.length} tool(s):`,
        `  openai → ${openaiPath}`,
        `  mcp    → ${mcpPath}`,
        "",
        definitions.openai.map((t) => `  ${t.function.name}`).join("\n"),
    ].join("\n");
    return textResult(summary);
}

async function runDelivery(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    if (args.action === "build") {
        const database = checkAppDatabaseSources(root);
        if (database && !database.ok) {
            return textResult(JSON.stringify({ ok: false, database, written: [] }, null, 2), true);
        }
    }
    const loaded = await loadSupacloudConfig(root);
    const options = compileOptionsFromConfig({
        ...loaded,
        ...(args.out_dir === undefined ? {} : { outDir: resolve(root, args.out_dir) }),
        ...(args.include === undefined ? {} : { include: parseInclude(args.include) }),
        ...(args.strict === undefined ? {} : { strict: args.strict }),
    }, root);
    if (args.action === "plan") {
        const result = await planDeliveryProject(options, loaded.delivery);
        return textResult(args.format === "json" ? JSON.stringify(result, null, 2) : formatDeliveryPlan(result), !result.ok);
    }
    const result = await buildDeliveryProject(options, loaded.delivery);
    return textResult(JSON.stringify(result, null, 2), !result.ok);
}

function formatReleaseTransfer(result: ToolResult): ToolResult {
    if (result.isError) return result;
    try {
        const payload: unknown = JSON.parse(result.content[0]?.text ?? "");
        if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) return result;
        const plan = "plan" in payload ? parseApplicationReleaseTransferPlan(payload.plan) : null;
        const receipt = !plan && "transfer" in payload ? parseApplicationReleaseTransferResult(payload.transfer) : null;
        const data = plan ?? receipt;
        if (!data) return result;
        return textResult([
            `${data.project_ref}/${data.application_id}: ${plan ? plan.action === "no-op" ? "No changes" : "Transfer required" : "Artifact transferred"}`,
            `Source: ${data.source.project_ref} / ${data.source.release_id}`,
            `Target release: ${data.candidate_release_id}`,
            `Manifest: ${data.source.manifest_sha256}`,
            "Activation: not performed",
        ].join("\n"));
    } catch { return result; }
}
const historyReceiptSchema = Type.Object({
    schema: Type.Literal(RELEASE_CONTROL_RESPONSE_SCHEMA),
    ok: Type.Literal(true),
    operation: Type.Literal("applications.get_history"),
    project_ref: Type.String(), application_id: Type.String(), environment_id: Type.String(),
    history: ApplicationActivationHistorySchema,
}, { additionalProperties: false });

function historyText(result: ToolResult, request: AppToolArguments, projectRef: string | undefined): ToolResult {
    if (result.isError) return result;
    try {
        if (result.content.length !== 1 || result.content[0]!.text.length > 262_144) throw new Error();
        const receipt: unknown = JSON.parse(result.content[0]!.text);
        if (!Value.Check(historyReceiptSchema, receipt)) throw new Error();
        const history = parseApplicationActivationHistory(receipt.history);
        if (history.project_ref !== projectRef || history.application_id !== request.id
            || history.environment_id !== request.environment_id
            || receipt.project_ref !== history.project_ref || receipt.application_id !== history.application_id
            || receipt.environment_id !== history.environment_id) throw new Error();
        const lines = [
            `Activation History: ${history.project_ref}/${history.application_id}/${history.environment_id}`,
            `Active activation: ${history.active_activation_id ?? "none"}`,
            "",
        ];
        if (history.activations.length === 0) lines.push("No successful activations on this page.");
        else {
            lines.push(`${"Completed (UTC)".padEnd(29)}  ${"State".padEnd(7)}  ${"Activation ID".padEnd(36)}  Release (12)`);
            for (const entry of history.activations) lines.push(
                `${entry.completed_at.padEnd(29)}  ${(entry.is_active ? "current" : "-").padEnd(7)}  ${entry.activation_id}  ${entry.release_id.slice(0, 12)}`,
            );
        }
        if (history.next_cursor) lines.push("", `Next cursor: ${history.next_cursor}`);
        return textResult(lines.join("\n"));
    } catch {
        return releaseControlFailure("applications.get_history", "INVALID_RESPONSE", null);
    }
}

function formatRemoteDeployPlan(result: ToolResult): ToolResult {
    if (result.isError) return result;
    try {
        const payload: unknown = JSON.parse(result.content[0]?.text ?? "");
        if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true
            || !("plan" in payload)) return result;
        const plan = parseApplicationDeployPlan(payload.plan);
        const names = (values: string[], prefix: string) => values.map(name => `${prefix}${name}`);
        const targets = [
            ...names(plan.changes.targets.added, "+"), ...names(plan.changes.targets.removed, "-"),
            ...names(plan.changes.targets.changed, "~"),
        ];
        return textResult([
            `${plan.project_ref}/${plan.application_id} [${plan.environment_id}]: ${plan.action === "no-op" ? "No changes" : "Activation required"}`,
            `Release: ${plan.candidate.release_id} (${plan.changes.release ? "changed" : "unchanged"})`,
            `Configuration: ${plan.candidate.configuration_id} (${plan.changes.configuration ? "changed" : "unchanged"})`,
            `Targets: ${targets.length ? targets.join(", ") : "unchanged"}`,
            `Migrations: ${!plan.migrations.ledger_compatible ? "ledger conflict" : plan.migrations.project_migrations_applied ? "applied" : "pending"}`,
            `Provisioning: ${plan.migrations.operator_provisioning}`,
            `Expected activation: ${plan.expected_activation_id ?? "absent"}`,
        ].join("\n"));
    } catch { return result; }
}

export async function runAppTool(request: AppToolArguments, options: AppToolOptions = {}): Promise<ToolResult> {
    if ((request.dry_run !== undefined && request["dry-run"] !== undefined)
        || (request.register_in !== undefined && request["register-in"] !== undefined)
        || (request.database_url !== undefined && request["database-url"] !== undefined)) {
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "Do not combine hyphenated and underscored aliases of the same flag");
    }
    request = {
        ...request,
        ...(request["dry-run"] === undefined ? {} : { dry_run: request["dry-run"] }),
        ...(request["register-in"] === undefined ? {} : { register_in: request["register-in"] }),
        ...(request["database-url"] === undefined ? {} : { database_url: request["database-url"] }),
    };
    if ((request.dry_run !== undefined || request.register_in !== undefined) && request.action !== "generate") {
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "--dry-run and --register-in apply only to app generate");
    }
    if (request.database_url !== undefined && request.action !== "dev" && request.action !== "watch") {
        throw new ScaffoldError("SCAFFOLD_OPTION_INVALID", "--database-url applies only to app dev --profile integration");
    }
    if (request.json !== undefined
        && request.action !== "history" && request.action !== "transfer-plan" && request.action !== "transfer"
        && request.action !== "promote-plan") {
        throw new Error("--json applies only to app history, transfer-plan, transfer or promote-plan");
    }
    if (request.json !== undefined && request.format === "text") throw new Error("--json and --format text cannot be combined");
    if (Object.hasOwn(REMOTE_APP_ACTIONS, request.action)) {
        const delegate = options.getApplications?.();
        if (!delegate) return textResult("App remote actions require a Management API context.", true);
        const action = REMOTE_APP_ACTIONS[request.action as keyof typeof REMOTE_APP_ACTIONS];
        const { format, json, ...remoteRequest } = request;
        const args = {
            ...remoteRequest, action, ref: request.ref ?? options.projectRef,
        };
        validateToolArguments(APPLICATION_TOOL_SCHEMA, args);
        const result = await delegate(args);
        if (request.action === "history" && format !== "json" && json !== true) {
            return historyText(result, request, args.ref);
        }
        if ((request.action === "deploy-plan" || request.action === "diff") && format !== "json") {
            return formatRemoteDeployPlan(result);
        }
        if (request.action === "promote-plan" && !result.isError && format !== "json" && !json) {
            const payload: unknown = JSON.parse(result.content[0]?.text ?? "");
            if (!payload || typeof payload !== "object" || !("plan" in payload)) return result;
            const plan = parseApplicationPromotionPlan(payload.plan);
            return textResult([
                `${plan.project_ref}/${plan.application_id}/${plan.environment_id}: ${plan.action}`,
                `Source: ${plan.source.project_ref}/${plan.source.environment_id}`,
                ...(plan.blockers.length ? [`Blocked: ${plan.blockers.join(", ")}`] : []),
                ...(plan.steps.length ? [`Next: ${plan.steps.join(" -> ")}`] : []),
                "Execution: not performed",
            ].join("\n"));
        }
        // Preserve the original receipt, including unknown outcomes. Never infer a rollback or retry.
        return (request.action === "transfer-plan" || request.action === "transfer") && format !== "json" && !json
            ? formatReleaseTransfer(result) : result;
    }
    switch (request.action) {
        case "verify-plan": {
            if (!request.target?.trim()) throw new Error("verify-plan requires --target; it never defaults to a full test suite");
            const { root, sourceDir, result } = await projectCompileConfig(request);
            const plan = await createVerificationPlan(root, result.graph, request.target.trim(), sourceDir);
            const ready = plan.ready && !result.diagnostics.some(item => item.severity === "error");
            return textResult(JSON.stringify({ ...plan, ready, diagnostics: result.diagnostics }, null, 2), !ready);
        }
        case "dev":
        case "watch": return runAppDev(request, options);
        case "plan":
        case "build": return runDelivery(request);
        case "init": return initProject(request);
        case "generate": {
            try { return await generateScaffold(request); }
            catch (error) {
                if (request.format !== "json") throw error;
                return textResult(JSON.stringify({
                    version: 1, ok: false,
                    code: error instanceof ScaffoldError ? error.code : "SCAFFOLD_FAILED",
                    message: error instanceof Error ? error.message : "Scaffold generation failed",
                }, null, 2), true);
            }
        }
        case "compile": return runCompile(request);
        case "check": return runCheck(request);
        case "graph": return runGraph(request);
        case "explain": return runExplain(request);
        case "export-tools": return runExportTools(request);
        case "context": return runContext(request);
        case "doctor": return runDoctor(request);
        case "fix": return runFix(request);
        default:
            return textResult(`Unknown app action: ${String(request.action)}`, true);
    }
}

export function registerAppTools(server: ToolServer, options: AppToolOptions = {}): void {
    registerTool(server,
        "app",
        "Application authoring and delivery. Plan is read-only; build, upload and configure never deploy. Deploy/rollback explicitly activate a release; rollback never downgrades schema.",
        {
            ...REMOTE_APP_SCHEMA,
            action: withDescription(stringEnum(["init", "generate", "dev", "watch", "verify-plan", "compile", "check", "graph", "explain", "export-tools", "context", "doctor", "fix",
                "plan", "build", "upload", "configure", "transfer-plan", "transfer", "promote-plan", "deploy", "deploy-plan", "diff", "status", "rollback", "rollback-plan", "history", "reconcile", "retire", "logs",
                "preview-plan", "preview", "previews", "preview-status", "preview-cleanup"]), "App action; transfer reuses a verified release without build or activation; local plan is topology-only, deploy-plan/diff observe remote state, deploy skips verified no-op, rollback never downgrades schema"),
            kind: optional(stringEnum(["module", "command", "query", "controller", "job", "contract", "resource"]), "[generate] Scaffold kind"),
            template: optional(stringEnum(["minimal", "http", "command", "edge"]), "[init] Minimal application by default; explicit http/command/edge recipes"),
            name: optional(Type.String(), "[init/generate] Project or object name"),
            module: optional(Type.String(), "[generate] Target feature module (required for command/query/controller)"),
            dir: optional(Type.String(), "[generate] Feature root directory (default: src/features)"),
            force: optional(Type.Boolean(), "[generate] Overwrite a single regular file; resource/controller never overwrite"),
            dry_run: optional(Type.Boolean(), "[generate] Validate and preview the complete change set without writing"),
            "dry-run": optional(Type.Boolean(), "[generate] CLI alias of dry_run"),
            register_in: optional(Type.String(), "[generate] Existing parent module file for module/resource; uses the compiler AST editor"),
            "register-in": optional(Type.String(), "[generate] CLI alias of register_in"),
            root: optional(Type.String(), "[dev/plan/build/compile/check] Project directory containing supacloud.config.ts (default: current directory)"),
            include: optional(Type.String(), "[dev/compile/check] Comma-separated glob patterns for source files"),
            out_dir: optional(Type.String(), "[dev/compile/plan/build/export-tools] Output directory (default: configured outDir)"),
            strict: optional(Type.Boolean(), "[dev/compile/check] Promote warnings to errors"),
            format: optional(stringEnum(["text", "json"]), "[dev/generate/compile/check/plan/deploy-plan/diff/history/promote-plan/graph/export-tools] Output format (default: text)"),
            json: optional(Type.Boolean(), "[history/transfer-plan/transfer/promote-plan] Preserve or return the full machine-readable receipt"),
            profile: optional(stringEnum(["fast", "integration"]), "[dev] Run dev or dev:integration; integration verifies an explicit loopback database"),
            once: optional(Type.Boolean(), "[dev] Validate and report once without watching"),
            watch: optional(Type.Boolean(), "[dev] Watch for changes (default: true; --once disables)"),
            database_url: optional(Type.String(), "[dev] Explicit loopback integration URL; watch/once only inspect its shape"),
            "database-url": optional(Type.String(), "[dev] CLI alias of database_url"),
            target: optional(Type.String(), "[explain/context/verify-plan] Provider class name / token name / command name / job name / module name"),
            fix: optional(Type.String(), "[fix] Path to a DiagnosticFix JSON file produced by `doctor --format json`"),
            write: optional(Type.Boolean(), "[fix] Write the fix to disk (default: preview only)"),
        },
        (request) => runAppTool(request, options),
    );
}

const APP_ALIAS_ACTIONS = ["generate", "compile", "check", "graph", "explain", "context", "doctor", "fix"] as const;

/**
 * Promotes the single-entry development verbs to top-level commands so an AI or
 * developer does not need to remember the `app` namespace. The `app` tool and
 * these aliases share one implementation and one execution-policy classification.
 */
export function registerAppAliases(server: ToolServer): void {
    const schema = {
        kind: optional(stringEnum(["module", "command", "query", "controller", "job", "contract", "resource"]), "[generate] Scaffold kind"),
        name: optional(Type.String(), "[generate] Object name"),
        module: optional(Type.String(), "[generate] Target feature module"),
        dir: optional(Type.String(), "[generate] Feature root directory (default: src/features)"),
        force: optional(Type.Boolean(), "[generate] Overwrite a single regular file; resource/controller never overwrite"),
        dry_run: optional(Type.Boolean(), "[generate] Validate and preview the complete change set without writing"),
        "dry-run": optional(Type.Boolean(), "[generate] CLI alias of dry_run"),
        register_in: optional(Type.String(), "[generate] Existing parent module file for module/resource; uses the compiler AST editor"),
        "register-in": optional(Type.String(), "[generate] CLI alias of register_in"),
        root: optional(Type.String(), "Project directory containing supacloud.config.ts (default: current directory)"),
        include: optional(Type.String(), "[compile/check] Comma-separated glob patterns for source files"),
        out_dir: optional(Type.String(), "[compile/export-tools] Output directory (default: <root>/generated)"),
        strict: optional(Type.Boolean(), "[compile/check] Promote warnings to errors"),
        format: optional(stringEnum(["text", "json"]), "Output format (default: text)"),
        target: optional(Type.String(), "[explain/context] Provider class name / token name / command name / job name / module name"),
        fix: optional(Type.String(), "[fix] Path to a DiagnosticFix JSON file produced by `doctor --format json`"),
        write: optional(Type.Boolean(), "[fix] Write the fix to disk (default: preview only)"),
    } satisfies ToolSchema;
    for (const action of APP_ALIAS_ACTIONS) {
        registerTool(server, action, `Top-level alias of \`app ${action}\`.`, schema,
            (request) => runAppTool({ ...request, action }));
    }
}

// For testing and internal reuse
export const __internal = {
    pascalName,
    camelName,
    formatGraphText,
    reverseDependencies,
};
