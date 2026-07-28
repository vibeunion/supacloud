import { $, SQL } from "bun";
import * as p from "@clack/prompts";
import os from "node:os";
import path from "node:path";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { logger } from "./utils/logger";
import { WEB_CONSOLE_CURRENT_DIR } from "./utils/web-console-path";
import { hasSecretEncryptionCheckpoint } from "./db/secret-key-migration";

const RELEASES_API = "https://api.github.com/repos/zuohuadong/supacloud/releases";
const RELEASE_REPOSITORY = "zuohuadong/supacloud";
const RELEASE_SIGNER_WORKFLOW = `${RELEASE_REPOSITORY}/.github/workflows/release-please.yml`;
const BIN_TARGET = "/usr/local/bin/supacloud";
const DEFAULT_MANAGEMENT_ENV_FILE = "/etc/supabase/management-api.env";
const DEFAULT_EDGE_RUNTIME_USER = "supacloud-edge";
const DEFAULT_EDGE_RUNTIME_GROUP = "supacloud-edge";
const DEFAULT_EDGE_RUNTIME_PORT = 9005;
const DEFAULT_EDGE_RUNTIME_SOURCE_DIR = "/opt/supacloud/edge-runtime";
const DEFAULT_EDGE_RUNTIME_ENV_FILE = "/etc/supabase/edge-runtime.env";
const LEGACY_CONFIG_FILE = "/opt/supacloud/config.env";
const DEFAULT_GITHUB_PROXY = "https://ghproxy.net/";
const WEB_CONSOLE_ASSET = "web-console-build.tar.gz";
const WEB_CONSOLE_ROOT = "/opt/supacloud/web-console";
const WEB_CONSOLE_RELEASES_DIR = `${WEB_CONSOLE_ROOT}/releases`;
const WEB_CONSOLE_CURRENT_LINK = WEB_CONSOLE_CURRENT_DIR;
const DEFAULT_EDGE_RUNTIME_CAPACITY_DROPIN = "/etc/systemd/system/supacloud-edge-runtime.service.d/50-edge-runtime-capacity.conf";
const DEFAULT_EMBEDDED_EDGE_PRIVILEGE_DROPIN = "/etc/systemd/system/supacloud.service.d/50-embedded-edge-privilege.conf";
const DEFAULT_EDGE_WORKER_POOL_SIZE = 20;
const DEFAULT_EDGE_BACKGROUND_WORKER_POOL_SIZE = 20;
const DEFAULT_EDGE_RESOURCE_RATIO = 0.6;
const DEFAULT_EDGE_TASKS_MAX = 256;
const WEB_CONSOLE_DIR_ENV_KEY = "WEB_CONSOLE_DIR";
const LINUX_ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,30}\$?$/;

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

type HostIdentityCommandResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

type HostIdentityCommandRunner = (command: string[]) => Promise<HostIdentityCommandResult>;

export type EdgeRuntimeIdentity = {
    user: string;
    group: string;
};

type EdgeRuntimeIdentityOptions = {
    platform?: NodeJS.Platform;
    run?: HostIdentityCommandRunner;
};

