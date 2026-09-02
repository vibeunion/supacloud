import { access, lstat, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { zipSync, type Zippable } from "fflate";
import { optional } from "../schema";
import type { HttpTransport } from "../transports/http";
import {
    activateFrontendRelease,
    listFrontendReleases,
    uploadFrontendRelease,
} from "./frontend-release-control";

const FIXED_ZIP_MTIME = new Date("1980-01-01T00:00:00.000Z");
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

interface DeployConfig {
    frontend?: {
        id?: string;
        buildCommand?: string;
        outputDirectory?: string;
    };
}

interface FrontendDeployment {
    id: string;
    name: string;
    framework: string;
    buildCommand: string;
    outputDirectory: string;
    deploymentUrl: string | null;
}

interface DeployToolOptions {
    projectRef?: string;
    cwd?: string;
}

interface ToolResponse {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

export const deployToolSchema = {
    ref: optional(Type.String(), "Project ref (defaults to the linked project)"),
    id: optional(Type.String(), "Frontend deployment ID (auto-selected when unambiguous)"),
    cwd: optional(Type.String(), "Project directory (default: current directory)"),
    build_command: optional(Type.String(), "Build command override"),
    output_dir: optional(Type.String(), "Build output directory override"),
    skip_build: optional(Type.Boolean(), "Use an existing output directory without building"),
    dry_run: optional(Type.Boolean(), "Resolve and validate the deployment without building or publishing"),
    json: optional(Type.Boolean(), "Print only the final JSON result"),
};

function record(candidate: unknown): Record<string, unknown> | null {
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function requiredString(candidate: unknown, field: string): string {
    if (typeof candidate !== "string" || !candidate.trim()) {
        throw new Error(`Invalid frontend deployment response: missing ${field}`);
    }
    return candidate.trim();
}

function frontendDeployment(candidate: unknown): FrontendDeployment {
    const value = record(candidate);
    if (!value) throw new Error("Invalid frontend deployment response");
    return {
        id: requiredString(value.id, "id"),
        name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : requiredString(value.id, "id"),
        framework: typeof value.framework === "string" ? value.framework.trim() : "static",
        buildCommand: typeof value.build_command === "string" ? value.build_command.trim() : "",
        outputDirectory: typeof value.output_dir === "string" ? value.output_dir.trim() : "",
        deploymentUrl: typeof value.deployment_url === "string" && value.deployment_url.trim()
            ? value.deployment_url.trim()
            : null,
    };
}

async function readJson(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw new Error(`Invalid JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function readDeployConfig(projectDirectory: string): Promise<DeployConfig> {
    const configPath = join(projectDirectory, "supacloud.json");
    const candidate = await readJson(configPath);
    if (candidate === null) return {};
    const config = record(candidate);
    const frontend = record(config?.frontend);
    if (!config || (config.frontend !== undefined && !frontend)) {
        throw new Error("supacloud.json must contain an object-valued 'frontend' configuration");
    }
    const optionalText = (value: unknown, field: string) => {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || !value.trim()) throw new Error(`supacloud.json ${field} must be a non-empty string`);
        return value.trim();
    };
    return {
        frontend: frontend ? {
            id: optionalText(frontend.id, "frontend.id"),
            buildCommand: optionalText(frontend.buildCommand, "frontend.buildCommand"),
            outputDirectory: optionalText(frontend.outputDirectory, "frontend.outputDirectory"),
        } : undefined,
    };
}

async function packageName(projectDirectory: string): Promise<string | null> {
    const candidate = record(await readJson(join(projectDirectory, "package.json")));
    return typeof candidate?.name === "string" && candidate.name.trim() ? candidate.name.trim() : null;
}

async function pathExists(path: string): Promise<boolean> {
    return access(path).then(() => true, () => false);
}

async function defaultBuildCommand(projectDirectory: string): Promise<string> {
    const packageJson = record(await readJson(join(projectDirectory, "package.json")));
    const scripts = record(packageJson?.scripts);
    if (typeof scripts?.build !== "string" || !scripts.build.trim()) {
        throw new Error("No build command was configured and package.json has no build script");
    }
    if (await pathExists(join(projectDirectory, "bun.lock"))
        || await pathExists(join(projectDirectory, "bun.lockb"))) return "bun run build";
    if (await pathExists(join(projectDirectory, "pnpm-lock.yaml"))) return "pnpm run build";
    if (await pathExists(join(projectDirectory, "yarn.lock"))) return "yarn build";
    return "npm run build";
}

function deploymentList(candidate: unknown): FrontendDeployment[] {
    const values = Array.isArray(candidate)
        ? candidate
        : Array.isArray(record(candidate)?.deployments) ? record(candidate)?.deployments as unknown[] : null;
    if (!values) throw new Error("Invalid frontend deployment list response");
    return values.map(frontendDeployment);
}

function selectDeployment(
    deployments: FrontendDeployment[],
    requestedId: string | undefined,
    projectName: string | null,
): FrontendDeployment {
    if (requestedId) {
        const selected = deployments.find((deployment) => deployment.id === requestedId);
        if (!selected) throw new Error(`Frontend deployment '${requestedId}' was not found`);
        return selected;
    }
    if (deployments.length === 1) return deployments[0];
    if (projectName) {
        const matches = deployments.filter((deployment) => (
            deployment.id === projectName || deployment.name === projectName
        ));
        if (matches.length === 1) return matches[0];
    }
    const ids = deployments.map((deployment) => deployment.id).sort().join(", ");
    throw new Error(deployments.length === 0
        ? "No frontend deployments exist for this project"
        : `Multiple frontend deployments found (${ids}). Set frontend.id in supacloud.json or pass --id`);
}

function defaultOutputDirectory(framework: string): string {
    switch (framework) {
        case "sveltekit-static": return "build";
        case "nextjs": return "out";
        case "static": return "dist";
        default: return "dist";
    }
}

function resolveInsideProject(projectDirectory: string, candidate: string): string {
    const resolved = resolve(projectDirectory, candidate);
    const projectRoot = resolve(projectDirectory);
    const projectPrefix = `${projectRoot}${sep}`;
    if (!resolved.startsWith(projectPrefix)) {
        throw new Error("Frontend output directory must stay inside the project directory");
    }
    return resolved;
}

async function runBuild(command: string, cwd: string): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(command, { cwd, env: process.env, shell: true, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`Build command failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}): ${command}`));
        });
    });
}

async function collectArchiveFiles(root: string): Promise<{ files: Zippable; bytes: number; count: number }> {
    const rootStat = await lstat(root).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Frontend output directory does not exist or is not a regular directory: ${root}`);
    }
    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        const entries = [];
        for await (const entry of await opendir(directory)) entries.push(entry);
        entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
        for (const entry of entries) {
            const path = join(directory, entry.name);
            const stats = await lstat(path);
            if (stats.isSymbolicLink()) throw new Error(`Frontend output cannot contain symbolic links: ${path}`);
            if (stats.isDirectory()) await visit(path);
            else if (stats.isFile()) paths.push(path);
            else throw new Error(`Frontend output contains an unsupported file type: ${path}`);
        }
    };
    await visit(root);
    if (paths.length === 0) throw new Error(`Frontend output directory is empty: ${root}`);

    let bytes = 0;
    const files: Zippable = {};
    for (const path of paths) {
        const data = new Uint8Array(await readFile(path));
        bytes += data.byteLength;
        if (bytes > MAX_SOURCE_BYTES) throw new Error(`Frontend output exceeds ${MAX_SOURCE_BYTES} bytes`);
        const archivePath = relative(root, path).split(sep).join("/");
        files[archivePath] = [data, { mtime: FIXED_ZIP_MTIME }];
    }
    return { files, bytes, count: paths.length };
}

