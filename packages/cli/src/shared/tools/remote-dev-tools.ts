import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { compileProject } from "@supacloud/compiler";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";

type ToolServer = { tool: (name: string, description: string, schema: ToolSchema, callback: (args: any) => Promise<any>) => void };
type CommandResult = { exitCode: number; stdout: string; stderr: string };
type CommandExecutor = (command: string, args: string[], cwd: string) => Promise<CommandResult>;
type DatabaseCallback = (args: Record<string, unknown>) => Promise<any>;

export interface RemoteDevToolOptions {
    cwd?: string;
    host?: string;
    sshUser?: string;
    sshPort?: number;
    sshKey?: string;
    projectRef?: string;
    environment?: string;
    execute?: CommandExecutor;
    runDatabase?: DatabaseCallback;
}

interface DevConfig {
    host?: string;
    user?: string;
    port?: number;
    key?: string;
    remoteRoot?: string;
    reloadCommand?: string;
    statusCommand?: string;
    excludes?: string[];
    compile?: boolean;
    compileRoot?: string;
    compileOutDir?: string;
    compileStrict?: boolean;
    database?: {
        drizzleConfig?: string;
        migrationsDir?: string;
        drizzleBin?: string;
        strict?: boolean;
    };
}

interface ProjectConfig {
    dev?: DevConfig;
    targets?: Record<string, { type?: string; root?: string; slug?: string }>;
}

const SAFE_TOKEN = /^[A-Za-z0-9._:@/+,-]+$/;
const SAFE_REMOTE_ROOT = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/;

export const remoteDevToolSchema = {
    action: withDescription(stringEnum(["sync", "watch", "status", "migrate"]), "Remote development action"),
    target: optional(stringEnum(["db", "functions", "frontend", "project"]), "Sync target (default: project)"),
    project_dir: optional(Type.String(), "Local project directory (default: current directory)"),
    remote_root: optional(Type.String(), "Remote development root"),
    remote_host: optional(Type.String(), "Remote test server host"),
    remote_user: optional(Type.String(), "SSH user"),
    remote_port: optional(Type.Number(), "SSH port"),
    remote_key: optional(Type.String(), "SSH private key path"),
    function: optional(Type.String(), "Function slug"),
    delete: optional(Type.Boolean(), "Delete remote files absent locally"),
    reload: optional(Type.Boolean(), "Reload the affected target after sync (default: true)"),
    interval_ms: optional(Type.Number(), "Watch debounce interval in milliseconds (default: 300)"),
    json: optional(Type.Boolean(), "Emit machine-readable JSON"),
    apply: optional(Type.Boolean(), "Apply generated migrations to the selected test database"),
    drizzle_config: optional(Type.String(), "Drizzle config path"),
    migrations_dir: optional(Type.String(), "Migration directory"),
    drizzle_bin: optional(Type.String(), "drizzle-kit executable"),
};

function runProcess(executable: string, args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolveResult, reject) => {
        const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (exitCode) => resolveResult({ exitCode: exitCode ?? 1, stdout, stderr }));
    });
}

function resolveDrizzleCommand(root: string, configured: string | undefined): string {
    if (configured?.trim()) return configured.trim();
    const local = join(root, "node_modules", ".bin", "drizzle-kit");
    return existsSync(local) ? local : "drizzle-kit";
}

function toolFailed(value: any): boolean {
    return value?.isError === true || value?.content?.some((chunk: any) => typeof chunk?.text === "string" && chunk.text.trimStart().startsWith("❌"));
}