type EmbeddedEdgeSourceAccessOptions = EdgeRuntimeIdentityOptions & {
    sourceDir?: string;
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

export type PreparedUpgradeSecrets = {
    runtimeEnv: Record<string, string>;
    runtimeSecretsToPersist: Record<string, string>;
};

function generatedPrivilegedSecret(): string {
    return randomBytes(48).toString("base64url");
}

function assertUpgradeSecret(name: string, value: string): void {
    if (value.length < 32 || /[\0\r\n]/.test(value)) {
        throw new Error(`${name} must contain at least 32 characters and no control characters`);
    }
}

type UpgradeSecretValues = {
    masterToken: string;
    currentEncryptionKey: string;
    legacyEncryptionKey: string;
    bffSigningSecret: string;
};

function resolvedUpgradeSecretValues(env: Record<string, string>): UpgradeSecretValues {
    const masterToken = env.MASTER_TOKEN || "";
    const previousEncryptionKey = env.SECRETS_ENCRYPTION_KEY || "";
    const generatedEncryptionKey = !previousEncryptionKey || previousEncryptionKey === masterToken;
    const currentEncryptionKey = generatedEncryptionKey
        ? generatedPrivilegedSecret()
        : previousEncryptionKey;
    const legacyEncryptionKey = env.LEGACY_SECRETS_ENCRYPTION_KEY
        || (generatedEncryptionKey ? masterToken : "");
    return {
        masterToken,
        currentEncryptionKey,
        legacyEncryptionKey,
        bffSigningSecret: env.SUPAOAUTH_BFF_SIGNING_SECRET || generatedPrivilegedSecret(),
    };
}

function validateUpgradeSecretValues(secrets: UpgradeSecretValues): void {
    assertUpgradeSecret("MASTER_TOKEN", secrets.masterToken);
    assertUpgradeSecret("SECRETS_ENCRYPTION_KEY", secrets.currentEncryptionKey);
    assertUpgradeSecret("SUPAOAUTH_BFF_SIGNING_SECRET", secrets.bffSigningSecret);
    if (secrets.legacyEncryptionKey) {
        assertUpgradeSecret("LEGACY_SECRETS_ENCRYPTION_KEY", secrets.legacyEncryptionKey);
    }
    if (new Set([secrets.masterToken, secrets.currentEncryptionKey, secrets.bffSigningSecret]).size !== 3) {
        throw new Error("Management, encryption, and BFF signing secrets must be independent");
    }
    if (
        secrets.legacyEncryptionKey === secrets.currentEncryptionKey
        || secrets.legacyEncryptionKey === secrets.bffSigningSecret
    ) {
        throw new Error("LEGACY_SECRETS_ENCRYPTION_KEY must differ from current runtime secrets");
    }
}

export function prepareUpgradeSecrets(env: Record<string, string>): PreparedUpgradeSecrets {
    const secrets = resolvedUpgradeSecretValues(env);
    validateUpgradeSecretValues(secrets);
    return {
        runtimeEnv: {
            ...env,
            SECRETS_ENCRYPTION_KEY: secrets.currentEncryptionKey,
            SUPAOAUTH_BFF_SIGNING_SECRET: secrets.bffSigningSecret,
            ...(secrets.legacyEncryptionKey
                ? { LEGACY_SECRETS_ENCRYPTION_KEY: secrets.legacyEncryptionKey }
                : {}),
        },
        runtimeSecretsToPersist: {
            SECRETS_ENCRYPTION_KEY: secrets.currentEncryptionKey,
            SUPAOAUTH_BFF_SIGNING_SECRET: secrets.bffSigningSecret,
        },
    };
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

export function buildEmbeddedEdgePrivilegeDropIn() {
    return `[Service]
# The embedded Edge Runtime uses setpriv to drop from the root Management API
# account before any tenant function code starts.
CapabilityBoundingSet=
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID
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

function persistUpgradeRuntimeSecrets(secrets: Record<string, string>): void {
    for (const [name, secret] of Object.entries(secrets)) {
        upsertEnvFileValue(managementEnvFile(), name, secret);
    }
}

type ServiceCommandResult = { exitCode: number; stderr: string };

export type ManagementServiceControl = {
    isActive: () => Promise<boolean>;
    stop: () => Promise<ServiceCommandResult>;
    start: () => Promise<ServiceCommandResult>;
    healthCheck: () => Promise<void>;
};

function managementServiceControl(): ManagementServiceControl {
    return {
        isActive: async () => (await $`systemctl is-active --quiet supacloud`.nothrow().quiet()).exitCode === 0,
        stop: async () => {
            const output = await $`systemctl stop supacloud`.nothrow().quiet();
            return { exitCode: output.exitCode, stderr: output.stderr.toString() };
        },
        start: async () => {
            const output = await $`systemctl start supacloud`.nothrow().quiet();
            return { exitCode: output.exitCode, stderr: output.stderr.toString() };
        },
        healthCheck: waitForManagementHealth,
    };
}

async function restorePartiallyStoppedService(control: ManagementServiceControl): Promise<void> {
    const started = await control.start();
    if (started.exitCode !== 0) {
        throw new Error(`Failed to restore supacloud.service after stop failure: ${started.stderr.slice(-500)}`);
    }
    await control.healthCheck();
}

export async function stopManagementService(
    control: ManagementServiceControl = managementServiceControl(),
): Promise<void> {
    const wasActive = await control.isActive();
    const stopped = await control.stop();
    const activeAfterStop = await control.isActive();
    if (stopped.exitCode === 0 && !activeAfterStop) return;

    const stopError = new Error(
        `Failed to stop supacloud.service before secret migration: ${stopped.stderr.slice(-500) || "service remained active"}`,
    );
    if (wasActive && !activeAfterStop) {
        try {
            await restorePartiallyStoppedService(control);
        } catch (recoveryError: unknown) {
            throw new AggregateError([stopError, recoveryError], "Service stop failed and the previous service could not be restored");
        }
    }
    throw stopError;
}

export function buildCheckpointDatabaseOptions(databaseUrl: string) {
    const parsed = new URL(databaseUrl);
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!database) {
        throw new Error("DATABASE_URL must include a database name for secret migration checkpoint verification");
    }
    return { url: databaseUrl, database, max: 1 };
}

async function checkpointExists(databaseUrl: string, encryptionKey: string): Promise<boolean> {
    const database = new SQL(buildCheckpointDatabaseOptions(databaseUrl));
    try {
        return await hasSecretEncryptionCheckpoint(database, encryptionKey);
    } finally {
        await database.close();
    }
}

export type StagedMigrationOperations = {
    captureRuntimeEnv: () => FileState;
    stopService: () => Promise<void>;
    persistSecrets: (secrets: Record<string, string>) => void;
    runInit: (binaryPath: string, env: Record<string, string | undefined>) => Promise<void>;
    hasCheckpoint: (databaseUrl: string, encryptionKey: string) => Promise<boolean>;
    restoreRuntimeEnv: (state: FileState) => void;
    restart: () => Promise<void>;
    healthCheck: () => Promise<void>;
};

function stagedMigrationOperations(): StagedMigrationOperations {
    return {
        captureRuntimeEnv: () => captureFileState(managementEnvFile()),
        stopService: () => stopManagementService(),
        persistSecrets: persistUpgradeRuntimeSecrets,
        runInit: runInitDb,
        hasCheckpoint: checkpointExists,
        restoreRuntimeEnv: restoreFileState,
        restart: async () => restartServices(await runtimeModeForBinaryUpgrade()),
        healthCheck: waitForManagementHealth,
    };
}

async function restoreRuntimeAfterMigrationFailure(
    runtimeEnvState: FileState,
    keepCurrentKey: boolean,
    operations: StagedMigrationOperations,
): Promise<void> {
    if (!keepCurrentKey) operations.restoreRuntimeEnv(runtimeEnvState);
    await operations.restart();
    await operations.healthCheck();
}

export async function runStagedDatabaseMigration(
    binaryPath: string,
    preparedSecrets: PreparedUpgradeSecrets,
    operations: StagedMigrationOperations = stagedMigrationOperations(),
): Promise<void> {
    const databaseUrl = preparedSecrets.runtimeEnv.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required for secret migration checkpoint verification");
    const encryptionKey = preparedSecrets.runtimeSecretsToPersist.SECRETS_ENCRYPTION_KEY;
    const runtimeEnvState = operations.captureRuntimeEnv();
    await operations.stopService();
    try {
        operations.persistSecrets(preparedSecrets.runtimeSecretsToPersist);
        await operations.runInit(binaryPath, preparedSecrets.runtimeEnv);
        if (!(await operations.hasCheckpoint(databaseUrl, encryptionKey))) {
            throw new Error("Secret migration checkpoint is missing after init-db");
        }
    } catch (migrationError: unknown) {
        let rotationComplete: boolean;
        try {
            rotationComplete = await operations.hasCheckpoint(databaseUrl, encryptionKey);
        } catch (checkpointError: unknown) {
            throw new AggregateError(
                [migrationError, checkpointError],
                "Database migration failed and key state could not be verified; the service remains stopped",
            );
        }
        try {
            await restoreRuntimeAfterMigrationFailure(runtimeEnvState, rotationComplete, operations);
        } catch (recoveryError: unknown) {
            throw new AggregateError(
                [migrationError, recoveryError],
                "Database migration failed and the management runtime could not be restored",
            );
        }
        throw migrationError;
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

function envFileHasNonEmptyValue(filePath: string, key: string): boolean {
    if (!existsSync(filePath)) return false;
    return Boolean(parseEnv(readFileSync(filePath, "utf8"))[key]?.trim());
}

export function upsertEdgeRuntimeIdentityDefaults(filePath: string, identity: EdgeRuntimeIdentity) {
    if (!envFileHasNonEmptyValue(filePath, "EDGE_RUNTIME_USER")) {
        upsertEnvFileValue(filePath, "EDGE_RUNTIME_USER", identity.user);
    }
    if (!envFileHasNonEmptyValue(filePath, "EDGE_RUNTIME_GROUP")) {
        upsertEnvFileValue(filePath, "EDGE_RUNTIME_GROUP", identity.group);
    }
}

function edgeRuntimeEnvFile() {
    return process.env.SUPACLOUD_EDGE_RUNTIME_ENV_FILE || DEFAULT_EDGE_RUNTIME_ENV_FILE;
}

export function resolvePersistedEdgeRuntimePort(
    managementEnvPath: string = managementEnvFile(),
    runtimeEnvPath: string = edgeRuntimeEnvFile(),
): number {
    const managementEnv = existsSync(managementEnvPath) ? parseEnv(readFileSync(managementEnvPath, "utf8")) : {};
    const runtimeEnv = existsSync(runtimeEnvPath) ? parseEnv(readFileSync(runtimeEnvPath, "utf8")) : {};
    const persistedPort = managementEnv.EDGE_RUNTIME_PORT || runtimeEnv.EDGE_RUNTIME_PORT;
    const port = Number(persistedPort || DEFAULT_EDGE_RUNTIME_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid persisted EDGE_RUNTIME_PORT: ${persistedPort}`);
    }
    return port;
}

