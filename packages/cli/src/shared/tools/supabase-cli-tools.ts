import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (requestArguments: any) => Promise<any>,
    ) => void;
};

export type SupabaseCliAction =
    | "version"
    | "init"
    | "migration_new"
    | "db_diff"
    | "db_reset"
    | "db_pull"
    | "db_schema_declarative_sync"
    | "db_schema_declarative_generate"
    | "db_dump"
    | "config_pull"
    | "stack_start"
    | "stack_prepare"
    | "stack_status"
    | "stack_stop"
    | "stack_destroy"
    | "migration_list"
    | "gen_types"
    | "push";

export interface SupabaseCliArgs {
    action: SupabaseCliAction;
    workdir?: string;
    ref?: string;
    name?: string;
    schema?: string;
    db_url?: string;
    file?: string;
    dir?: string;
    dry_run?: boolean;
    declarative?: boolean;
    apply?: boolean;
    experimental?: boolean;
    strict_coverage?: boolean;
    overwrite?: boolean;
    runtime?: "docker" | "podman" | "native";
    eager?: boolean;
    preparation?: "background" | "on-demand";
    force?: boolean;
    yes?: boolean;
    confirm_destroy?: boolean;
    no_seed?: boolean;
    diff_engine?: "migra" | "pg-delta" | "pgadmin" | "pg-schema";
    dump_mode?: "schema" | "data" | "roles";
    language?: "typescript" | "go" | "swift" | "python";
}

export interface OfficialCliExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

type MigrationPushCallback = (requestArguments: Record<string, unknown>) => Promise<any>;
type OfficialCliExecutor = (request: SupabaseCliArgs) => Promise<OfficialCliExecutionResult>;

export interface SupabaseCliToolOptions {
    getPushMigrations?: () => MigrationPushCallback | undefined;
    executeOfficialCli?: OfficialCliExecutor;
    environment?: NodeJS.ProcessEnv;
    currentWorkingDirectory?: string;
    projectRef?: string;
    readOnly?: boolean;
}

const SENSITIVE_ENV_KEY = /(?:^|_)(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIALS?|AUTHORIZATION|AUTH|SESSION|COOKIE|BEARER|DB_URI|DB_URL|DSN|DATABASE_URL|DATABASE_URI|CONNECTION_STRING|CONNECTION_URI)(?:_|$)/i;
const VALID_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VALID_MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;
const VALID_SCHEMA = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const VALID_PROJECT_REF = /^[A-Za-z0-9_-]{1,64}$/;

function isSensitiveEnvironmentKey(key: string): boolean {
    return key.toUpperCase().startsWith("PG") || SENSITIVE_ENV_KEY.test(key);
}

function requireMigrationName(name: string | undefined): string {
    if (!name || !VALID_MIGRATION_NAME.test(name)) {
        throw new Error("Invalid migration name; use letters, numbers, underscore, or hyphen");
    }
    return name;
}

function normalizeSchemaList(schema: string | undefined): string | undefined {
    if (!schema) return undefined;
    const schemas = schema.split(",").map((schemaName) => schemaName.trim()).filter(Boolean);
    if (!schemas.length || schemas.some((schemaName) => !VALID_SCHEMA.test(schemaName))) {
        throw new Error("Invalid schema list");
    }
    return schemas.join(",");
}

function requirePostgresUrl(databaseUrl: string | undefined): string {
    if (!databaseUrl || /[\r\n\0]/.test(databaseUrl)) {
        throw new Error("A Postgres database URL is required");
    }
    try {
        const url = new URL(databaseUrl);
        if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
            throw new Error("unsupported protocol");
        }
    } catch {
        throw new Error("A valid Postgres database URL is required");
    }
    return databaseUrl;
}

function schemaArguments(schema: string | undefined): string[] {
    const normalized = normalizeSchemaList(schema);
    return normalized ? ["--schema", normalized] : [];
}

function workdirArguments(workdir: string | undefined): string[] {
    if (!workdir) throw new Error("A workdir is required");
    return ["--workdir", resolve(workdir)];
}

function resolveOutputPath(workdir: string, file: string | undefined, label: string): string {
    if (!file || /[\r\n\0]/.test(file)) throw new Error(`${label} file is required`);
    return isAbsolute(file) ? resolve(file) : resolve(workdir, file);
}

function databaseTargetArguments(databaseUrl: string | undefined): string[] {
    return databaseUrl ? ["--db-url", requirePostgresUrl(databaseUrl)] : ["--local"];
}