export async function createFrontendArchive(outputDirectory: string): Promise<{
    archivePath: string;
    sha256: string;
    sourceBytes: number;
    fileCount: number;
    cleanup(): Promise<void>;
}> {
    const collected = await collectArchiveFiles(outputDirectory);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supacloud-deploy-"));
    const archivePath = join(temporaryDirectory, `${basename(outputDirectory)}.zip`);
    try {
        const archiveBytes = zipSync(collected.files, { level: 6, mtime: FIXED_ZIP_MTIME });
        await writeFile(archivePath, archiveBytes);
        const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
        return {
            archivePath,
            sha256,
            sourceBytes: collected.bytes,
            fileCount: collected.count,
            cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw error;
    }
}

function payload(response: ToolResponse): Record<string, unknown> {
    if (response.isError) throw new Error(response.content[0]?.text || "Deployment operation failed");
    const text = response.content.find((chunk) => chunk.type === "text")?.text;
    const parsed = text ? record(JSON.parse(text)) : null;
    if (!parsed) throw new Error("Deployment operation returned an invalid response");
    return parsed;
}

function phaseReporter(json: boolean | undefined) {
    const started = performance.now();
    return (phase: string, detail: string) => {
        if (!json) console.error(`  ${phase.padEnd(10)} ${detail}`);
        return Math.round(performance.now() - started);
    };
}

function deployResponse(result: Record<string, unknown>, json: boolean | undefined): ToolResponse {
    if (json) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    const lines = [
        result.unchanged === true ? "Already up to date." : `Deployed ${String(result.deployment_id)}.`,
        result.url ? `URL: ${String(result.url)}` : null,
        `Release: ${String(result.release_id)}`,
        `Files: ${String(result.file_count)}`,
        `Duration: ${(Number(result.duration_ms) / 1000).toFixed(1)}s`,
    ].filter((line): line is string => Boolean(line));
    return { content: [{ type: "text", text: lines.join("\n") }] };
}

export function registerDeployTools(
    server: { tool: (...args: any[]) => void },
    http: HttpTransport,
    options: DeployToolOptions = {},
): void {
    server.tool(
        "deploy",
        "Build and publish the linked frontend with one command",
        deployToolSchema,
        async (args: Record<string, unknown>) => {
            const projectDirectory = resolve(String(args.cwd || options.cwd || process.cwd()));
            const projectRef = String(args.ref || options.projectRef || "").trim();
            if (!projectRef) throw new Error("A linked project ref is required. Set SUPACLOUD_PROJECT_REF or pass --ref");
            const config = await readDeployConfig(projectDirectory);
            const requestedId = String(args.id || config.frontend?.id || "").trim() || undefined;
            const report = phaseReporter(args.json === true);
            report("inspect", `project ${projectRef}`);

            const listResponse = await http.get(`/v1/projects/${encodeURIComponent(projectRef)}/frontend/deployments`);
            if (!listResponse.ok) throw new Error(`Failed to list frontend deployments (HTTP ${listResponse.status})`);
            const selected = selectDeployment(deploymentList(listResponse.data), requestedId, await packageName(projectDirectory));
            const configuredBuildCommand = String(args.build_command || config.frontend?.buildCommand || selected.buildCommand || "").trim();
            const buildCommand = configuredBuildCommand
                || (args.skip_build === true ? "" : await defaultBuildCommand(projectDirectory));
            const configuredOutput = String(args.output_dir || config.frontend?.outputDirectory || "").trim();
            const remoteOutput = selected.outputDirectory && selected.outputDirectory !== "." ? selected.outputDirectory : "";
            const outputDirectory = resolveInsideProject(
                projectDirectory,
                configuredOutput || remoteOutput || defaultOutputDirectory(selected.framework),
            );

            if (args.dry_run === true) {
                return { content: [{ type: "text" as const, text: JSON.stringify({
                    ok: true,
                    dry_run: true,
                    project_ref: projectRef,
                    deployment_id: selected.id,
                    build_command: args.skip_build === true ? null : buildCommand,
                    output_directory: outputDirectory,
                }, null, 2) }] };
            }

            if (args.skip_build !== true) {
                report("build", buildCommand);
                await runBuild(buildCommand, projectDirectory);
            } else {
                report("build", "skipped");
            }

            report("package", relative(projectDirectory, outputDirectory) || ".");
            const archive = await createFrontendArchive(outputDirectory);
            try {
                const inventory = payload(await listFrontendReleases(http, projectRef, selected.id, undefined, 100));
                const activeReleaseId = typeof inventory.active_release_id === "string" ? inventory.active_release_id : null;
                const activeActivationId = typeof inventory.active_activation_id === "string" ? inventory.active_activation_id : null;

                if (archive.sha256 === activeReleaseId) {
                    const durationMs = report("done", "already current");
                    return deployResponse({
                        ok: true,
                        unchanged: true,
                        project_ref: projectRef,
                        deployment_id: selected.id,
                        release_id: archive.sha256,
                        url: selected.deploymentUrl,
                        file_count: archive.fileCount,
                        source_bytes: archive.sourceBytes,
                        duration_ms: durationMs,
                    }, args.json === true);
                }

                report("upload", `${archive.fileCount} files`);
                const uploaded = payload(await uploadFrontendRelease(http, projectRef, selected.id, archive.archivePath));
                const release = record(uploaded.release);
                const releaseId = requiredString(release?.release_id, "release.release_id");
                if (releaseId !== archive.sha256) throw new Error("Uploaded release identity does not match the local archive");

                report("activate", releaseId.slice(0, 12));
                const mutationId = crypto.randomUUID();
                const activated = payload(await activateFrontendRelease(http, {
                    projectRef,
                    deploymentId: selected.id,
                    releaseId,
                    expectedActiveReleaseId: activeReleaseId || "absent",
                    expectedActivationId: activeActivationId || "absent",
                    mutationId,
                }));
                const finalResponse = await http.get(
                    `/v1/projects/${encodeURIComponent(projectRef)}/frontend/deployments/${encodeURIComponent(selected.id)}`,
                );
                const finalDeployment = finalResponse.ok ? frontendDeployment(finalResponse.data) : selected;
                const durationMs = report("done", finalDeployment.deploymentUrl || selected.id);
                return deployResponse({
                    ok: true,
                    unchanged: false,
                    project_ref: projectRef,
                    deployment_id: selected.id,
                    release_id: activated.active_release_id,
                    activation_id: activated.activation_id,
                    url: finalDeployment.deploymentUrl,
                    file_count: archive.fileCount,
                    source_bytes: archive.sourceBytes,
                    duration_ms: durationMs,
                }, args.json === true);
            } finally {
                await archive.cleanup();
            }
        },
    );
}