export function upsertPersistedEdgeRuntimePort(
    managementEnvPath: string = managementEnvFile(),
    runtimeEnvPath: string = edgeRuntimeEnvFile(),
) {
    const port = resolvePersistedEdgeRuntimePort(managementEnvPath, runtimeEnvPath);
    upsertEnvFileValue(managementEnvPath, "EDGE_RUNTIME_PORT", String(port));
    upsertEnvFileValue(runtimeEnvPath, "EDGE_RUNTIME_PORT", String(port));
    if (!envFileHasNonEmptyValue(managementEnvPath, "EDGE_RUNTIME_INTERNAL")) {
        upsertEnvFileValue(managementEnvPath, "EDGE_RUNTIME_INTERNAL", `127.0.0.1:${port}`);
    }
    return port;
}

export function upsertManagementWebConsoleDir(managementEnvPath: string = managementEnvFile()) {
    upsertEnvFileValue(managementEnvPath, WEB_CONSOLE_DIR_ENV_KEY, WEB_CONSOLE_CURRENT_LINK);
}

function managementEnvFile() {
    return process.env.SUPACLOUD_MANAGEMENT_ENV_FILE || DEFAULT_MANAGEMENT_ENV_FILE;
}

async function runHostIdentityCommand(command: string[]): Promise<HostIdentityCommandResult> {
    const child = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { exitCode, stdout, stderr };
}