function databaseDiffArguments(request: SupabaseCliArgs): string[] {
    const engineFlags: Partial<Record<NonNullable<SupabaseCliArgs["diff_engine"]>, string>> = {
        migra: "--use-migra",
        pgadmin: "--use-pgadmin",
        "pg-schema": "--use-pg-schema",
        "pg-delta": "--use-pg-delta",
    };
    return [
        "db", "diff", "--local",
        ...(request.name ? ["--file", requireMigrationName(request.name)] : []),
        ...schemaArguments(request.schema),
        ...(request.diff_engine ? [engineFlags[request.diff_engine]!] : []),
    ];
}

function databasePullArguments(request: SupabaseCliArgs): string[] {
    if (request.diff_engine && request.diff_engine !== "migra" && request.diff_engine !== "pg-delta") {
        throw new Error("db_pull only supports migra or pg-delta diff engines");
    }
    return [
        "db", "pull",
        ...(request.name ? [requireMigrationName(request.name)] : []),
        "--db-url", requirePostgresUrl(request.db_url),
        ...(request.declarative ? ["--declarative"] : []),
        ...(request.diff_engine ? ["--diff-engine", request.diff_engine] : []),
        ...schemaArguments(request.schema),
    ];
}

function declarativeSyncArguments(request: SupabaseCliArgs): string[] {
    return [
        "db", "schema", "declarative", "sync",
        ...(request.name ? ["--name", requireMigrationName(request.name)] : []),
        ...(request.file ? ["--file", requireMigrationName(request.file)] : []),
        ...(request.apply === true ? ["--apply"] : ["--no-apply"]),
        ...(request.experimental === false ? [] : ["--experimental"]),
        ...(request.strict_coverage ? ["--strict-coverage"] : []),
        ...schemaArguments(request.schema),
    ];
}

function declarativeGenerateArguments(request: SupabaseCliArgs): string[] {
    const target = request.db_url ? ["--db-url", requirePostgresUrl(request.db_url)] : ["--linked"];
    return [
        "db", "schema", "declarative", "generate",
        ...target,
        ...(request.experimental === false ? [] : ["--experimental"]),
        ...(request.overwrite ? ["--overwrite"] : []),
        ...(request.strict_coverage ? ["--strict-coverage"] : []),
        ...schemaArguments(request.schema),
    ];
}

function stackRuntimeArguments(request: SupabaseCliArgs): string[] {
    if (request.runtime && !["docker", "podman", "native"].includes(request.runtime)) {
        throw new Error("Invalid local stack runtime");
    }
    return request.runtime ? ["--runtime", request.runtime] : [];
}

function stackArguments(request: SupabaseCliArgs): string[] {
    switch (request.action) {
        case "stack_start":
            return [
                "stack", "start",
                ...stackRuntimeArguments({ ...request, runtime: request.runtime ?? "docker" }),
                ...(request.eager ? ["--eager"] : []),
                ...(request.preparation ? ["--preparation", request.preparation] : []),
            ];
        case "stack_prepare":
            return ["stack", "prepare", ...stackRuntimeArguments({ ...request, runtime: request.runtime ?? "docker" })];
        case "stack_status":
            return ["stack", "status", "--output-format", "json"];
        case "stack_stop":
            return ["stack", "stop"];
        case "stack_destroy":
            if (request.confirm_destroy !== true || request.yes !== true) {
                throw new Error("stack_destroy requires confirm_destroy=true and yes=true");
            }
            return ["stack", "destroy", "--yes"];
        default:
            throw new Error(`Unsupported local stack action: ${request.action}`);
    }
}

function databaseDumpArguments(request: SupabaseCliArgs, workdir: string): string[] {
    return [
        "db", "dump", "--db-url", requirePostgresUrl(request.db_url),
        "--file", resolveOutputPath(workdir, request.file, "Database dump"),
        ...(request.dump_mode === "data" ? ["--data-only"] : []),
        ...(request.dump_mode === "roles" ? ["--role-only"] : []),
        ...schemaArguments(request.schema),
    ];
}

