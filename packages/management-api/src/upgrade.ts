import { $ } from "bun";
import * as p from "@clack/prompts";
import os from "node:os";
import path from "node:path";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "./utils/logger";

const RELEASES_API = "https://api.github.com/repos/zuohuadong/supacloud/releases";
const RELEASE_REPOSITORY = "zuohuadong/supacloud";
const RELEASE_SIGNER_WORKFLOW = `${RELEASE_REPOSITORY}/.github/workflows/release-please.yml`;
const BIN_TARGET = "/usr/local/bin/supacloud";
const DEFAULT_MANAGEMENT_ENV_FILE = "/etc/supabase/management-api.env";
const LEGACY_CONFIG_FILE = "/opt/supacloud/config.env";
const DEFAULT_GITHUB_PROXY = "https://ghproxy.net/";
const WEB_CONSOLE_ASSET = "web-console-build.tar.gz";
const WEB_CONSOLE_ROOT = "/opt/supacloud/web-console";
const WEB_CONSOLE_RELEASES_DIR = `${WEB_CONSOLE_ROOT}/releases`;
const WEB_CONSOLE_CURRENT_LINK = `${WEB_CONSOLE_ROOT}/current`;
const DEFAULT_EDGE_RUNTIME_CAPACITY_DROPIN = "/etc/systemd/system/supacloud-edge-runtime.service.d/50-edge-runtime-capacity.conf";
const DEFAULT_EDGE_WORKER_POOL_SIZE = 20;
const DEFAULT_EDGE_BACKGROUND_WORKER_POOL_SIZE = 20;
const DEFAULT_EDGE_RESOURCE_RATIO = 0.6;
const DEFAULT_EDGE_TASKS_MAX = 256;

type GithubEndpoint = {
    label: string;
    proxyPrefix: string;
};

export type GithubReleaseAsset = {
    name?: string;
    browser_download_url?: string;
};

export type GithubRelease = {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: GithubReleaseAsset[];
};

export type FileState = {
    path: string;
    existed: boolean;
    content?: Buffer;
    mode?: number;
};

export type BinaryBackupState = {
    targetPath: string;
    backupPath: string;
    hadTarget: boolean;
    backupReady: boolean;
    activated: boolean;
};

export function createBinaryBackupState(targetPath: string, runId = randomUUID()): BinaryBackupState {
    return {
        targetPath,
        backupPath: `${targetPath}.bak-${runId}`,
        hadTarget: existsSync(targetPath),
        backupReady: false,
        activated: false,
    };
}

export function backupCurrentBinary(
    state: BinaryBackupState,
    copier: (source: string, destination: string) => void = copyFileSync,
) {
    if (!state.hadTarget) return;
    copier(state.targetPath, state.backupPath);
    state.backupReady = true;
}

export function restoreCurrentBinary(state: BinaryBackupState) {
    if (state.backupReady && existsSync(state.backupPath)) {
        copyFileSync(state.backupPath, state.targetPath);
        chmodSync(state.targetPath, 0o755);
    } else if (!state.hadTarget && state.activated) {
        rmSync(state.targetPath, { force: true });
    }
}

export function cleanupBinaryBackup(state: BinaryBackupState) {
    rmSync(state.backupPath, { force: true });
}

export function captureFileState(filePath: string): FileState {
    if (!existsSync(filePath)) return { path: filePath, existed: false };
    const stats = statSync(filePath);
    return {
        path: filePath,
        existed: true,
        content: readFileSync(filePath),
        mode: stats.mode & 0o777,
    };
}