function validatedAccountName(value: string | undefined, fallback: string, label: string): string {
    const accountName = value?.trim() || fallback;
    if (!LINUX_ACCOUNT_NAME.test(accountName)) {
        throw new Error(`${label} is not a valid Linux account name`);
    }
    return accountName;
}

async function ensureHostGroup(group: string, run: HostIdentityCommandRunner): Promise<void> {
    if ((await run(["getent", "group", group])).exitCode === 0) return;
    const created = await run(["groupadd", "--system", group]);
    if (created.exitCode === 0 || (await run(["getent", "group", group])).exitCode === 0) return;
    throw new Error(`Failed to create Edge Runtime group ${group}: ${created.stderr.trim().slice(-300)}`);
}

async function verifyHostUser(user: string, group: string, run: HostIdentityCommandRunner): Promise<void> {
    const uid = await run(["id", "-u", user]);
    const primaryGroup = await run(["id", "-gn", user]);
    if (uid.exitCode !== 0 || primaryGroup.exitCode !== 0) {
        throw new Error(`Failed to verify Edge Runtime user ${user}`);
    }
    if (uid.stdout.trim() === "0" || primaryGroup.stdout.trim() !== group) {
        throw new Error(`Existing Edge Runtime account ${user} violates the dedicated runtime-user contract`);
    }
}