function configPullArguments(request: SupabaseCliArgs): string[] {
    if (!request.ref || !VALID_PROJECT_REF.test(request.ref)) throw new Error("Invalid project ref");
    if (request.dry_run === false && request.yes !== true) {
        throw new Error("config_pull apply requires yes=true");
    }
    return [
        "config", "pull",
        ...(request.ref ? ["--project-ref", request.ref] : []),
        ...(request.dry_run === true || request.dry_run === undefined ? ["--dry-run"] : []),
        ...(request.force ? ["--force"] : []),
        ...(request.dry_run === false ? ["--yes"] : []),
    ];
}

function generateTypesArguments(request: SupabaseCliArgs, workdir: string): string[] {
    resolveOutputPath(workdir, request.file, "Generated types");
    return [
        "gen", "types",
        ...databaseTargetArguments(request.db_url),
        "--lang", request.language || "typescript",
        ...schemaArguments(request.schema),
    ];
}

function actionArguments(request: SupabaseCliArgs, workdir: string): string[] {
    switch (request.action) {
        case "init":
            if (request.force) throw new Error("init never overwrites an existing project configuration");
            return ["init"];
        case "migration_new": return ["migration", "new", requireMigrationName(request.name)];
        case "db_diff": return databaseDiffArguments(request);
        case "db_reset": return ["db", "reset", "--local", ...(request.no_seed ? ["--no-seed"] : []), "--yes"];
        case "db_pull": return databasePullArguments(request);
        case "db_schema_declarative_sync": return declarativeSyncArguments(request);
        case "db_schema_declarative_generate": return declarativeGenerateArguments(request);
        case "db_dump": return databaseDumpArguments(request, workdir);
        case "config_pull": return configPullArguments(request);
        case "stack_start":
        case "stack_prepare":
        case "stack_status":
        case "stack_stop":
        case "stack_destroy":
            return stackArguments(request);
        case "migration_list": return ["migration", "list", ...databaseTargetArguments(request.db_url)];
        case "gen_types": return generateTypesArguments(request, workdir);
        case "push": throw new Error("Remote push must use the SupaCloud Management API");
        default: throw new Error(`Unsupported official Supabase CLI action: ${String(request.action)}`);
    }
}

export function buildOfficialSupabaseArgs(request: SupabaseCliArgs): string[] {
    if (request.action === "version") return ["--version"];
    const workdir = request.workdir ? resolve(request.workdir) : undefined;
    if (!workdir) throw new Error("A workdir is required");
    return [...actionArguments(request, workdir), ...workdirArguments(workdir)];
}

export function createOfficialSupabaseEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
    const safeEnvironment: Record<string, string> = {};
    for (const [key, environmentValue] of Object.entries(environment)) {
        if (environmentValue === undefined) continue;
        if (key === "SUPABASE_YES" || key === "SUPABASE_EXPERIMENTAL") continue;
        if (key === "SUPABASE_ACCESS_TOKEN" && environment.SUPACLOUD_FORWARD_SUPABASE_ACCESS_TOKEN === "1") {
            safeEnvironment[key] = environmentValue;
            continue;
        }
        if (isSensitiveEnvironmentKey(key)) continue;
        safeEnvironment[key] = environmentValue;
    }
    safeEnvironment.SUPABASE_TELEMETRY_DISABLED = "true";
    safeEnvironment.NO_COLOR = "1";
    return safeEnvironment;
}

export function redactOfficialSupabaseOutput(commandOutput: string, secrets: string[] = []): string {
    const redactJson = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(redactJson);
        if (value !== null && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [
                key, /password|secret|token|key|credential|authorization|dsn|connection.?string/i.test(key)
                    ? "[REDACTED]" : redactJson(item),
            ]));
        }
        return value;
    };
    let redacted = commandOutput.split("\n").map(line => {
        try { return JSON.stringify(redactJson(JSON.parse(line))); } catch { return line; }
    }).join("\n");
    try { redacted = JSON.stringify(redactJson(JSON.parse(commandOutput)), null, 2); } catch { /* CLI progress is not JSON. */ }
    const explicitSecrets = [...new Set(secrets.filter((secret) => secret.length >= 4))]
        .sort((left, right) => right.length - left.length);
    for (const secret of explicitSecrets) {
        redacted = redacted.split(secret).join("[REDACTED]");
    }
    redacted = redacted.replace(
        /^(\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|DB_URI|DATABASE_URL|DB_URL|DSN)[A-Z0-9_]*\s*=\s*).*$/gim,
        "$1[REDACTED]",
    );
    redacted = redacted.replace(
        /("[^"]*(?:password|secret|token|key|credential|authorization|dsn|connection.?string)[^"]*"\s*:\s*")((?:\\.|[^"\\])*)(")/gi,
        "$1[REDACTED]$3",
    );
    redacted = redacted.replace(
        /(\b(?:password|pass|secret|token|key|credential|authorization|access_token|anon_key|service_role_key|db_password|connection_string)\b\s*:\s*)([^,\s}]+)/gi,
        "$1[REDACTED]",
    );
    redacted = redacted.replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, "postgresql://[REDACTED]");
    redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
    return redacted;
}

