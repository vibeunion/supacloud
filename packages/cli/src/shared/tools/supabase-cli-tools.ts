import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
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
    | "migration_new"
    | "db_diff"
    | "db_reset"
    | "db_pull"
    | "db_dump"
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

function databaseDumpArguments(request: SupabaseCliArgs, workdir: string): string[] {
    return [
        "db", "dump", "--db-url", requirePostgresUrl(request.db_url),
        "--file", resolveOutputPath(workdir, request.file, "Database dump"),
        ...(request.dump_mode === "data" ? ["--data-only"] : []),
        ...(request.dump_mode === "roles" ? ["--role-only"] : []),
        ...schemaArguments(request.schema),
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
        case "migration_new": return ["migration", "new", requireMigrationName(request.name)];
        case "db_diff": return databaseDiffArguments(request);
        case "db_reset": return ["db", "reset", "--local", ...(request.no_seed ? ["--no-seed"] : []), "--yes"];
        case "db_pull": return databasePullArguments(request);
        case "db_dump": return databaseDumpArguments(request, workdir);
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
        if (isSensitiveEnvironmentKey(key)) continue;
        safeEnvironment[key] = environmentValue;
    }
    safeEnvironment.SUPABASE_TELEMETRY_DISABLED = "true";
    safeEnvironment.NO_COLOR = "1";
    return safeEnvironment;
}

export function redactOfficialSupabaseOutput(commandOutput: string, secrets: string[] = []): string {
    let redacted = commandOutput;
    const explicitSecrets = [...new Set(secrets.filter((secret) => secret.length >= 4))]
        .sort((left, right) => right.length - left.length);
    for (const secret of explicitSecrets) {
        redacted = redacted.split(secret).join("[REDACTED]");
    }
    redacted = redacted.replace(
        /^(\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|DB_URI|DATABASE_URL|DB_URL|DSN)[A-Z0-9_]*\s*=\s*).*$/gim,
        "$1[REDACTED]",
    );
    redacted = redacted.replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, "postgresql://[REDACTED]");
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
        if (!VALID_VERSION.test(version)) throw new Error("Invalid SUPABASE_CLI_VERSION; use an exact version such as 2.110.0");
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

function spawnOfficialSupabaseCommand(
    command: string[],
    workdir: string,
    environment: Record<string, string>,
): Promise<OfficialCliExecutionResult> {
    const [executable, ...commandArguments] = command;
    return new Promise((resolveExecution, rejectExecution) => {
        const child = spawn(executable, commandArguments, {
            cwd: workdir,
            env: environment,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let standardOutput = "";
        let standardError = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { standardOutput += chunk; });
        child.stderr.on("data", (chunk: string) => { standardError += chunk; });
        child.once("error", rejectExecution);
        child.once("close", (exitCode) => {
            resolveExecution({ exitCode: exitCode ?? 1, stdout: standardOutput, stderr: standardError });
        });
    });
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
    const workdir = resolveExistingWorkdir(request.workdir, runtime.fallbackWorkdir);
    const normalizedRequest = { ...request, workdir };
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
                "version", "migration_new", "db_diff", "db_reset", "db_pull",
                "db_dump", "migration_list", "gen_types", "push",
            ]), "Action to perform"),
            workdir: optional(Type.String(), "[*] Supabase project directory (default: current directory)"),
            ref: optional(Type.String(), "[push] Optional project ref override"),
            name: optional(Type.String(), "[migration_new/db_diff/db_pull] Migration name"),
            schema: optional(Type.String(), "[db_diff/db_pull/db_dump/gen_types] Comma-separated schemas"),
            db_url: optional(Type.String(), "[db_pull/db_dump/migration_list/gen_types] Explicit percent-encoded Postgres DSN"),
            file: optional(Type.String(), "[db_dump/gen_types] Output file"),
            dir: optional(Type.String(), "[push] Migration directory (default: supabase/migrations)"),
            dry_run: optional(Type.Boolean(), "[push] Preview pending migrations without applying"),
            declarative: optional(Type.Boolean(), "[db_pull] Pull declarative schemas with pg-delta"),
            no_seed: optional(Type.Boolean(), "[db_reset] Skip seed scripts"),
            diff_engine: optional(stringEnum(["migra", "pg-delta", "pgadmin", "pg-schema"]), "[db_diff/db_pull] Official CLI diff engine"),
            dump_mode: optional(stringEnum(["schema", "data", "roles"]), "[db_dump] Dump schema (default), data, or roles"),
            language: optional(stringEnum(["typescript", "go", "swift", "python"]), "[gen_types] Output language (default: typescript)"),
        },
        (request: SupabaseCliArgs) => executeSupabaseAction(request, runtime),
    );
}