async function ensureHostUser(user: string, group: string, run: HostIdentityCommandRunner): Promise<void> {
    const current = await run(["id", "-u", user]);
    if (current.exitCode !== 0) {
        const created = await run([
            "useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent",
            "--shell", "/usr/sbin/nologin", "--gid", group, user,
        ]);
        if (created.exitCode !== 0 && (await run(["id", "-u", user])).exitCode !== 0) {
            throw new Error(`Failed to create Edge Runtime user ${user}: ${created.stderr.trim().slice(-300)}`);
        }
    }
    await verifyHostUser(user, group, run);
}

export async function ensureEdgeRuntimeIdentity(
    env: Record<string, string | undefined>,
    options: EdgeRuntimeIdentityOptions = {},
): Promise<EdgeRuntimeIdentity> {
    const user = validatedAccountName(env.EDGE_RUNTIME_USER, DEFAULT_EDGE_RUNTIME_USER, "EDGE_RUNTIME_USER");
    const group = validatedAccountName(env.EDGE_RUNTIME_GROUP, DEFAULT_EDGE_RUNTIME_GROUP, "EDGE_RUNTIME_GROUP");
    if ((options.platform ?? process.platform) !== "linux") return { user, group };

    const run = options.run ?? runHostIdentityCommand;
    await ensureHostGroup(group, run);
    await ensureHostUser(user, group, run);
    return { user, group };
}

export async function ensurePersistedEdgeRuntimeIdentity(
    filePath: string,
    options: EdgeRuntimeIdentityOptions = {},
): Promise<EdgeRuntimeIdentity> {
    const identity = await ensureEdgeRuntimeIdentity(await readEnvFile(filePath), options);
    upsertEdgeRuntimeIdentityDefaults(filePath, identity);
    return identity;
}

async function runRequiredHostCommand(
    command: string[],
    failureMessage: string,
    run: HostIdentityCommandRunner,
): Promise<void> {
    const completed = await run(command);
    if (completed.exitCode !== 0) {
        throw new Error(`${failureMessage}: ${completed.stderr.trim().slice(-300)}`);
    }
}

export async function ensureEmbeddedEdgeRuntimeSourceAccess(
    identity: EdgeRuntimeIdentity,
    options: EmbeddedEdgeSourceAccessOptions = {},
): Promise<void> {
    if ((options.platform ?? process.platform) !== "linux") return;
    const sourceDir = options.sourceDir || DEFAULT_EDGE_RUNTIME_SOURCE_DIR;
    if (!existsSync(sourceDir)) throw new Error(`Embedded Edge Runtime source directory is missing: ${sourceDir}`);
    const run = options.run ?? runHostIdentityCommand;
    await runRequiredHostCommand(["chmod", "-R", "g-w,g+rX", sourceDir], "Failed to grant Edge Runtime source access", run);
    await runRequiredHostCommand(["chgrp", "-R", identity.group, sourceDir], "Failed to assign Edge Runtime source group", run);
}

function edgeRuntimeCapacityDropIn() {
    return process.env.SUPACLOUD_EDGE_RUNTIME_CAPACITY_DROPIN || DEFAULT_EDGE_RUNTIME_CAPACITY_DROPIN;
}

