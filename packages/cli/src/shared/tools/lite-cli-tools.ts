import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

export type LiteCliAction =
    | "version" | "start" | "migrate" | "status" | "keys" | "gen_types"
    | "db_reset" | "db_diff" | "db_pull" | "snapshot_create" | "snapshot_restore"
    | "upgrade" | "inspect" | "doctor";

export interface LiteCliArgs {
    action: LiteCliAction;
    workdir?: string;
    project_dir?: string;
    state_dir?: string;
    data_dir?: string;
    storage_dir?: string;
    storage_backend?: "fs" | "memory" | "s3";
    s3_prefix?: string;
    engine?: "pglite" | "native";
    host?: string;
    port?: number;
    api_url?: string;
    site_url?: string;
    replication_profile?: "powersync";
    replication_host?: string;
    replication_port?: number;
    replication_allow_cidrs?: string;
    powersync_tables?: string;
    replication_tls_cert?: string;
    replication_tls_key?: string;
    output?: string;
    file?: string;
    snapshot_file?: string;
    service_role?: boolean;
    force?: boolean;
    memory?: boolean;
    json?: boolean;
}

export interface LiteCliExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

type LiteCliExecutor = (request: LiteCliArgs) => Promise<LiteCliExecutionResult>;

export interface LiteCliToolOptions {
    executeLiteCli?: LiteCliExecutor;
    environment?: NodeJS.ProcessEnv;
    currentWorkingDirectory?: string;
}

function requireWorkdir(workdir: string | undefined, fallback: string): string {
    const resolved = resolve(workdir || fallback);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new Error(`Lite workdir not found: ${resolved}`);
    }
    return resolved;
}

function optionalFlag(args: string[], flag: string, value: string | number | undefined): void {
    if (value !== undefined) args.push(flag, String(value));
}

function booleanFlag(args: string[], flag: string, value: boolean | undefined): void {
    if (value === true) args.push(flag);
}

export function buildLiteArgs(request: LiteCliArgs): string[] {
    const args: string[] = [];
    if (request.action === "version") return ["--version"];

    switch (request.action) {
        case "start": case "migrate": case "status": case "keys": case "upgrade": case "inspect": case "doctor":
            args.push(request.action);
            break;
        case "gen_types": args.push("gen", "types"); break;
        case "db_reset": args.push("db", "reset"); break;
        case "db_diff": args.push("db", "diff"); break;
        case "db_pull":
            args.push("db", "pull");
            if (request.file) args.push(request.file);
            break;
        case "snapshot_create": args.push("snapshot", "create"); break;
        case "snapshot_restore":
            if (!request.snapshot_file) throw new Error("snapshot_restore requires --snapshot_file");
            args.push("snapshot", "restore", request.snapshot_file);
            break;
        default: throw new Error(`Unsupported Lite CLI action: ${String(request.action)}`);
    }

    optionalFlag(args, "--project-dir", request.project_dir);
    optionalFlag(args, "--state-dir", request.state_dir);
    optionalFlag(args, "--data-dir", request.data_dir);
    optionalFlag(args, "--storage-dir", request.storage_dir);
    optionalFlag(args, "--storage-backend", request.storage_backend);
    optionalFlag(args, "--s3-prefix", request.s3_prefix);
    optionalFlag(args, "--engine", request.engine);
    optionalFlag(args, "--host", request.host);
    optionalFlag(args, "--port", request.port);
    optionalFlag(args, "--api-url", request.api_url);
    optionalFlag(args, "--site-url", request.site_url);
    optionalFlag(args, "--replication-profile", request.replication_profile);
    optionalFlag(args, "--replication-host", request.replication_host);
    optionalFlag(args, "--replication-port", request.replication_port);
    optionalFlag(args, "--replication-allow-cidrs", request.replication_allow_cidrs);
    optionalFlag(args, "--powersync-tables", request.powersync_tables);
    optionalFlag(args, "--replication-tls-cert", request.replication_tls_cert);
    optionalFlag(args, "--replication-tls-key", request.replication_tls_key);
    optionalFlag(args, "--output", request.output);
    optionalFlag(args, "--file", request.action === "db_diff" ? request.file : undefined);
    booleanFlag(args, "--service-role", request.service_role);
    booleanFlag(args, "--force", request.force);
    booleanFlag(args, "--memory", request.memory);
    booleanFlag(args, "--json", request.json);
    return args;
}

export function resolveLiteCommand(workdir: string, environment: NodeJS.ProcessEnv = process.env): string[] {
    const explicitBinary = environment.SUPACLOUD_LITE_CLI_BIN?.trim();
    if (explicitBinary) {
        if (explicitBinary.includes("\0")) throw new Error("Invalid SUPACLOUD_LITE_CLI_BIN");
        return [explicitBinary];
    }
    const localPackageEntry = join(resolve(workdir), "node_modules", "@supacloud", "lite", "dist", "launcher.cjs");
    if (existsSync(localPackageEntry)) return [process.execPath, localPackageEntry];
    return ["supacloud-lite"];
}