export function restoreFileState(state: FileState) {
    if (!state.existed) {
        rmSync(state.path, { force: true });
        return;
    }
    if (!state.content || state.mode === undefined) {
        throw new Error(`Incomplete file rollback state for ${state.path}`);
    }
    mkdirSync(path.dirname(state.path), { recursive: true });
    const temporaryPath = `${state.path}.restore-${process.pid}-${Date.now()}`;
    try {
        writeFileSync(temporaryPath, state.content, { mode: state.mode });
        renameSync(temporaryPath, state.path);
        chmodSync(state.path, state.mode);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

type EdgeRuntimeCapacityInput = {
    env?: Record<string, string | undefined>;
    cpuCount?: number;
    totalMemoryMb?: number;
};

type EdgeRuntimeCapacityConfig = {
    workerPoolSize: number;
    backgroundWorkerPoolSize: number;
    cpuQuotaPercent: number;
    memoryHighMb: number;
    memoryMaxMb: number;
    tasksMax: number;
};

function resolveLinuxBinaryName() {
    if (os.platform() !== "linux") {
        throw new Error("Production binary upgrades are supported on Linux only. Use macOS binaries for local diagnostics.");
    }

    const arch = os.arch();
    if (arch === "arm64") return "supacloud-linux-arm64";
    if (arch === "x64") return "supacloud-linux-amd64";
    throw new Error(`Unsupported Linux architecture: ${arch}`);
}

export function normalizeManagementReleaseTag(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed || trimmed === "latest") return "";
    if (trimmed.startsWith("management-api-v")) return trimmed;
    if (trimmed.startsWith("v")) return `management-api-${trimmed}`;
    return `management-api-v${trimmed}`;
}

function resolveReleaseApiUrl(targetVersion?: string) {
    const tag = normalizeManagementReleaseTag(targetVersion || process.env.SUPACLOUD_UPGRADE_TAG || process.env.SUPACLOUD_UPGRADE_VERSION || "");
    return tag ? `${RELEASES_API}/tags/${encodeURIComponent(tag)}` : `${RELEASES_API}?per_page=100`;
}

function hasReleaseAsset(release: GithubRelease, assetName: string) {
    return Array.isArray(release.assets) && release.assets.some(asset => asset.name === assetName);
}

export function selectManagementRelease(data: GithubRelease | GithubRelease[], binaryName: string): GithubRelease {
    const candidates = Array.isArray(data) ? data : [data];
    const release = candidates.find(candidate =>
        !candidate.draft
        && !candidate.prerelease
        && candidate.tag_name?.startsWith("management-api-v")
        && hasReleaseAsset(candidate, binaryName)
        && hasReleaseAsset(candidate, WEB_CONSOLE_ASSET)
        && hasReleaseAsset(candidate, "SHA256SUMS")
    );
    if (!release) {
        throw new Error(`No Management API release contains ${binaryName}, ${WEB_CONSOLE_ASSET}, and SHA256SUMS`);
    }
    return release;
}

export function verifyArtifactChecksum(filePath: string, assetName: string, checksums: string) {
    const checksumLine = checksums
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => {
            const [, listedName = ""] = line.split(/\s+/, 2);
            return listedName.replace(/^\*/, "") === assetName;
        });
    const expected = checksumLine?.split(/\s+/, 1)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
        throw new Error(`SHA256SUMS does not contain a valid checksum for ${assetName}`);
    }
    const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    if (actual !== expected) {
        throw new Error(`SHA256 mismatch for ${assetName}`);
    }
}

export function validateWebConsoleArchiveEntries(entriesText: string) {
    const entries = entriesText.split(/\r?\n/).filter(Boolean);
    for (const entry of entries) {
        if (entry.startsWith("/") || entry.split("/").includes("..")) {
            throw new Error(`Web Console archive contains an unsafe path: ${entry}`);
        }
    }
    if (!entries.some(entry => /(^|\/)index\.html$/.test(entry))) {
        throw new Error("Web Console archive does not contain index.html");
    }
}

export type UpgradeTransactionOperations = {
    stage: () => Promise<void>;
    migrate: () => Promise<void>;
    activate: () => Promise<void>;
    restart: () => Promise<void>;
    healthCheck: () => Promise<void>;
    rollback: () => Promise<void>;
    cleanup?: () => Promise<void>;
};

export async function executeUpgradeTransaction(operations: UpgradeTransactionOperations) {
    let activationStarted = false;
    try {
        await operations.stage();
        // Database migrations executed by the staged binary must remain backward
        // compatible because artifact rollback cannot reverse committed schema changes.
        await operations.migrate();
        activationStarted = true;
        await operations.activate();
        await operations.restart();
        await operations.healthCheck();
    } catch (error: unknown) {
        if (activationStarted) {
            await operations.rollback();
        }
        throw error;
    } finally {
        await operations.cleanup?.();
    }
}

