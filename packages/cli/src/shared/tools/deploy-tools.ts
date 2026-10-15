import { access, lstat, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createFrontendTarZstd } from "@supacloud/delivery/frontend-archive";
import { ApplicationIdSchema, type ApplicationDeployRequest } from "@supacloud/delivery";
import { optional } from "../schema";
import type { HttpTransport } from "../transports/http";
import { registerTool, type ToolServer } from "../tool-server";
import { publishFrontendRelease, uploadProjectWebRelease } from "./frontend-release-control";
import { DEPLOYMENT_UPGRADE } from "../deployment-upgrade";
import { requireProjectDeploymentProtocol } from "./project-deployment";

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

interface DeployConfig {
    defaultTarget?: string;
    application?: {
        id: string;
        environmentId?: string;
        configurationPath?: string;
        configurationId?: string;
        manifestPath?: string;
    };
    targets?: Record<string, DeployTargetConfig>;
    frontend?: {
        id?: string;
        name?: string;
        root?: string;
        buildCommand?: string;
        outputDirectory?: string;
        buildEnv?: string[];
    };
}

interface DeployTargetConfig {
    type: "frontend" | "edge_function";
    root?: string;
    id?: string;
    name?: string;
    slug?: string;
    buildCommand?: string;
    outputDirectory?: string;
    buildEnv?: string[];
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
    environment?: string | null;
    cwd?: string;
    environmentVariables?: Readonly<Record<string, string>>;
    application?: {
        id: string;
        environmentId: string;
        configurationPath?: string;
        configurationId?: string;
        manifestPath?: string;
    };
    applicationRelease?: (args: Record<string, unknown>) => Promise<ToolResponse>;
}