function spawnLiteCommand(
    command: string[],
    workdir: string,
    environment: NodeJS.ProcessEnv,
    inheritOutput: boolean,
): Promise<LiteCliExecutionResult> {
    const [executable, ...commandArguments] = command;
    return new Promise((resolveExecution, rejectExecution) => {
        const child = spawn(executable, commandArguments, {
            cwd: workdir, env: { ...environment, NO_COLOR: "1" }, shell: false,
            stdio: inheritOutput ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
        process.once("SIGINT", forwardSignal);
        process.once("SIGTERM", forwardSignal);
        const cleanup = () => {
            process.off("SIGINT", forwardSignal);
            process.off("SIGTERM", forwardSignal);
        };
        if (inheritOutput) {
            child.once("error", (error) => {
                cleanup();
                rejectExecution(error);
            });
            child.once("close", (exitCode) => {
                cleanup();
                resolveExecution({ exitCode: exitCode ?? 1, stdout: "", stderr: "" });
            });
            return;
        }
        if (!child.stdout || !child.stderr) {
            cleanup();
            rejectExecution(new Error("Lite CLI child process did not expose piped output"));
            return;
        }
        let standardOutput: string = "";
        let standardError: string = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { standardOutput += chunk; });
        child.stderr.on("data", (chunk: string) => { standardError += chunk; });
        child.once("error", (error) => {
            cleanup();
            rejectExecution(error);
        });
        child.once("close", (exitCode) => {
            cleanup();
            resolveExecution({ exitCode: exitCode ?? 1, stdout: standardOutput, stderr: standardError });
        });
    });
}

async function executeLiteCli(
    request: LiteCliArgs,
    environment: NodeJS.ProcessEnv,
    fallbackWorkdir: string,
): Promise<LiteCliExecutionResult> {
    const workdir = requireWorkdir(request.workdir, fallbackWorkdir);
    const command = [...resolveLiteCommand(workdir, environment), ...buildLiteArgs({ ...request, workdir })];
    try {
        return await spawnLiteCommand(command, workdir, environment, request.action === "start");
    } catch (error) {
        const failureMessage = error instanceof Error ? error.message : String(error);
        throw new Error([
            "SupaCloud Lite CLI could not be started.",
            "Install @supacloud/lite, put supacloud-lite on PATH, or set SUPACLOUD_LITE_CLI_BIN.",
            failureMessage,
        ].join(" "));
    }
}

function formatExecutionText(action: LiteCliAction, execution: LiteCliExecutionResult): string {
    const combinedOutput = [execution.stdout.trim(), execution.stderr.trim()].filter(Boolean).join("\n");
    const heading = execution.exitCode === 0
        ? `✅ SupaCloud Lite ${action} completed`
        : `❌ SupaCloud Lite ${action} failed (exit ${execution.exitCode})`;
    return combinedOutput ? `${heading}\n${combinedOutput}` : heading;
}

export function registerLiteCliTools(server: ToolServer, options: LiteCliToolOptions = {}): void {
    const environment = options.environment || process.env;
    const fallbackWorkdir = options.currentWorkingDirectory || process.cwd();
    const execute = options.executeLiteCli || ((request) => executeLiteCli(request, environment, fallbackWorkdir));
    server.tool(
        "lite",
        "Controlled adapter for the local SupaCloud Lite CLI. Lite actions are local-only and never use the Management API or official Supabase CLI.",
        {
            action: withDescription(stringEnum([
                "version", "start", "migrate", "status", "keys", "gen_types", "db_reset", "db_diff", "db_pull",
                "snapshot_create", "snapshot_restore", "upgrade", "inspect", "doctor",
            ]), "Lite CLI action"),
            workdir: optional(Type.String(), "[*] Process working directory (default: current directory)"),
            project_dir: optional(Type.String(), "[*] Project containing supabase/"),
            state_dir: optional(Type.String(), "[*] Lite state root"),
            data_dir: optional(Type.String(), "[*] PGlite/native data directory"),
            storage_dir: optional(Type.String(), "[*] Object storage directory"),
            storage_backend: optional(stringEnum(["fs", "memory", "s3"]), "[*] Storage backend"),
            s3_prefix: optional(Type.String(), "[*] S3 object key prefix"),
            engine: optional(stringEnum(["pglite", "native"]), "[*] Database engine"),
            host: optional(Type.String(), "[start] Listen host"),
            port: optional(Type.Number(), "[start] Listen port"),
            api_url: optional(Type.String(), "[start] Public API URL"),
            site_url: optional(Type.String(), "[start] Auth site URL"),
            replication_profile: optional(stringEnum(["powersync"]), "[start/doctor] Replication profile"),
            replication_host: optional(Type.String(), "[start] Replication listener host"),
            replication_port: optional(Type.Number(), "[start] Replication listener port"),
            replication_allow_cidrs: optional(Type.String(), "[start] Replication client CIDRs"),
            powersync_tables: optional(Type.String(), "[start] PowerSync publication tables"),
            replication_tls_cert: optional(Type.String(), "[start] Replication TLS certificate"),
            replication_tls_key: optional(Type.String(), "[start] Replication TLS private key"),
            output: optional(Type.String(), "[gen_types/snapshot_create/upgrade] Output path"),
            file: optional(Type.String(), "[db_diff/db_pull] Migration suffix or name"),
            snapshot_file: optional(Type.String(), "[snapshot_restore] Snapshot archive"),
            service_role: optional(Type.Boolean(), "[keys] Also print the service_role key"),
            force: optional(Type.Boolean(), "[snapshot_restore] Replace non-empty restore targets"),
            memory: optional(Type.Boolean(), "[*] Use an in-memory PGlite database"),
            json: optional(Type.Boolean(), "[doctor] Emit machine-readable output"),
        },
        async (request: LiteCliArgs) => {
            const execution = await execute(request);
            return {
                isError: execution.exitCode !== 0,
                content: [{ type: "text" as const, text: formatExecutionText(request.action, execution) }],
            };
        },
    );
}