function normalizeProxyPrefix(value: string) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "direct" || trimmed.toLowerCase() === "none") return "";
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function resolveGithubEndpointPrefixes(
    env: Record<string, string | undefined>,
    extraProxy?: string,
) {
    const rawProxies = [
        "",
        extraProxy,
        env.SUPACLOUD_GITHUB_PROXY,
        ...(env.SUPACLOUD_GITHUB_PROXIES || "").split(","),
    ];

    const seen = new Set<string>();
    return rawProxies
        .map(value => normalizeProxyPrefix(value || ""))
        .filter(proxyPrefix => {
            if (seen.has(proxyPrefix)) return false;
            seen.add(proxyPrefix);
            return true;
        });
}

function buildGithubEndpoints(extraProxy?: string): GithubEndpoint[] {
    return resolveGithubEndpointPrefixes(process.env, extraProxy)
        .map(proxyPrefix => ({
            proxyPrefix,
            label: proxyPrefix ? proxyPrefix.replace(/\/$/, "") : "direct GitHub",
        }));
}

function withGithubProxy(url: string, endpoint: GithubEndpoint) {
    return endpoint.proxyPrefix ? `${endpoint.proxyPrefix}${url}` : url;
}

async function promptForGithubProxy(lastError: string) {
    p.log.warn(`GitHub download failed: ${lastError}`);
    const value = await p.text({
        message: "Enter another GitHub proxy URL, or type direct to retry GitHub directly",
        placeholder: DEFAULT_GITHUB_PROXY,
        defaultValue: "direct",
    });
    if (p.isCancel(value)) {
        p.cancel("Upgrade cancelled.");
        process.exit(1);
    }
    return String(value);
}

async function fetchReleaseMetadata(apiUrl: string, forceYes?: boolean) {
    let lastError = "";
    let endpoints = buildGithubEndpoints();

    while (true) {
        for (const endpoint of endpoints) {
            const requestUrl = withGithubProxy(apiUrl, endpoint);
            try {
                const response = await fetch(requestUrl, {
                    headers: { "User-Agent": "SupaCloud-CLI" },
                });
                if (!response.ok) {
                    lastError = `${endpoint.label} returned HTTP ${response.status}`;
                    continue;
                }
                return {
                    data: await response.json(),
                    endpoint,
                };
            } catch (error: unknown) {
                lastError = `${endpoint.label}: ${error instanceof Error ? error.message : String(error)}`;
            }
        }

        if (forceYes) {
            throw new Error(`Unable to retrieve GitHub release metadata. Last error: ${lastError}`);
        }

        const customProxy = await promptForGithubProxy(lastError);
        endpoints = buildGithubEndpoints(customProxy);
    }
}

function parseEnv(text: string) {
    return Object.fromEntries(
        text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#") && line.includes("="))
            .map(line => {
                const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
                const idx = normalized.indexOf("=");
                const key = normalized.slice(0, idx).trim();
                const raw = normalized.slice(idx + 1).trim();
                const value = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
                return [key, value];
            })
            .filter(([key]) => key.length > 0)
    );
}

async function readEnvFile(filePath: string) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {};
    return parseEnv(await file.text());
}

type ResolveUpgradeEnvironmentOptions = {
    env?: Record<string, string | undefined>;
    managementEnvPath?: string;
    legacyEnvPath?: string;
    readEnv?: (filePath: string) => Promise<Record<string, string>>;
};