export function resolveOfficialSupabaseCommand(
    workdir: string,
    environment: NodeJS.ProcessEnv = process.env,
): string[] {
    const explicitBinary = environment.SUPACLOUD_SUPABASE_CLI_BIN?.trim();
    if (explicitBinary) {
        if (explicitBinary.includes("\0")) throw new Error("Invalid SUPACLOUD_SUPABASE_CLI_BIN");
        return [explicitBinary];
    }

    const version = environment.SUPABASE_CLI_VERSION?.trim();
    if (version) {
        if (!VALID_VERSION.test(version)) throw new Error("Invalid SUPABASE_CLI_VERSION; use an exact version such as 2.120.0");
        if (process.versions.bun) return [process.execPath, "x", `supabase@${version}`];
        if (process.platform === "win32") {
            throw new Error("SUPABASE_CLI_VERSION bootstrap is unavailable under Node on Windows; install the official CLI or set SUPACLOUD_SUPABASE_CLI_BIN");
        }
        return ["npx", "--yes", `supabase@${version}`];
    }

    const localPackageEntry = join(resolve(workdir), "node_modules", "supabase", "dist", "supabase.js");
    if (existsSync(localPackageEntry)) return [process.execPath, localPackageEntry];
    return ["supabase"];
}

function resolveExistingWorkdir(workdirInput: string | undefined, fallback: string): string {
    const workdir = resolve(workdirInput || fallback);
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
        throw new Error(`Supabase workdir not found: ${workdir}`);
    }
    return workdir;
}

function sensitiveValues(environment: NodeJS.ProcessEnv, dbUrl?: string): string[] {
    const values = Object.entries(environment)
        .filter(([key, environmentValue]) => environmentValue !== undefined && isSensitiveEnvironmentKey(key))
        .map(([, environmentValue]) => environmentValue as string);
    if (dbUrl) values.push(dbUrl);
    return values;
}

async function spawnOfficialSupabaseCommand(
    command: string[],
    workdir: string,
    environment: Record<string, string>,
): Promise<OfficialCliExecutionResult> {
    const child = Bun.spawn(command, {
        cwd: workdir,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
        child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
        child.exited,
    ]);
    return { exitCode: exitCode ?? 1, stdout, stderr };
}

async function executeOfficialSupabaseCli(
    request: SupabaseCliArgs,
    environment: NodeJS.ProcessEnv,
): Promise<OfficialCliExecutionResult> {
    const workdir = resolveExistingWorkdir(request.workdir, process.cwd());
    const command = [
        ...resolveOfficialSupabaseCommand(workdir, environment),
        ...buildOfficialSupabaseArgs({ ...request, workdir }),
    ];
    try {
        return await spawnOfficialSupabaseCommand(command, workdir, createOfficialSupabaseEnvironment(environment));
    } catch (error) {
        const failureMessage = error instanceof Error ? error.message : String(error);
        throw new Error([
            "Official Supabase CLI could not be started.",
            "Install it in the project, put `supabase` on PATH, set SUPACLOUD_SUPABASE_CLI_BIN,",
            "or explicitly opt into a pinned package-runner version with SUPABASE_CLI_VERSION.",
            failureMessage,
        ].join(" "));
    }
}

function actionOutputPath(request: SupabaseCliArgs, workdir: string): string | undefined {
    if (request.action === "db_dump") return resolveOutputPath(workdir, request.file, "Database dump");
    if (request.action === "gen_types") return resolveOutputPath(workdir, request.file, "Generated types");
    return undefined;
}

function formatExecutionText(action: SupabaseCliAction, execution: OfficialCliExecutionResult, secrets: string[]): string {
    const combinedOutput = [execution.stdout.trim(), execution.stderr.trim()].filter(Boolean).join("\n");
    const redacted = redactOfficialSupabaseOutput(combinedOutput, secrets);
    const heading = execution.exitCode === 0
        ? `✅ Official Supabase CLI ${action} completed`
        : `❌ Official Supabase CLI ${action} failed (exit ${execution.exitCode})`;
    return redacted ? `${heading}\n${redacted}` : heading;
}