interface ToolResponse {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

const PUBLIC_BUILD_ENV_PREFIXES = ["PUBLIC_", "VITE_", "NEXT_PUBLIC_", "NUXT_PUBLIC_", "ASTRO_PUBLIC_"];
const SENSITIVE_BUILD_ENV = /(?:^|_)(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION)(?:_|$)|(?:DATABASE_URL|DATABASE_URI|CONNECTION_STRING|DSN|PRIVATE_KEY)/i;

function isPublicBuildEnv(name: string): boolean {
    return PUBLIC_BUILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isProtectedBuildEnv(name: string): boolean {
    return name.startsWith("SUPACLOUD_")
        || name === "SUPABASE_SERVICE_ROLE_KEY"
        || name === "SUPABASE_ACCESS_TOKEN"
        || name === "MANAGEMENT_API_URL"
        || name === "MANAGEMENT_API_TOKEN";
}

export const deployToolSchema = {
    ref: optional(Type.String(), "Project ref (defaults to the linked project)"),
    cwd: optional(Type.String(), "Project directory (default: current directory)"),
    skip_build: optional(Type.Boolean(), "Use an existing output directory without building"),
    assets_only: optional(Type.Boolean(), "Publish only configured static assets; leave backend Functions, schedules and migrations unchanged"),
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
        return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw new Error(`Invalid JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function findDeployConfigRoot(startDirectory: string, environmentName?: string): Promise<string> {
    let directory = resolve(startDirectory);
    while (true) {
        const environmentFile = environmentName ? `.env.supacloud.${environmentName}` : null;
        if (await pathExists(join(directory, "supacloud.json"))
            || await pathExists(join(directory, "supacloud.config.ts"))
            || (environmentFile !== null && await pathExists(join(directory, environmentFile)))) {
            return directory;
        }
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

function optionalStringArray(value: unknown, field: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`supacloud.json ${field} must be an array of non-empty strings`);
    }
    return value.map((item) => item.trim()).map((name) => {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
            throw new Error(`supacloud.json ${field} must contain uppercase environment variable names`);
        }
        const isPublic = isPublicBuildEnv(name);
        if (SENSITIVE_BUILD_ENV.test(name) && !isPublic) {
            throw new Error(`supacloud.json ${field} cannot include sensitive variable '${name}'; use runtime secrets instead`);
        }
        if (isProtectedBuildEnv(name)) {
            throw new Error(`supacloud.json ${field} cannot include platform credential '${name}'`);
        }
        return name;
    });
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
        name: optionalText(value.name, `targets.${name}.name`),
        slug: optionalText(value.slug, `targets.${name}.slug`),
        buildCommand: optionalText(value.buildCommand, `targets.${name}.buildCommand`),
        outputDirectory: optionalText(value.outputDirectory, `targets.${name}.outputDirectory`),
        buildEnv: optionalStringArray(value.buildEnv, `targets.${name}.buildEnv`),
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
    const application = record(config?.application);
    const targetValues = record(config?.targets);
    if (!config || (config.frontend !== undefined && !frontend)
        || (config.application !== undefined && !application)
        || (config.targets !== undefined && !targetValues)) {
        throw new Error("supacloud.json must contain object-valued 'application', 'frontend' or 'targets' configuration");
    }
    let parsedApplication: DeployConfig["application"];
    if (application) {
        const id = optionalText(application.id, "application.id");
        const environmentId = optionalText(application.environmentId, "application.environmentId");
        if (!id || !Value.Check(ApplicationIdSchema, id)
            || (environmentId !== undefined && !Value.Check(ApplicationIdSchema, environmentId))) {
            throw new Error("supacloud.json requires a valid application.id and optional application.environmentId");
        }
        const configurationPath = optionalText(application.configurationPath, "application.configurationPath");
        const configurationId = optionalText(application.configurationId, "application.configurationId");
        if (configurationPath && configurationId) {
            throw new Error("supacloud.json application must set only one of application.configurationPath or application.configurationId");
        }
        const manifestPath = optionalText(application.manifestPath, "application.manifestPath");
        parsedApplication = {
            id,
            ...(environmentId ? { environmentId } : {}),
            ...(configurationPath ? { configurationPath } : {}),
            ...(configurationId ? { configurationId } : {}),
            ...(manifestPath ? { manifestPath } : {}),
        };
    }
    return {
        defaultTarget: optionalText(config.defaultTarget, "defaultTarget"),
        ...(parsedApplication === undefined ? {} : { application: parsedApplication }),
        targets: targetValues
            ? Object.fromEntries(Object.entries(targetValues).map(([name, value]) => (
                [name, deployTargetConfig(value, name)]
            )))
            : undefined,
        frontend: frontend ? {
            id: optionalText(frontend.id, "frontend.id"),
            name: optionalText(frontend.name, "frontend.name"),
            root: optionalText(frontend.root, "frontend.root"),
            buildCommand: optionalText(frontend.buildCommand, "frontend.buildCommand"),
            outputDirectory: optionalText(frontend.outputDirectory, "frontend.outputDirectory"),
            buildEnv: optionalStringArray(frontend.buildEnv, "frontend.buildEnv"),
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

async function hasProjectReleaseManifest(root: string): Promise<boolean> {
    if (await pathExists(join(root, "deploy-manifest.json"))) return true;
    const directory = await opendir(join(root, "supacloud")).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    });
    if (!directory) return false;
    let entries = 0;
    for await (const entry of directory) {
        if (++entries > 128) throw new Error("Too many SupaCloud project roots to resolve a deployment");
        if ((entry.isDirectory() || entry.isSymbolicLink())
            && await pathExists(join(root, "supacloud", entry.name, "deploy-manifest.json"))) return true;
    }
    return false;
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
    requestedName?: string,
): FrontendDeployment {
    if (requestedId) {
        const selected = deployments.find((deployment) => deployment.id === requestedId);
        if (!selected) throw new Error(`Frontend deployment '${requestedId}' was not found`);
        if (requestedName && selected.name !== requestedName) {
            throw new Error(`Frontend deployment '${requestedId}' does not match name '${requestedName}'`);
        }
        return selected;
    }
    if (requestedName) {
        const matches = deployments.filter(deployment => deployment.name === requestedName);
        if (matches.length !== 1) throw new Error(`Expected exactly one frontend deployment named '${requestedName}'`);
        return matches[0]!;
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

function selectFrontendTarget(configRoot: string, config: DeployConfig): SelectedTarget | null {
    if (config.targets === undefined && config.frontend === undefined) return null;
    const targets: Array<[string, DeployTargetConfig]> = config.targets
        ? Object.entries(config.targets).filter(([, target]) => target.type === "frontend")
        : [["frontend", {
            type: "frontend" as const,
            root: config.frontend?.root,
            id: config.frontend?.id,
            name: config.frontend?.name,
            buildCommand: config.frontend?.buildCommand,
            outputDirectory: config.frontend?.outputDirectory,
            buildEnv: config.frontend?.buildEnv,
        }]];
    if (targets.length === 0) return null;
    if (config.defaultTarget) {
        const selected = targets.find(([name]) => name === config.defaultTarget);
        if (selected) return { name: selected[0], config: selected[1], root: targetRoot(configRoot, selected[1], selected[0]) };
    }
    const namedWeb = targets.find(([name]) => name === "web");
    if (namedWeb) return { name: namedWeb[0], config: namedWeb[1], root: targetRoot(configRoot, namedWeb[1], namedWeb[0]) };
    if (targets.length === 1) {
        const selected = targets[0]!;
        return { name: selected[0], config: selected[1], root: targetRoot(configRoot, selected[1], selected[0]) };
    }
    throw new Error(`Multiple frontend deploy targets found (${targets.map(([name]) => name).sort().join(", ")}). Set defaultTarget to the Web target`);
}

function targetRoot(configRoot: string, target: DeployTargetConfig, name: string): string {
    const root = resolve(configRoot, target.root || (name === "frontend" ? "." : name));
    const prefix = `${resolve(configRoot)}${sep}`;
    if (root !== resolve(configRoot) && !root.startsWith(prefix)) {
        throw new Error(`Deploy target '${name}' root must stay inside the repository root`);
    }
    return root;
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

export function createBuildEnvironment(
    names: string[] | undefined,
    environmentVariables: Readonly<Record<string, string>> | undefined,
): { env: NodeJS.ProcessEnv; names: string[]; missing: string[] } {
    const values = environmentVariables ?? process.env;
    const selectedNames = [...new Set(names ?? Object.keys(values).filter(isPublicBuildEnv))].sort();
    const selectedNameSet = new Set(selectedNames);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
        !isProtectedBuildEnv(name)
        && (!isPublicBuildEnv(name) || selectedNameSet.has(name))
        && (!SENSITIVE_BUILD_ENV.test(name) || isPublicBuildEnv(name))
    ))) as NodeJS.ProcessEnv;
    const missing = selectedNames.filter((name) => !values[name]?.trim());
    for (const name of selectedNames) {
        const value = values[name];
        if (value !== undefined) env[name] = value;
    }
    return { env, names: selectedNames, missing };
}

function assertBuildEnvironment(
    build: ReturnType<typeof createBuildEnvironment>,
    skipBuild: boolean,
): void {
    if (!skipBuild && build.missing.length > 0) {
        throw new Error(`Missing build environment variables: ${build.missing.join(", ")}`);
    }
}

async function runBuild(
    command: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    json: boolean,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("sh", ["-c", command], {
            cwd,
            env: environment,
            stdio: ["inherit", json ? 2 : "inherit", "inherit"],
        });
        child.once("error", reject);
        child.once("close", (exitCode) => {
            if (exitCode === 0) {
                resolve();
            } else {
                reject(new Error(`Build command failed (exit ${exitCode ?? "unknown"}): ${command}`));
            }
        });
    });
}

async function collectArchiveFiles(root: string): Promise<{ files: Map<string, Uint8Array>; bytes: number; count: number; treeSha256: string }> {
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
    const files = new Map<string, Uint8Array>();
    const digests: Array<{ path: string; size: number; sha256: string }> = [];
    for (const path of paths) {
        const data = new Uint8Array(await readFile(path));
        bytes += data.byteLength;
        if (bytes > MAX_SOURCE_BYTES) throw new Error(`Frontend output exceeds ${MAX_SOURCE_BYTES} bytes`);
        const archivePath = relative(root, path).split(sep).join("/");
        files.set(archivePath, data);
        digests.push({ path: archivePath, size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
    }
    const tree = createHash("sha256");
    for (const file of digests.sort((left, right) => left.path.localeCompare(right.path))) {
        const pathBytes = Buffer.from(file.path, "utf8");
        const frame = Buffer.alloc(12);
        frame.writeUInt32BE(pathBytes.byteLength, 0);
        frame.writeBigUInt64BE(BigInt(file.size), 4);
        tree.update(frame).update(pathBytes).update(Buffer.from(file.sha256, "hex"));
    }
    return { files, bytes, count: paths.length, treeSha256: tree.digest("hex") };
}

export async function createFrontendArchive(outputDirectory: string): Promise<{
    archivePath: string;
    sha256: string;
    treeSha256: string;
    archiveBytes: number;
    sourceBytes: number;
    fileCount: number;
    cleanup(): Promise<void>;
}> {
    const collected = await collectArchiveFiles(outputDirectory);
    return createCollectedFrontendArchive(outputDirectory, collected);
}

async function createCollectedFrontendArchive(
    outputDirectory: string,
    collected: Awaited<ReturnType<typeof collectArchiveFiles>>,
) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supacloud-deploy-"));
    const archivePath = join(temporaryDirectory, `${basename(outputDirectory)}.tar.zst`);
    try {
        const archiveBytes = await createFrontendTarZstd(collected.files);
        await writeFile(archivePath, archiveBytes);
        const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
        return {
            archivePath,
            sha256,
            treeSha256: collected.treeSha256,
            archiveBytes: archiveBytes.byteLength,
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

interface StagedApplicationWeb {
    request?: ApplicationDeployRequest["web_release"];
    result?: ToolResponse;
}

async function stageApplicationWebRelease(
    http: HttpTransport,
    projectRef: string,
    environmentId: string,
    configRoot: string,
    skipBuild: boolean,
    json: boolean,
    environmentVariables?: Readonly<Record<string, string>>,
    assetsOnly = false,
): Promise<StagedApplicationWeb | null> {
    const target = selectFrontendTarget(configRoot, await readDeployConfig(configRoot));
    if (!target) return null;
    const projectDirectory = target.root;
    const targetState = await lstat(projectDirectory).catch(() => null);
    if (!targetState?.isDirectory() || targetState.isSymbolicLink()) {
        throw new Error(`Deploy target '${target.name}' root is not a regular directory: ${projectDirectory}`);
    }
    const requestedId = target.config.id;
    const listResponse = await http.get(`/v1/projects/${encodeURIComponent(projectRef)}/frontend/deployments`);
    if (!listResponse.ok) throw new Error(`Failed to list frontend deployments (HTTP ${listResponse.status})`);
    const selected = selectDeployment(
        deploymentList(listResponse.data), requestedId, await packageName(projectDirectory), target.config.name,
    );
    const configuredBuildCommand = String(target.config.buildCommand || selected.buildCommand || "").trim();
    const buildCommand = configuredBuildCommand || (skipBuild ? "" : await defaultBuildCommand(projectDirectory, configRoot));
    const configuredOutput = String(target.config.outputDirectory || "").trim();
    const remoteOutput = selected.outputDirectory && selected.outputDirectory !== "." ? selected.outputDirectory : "";
    const outputDirectory = resolveInsideProject(
        projectDirectory,
        configuredOutput || remoteOutput || defaultOutputDirectory(selected.framework),
    );
    const build = createBuildEnvironment(target.config.buildEnv, environmentVariables);
    assertBuildEnvironment(build, skipBuild);
    if (!skipBuild) {
        await runBuild(buildCommand, projectDirectory, build.env, json);
    }

    const collected = await collectArchiveFiles(outputDirectory);
    if (assetsOnly) {
        return { result: await publishFrontendRelease(
            http, projectRef, selected.id,
            () => createCollectedFrontendArchive(outputDirectory, collected), collected.treeSha256,
        ) };
    }
    const archive = await createCollectedFrontendArchive(outputDirectory, collected);
    try {
        const uploaded = payload(await uploadProjectWebRelease(
            http, projectRef, environmentId, selected.id, archive.archivePath,
        ));
        const release = record(uploaded.release);
        const releaseId = requiredString(release?.release_id, "release.release_id");
        if (releaseId !== archive.sha256) throw new Error("Uploaded Web release identity does not match the local archive");
        if (release?.tree_sha256 !== archive.treeSha256) throw new Error("Uploaded Web release tree does not match the local build");
        return {
            request: {
                deployment_id: selected.id,
                release_id: releaseId,
            },
        };
    } finally {
        await archive.cleanup();
    }
}

export function registerDeployTools(
    server: ToolServer,
    http: HttpTransport,
    options: DeployToolOptions = {},
): void {
    registerTool(server,
        "deploy",
        "Build and publish the linked project with one command",
        deployToolSchema,
        async (args) => {
            const invocationDirectory = resolve(String(args.cwd || options.cwd || process.cwd()));
            const projectRef = String(args.ref || options.projectRef || "").trim();
            if (!projectRef) throw new Error("A linked project ref is required. Set SUPACLOUD_PROJECT_REF or pass --ref");
            const configRoot = await findDeployConfigRoot(invocationDirectory, options.environment ?? undefined);

            const config = await readDeployConfig(configRoot);
            const application = options.application?.id
                ? options.application
                : config.application ? {
                    ...config.application, environmentId: options.environment || config.application.environmentId,
                } : undefined;
            const legacyManifest = await hasProjectReleaseManifest(configRoot);
            const assetsOnly = args.assets_only === true
                || (!application?.id && selectFrontendTarget(configRoot, config) !== null
                    && !legacyManifest
                    && !Object.values(config.targets ?? {}).some(target => target.type === "edge_function"));
            if (assetsOnly) {
                if (!selectFrontendTarget(configRoot, config)) {
                    throw new Error("Static asset deployment requires a frontend configuration in supacloud.json");
                }
                const environmentId = options.environment?.trim() || application?.environmentId?.trim();
                if (!environmentId || !Value.Check(ApplicationIdSchema, environmentId)) {
                    throw new Error("Static asset deployment requires SUPACLOUD_ENV");
                }
                await requireProjectDeploymentProtocol(http, projectRef, environmentId);
                const staged = await stageApplicationWebRelease(
                    http, projectRef, environmentId, configRoot,
                    args.skip_build === true, args.json === true, options.environmentVariables, true,
                );
                if (!staged?.result) throw new Error("Static asset deployment did not produce a receipt");
                return staged.result;
            }
            if (legacyManifest) {
                throw new Error(`${DEPLOYMENT_UPGRADE} Replace deploy-manifest.json with the current application delivery configuration; no remote mutation was performed.`);
            }
            if (application?.id) {
                if (Object.values(config.targets ?? {}).some(target => target.type === "edge_function")) {
                    throw new Error("PROJECT_DEPLOYMENT_UNSUPPORTED: Application deployment cannot yet include declared Edge Function targets. No partial deployment was performed.");
                }
                if (!options.applicationRelease) {
                    throw new Error("Application release support is unavailable in this CLI context");
                }
                const environmentId = application.environmentId?.trim();
                if (!environmentId || !Value.Check(ApplicationIdSchema, environmentId)
                    || !Value.Check(ApplicationIdSchema, application.id)) {
                    throw new Error("Application profile requires SUPACLOUD_APPLICATION_ENVIRONMENT_ID or SUPACLOUD_ENV");
                }
                const configurationPath = application.configurationPath?.trim();
                const configurationId = application.configurationId?.trim();
                if (configurationPath && configurationId) {
                    throw new Error("Application profile must set only one of SUPACLOUD_APPLICATION_CONFIGURATION_PATH or SUPACLOUD_APPLICATION_CONFIGURATION_ID");
                }
                await requireProjectDeploymentProtocol(http, projectRef, environmentId);
                const stagedWeb = await stageApplicationWebRelease(
                    http,
                    projectRef,
                    environmentId,
                    configRoot,
                    args.skip_build === true,
                    args.json === true,
                    options.environmentVariables,
                );
                const result = await options.applicationRelease({
                    action: "release",
                    ref: projectRef,
                    id: application.id,
                    environment_id: environmentId,
                    root: configRoot,
                    ...(configurationPath ? { configuration_path: configurationPath } : {}),
                    ...(configurationId ? { configuration_id: configurationId } : {}),
                    ...(application.manifestPath ? { manifest_path: application.manifestPath } : {}),
                    ...(args.skip_build === true ? { skip_build: true } : {}),
                    ...(stagedWeb?.request === undefined ? {} : { web_release: stagedWeb.request }),
                    ...(args.json === true ? { format: "json", json: true } : {}),
                });
                return result;
            }

            throw new Error(DEPLOYMENT_UPGRADE);
        },
    );
}
