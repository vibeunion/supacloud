import { access, lstat, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
import { projectedFunctionList } from "./edge-function-response";

const FIXED_ZIP_MTIME = new Date("1980-01-01T00:00:00.000Z");
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

interface DeployConfig {
    defaultTarget?: string;
    targets?: Record<string, DeployTargetConfig>;
    frontend?: {
        id?: string;
        root?: string;
        buildCommand?: string;
        outputDirectory?: string;
    };
}

interface DeployTargetConfig {
    type: "frontend" | "edge_function";
    root?: string;
    id?: string;
    slug?: string;
    buildCommand?: string;
    outputDirectory?: string;
    bundleDirectory?: string;
    entrypoint?: string;
    verifyJwt?: boolean;
    minify?: boolean;
    framework?: "fetch" | "elysia" | "hono" | "sveltekit-function";
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
    edgeFunctionDeploy?: (args: Record<string, unknown>) => Promise<ToolResponse>;
}

interface ToolResponse {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

export const deployToolSchema = {
    ref: optional(Type.String(), "Project ref (defaults to the linked project)"),
    target: optional(Type.String(), "Named deploy target from supacloud.json"),
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

export async function findDeployConfigRoot(startDirectory: string): Promise<string> {
    let directory = resolve(startDirectory);
    while (true) {
        if (await pathExists(join(directory, "supacloud.json"))) return directory;
        const parent = dirname(directory);
        if (parent === directory) return resolve(startDirectory);
        directory = parent;
    }
}

function optionalText(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`supacloud.json ${field} must be a non-empty string`);
    }
    return value.trim();
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`supacloud.json ${field} must be a boolean`);
    return value;
}

function deployTargetConfig(candidate: unknown, name: string): DeployTargetConfig {
    const value = record(candidate);
    if (!value || (value.type !== "frontend" && value.type !== "edge_function")) {
        throw new Error(`supacloud.json targets.${name}.type must be 'frontend' or 'edge_function'`);
    }
    const framework = optionalText(value.framework, `targets.${name}.framework`);
    if (framework && !["fetch", "elysia", "hono", "sveltekit-function"].includes(framework)) {
        throw new Error(`supacloud.json targets.${name}.framework is invalid`);
    }
    return {
        type: value.type,
        root: optionalText(value.root, `targets.${name}.root`),
        id: optionalText(value.id, `targets.${name}.id`),
        slug: optionalText(value.slug, `targets.${name}.slug`),
        buildCommand: optionalText(value.buildCommand, `targets.${name}.buildCommand`),
        outputDirectory: optionalText(value.outputDirectory, `targets.${name}.outputDirectory`),
        bundleDirectory: optionalText(value.bundleDirectory, `targets.${name}.bundleDirectory`),
        entrypoint: optionalText(value.entrypoint, `targets.${name}.entrypoint`),
        verifyJwt: optionalBoolean(value.verifyJwt, `targets.${name}.verifyJwt`),
        minify: optionalBoolean(value.minify, `targets.${name}.minify`),
        framework: framework as DeployTargetConfig["framework"],
    };
}