interface SupabaseCliRuntime {
    getPushMigrations?: () => MigrationPushCallback | undefined;
    executeOfficialCli: OfficialCliExecutor;
    environment: NodeJS.ProcessEnv;
    fallbackWorkdir: string;
    projectRef?: string;
    readOnly: boolean;
}

function missingMigrationContextResult() {
    return {
        isError: true,
        content: [{
            type: "text" as const,
            text: [
                "⚠️ Remote migration push requires SupaCloud Management API context.",
                "Provide SUPACLOUD_API_URL + SUPACLOUD_API_TOKEN.",
                "Also pass --ref or set SUPACLOUD_PROJECT_REF when the project ref cannot be inferred from the URL.",
                "The Management token is sent only to the SupaCloud Management API and is never forwarded to the official CLI.",
            ].join("\n"),
        }],
    };
}

function readOnlyMigrationResult() {
    return {
        isError: true,
        content: [{
            type: "text" as const,
            text: "⚠️ Remote migration push is blocked in read-only mode (SUPACLOUD_READ_ONLY=true).",
        }],
    };
}

function missingProjectRefResult() {
    return {
        isError: true,
        content: [{
            type: "text" as const,
            text: "⚠️ Remote migration push requires a project ref. Pass --ref or set SUPACLOUD_PROJECT_REF.",
        }],
    };
}

async function executeMigrationPush(request: SupabaseCliArgs, runtime: SupabaseCliRuntime) {
    if (runtime.readOnly) return readOnlyMigrationResult();
    const pushMigrations = runtime.getPushMigrations?.();
    if (!pushMigrations) return missingMigrationContextResult();
    const projectRef = request.ref || runtime.projectRef;
    if (!projectRef) return missingProjectRefResult();
    const workdir = resolveExistingWorkdir(request.workdir, runtime.fallbackWorkdir);
    const migrationDirectory = resolve(workdir, request.dir || "supabase/migrations");
    const migrationResponse = await pushMigrations({
        action: "push_migrations",
        ref: projectRef,
        dir: migrationDirectory,
        dry_run: request.dry_run,
    });
    const failureText = migrationResponse?.content?.some(
        (content: { type?: string; text?: string }) => content.type === "text" && content.text?.trimStart().startsWith("❌"),
    );
    return failureText ? { ...migrationResponse, isError: true } : migrationResponse;
}

function generatedTypesResult(outputPath: string, execution: OfficialCliExecutionResult, secrets: string[]) {
    writeFileSync(outputPath, execution.stdout, { encoding: "utf8", mode: 0o600 });
    const safeStandardError = redactOfficialSupabaseOutput(execution.stderr.trim(), secrets);
    return {
        content: [{
            type: "text" as const,
            text: [`✅ Official Supabase CLI gen_types wrote ${outputPath}`, ...(safeStandardError ? [safeStandardError] : [])].join("\n"),
        }],
    };
}

async function executeOfficialAction(request: SupabaseCliArgs, runtime: SupabaseCliRuntime) {
    if (request.action.startsWith("stack_") && request.runtime === "native"
        && runtime.environment.SUPACLOUD_ENABLE_NATIVE_STACK !== "1") {
        throw new Error("Native local stack is alpha and disabled by default; set SUPACLOUD_ENABLE_NATIVE_STACK=1 to enable it");
    }
    const workdir = resolveExistingWorkdir(request.workdir, runtime.fallbackWorkdir);
    if (request.action === "config_pull" && request.ref && runtime.projectRef && request.ref !== runtime.projectRef) {
        throw new Error("config_pull cannot target a project outside the authorized context");
    }
    const normalizedRequest = {
        ...request, workdir,
        ...(request.action === "config_pull" ? { ref: request.ref ?? runtime.projectRef } : {}),
    };
    // Validate even with an injected executor so alternate transports keep the same boundary.
    buildOfficialSupabaseArgs(normalizedRequest);
    const outputPath = actionOutputPath(normalizedRequest, workdir);
    if (outputPath) mkdirSync(dirname(outputPath), { recursive: true });
    const secrets = sensitiveValues(runtime.environment, request.db_url);
    const execution = await runtime.executeOfficialCli(normalizedRequest);

    if (execution.exitCode === 0 && request.action === "gen_types" && outputPath) {
        return generatedTypesResult(outputPath, execution, secrets);
    }
    if (execution.exitCode === 0 && request.action === "db_dump" && outputPath && existsSync(outputPath)) {
        chmodSync(outputPath, 0o600);
    }
    return {
        isError: execution.exitCode !== 0,
        content: [{ type: "text" as const, text: formatExecutionText(request.action, execution, secrets) }],
    };
}