function embeddedEdgePrivilegeDropIn() {
    return process.env.SUPACLOUD_EMBEDDED_EDGE_PRIVILEGE_DROPIN || DEFAULT_EMBEDDED_EDGE_PRIVILEGE_DROPIN;
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

export type EdgeRuntimeMode = "embedded" | "external";

export type RuntimeServiceRestartAction =
    | "disable-external-edge-runtime"
    | "restart-management"
    | "restart-external-edge-runtime";

async function runtimeModeForBinaryUpgrade(): Promise<EdgeRuntimeMode> {
    const persistedEnv = await readEnvFile(managementEnvFile());
    return resolvePersistedEdgeRuntimeMode(persistedEnv.EDGE_RUNTIME_MODE);
}

export function resolvePersistedEdgeRuntimeMode(persistedMode?: string): EdgeRuntimeMode {
    if (persistedMode === undefined || persistedMode === "" || persistedMode === "embedded") return "embedded";
    if (persistedMode === "external") return "external";
    throw new Error(`Invalid persisted EDGE_RUNTIME_MODE: ${persistedMode}`);
}

async function reloadSystemdUnits() {
    const reload = await $`systemctl daemon-reload`.nothrow().quiet();
    if (reload.exitCode !== 0) {
        throw new Error(`Failed to reload systemd units: ${reload.stderr.toString().trim().slice(-500)}`);
    }
}

async function reconcileEmbeddedEdgePrivilegeDropIn(mode: "embedded" | "external", identity: EdgeRuntimeIdentity) {
    if (mode === "embedded") {
        await ensureEmbeddedEdgeRuntimeSourceAccess(identity);
        writeFileAtomically(embeddedEdgePrivilegeDropIn(), buildEmbeddedEdgePrivilegeDropIn(), 0o644);
    } else {
        rmSync(embeddedEdgePrivilegeDropIn(), { force: true });
    }
    await reloadSystemdUnits();
}

async function edgeRuntimeServiceIsInstalled(): Promise<boolean> {
    const edgeUnit = await $`systemctl list-unit-files supacloud-edge-runtime.service --no-legend`.nothrow().quiet();
    return edgeUnit.exitCode === 0 && edgeUnit.stdout.toString().includes("supacloud-edge-runtime.service");
}

async function ensureEdgeRuntimeCapacityDropIn(env: Record<string, string | undefined>) {
    if (!await edgeRuntimeServiceIsInstalled()) return;

    const config = resolveEdgeRuntimeCapacityConfig({ env });
    writeFileAtomically(edgeRuntimeCapacityDropIn(), buildEdgeRuntimeCapacityDropIn(config), 0o644);
    await reloadSystemdUnits();
}

export function buildRuntimeServiceRestartPlan(
    mode: EdgeRuntimeMode,
    externalEdgeRuntimeServiceInstalled: boolean,
): RuntimeServiceRestartAction[] {
    if (mode === "embedded") {
        return externalEdgeRuntimeServiceInstalled
            ? ["disable-external-edge-runtime", "restart-management"]
            : ["restart-management"];
    }
    return externalEdgeRuntimeServiceInstalled
        ? ["restart-management", "restart-external-edge-runtime"]
        : ["restart-management"];
}

async function runRuntimeServiceRestartAction(action: RuntimeServiceRestartAction) {
    const command = action === "disable-external-edge-runtime"
        ? $`systemctl disable --now supacloud-edge-runtime`.nothrow().quiet()
        : action === "restart-management"
            ? $`systemctl restart supacloud`.nothrow().quiet()
            : $`systemctl restart supacloud-edge-runtime`.nothrow().quiet();
    const result = await command;
    if (result.exitCode === 0) return;

    const service = action === "restart-management" ? "supacloud.service" : "supacloud-edge-runtime.service";
    logger.warn(`[Upgrade] Failed to ${action}`, {
        stderr: result.stderr.toString().slice(-500),
    });
    throw new Error(`Failed to ${action} for ${service}`);
}

async function restartServices(mode: EdgeRuntimeMode) {
    const externalEdgeRuntimeServiceInstalled = await edgeRuntimeServiceIsInstalled();
    for (const action of buildRuntimeServiceRestartPlan(mode, externalEdgeRuntimeServiceInstalled)) {
        await runRuntimeServiceRestartAction(action);
    }
}

export async function waitForManagementHealth() {
    const attempts = positiveInteger(process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS, 30);
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const healthResponse = await fetch("http://127.0.0.1:9090/health", {
                signal: AbortSignal.timeout(2_000),
            });
            if (!healthResponse.ok) {
                lastError = `health endpoint returned HTTP ${healthResponse.status}`;
                throw new Error(lastError);
            }

            const rootResponse = await fetch("http://127.0.0.1:9090/", {
                signal: AbortSignal.timeout(2_000),
            });
            if (!rootResponse.ok) {
                lastError = `web console root check failed: returned HTTP ${rootResponse.status}`;
                throw new Error(lastError);
            }

            const contentType = rootResponse.headers.get("content-type")?.toLowerCase() ?? "";
            if (!contentType.includes("text/html")) {
                const body = (await rootResponse.text()).toLowerCase();
                if (!body.includes("<!doctype html") && !body.includes("<html")) {
                    lastError = "web console root check failed: response does not contain HTML";
                    throw new Error(lastError);
                }
            }

            return;
        } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : String(error);
            logger.debug("Management health check attempt failed", {
                attempt,
                lastError,
            });

            // Service may still be starting; retry within the bounded window.
        }
        await Bun.sleep(1_000);
    }
    throw new Error(`SupaCloud failed the post-upgrade health checks: ${lastError ?? "timeout"}`);
}