export async function resolveUpgradeEnvironment(
    options: ResolveUpgradeEnvironmentOptions = {},
): Promise<Record<string, string>> {
    const explicitEnv = Object.fromEntries(
        Object.entries(options.env ?? process.env)
            .filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const readEnv = options.readEnv ?? readEnvFile;
    const managementEnv = await readEnv(
        options.managementEnvPath ?? managementEnvFile(),
    );
    const legacyOptIn = explicitEnv.SUPACLOUD_LOAD_LEGACY_CONFIG_ENV
        ?? managementEnv.SUPACLOUD_LOAD_LEGACY_CONFIG_ENV;
    const legacyEnv = legacyOptIn === "true"
        ? await readEnv(options.legacyEnvPath ?? LEGACY_CONFIG_FILE)
        : {};

    // Match config.ts precedence: explicit process env wins, the dedicated
    // runtime file fills missing values, and the tracked legacy template is
    // ignored unless an operator opts in explicitly.
    return { ...legacyEnv, ...managementEnv, ...explicitEnv };
}

function positiveInteger(value: string | number | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatSystemdMemory(mb: number) {
    return `${Math.max(64, Math.floor(mb))}M`;
}

export function resolveEdgeRuntimeCapacityConfig(input: EdgeRuntimeCapacityInput = {}): EdgeRuntimeCapacityConfig {
    const env = input.env || process.env;
    const cpuCount = positiveInteger(input.cpuCount, os.cpus().length || 1);
    const totalMemoryMb = positiveInteger(input.totalMemoryMb, Math.floor(os.totalmem() / 1024 / 1024));
    const workerPoolSize = positiveInteger(
        env.SUPACLOUD_EDGE_WORKER_POOL_SIZE || env.WORKER_POOL_SIZE,
        DEFAULT_EDGE_WORKER_POOL_SIZE,
    );
    const backgroundWorkerPoolSize = positiveInteger(
        env.SUPACLOUD_EDGE_BACKGROUND_WORKER_POOL_SIZE || env.BACKGROUND_WORKER_POOL_SIZE,
        DEFAULT_EDGE_BACKGROUND_WORKER_POOL_SIZE,
    );
    const cpuQuotaPercent = positiveInteger(
        env.SUPACLOUD_EDGE_CPU_QUOTA_PERCENT,
        Math.max(100, Math.floor(cpuCount * DEFAULT_EDGE_RESOURCE_RATIO * 100)),
    );
    const memoryMaxMb = positiveInteger(
        env.SUPACLOUD_EDGE_MEMORY_MAX_MB,
        Math.floor(totalMemoryMb * DEFAULT_EDGE_RESOURCE_RATIO),
    );
    const memoryHighMb = positiveInteger(
        env.SUPACLOUD_EDGE_MEMORY_HIGH_MB,
        Math.floor(memoryMaxMb * 0.8),
    );
    const tasksMax = positiveInteger(env.SUPACLOUD_EDGE_TASKS_MAX, DEFAULT_EDGE_TASKS_MAX);

    return {
        workerPoolSize,
        backgroundWorkerPoolSize,
        cpuQuotaPercent,
        memoryHighMb: Math.min(memoryHighMb, memoryMaxMb),
        memoryMaxMb,
        tasksMax,
    };
}

export function buildEdgeRuntimeCapacityDropIn(config: EdgeRuntimeCapacityConfig) {
    return `[Service]
# Managed by supacloud upgrade. These values are deliberately applied in a
# late drop-in so stale low worker/resource limits from older installs do not
# keep foreground Edge Function reads queued behind a small pool.
Environment=WORKER_POOL_SIZE=${config.workerPoolSize}
Environment=BACKGROUND_WORKER_POOL_SIZE=${config.backgroundWorkerPoolSize}
MemoryHigh=${formatSystemdMemory(config.memoryHighMb)}
MemoryMax=${formatSystemdMemory(config.memoryMaxMb)}
CPUQuota=${config.cpuQuotaPercent}%
CPUWeight=60
TasksMax=${config.tasksMax}
OOMPolicy=stop
`;
}

async function downloadAsset(downloadUrl: string, localPath: string, preferredEndpoint: GithubEndpoint, forceYes?: boolean) {
    let lastError = "";
    let endpoints = buildGithubEndpoints(preferredEndpoint.proxyPrefix || undefined);

    while (true) {
        for (const endpoint of endpoints) {
            const requestUrl = withGithubProxy(downloadUrl, endpoint);
            const result = await $`curl -fsSL ${requestUrl} -o ${localPath}`.nothrow().quiet();
            if (result.exitCode === 0) return endpoint;
            lastError = `${endpoint.label}: ${result.stderr.toString().trim() || `curl exited ${result.exitCode}`}`;
        }

        if (forceYes) {
            throw new Error(`Unable to download asset. Last error: ${lastError}`);
        }

        const customProxy = await promptForGithubProxy(lastError);
        endpoints = buildGithubEndpoints(customProxy);
    }
}

function releaseAssetUrl(release: GithubRelease, assetName: string) {
    const asset = release.assets?.find(candidate => candidate.name === assetName);
    if (!asset?.browser_download_url) {
        throw new Error(`Release ${release.tag_name || "unknown"} does not contain required asset: ${assetName}`);
    }
    return asset.browser_download_url;
}

function recordIntegrityMode(mode: string) {
    const recordPath = process.env.SUPACLOUD_INTEGRITY_MODE_RECORD || "/var/lib/supacloud/artifact-integrity-mode";
    const temporaryPath = `${recordPath}.tmp-${process.pid}`;
    try {
        mkdirSync(path.dirname(recordPath), { recursive: true });
        writeFileSync(temporaryPath, `${mode}\n`, { mode: 0o600 });
        renameSync(temporaryPath, recordPath);
    } catch (error: unknown) {
        logger.warn("[Upgrade] Failed to persist artifact integrity mode", {
            error: error instanceof Error ? error.message : String(error),
        });
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

export function resolveArtifactVerificationMode(
    verifierAvailable: boolean,
    env: Record<string, string | undefined>,
): "attested" | "limited" {
    if (verifierAvailable) return "attested";
    if (env.SUPACLOUD_ALLOW_UNVERIFIED_RELEASE === "true") return "limited";
    throw new Error(
        "Artifact attestation verification is required, but gh attestation verify is unavailable. "
        + "Install GitHub CLI or explicitly set SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true for emergency break-glass use.",
    );
}

async function verifyArtifactAttestation(filePath: string) {
    const capability = await $`gh attestation verify --help`.nothrow().quiet();
    const mode = resolveArtifactVerificationMode(capability.exitCode === 0, process.env);
    if (mode === "attested") {
        const verification = await $`gh attestation verify ${filePath} --repo ${RELEASE_REPOSITORY} --signer-workflow ${RELEASE_SIGNER_WORKFLOW}`.nothrow().quiet();
        if (verification.exitCode !== 0) {
            throw new Error(`GitHub artifact attestation verification failed: ${verification.stderr.toString().slice(-500)}`);
        }
        recordIntegrityMode("github-attestation+same-release-sha256");
        return;
    }

    p.log.warn("BREAK-GLASS LIMITED INTEGRITY MODE: artifact attestation verification is unavailable; only the same-release SHA256 checksum was verified.");
    recordIntegrityMode("break-glass:same-release-sha256-only");
}

async function validateBinaryArtifact(filePath: string, binaryName: string) {
    const inspected = await $`file -b ${filePath}`.nothrow().quiet();
    const description = inspected.stdout.toString().trim();
    if (inspected.exitCode !== 0 || !description.includes("ELF")) {
        throw new Error(`${binaryName} is not a valid ELF binary: ${description || inspected.stderr.toString().trim()}`);
    }
    const expectedArchitecture = binaryName.endsWith("arm64") ? ["aarch64", "ARM64"] : ["x86-64", "x86_64"];
    if (!expectedArchitecture.some(value => description.includes(value))) {
        throw new Error(`${binaryName} has the wrong architecture: ${description}`);
    }

    await $`chmod 0755 ${filePath}`;
    const smoke = Bun.spawn([filePath, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (await smoke.exited !== 0) {
        throw new Error(`${binaryName} failed the --version smoke check`);
    }
}

async function downloadReleaseChecksums(release: GithubRelease, preferredEndpoint: GithubEndpoint, forceYes?: boolean) {
    const checksumPath = path.join(os.tmpdir(), `supacloud-SHA256SUMS-${process.pid}-${Date.now()}`);
    try {
        await downloadAsset(releaseAssetUrl(release, "SHA256SUMS"), checksumPath, preferredEndpoint, forceYes);
        return readFileSync(checksumPath, "utf8");
    } finally {
        await $`rm -f ${checksumPath}`.nothrow().quiet();
    }
}

type StagedBinary = {
    path: string;
    endpoint: GithubEndpoint;
};

async function stageBinary(
    downloadUrl: string,
    binaryName: string,
    checksums: string,
    preferredEndpoint: GithubEndpoint,
    forceYes?: boolean,
): Promise<StagedBinary> {
    const tmpBinary = path.join(os.tmpdir(), `${binaryName}-${process.pid}-${Date.now()}`);
    const stagedBinary = `${BIN_TARGET}.new-${process.pid}`;
    try {
        const endpoint = await downloadAsset(downloadUrl, tmpBinary, preferredEndpoint, forceYes);
        verifyArtifactChecksum(tmpBinary, binaryName, checksums);
        await verifyArtifactAttestation(tmpBinary);
        await validateBinaryArtifact(tmpBinary, binaryName);
        await $`install -m 0755 ${tmpBinary} ${stagedBinary}`;
        return { path: stagedBinary, endpoint };
    } finally {
        await $`rm -f ${tmpBinary}`.nothrow().quiet();
    }
}

type StagedWebConsole = {
    releaseDir: string;
    endpoint: GithubEndpoint;
};

async function stageWebConsoleBuild(
    downloadUrl: string,
    version: string,
    checksums: string,
    preferredEndpoint: GithubEndpoint,
    forceYes?: boolean,
): Promise<StagedWebConsole> {
    const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
    const archivePath = path.join(os.tmpdir(), `${WEB_CONSOLE_ASSET}-${Date.now()}`);
    const releaseDir = path.join(WEB_CONSOLE_RELEASES_DIR, `${safeVersion}-${process.pid}-${Date.now()}`);

    try {
        const endpoint = await downloadAsset(downloadUrl, archivePath, preferredEndpoint, forceYes);
        verifyArtifactChecksum(archivePath, WEB_CONSOLE_ASSET, checksums);
        await verifyArtifactAttestation(archivePath);

        const listed = await $`tar -tzf ${archivePath}`.nothrow().quiet();
        if (listed.exitCode !== 0) {
            throw new Error(`${WEB_CONSOLE_ASSET} is not a readable gzip tarball`);
        }
        validateWebConsoleArchiveEntries(listed.stdout.toString());
        const verboseListing = await $`tar -tvzf ${archivePath}`.nothrow().quiet();
        if (verboseListing.exitCode !== 0 || verboseListing.stdout.toString().split(/\r?\n/).filter(Boolean).some(line => !["-", "d"].includes(line[0] || ""))) {
            throw new Error(`${WEB_CONSOLE_ASSET} contains links or special files`);
        }

        await $`rm -rf ${releaseDir}`.nothrow().quiet();
        await $`mkdir -p ${releaseDir} ${WEB_CONSOLE_RELEASES_DIR}`;
        const extract = await $`tar --no-same-owner --no-same-permissions -xzf ${archivePath} -C ${releaseDir}`.nothrow().quiet();
        if (extract.exitCode !== 0) {
            throw new Error(`Failed to extract ${WEB_CONSOLE_ASSET}: ${extract.stderr.toString().slice(-500)}`);
        }
        if (!existsSync(path.join(releaseDir, "index.html"))) {
            throw new Error(`${WEB_CONSOLE_ASSET} is invalid: index.html not found at archive root`);
        }

        return { releaseDir, endpoint };
    } catch (error: unknown) {
        await $`rm -rf ${releaseDir}`.nothrow().quiet();
        throw error;
    } finally {
        await $`rm -f ${archivePath}`.nothrow().quiet();
    }
}

async function runInitDb(binaryPath: string, env: Record<string, string | undefined>) {
    const proc = Bun.spawn([binaryPath, "--init-db"], {
        stdout: "inherit",
        stderr: "inherit",
        env,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`supacloud --init-db exited with code ${exitCode}`);
    }
}

function upsertEnvFileValue(filePath: string, key: string, value: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const line = `${key}=${value}`;
    const next = new RegExp(`^${key}=.*$`, "m").test(existing)
        ? existing.replace(new RegExp(`^${key}=.*$`, "m"), line)
        : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`;
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        writeFileSync(temporaryPath, next, { mode: 0o600 });
        renameSync(temporaryPath, filePath);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

function managementEnvFile() {
    return process.env.SUPACLOUD_MANAGEMENT_ENV_FILE || DEFAULT_MANAGEMENT_ENV_FILE;
}

function edgeRuntimeCapacityDropIn() {
    return process.env.SUPACLOUD_EDGE_RUNTIME_CAPACITY_DROPIN || DEFAULT_EDGE_RUNTIME_CAPACITY_DROPIN;
}

function writeFileAtomically(filePath: string, content: string, mode: number) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        writeFileSync(temporaryPath, content, { mode });
        renameSync(temporaryPath, filePath);
        chmodSync(filePath, mode);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

async function ensureRuntimeModeForBinaryUpgrade() {
    const edgeUnit = await $`systemctl list-unit-files supacloud-edge-runtime.service --no-legend`.nothrow().quiet();
    const edgeServiceKnown = edgeUnit.exitCode === 0 && edgeUnit.stdout.toString().includes("supacloud-edge-runtime.service");
    if (!edgeServiceKnown) return;

    upsertEnvFileValue(managementEnvFile(), "EDGE_RUNTIME_MODE", "external");
}

async function ensureEdgeRuntimeCapacityDropIn(env: Record<string, string | undefined>) {
    const edgeUnit = await $`systemctl list-unit-files supacloud-edge-runtime.service --no-legend`.nothrow().quiet();
    const edgeServiceKnown = edgeUnit.exitCode === 0 && edgeUnit.stdout.toString().includes("supacloud-edge-runtime.service");
    if (!edgeServiceKnown) return;

    const config = resolveEdgeRuntimeCapacityConfig({ env });
    writeFileAtomically(edgeRuntimeCapacityDropIn(), buildEdgeRuntimeCapacityDropIn(config), 0o644);
    await $`systemctl daemon-reload`.nothrow().quiet();
}

async function restartServices() {
    const management = await $`systemctl restart supacloud`.nothrow().quiet();
    if (management.exitCode !== 0) {
        logger.warn("[Upgrade] Failed to restart supacloud.service", {
            stderr: management.stderr.toString().slice(-500),
        });
        throw new Error("Failed to restart supacloud.service");
    }

    await $`systemctl try-restart supacloud-edge-runtime`.nothrow().quiet();
}

async function waitForManagementHealth() {
    const attempts = positiveInteger(process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS, 30);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch("http://127.0.0.1:9090/health", {
                signal: AbortSignal.timeout(2_000),
            });
            if (response.ok) return;
        } catch {
            // Service may still be starting; retry within the bounded window.
        }
        await Bun.sleep(1_000);
    }
    throw new Error("SupaCloud failed the post-upgrade /health check");
}

type UpgradeActivationState = {
    binary: BinaryBackupState;
    oldWebTarget: string | null;
    oldWebBackup: string | null;
    managementEnvState: FileState | null;
    edgeRuntimeDropInState: FileState | null;
};

async function activateArtifacts(stagedBinary: StagedBinary, stagedWeb: StagedWebConsole | null, state: UpgradeActivationState) {
    backupCurrentBinary(state.binary);
    renameSync(stagedBinary.path, BIN_TARGET);
    state.binary.activated = true;
    chmodSync(BIN_TARGET, 0o755);

    if (stagedWeb) {
        await $`mkdir -p ${WEB_CONSOLE_ROOT}`;
        const currentIsLink = await $`test -L ${WEB_CONSOLE_CURRENT_LINK}`.nothrow().quiet();
        if (currentIsLink.exitCode === 0) {
            const oldTarget = await $`readlink ${WEB_CONSOLE_CURRENT_LINK}`.nothrow().quiet();
            state.oldWebTarget = oldTarget.exitCode === 0 ? oldTarget.stdout.toString().trim() : null;
            await $`rm -f ${WEB_CONSOLE_CURRENT_LINK}`;
        } else {
            const currentExists = await $`test -e ${WEB_CONSOLE_CURRENT_LINK}`.nothrow().quiet();
            if (currentExists.exitCode === 0) {
                state.oldWebBackup = `${WEB_CONSOLE_ROOT}/current.bak-${process.pid}-${Date.now()}`;
                await $`mv ${WEB_CONSOLE_CURRENT_LINK} ${state.oldWebBackup}`;
            }
        }
        await $`ln -s ${stagedWeb.releaseDir} ${WEB_CONSOLE_CURRENT_LINK}`;
    }
}

async function rollbackArtifacts(state: UpgradeActivationState, stagedWeb: StagedWebConsole | null) {
    restoreCurrentBinary(state.binary);

    if (stagedWeb) {
        await $`rm -rf ${WEB_CONSOLE_CURRENT_LINK}`.nothrow().quiet();
        if (state.oldWebBackup) {
            await $`mv ${state.oldWebBackup} ${WEB_CONSOLE_CURRENT_LINK}`;
        } else if (state.oldWebTarget) {
            await $`ln -s ${state.oldWebTarget} ${WEB_CONSOLE_CURRENT_LINK}`;
        }
    }

    if (state.managementEnvState) {
        restoreFileState(state.managementEnvState);
    }
    if (state.edgeRuntimeDropInState) {
        restoreFileState(state.edgeRuntimeDropInState);
        await $`systemctl daemon-reload`.nothrow().quiet();
    }

    await restartServices();
    await waitForManagementHealth();
}

export async function runUpgrade(options: { forceYes?: boolean; targetVersion?: string } = {}) {
    p.intro("\x1b[46m SupaCloud Binary Upgrade \x1b[0m");

    const s = p.spinner();
    s.start("Retrieving GitHub release metadata");

    try {
        if (os.userInfo().uid !== 0) {
            throw new Error("Please run the upgrade with root privileges (sudo).");
        }

        const binaryName = resolveLinuxBinaryName();
        const { data, endpoint } = await fetchReleaseMetadata(resolveReleaseApiUrl(options.targetVersion), options.forceYes);
        const release = selectManagementRelease(data as GithubRelease | GithubRelease[], binaryName);
        const remoteVersion = release.tag_name || "unknown";
        const releaseUrl = releaseAssetUrl(release, binaryName);
        const webConsoleUrl = releaseAssetUrl(release, WEB_CONSOLE_ASSET);

        s.stop(`Latest binary available: ${remoteVersion} (${binaryName}, via ${endpoint.label})`);
        p.log.warn("Database migrations must be backward compatible. Automatic rollback restores the binary and Web Console target, not committed schema changes.");

        const confirm = options.forceYes || await p.confirm({
            message: `Replace ${BIN_TARGET} with ${binaryName} from ${remoteVersion}?`,
            initialValue: true,
        });

        if (!confirm || p.isCancel(confirm)) {
            p.cancel("Upgrade cancelled.");
            return;
        }

        const env = await resolveUpgradeEnvironment();
        const checksums = await downloadReleaseChecksums(release, endpoint, options.forceYes);
        let stagedBinary: StagedBinary | null = null;
        let stagedWeb: StagedWebConsole | null = null;
        let activationState: UpgradeActivationState | null = null;
        let committed = false;
        let downloadEndpointLabel = endpoint.label;
        let webConsoleEndpointLabel: string | null = null;

        await executeUpgradeTransaction({
            stage: async () => {
                s.start(`Downloading, verifying, and staging ${binaryName}`);
                stagedBinary = await stageBinary(releaseUrl, binaryName, checksums, endpoint, options.forceYes);
                downloadEndpointLabel = stagedBinary.endpoint.label;
                s.start(`Downloading, verifying, and staging ${WEB_CONSOLE_ASSET}`);
                stagedWeb = await stageWebConsoleBuild(webConsoleUrl, remoteVersion, checksums, endpoint, options.forceYes);
                webConsoleEndpointLabel = stagedWeb.endpoint.label;
            },
            migrate: async () => {
                if (!stagedBinary) throw new Error("Upgrade binary was not staged");
                s.start("Applying backward-compatible metadata database migrations with the staged binary");
                await runInitDb(stagedBinary.path, env);
            },
            activate: async () => {
                if (!stagedBinary) throw new Error("Upgrade binary was not staged");
                s.start("Atomically activating staged SupaCloud artifacts");
                activationState = {
                    binary: createBinaryBackupState(BIN_TARGET),
                    oldWebTarget: null,
                    oldWebBackup: null,
                    managementEnvState: null,
                    edgeRuntimeDropInState: null,
                };
                await activateArtifacts(stagedBinary, stagedWeb, activationState);
            },
            restart: async () => {
                s.start("Applying runtime settings and restarting SupaCloud services");
                if (!activationState) throw new Error("Upgrade activation state is unavailable");
                activationState.managementEnvState = captureFileState(managementEnvFile());
                activationState.edgeRuntimeDropInState = captureFileState(edgeRuntimeCapacityDropIn());
                await ensureRuntimeModeForBinaryUpgrade();
                await ensureEdgeRuntimeCapacityDropIn(env);
                await restartServices();
            },
            healthCheck: async () => {
                s.start("Waiting for the SupaCloud health endpoint");
                await waitForManagementHealth();
                committed = true;
            },
            rollback: async () => {
                if (!activationState) return;
                p.log.warn("Upgrade activation failed; restoring the previous binary and Web Console target.");
                await rollbackArtifacts(activationState, stagedWeb);
            },
            cleanup: async () => {
                if (stagedBinary) {
                    await $`rm -f ${stagedBinary.path}`.nothrow().quiet();
                }
                if (!committed && stagedWeb) {
                    await $`rm -rf ${stagedWeb.releaseDir}`.nothrow().quiet();
                }
                if (activationState) {
                    cleanupBinaryBackup(activationState.binary);
                }
            },
        });

        p.outro(`SupaCloud upgraded to ${remoteVersion} via ${binaryName} (${downloadEndpointLabel})${webConsoleEndpointLabel ? ` and ${WEB_CONSOLE_ASSET} (${webConsoleEndpointLabel})` : ""}`);
    } catch (error: unknown) {
        s.stop(`Upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