function executeSupabaseAction(request: SupabaseCliArgs, runtime: SupabaseCliRuntime) {
    return request.action === "push"
        ? executeMigrationPush(request, runtime)
        : executeOfficialAction(request, runtime);
}

export function registerSupabaseCliTools(
    server: ToolServer,
    options: SupabaseCliToolOptions = {},
): void {
    const environment = options.environment || process.env;
    const runtime: SupabaseCliRuntime = {
        environment,
        fallbackWorkdir: options.currentWorkingDirectory || process.cwd(),
        getPushMigrations: options.getPushMigrations,
        projectRef: options.projectRef,
        readOnly: options.readOnly ?? false,
        executeOfficialCli: options.executeOfficialCli || ((request) => executeOfficialSupabaseCli(request, environment)),
    };

    server.tool(
        "supabase",
        "Controlled adapter for the official open-source Supabase CLI. Remote push stays on the SupaCloud Management API and requires explicit Management credentials.",
        {
            action: withDescription(stringEnum([
                "version", "init", "migration_new", "db_diff", "db_reset", "db_pull",
                "db_schema_declarative_sync", "db_schema_declarative_generate",
                "db_dump", "config_pull", "stack_start", "stack_prepare", "stack_status",
                "stack_stop", "stack_destroy", "migration_list", "gen_types", "push",
            ]), "Action to perform"),
            workdir: optional(Type.String(), "[*] Supabase project directory (default: current directory)"),
            ref: optional(Type.String(), "[config_pull/push] Optional project ref override"),
            name: optional(Type.String(), "[migration_new/db_diff/db_pull] Migration name"),
            schema: optional(Type.String(), "[db_diff/db_pull/db_dump/gen_types] Comma-separated schemas"),
            db_url: optional(Type.String(), "[db_pull/db_dump/migration_list/gen_types] Explicit percent-encoded Postgres DSN"),
            file: optional(Type.String(), "[db_dump/gen_types] Output file"),
            dir: optional(Type.String(), "[push] Migration directory (default: supabase/migrations)"),
            dry_run: optional(Type.Boolean(), "[push/config_pull] Preview changes; config_pull defaults to true"),
            declarative: optional(Type.Boolean(), "[db_pull] Pull declarative schemas with pg-delta"),
            apply: optional(Type.Boolean(), "[db_schema_declarative_sync] Apply the generated migration locally"),
            experimental: optional(Type.Boolean(), "[db_schema_declarative_*] Enable the experimental pg-delta workflow"),
            strict_coverage: optional(Type.Boolean(), "[db_schema_declarative_*] Fail on unmanaged schema objects"),
            overwrite: optional(Type.Boolean(), "[db_schema_declarative_generate] Replace existing schema files"),
            runtime: optional(stringEnum(["docker", "podman", "native"]), "[stack_*] Local stack runtime"),
            eager: optional(Type.Boolean(), "[stack_start] Start all services before returning"),
            preparation: optional(stringEnum(["background", "on-demand"]), "[stack_start] Download service archives in the background or on demand"),
            force: optional(Type.Boolean(), "[config_pull] Permit overwriting dirty tracked config"),
            yes: optional(Type.Boolean(), "[config_pull/stack_destroy] Confirm a write or destructive action"),
            confirm_destroy: optional(Type.Boolean(), "[stack_destroy] Explicitly confirm permanent local stack destruction"),
            no_seed: optional(Type.Boolean(), "[db_reset] Skip seed scripts"),
            diff_engine: optional(stringEnum(["migra", "pg-delta", "pgadmin", "pg-schema"]), "[db_diff/db_pull] Official CLI diff engine"),
            dump_mode: optional(stringEnum(["schema", "data", "roles"]), "[db_dump] Dump schema (default), data, or roles"),
            language: optional(stringEnum(["typescript", "go", "swift", "python"]), "[gen_types] Output language (default: typescript)"),
        },
        (request: SupabaseCliArgs) => executeSupabaseAction(request, runtime),
    );
}