async function readDeployConfig(configRoot: string): Promise<DeployConfig> {
    const configPath = join(configRoot, "supacloud.json");
    const candidate = await readJson(configPath);
    if (candidate === null) return {};
    const config = record(candidate);
    const frontend = record(config?.frontend);
    const targetValues = record(config?.targets);
    if (!config || (config.frontend !== undefined && !frontend)
        || (config.targets !== undefined && !targetValues)) {
        throw new Error("supacloud.json must contain object-valued 'frontend' or 'targets' configuration");
    }
    return {
        defaultTarget: optionalText(config.defaultTarget, "defaultTarget"),
        targets: targetValues
            ? Object.fromEntries(Object.entries(targetValues).map(([name, value]) => (
                [name, deployTargetConfig(value, name)]
            )))
            : undefined,
        frontend: frontend ? {
            id: optionalText(frontend.id, "frontend.id"),
            root: optionalText(frontend.root, "frontend.root"),
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

async function defaultBuildCommand(projectDirectory: string, configRoot: string): Promise<string> {
    const packageJson = record(await readJson(join(projectDirectory, "package.json")));
    const scripts = record(packageJson?.scripts);
    if (typeof scripts?.build !== "string" || !scripts.build.trim()) {
        throw new Error("No build command was configured and package.json has no build script");
    }
    let directory = projectDirectory;
    while (true) {
        if (await pathExists(join(directory, "bun.lock"))
            || await pathExists(join(directory, "bun.lockb"))) return "bun run build";
        if (await pathExists(join(directory, "pnpm-lock.yaml"))) return "pnpm run build";
        if (await pathExists(join(directory, "yarn.lock"))) return "yarn build";
        if (directory === configRoot) break;
        const parent = dirname(directory);
        if (parent === directory || !directory.startsWith(`${configRoot}${sep}`)) break;
        directory = parent;
    }
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

interface SelectedTarget {
    name: string;
    config: DeployTargetConfig;
    root: string;
}

function targetRoot(configRoot: string, target: DeployTargetConfig, name: string): string {
    const root = resolve(configRoot, target.root || (name === "frontend" ? "." : name));
    const prefix = `${resolve(configRoot)}${sep}`;
    if (root !== resolve(configRoot) && !root.startsWith(prefix)) {
        throw new Error(`Deploy target '${name}' root must stay inside the repository root`);
    }
    return root;
}

function selectTarget(
    configRoot: string,
    invocationDirectory: string,
    config: DeployConfig,
    requestedName?: string,
): SelectedTarget {
    const targets = config.targets
        ? Object.entries(config.targets)
        : [["frontend", {
            type: "frontend" as const,
            root: config.frontend?.root,
            id: config.frontend?.id,
            buildCommand: config.frontend?.buildCommand,
            outputDirectory: config.frontend?.outputDirectory,
        }]] as Array<[string, DeployTargetConfig]>;
    if (targets.length === 0) throw new Error("supacloud.json defines no deploy targets");

    if (requestedName) {
        const selected = targets.find(([name]) => name === requestedName);
        if (!selected) throw new Error(`Deploy target '${requestedName}' was not found in supacloud.json`);
        return { name: selected[0], config: selected[1], root: targetRoot(configRoot, selected[1], selected[0]) };
    }
    const containing = targets
        .map(([name, target]) => ({ name, target, root: targetRoot(configRoot, target, name) }))
        .filter((candidate) => invocationDirectory === candidate.root
            || invocationDirectory.startsWith(`${candidate.root}${sep}`))
        .sort((left, right) => right.root.length - left.root.length);
    if (containing.length === 1 || (containing.length > 1 && containing[0].root !== containing[1].root)) {
        const selected = containing[0];
        return { name: selected.name, config: selected.target, root: selected.root };
    }
    if (config.defaultTarget) {
        const selected = targets.find(([name]) => name === config.defaultTarget);
        if (!selected) throw new Error(`supacloud.json defaultTarget '${config.defaultTarget}' was not found`);
        return { name: selected[0], config: selected[1], root: targetRoot(configRoot, selected[1], selected[0]) };
    }
    if (targets.length === 1) {
        const selected = targets[0];
        return { name: selected[0], config: selected[1], root: targetRoot(configRoot, selected[1], selected[0]) };
    }
    throw new Error(`Multiple deploy targets found (${targets.map(([name]) => name).sort().join(", ")}). Pass --target`);
}

function defaultOutputDirectory(framework: string): string {
    switch (framework) {
        case "sveltekit-static": return "build";
        case "nextjs": return "out";
        case "static": return "dist";
        default: return "dist";
    }
}

function resolveInsideProject(projectDirectory: string, candidate: string, allowRoot = false): string {
    const resolved = resolve(projectDirectory, candidate);
    const projectRoot = resolve(projectDirectory);
    const projectPrefix = `${projectRoot}${sep}`;
    if ((!allowRoot && resolved === projectRoot)
        || (resolved !== projectRoot && !resolved.startsWith(projectPrefix))) {
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

    let bytes: number = 0;
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
        result.unchanged === true ? "Already up to date." : `Deployed ${String(result.target || result.deployment_id || result.slug)}.`,
        result.url ? `URL: ${String(result.url)}` : null,
        result.release_id ? `Release: ${String(result.release_id)}` : null,
        result.active_version ? `Active version: ${String(result.active_version)}` : null,
        result.file_count ? `Files: ${String(result.file_count)}` : null,
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
            const invocationDirectory = resolve(String(args.cwd || options.cwd || process.cwd()));
            const projectRef = String(args.ref || options.projectRef || "").trim();
            if (!projectRef) throw new Error("A linked project ref is required. Set SUPACLOUD_PROJECT_REF or pass --ref");
            const configRoot = await findDeployConfigRoot(invocationDirectory);
            const config = await readDeployConfig(configRoot);
            const target = selectTarget(configRoot, invocationDirectory, config, String(args.target || "").trim() || undefined);
            const projectDirectory = target.root;
            const targetState = await lstat(projectDirectory).catch(() => null);
            if (!targetState?.isDirectory() || targetState.isSymbolicLink()) {
                throw new Error(`Deploy target '${target.name}' root is not a regular directory: ${projectDirectory}`);
            }
            const requestedId = String(args.id || target.config.id || "").trim() || undefined;
            const report = phaseReporter(args.json === true);
            report("inspect", `${target.name} (${projectRef})`);

            if (target.config.type === "edge_function") {
                if (!options.edgeFunctionDeploy) throw new Error("Edge Function deploy support is unavailable in this CLI context");
                const slug = target.config.slug || requestedId || target.name;
                const functionListResponse = await options.edgeFunctionDeploy({
                    action: "list",
                    ref: projectRef,
                });
                if (functionListResponse.isError) {
                    throw new Error(`Unable to read the current identity for Edge Function '${slug}'`);
                }
                const functionListText = functionListResponse.content.find((chunk) => chunk.type === "text")?.text;
                if (!functionListText) throw new Error(`Unable to read the current identity for Edge Function '${slug}'`);
                const functions = projectedFunctionList(JSON.parse(functionListText));
                if (!functions) throw new Error(`Invalid current identity for Edge Function '${slug}'`);
                const current = functions?.find((candidate) => candidate.slug === slug);
                const activeVersion = current && typeof current.version === "number" ? String(current.version) : "absent";
                const activationId = current && typeof current.activation_id === "string" ? current.activation_id : "legacy";
                if (!activeVersion || !activationId) throw new Error(`Edge Function '${slug}' has an invalid active identity`);
                const buildCommand = String(args.build_command || target.config.buildCommand || "").trim()
                    || (args.skip_build === true ? "" : await defaultBuildCommand(projectDirectory, configRoot));
                const bundleDirectory = resolveInsideProject(
                    projectDirectory,
                    String(args.output_dir || target.config.bundleDirectory || target.config.outputDirectory || "dist"),
                    true,
                );
                if (args.dry_run === true) {
                    return { content: [{ type: "text" as const, text: JSON.stringify({
                        ok: true,
                        dry_run: true,
                        type: target.config.type,
                        target: target.name,
                        project_ref: projectRef,
                        slug,
                        build_command: args.skip_build === true ? null : buildCommand,
                        bundle_directory: bundleDirectory,
                        expected_active_version: activeVersion,
                        expected_activation_id: activationId,
                    }, null, 2) }] };
                }
                if (args.skip_build !== true) {
                    report("build", buildCommand);
                    await runBuild(buildCommand, projectDirectory);
                } else {
                    report("build", "skipped");
                }
                report("deploy", `edge function ${slug}`);
                const deployed = await options.edgeFunctionDeploy({
                    action: "deploy_bundle",
                    ref: projectRef,
                    slug,
                    "bundle-dir": bundleDirectory,
                    entrypoint: target.config.entrypoint || "index.ts",
                    minify: target.config.minify,
                    verify_jwt: target.config.verifyJwt,
                    framework: target.config.framework,
                    "expected-active-version": activeVersion,
                    "expected-activation-id": activationId,
                });
                if (deployed.isError) return deployed;
                const deployedText = deployed.content.find((chunk) => chunk.type === "text")?.text;
                const deployedPayload = deployedText ? record(JSON.parse(deployedText)) : null;
                const durationMs = report("done", slug);
                return deployResponse({
                    ok: true,
                    unchanged: false,
                    type: target.config.type,
                    target: target.name,
                    project_ref: projectRef,
                    slug,
                    active_version: deployedPayload?.active_version,
                    activation_id: deployedPayload?.activation_id,
                    duration_ms: durationMs,
                }, args.json === true);
            }

            const listResponse = await http.get(`/v1/projects/${encodeURIComponent(projectRef)}/frontend/deployments`);
            if (!listResponse.ok) throw new Error(`Failed to list frontend deployments (HTTP ${listResponse.status})`);
            const selected = selectDeployment(deploymentList(listResponse.data), requestedId, await packageName(projectDirectory));
            const configuredBuildCommand = String(args.build_command || target.config.buildCommand || selected.buildCommand || "").trim();
            const buildCommand = configuredBuildCommand
                || (args.skip_build === true ? "" : await defaultBuildCommand(projectDirectory, configRoot));
            const configuredOutput = String(args.output_dir || target.config.outputDirectory || "").trim();
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