export async function waitForEdgeRuntimeHealth() {
    const attempts = positiveInteger(process.env.SUPACLOUD_UPGRADE_EDGE_HEALTH_ATTEMPTS, 30);
    const port = resolvePersistedEdgeRuntimePort();
    let lastError = "timeout";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(2_000),
            });
            if (response.ok) return;
            lastError = `returned HTTP ${response.status}`;
        } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await Bun.sleep(1_000);
    }
    throw new Error(`Edge Runtime failed the post-upgrade health check: ${lastError}`);
}

export async function waitForUpgradeHealth() {
    await waitForManagementHealth();
    await waitForEdgeRuntimeHealth();
}

type UpgradeActivationState = {
    binary: BinaryBackupState;
    oldWebTarget: string | null;
    oldWebBackup: string | null;
    managementEnvState: FileState | null;
    edgeRuntimeEnvState: FileState | null;
    edgeRuntimeDropInState: FileState | null;
    embeddedEdgePrivilegeDropInState: FileState | null;
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
    if (state.edgeRuntimeEnvState) {
        restoreFileState(state.edgeRuntimeEnvState);
    }
    if (state.edgeRuntimeDropInState) {
        restoreFileState(state.edgeRuntimeDropInState);
    }
    if (state.embeddedEdgePrivilegeDropInState) {
        restoreFileState(state.embeddedEdgePrivilegeDropInState);
    }
    await reloadSystemdUnits();

    await restartServices(await runtimeModeForBinaryUpgrade());
    await waitForUpgradeHealth();
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

        const preparedSecrets = prepareUpgradeSecrets(await resolveUpgradeEnvironment());
        const env = preparedSecrets.runtimeEnv;
        const checksums = await downloadReleaseChecksums(release, endpoint, options.forceYes);
        let stagedBinary: StagedBinary | null = null;
        let stagedWeb: StagedWebConsole | null = null;
        let activationState: UpgradeActivationState | null = null;
        let committed = false;
        let downloadEndpointLabel = endpoint.label;
        let webConsoleEndpointLabel: string | null = null;
        let activatedEdgeRuntimeMode: EdgeRuntimeMode | null = null;

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
                await runStagedDatabaseMigration(stagedBinary.path, preparedSecrets);
            },
            activate: async () => {
                if (!stagedBinary) throw new Error("Upgrade binary was not staged");
                s.start("Atomically activating staged SupaCloud artifacts");
                activationState = {
                    binary: createBinaryBackupState(BIN_TARGET),
                    oldWebTarget: null,
                    oldWebBackup: null,
                    managementEnvState: null,
                    edgeRuntimeEnvState: null,
                    edgeRuntimeDropInState: null,
                    embeddedEdgePrivilegeDropInState: null,
                };
                await activateArtifacts(stagedBinary, stagedWeb, activationState);
            },
            restart: async () => {
                s.start("Applying runtime settings and restarting SupaCloud services");
                if (!activationState) throw new Error("Upgrade activation state is unavailable");
                activationState.managementEnvState = captureFileState(managementEnvFile());
                activationState.edgeRuntimeEnvState = captureFileState(edgeRuntimeEnvFile());
                activationState.edgeRuntimeDropInState = captureFileState(edgeRuntimeCapacityDropIn());
                activationState.embeddedEdgePrivilegeDropInState = captureFileState(embeddedEdgePrivilegeDropIn());
                const edgeRuntimeIdentity = await ensurePersistedEdgeRuntimeIdentity(managementEnvFile());
                upsertPersistedEdgeRuntimePort(managementEnvFile(), edgeRuntimeEnvFile());
                const edgeRuntimeMode = await runtimeModeForBinaryUpgrade();
                activatedEdgeRuntimeMode = edgeRuntimeMode;
                await reconcileEmbeddedEdgePrivilegeDropIn(edgeRuntimeMode, edgeRuntimeIdentity);
                if (edgeRuntimeMode === "external") {
                    await ensureEdgeRuntimeCapacityDropIn(env);
                }
                upsertManagementWebConsoleDir(managementEnvFile());
                await restartServices(edgeRuntimeMode);
            },
            healthCheck: async () => {
                s.start("Waiting for the SupaCloud health endpoint");
                if (!activatedEdgeRuntimeMode) throw new Error("Edge Runtime mode was not resolved");
                await waitForUpgradeHealth();
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