async function migrateDatabase(args: Record<string, unknown>, options: RemoteDevToolOptions): Promise<Record<string, unknown>> {
    const root = resolve(String(args.project_dir || options.cwd || process.cwd()));
    const projectConfig = await readProjectConfig(root);
    const config = projectConfig.dev || {};
    const database = config.database || {};
    const execute = options.execute || ((command, commandArgs, cwd) => runProcess(command, commandArgs, cwd));
    const drizzleConfig = resolve(root, String(args.drizzle_config || database.drizzleConfig || "drizzle.config.ts"));
    const migrationsDir = String(args.migrations_dir || database.migrationsDir || "supabase/migrations");
    if (!existsSync(drizzleConfig)) throw new Error(`Drizzle config not found: ${drizzleConfig}`);
    const generated = await execute(resolveDrizzleCommand(root, typeof args.drizzle_bin === "string" ? args.drizzle_bin : database.drizzleBin), ["generate", "--config", drizzleConfig], root);
    if (generated.exitCode !== 0) throw new Error(`Drizzle migration generation failed: ${generated.stderr.trim() || `exit ${generated.exitCode}`}`);
    if (!options.runDatabase) throw new Error("dev migrate requires Management API context");
    const dryRun = await options.runDatabase({ action: "push_migrations", dir: migrationsDir, dry_run: true, strict: database.strict !== false });
    if (toolFailed(dryRun)) throw new Error("SupaCloud migration dry-run failed");
    if (args.apply !== true) return { ok: true, mode: "dev", action: "migrate", generated: true, applied: false, migrations_dir: migrationsDir, dry_run: dryRun };
    const applied = await options.runDatabase({ action: "push_migrations", dir: migrationsDir, strict: database.strict !== false });
    if (toolFailed(applied)) throw new Error("SupaCloud migration apply failed");
    return { ok: true, mode: "dev", action: "migrate", generated: true, applied: true, migrations_dir: migrationsDir, result: applied };
}

async function readProjectConfig(root: string): Promise<ProjectConfig> {
    const file = join(root, "supacloud.json");
    if (!existsSync(file)) return {};
    try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        return parsed && typeof parsed === "object" ? parsed as ProjectConfig : {};
    } catch (error) {
        throw new Error(`Invalid supacloud.json: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function readDevConfig(root: string): Promise<DevConfig> {
    const config = await readProjectConfig(root);
    return config.dev || {};
}

async function sourceFingerprint(root: string): Promise<string> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(directory, entry.name);
            if (entry.isDirectory() && ![".git", "node_modules", "dist", "generated", ".supacloud"].includes(entry.name)) await visit(path);
            else if (entry.isFile()) files.push(path);
        }
    };
    await visit(root);
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(file.slice(root.length).replace(/\\/g, "/"));
        hash.update(await readFile(file));
    }
    return hash.digest("hex");
}

function safeToken(value: string, label: string): string {
    if (!value || !SAFE_TOKEN.test(value)) throw new Error(`Invalid ${label}`);
    return value;
}

function remoteRoot(value: string): string {
    const normalized = value.trim().replace(/\\/g, "/");
    if (!SAFE_REMOTE_ROOT.test(normalized) || normalized.includes("..")) throw new Error("Invalid remote_root");
    return normalized.replace(/\/$/, "");
}

function targetDirectory(root: string, target: string, functionSlug?: string, config: Record<string, unknown> = {}): string {
    if (target === "db") return join(root, "supabase", "migrations");
    if (target === "functions") {
        const targets = config.targets && typeof config.targets === "object" ? config.targets as Record<string, any> : {};
        const match = Object.values(targets).find((entry) => entry?.type === "edge_function"
            && (!functionSlug || String(entry.slug || "") === functionSlug));
        const base = match?.root ? resolve(root, String(match.root)) : join(root, "supabase", "functions");
        return match?.root ? base : functionSlug ? join(base, safeToken(functionSlug, "function")) : base;
    }
    if (target === "frontend") {
        const targets = config.targets && typeof config.targets === "object" ? config.targets as Record<string, any> : {};
        const match = Object.values(targets).find((entry) => entry?.type === "frontend");
        return match?.root ? resolve(root, String(match.root)) : join(root, "apps", "web");
    }
    return root;
}

function remoteTargetRoot(root: string, target: string, functionSlug?: string): string {
    if (target === "db") return `${root}/database/migrations`;
    if (target === "functions") return `${root}/functions/${functionSlug ? safeToken(functionSlug, "function") : ""}`.replace(/\/$/, "");
    if (target === "frontend") return `${root}/frontend`;
    return `${root}/project`;
}

function connectionArgs(options: RemoteDevToolOptions, config: DevConfig, args: Record<string, unknown>): { host: string; user: string; port: number; key: string } {
    const host = String(args.remote_host || config.host || options.host || "").trim();
    const user = String(args.remote_user || config.user || options.sshUser || "").trim();
    const port = Number(args.remote_port || config.port || options.sshPort || 22);
    const key = String(args.remote_key || config.key || options.sshKey || "").trim();
    if (!host) throw new Error("Remote dev requires SUPACLOUD_HOST or --remote_host");
    safeToken(host, "remote_host");
    safeToken(user, "remote_user");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid remote_port");
    if (!key || key.includes("\0") || key.includes("\n")) throw new Error("Invalid remote_key");
    return { host, user, port, key };
}

function targetConfigPath(target: string): string {
    return target === "project" ? "project" : target;
}

function reloadCommand(config: DevConfig, target: string, projectRef: string | undefined, functionSlug?: string): string[] {
    const command = config.reloadCommand?.trim() || "supacloud-dev-agent reload";
    if (!/^[A-Za-z0-9._/-]+(?: [A-Za-z0-9._:/=-]+)*$/.test(command)) throw new Error("Invalid reloadCommand in supacloud.json");
    return [...command.split(" "), "--project-ref", safeToken(projectRef || "test", "project_ref"), "--target", targetConfigPath(target), ...(functionSlug ? ["--function", safeToken(functionSlug, "function")] : [])];
}

function sshArgs(connection: { host: string; user: string; port: number; key: string }, remoteCommand: string[]): string[] {
    return ["-p", String(connection.port), "-i", resolve(connection.key), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", `${connection.user}@${connection.host}`, ...remoteCommand];
}

function rsyncArgs(connection: { host: string; user: string; port: number; key: string }, source: string, destination: string, excludes: string[], deleteRemote: boolean): string[] {
    const args = ["-az", "--checksum", "--partial", "--protect-args", "-e", `ssh -p ${connection.port} -i ${resolve(connection.key)} -o BatchMode=yes -o StrictHostKeyChecking=yes`];
    if (deleteRemote) args.push("--delete-delay");
    for (const exclude of excludes) {
        if (!/^\/?[A-Za-z0-9._*/-]+$/.test(exclude)) throw new Error("Invalid dev exclude pattern");
        args.push("--exclude", exclude);
    }
    args.push(`${source.replace(/\/$/, "")}/`, `${connection.user}@${connection.host}:${destination.replace(/\/$/, "")}/`);
    return args;
}

async function syncOnce(args: Record<string, unknown>, options: RemoteDevToolOptions): Promise<Record<string, unknown>> {
    const root = resolve(String(args.project_dir || options.cwd || process.cwd()));
    const projectConfig = await readProjectConfig(root);
    const config = projectConfig.dev || {};
    const target = String(args.target || "project");
    const source = targetDirectory(root, target, typeof args.function === "string" ? args.function : undefined, projectConfig as Record<string, unknown>);
    if (!existsSync(source)) throw new Error(`Dev source directory not found: ${source}`);
    let compiled = false;
    if (config.compile === true && target !== "db") {
        const compileRoot = resolve(root, config.compileRoot || ".");
        const compileOutDir = resolve(root, config.compileOutDir || "generated");
        const compilation = await compileProject({
            rootDir: compileRoot,
            outDir: compileOutDir,
            strict: config.compileStrict !== false,
        });
        const errors = compilation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0) {
            throw new Error(`DI compile failed: ${errors.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join("; ")}`);
        }
        compiled = true;
    }
    const remoteBase = remoteRoot(String(args.remote_root || config.remoteRoot || `/var/lib/supacloud/dev/${options.projectRef || "project"}`));
    const slug = typeof args.function === "string" ? args.function : undefined;
    const destination = remoteTargetRoot(remoteBase, target, slug);
    const connection = connectionArgs(options, config, args);
    const execute = options.execute || ((command, commandArgs, cwd) => runProcess(command, commandArgs, cwd));
    const mkdir = await execute("ssh", sshArgs(connection, ["mkdir", "-p", destination]), root);
    if (mkdir.exitCode !== 0) throw new Error(`Remote dev prepare failed: ${mkdir.stderr.trim() || `exit ${mkdir.exitCode}`}`);
    const excludes = Array.isArray(config.excludes) ? config.excludes : ["node_modules", ".git", ".env*", "dist", ".supacloud"];
    const sync = await execute("rsync", rsyncArgs(connection, source, destination, excludes, args.delete === true), root);
    if (sync.exitCode !== 0) throw new Error(`Remote dev sync failed: ${sync.stderr.trim() || `exit ${sync.exitCode}`}`);
    const shouldReload = args.reload !== false;
    let reload: CommandResult | null = null;
    if (shouldReload) {
        reload = await execute("ssh", sshArgs(connection, reloadCommand(config, target, options.projectRef, slug)), root);
        if (reload.exitCode !== 0) throw new Error(`Remote dev reload failed: ${reload.stderr.trim() || `exit ${reload.exitCode}`}`);
    }
    return { ok: true, mode: "dev", action: "sync", environment: options.environment || null, target, source, destination, host: connection.host, compiled, reloaded: shouldReload };
}

export function registerRemoteDevTools(server: ToolServer, options: RemoteDevToolOptions = {}): void {
    server.tool("dev", "Remote test-server development sync. It never targets production and never syncs secrets.", remoteDevToolSchema, async (args) => {
        if (["production", "prod"].includes((options.environment || "").toLowerCase())) throw new Error("Remote dev mode is forbidden for production environments");
        if (args.action === "status") {
            const root = resolve(String(args.project_dir || options.cwd || process.cwd()));
            const config = await readDevConfig(root);
            const connection = connectionArgs(options, config, args);
            const execute = options.execute || ((command, commandArgs, cwd) => runProcess(command, commandArgs, cwd));
            const status = await execute("ssh", sshArgs(connection, ["supacloud-dev-agent", "status", "--project-ref", safeToken(options.projectRef || "test", "project_ref")]), root);
            return { content: [{ type: "text" as const, text: JSON.stringify({ ok: status.exitCode === 0, mode: "dev", action: "status", host: connection.host, output: status.stdout.trim(), error: status.stderr.trim() }, null, 2) }], isError: status.exitCode !== 0 };
        }
        if (args.action === "sync") {
            return { content: [{ type: "text" as const, text: JSON.stringify(await syncOnce(args, options), null, 2) }] };
        }
        if (args.action === "migrate") {
            return { content: [{ type: "text" as const, text: JSON.stringify(await migrateDatabase(args, options), null, 2) }] };
        }
        if (args.action === "watch") {
            const root = resolve(String(args.project_dir || options.cwd || process.cwd()));
            const interval = Math.max(100, Math.min(10_000, Number(args.interval_ms || 300)));
            let fingerprint = "";
            let lastSync: Record<string, unknown> | null = null;
            for (;;) {
                const nextFingerprint = await sourceFingerprint(root);
                if (nextFingerprint !== fingerprint) {
                    lastSync = await syncOnce(args, options);
                    fingerprint = nextFingerprint;
                    process.stdout.write(`${JSON.stringify({ ...lastSync, watching: true })}\n`);
                }
                await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
            }
        }
        throw new Error("Unsupported remote dev action");
    });
}
