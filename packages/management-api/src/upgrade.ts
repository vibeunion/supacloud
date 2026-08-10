import { $, SQL } from "bun";
import * as p from "@clack/prompts";
import os from "node:os";
import path from "node:path";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { logger } from "./utils/logger";
import { WEB_CONSOLE_CURRENT_DIR } from "./utils/web-console-path";
import { hasSecretEncryptionCheckpoint } from "./db/secret-key-migration";
import {
    RELEASE_REPOSITORY,
    RELEASE_SIGNER_WORKFLOW,
    RELEASE_SOURCE_REF,
    manifestArtifact,
} from "./release-manifest";
import {
    loadOfflineUpgradeBundle,
    type OfflineReleaseBundle,
    type OfflineUpgradeBundle,
} from "./offline-upgrade-bundle";

const RELEASES_API = "https://api.github.com/repos/zuohuadong/supacloud/releases";
const BIN_TARGET = "/usr/local/bin/supacloud";
const MANAGEMENT_SERVICE_UNIT = "supacloud.service";
const EDGE_RUNTIME_SERVICE_UNIT = "supacloud-edge-runtime.service";
const EDGE_RUNTIME_BINARY_TARGETS = new Set([
    "/usr/local/bin/supacloud-edge-runtime",
    "/opt/supacloud/bin/supacloud-edge-runtime",
]);
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
const DEFAULT_MANAGEMENT_PRIVILEGE_DROPIN = "/etc/systemd/system/supacloud.service.d/40-management-privilege.conf";
const DEFAULT_EMBEDDED_EDGE_PRIVILEGE_DROPIN = "/etc/systemd/system/supacloud.service.d/50-embedded-edge-privilege.conf";
const DEFAULT_EDGE_WORKER_POOL_SIZE = 20;
const DEFAULT_EDGE_BACKGROUND_WORKER_POOL_SIZE = 20;
const DEFAULT_EDGE_RESOURCE_RATIO = 0.6;
const DEFAULT_EDGE_TASKS_MAX = 256;
const WEB_CONSOLE_DIR_ENV_KEY = "WEB_CONSOLE_DIR";
const LINUX_ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,30}\$?$/;
const OFFLINE_BUNDLE_ENDPOINT: GithubEndpoint = {
    label: "verified offline bundle",
    proxyPrefix: "",
};

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

export type HostIdentityCommandResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

type HostIdentityCommandRunner = (command: string[]) => Promise<HostIdentityCommandResult>;

export type ActiveSystemdBinary = {
    unit: string;
    execStartPath: string;
    pid: number;
    executablePath: string;
    sha256: string;
};

type SystemdBinaryInspectorOptions = {
    run?: HostIdentityCommandRunner;
    readlink?: (filePath: string) => string;
    sha256?: (filePath: string) => string;
};

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
        const restorePath = `${state.targetPath}.restore-${process.pid}-${randomUUID()}`;
        try {
            copyFileSync(state.backupPath, restorePath);
            chmodSync(restorePath, 0o755);
            renameSync(restorePath, state.targetPath);
        } finally {
            rmSync(restorePath, { force: true });
        }
    } else if (!state.hadTarget && state.activated) {
        rmSync(state.targetPath, { force: true });
    }
}

export function cleanupBinaryBackup(state: BinaryBackupState) {
    rmSync(state.backupPath, { force: true });
}

export function activateStagedBinary(stagedPath: string, state: BinaryBackupState): void {
    backupCurrentBinary(state);
    renameSync(stagedPath, state.targetPath);
    state.activated = true;
    chmodSync(state.targetPath, 0o755);
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

export function normalizeExactManagementVersion(tag: string): string {
    const version = tag.trim().replace(/^management-api-v/, "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error("An exact stable Management API version is required for an offline bundle");
    }
    return version;
}

export function normalizeEdgeRuntimeReleaseTag(tag: string) {
    const trimmed = tag.trim();
    const version = trimmed.replace(/^edge-runtime-v/, "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error("An exact stable Edge Runtime version is required");
    }
    return `edge-runtime-v${version}`;
}

function resolveReleaseApiUrl(targetVersion?: string) {
    const tag = normalizeManagementReleaseTag(targetVersion || process.env.SUPACLOUD_UPGRADE_TAG || process.env.SUPACLOUD_UPGRADE_VERSION || "");
    return tag ? `${RELEASES_API}/tags/${encodeURIComponent(tag)}` : `${RELEASES_API}?per_page=100`;
}

function resolveEdgeRuntimeReleaseApiUrl(version: string) {
    return `${RELEASES_API}/tags/${encodeURIComponent(normalizeEdgeRuntimeReleaseTag(version))}`;
}

function resolveEdgeRuntimeBinaryName(managementBinaryName: string) {
    return managementBinaryName.endsWith("arm64")
        ? "supacloud-edge-runtime-linux-arm64"
        : "supacloud-edge-runtime-linux-amd64";
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

export function selectEdgeRuntimeRelease(
    releaseMetadata: GithubRelease,
    expectedTag: string,
    binaryName: string,
): GithubRelease {
    if (releaseMetadata.draft || releaseMetadata.prerelease || releaseMetadata.tag_name !== expectedTag
        || !hasReleaseAsset(releaseMetadata, binaryName) || !hasReleaseAsset(releaseMetadata, "SHA256SUMS")) {
        throw new Error(`Edge Runtime release ${expectedTag} must contain ${binaryName} and SHA256SUMS`);
    }
    return releaseMetadata;
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
    const actual = sha256File(filePath);
    if (actual !== expected) {
        throw new Error(`SHA256 mismatch for ${assetName}`);
    }
    return actual;
}

function sha256File(filePath: string): string {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function parseSystemdExecStartPath(value: string): string {
    const matches = Array.from(value.trim().matchAll(/(?:^|[{;]\s*)path=([^;}\r\n]+?)\s*(?=;|}|$)/g));
    if (matches.length !== 1) {
        throw new Error("ExecStart must contain exactly one executable path");
    }

    const executablePath = matches[0]?.[1]?.trim() || "";
    if (!path.posix.isAbsolute(executablePath) || /\s/.test(executablePath)) {
        throw new Error("ExecStart executable path must be an unambiguous absolute path");
    }
    return executablePath;
}

export function parseSystemdMainPid(value: string): number {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
        throw new Error("MainPID must be a decimal integer");
    }
    const pid = Number(normalized);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error("MainPID must identify a running service process");
    }
    return pid;
}

export type SystemdEnabledState = "enabled" | "disabled";

export function parseSystemdEnabledState(commandResult: HostIdentityCommandResult): SystemdEnabledState {
    const state = commandResult.stdout.trim();
    if ((commandResult.exitCode === 0 || commandResult.exitCode === 1)
        && (state === "enabled" || state === "disabled")) {
        return state;
    }
    throw new Error(`Unsupported systemd enabled state: ${state || commandResult.stderr.trim() || commandResult.exitCode}`);
}

export function assertEdgeRuntimeBinaryTarget(targetPath: string): void {
    if (!EDGE_RUNTIME_BINARY_TARGETS.has(targetPath)) {
        throw new Error(`Unsafe Edge Runtime upgrade target: ${targetPath}`);
    }
}

export async function readSystemdEnabledState(
    unit: string,
    run: HostIdentityCommandRunner = runHostIdentityCommand,
): Promise<SystemdEnabledState> {
    try {
        return parseSystemdEnabledState(await run(["systemctl", "is-enabled", unit]));
    } catch (error: unknown) {
        throw new Error(`Cannot verify ${unit} enabled state: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function readSystemdProperty(
    unit: string,
    property: "ExecStart" | "MainPID",
    run: HostIdentityCommandRunner,
): Promise<string> {
    let result: HostIdentityCommandResult;
    try {
        result = await run(["systemctl", "show", unit, `--property=${property}`, "--value"]);
    } catch (error: unknown) {
        throw new Error(`Failed to inspect ${unit} ${property}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.exitCode !== 0) {
        throw new Error(`Failed to inspect ${unit} ${property}: ${result.stderr.trim().slice(-300) || `systemctl exited with ${result.exitCode}`}`);
    }
    return result.stdout;
}

async function readExecStartPath(unit: string, run: HostIdentityCommandRunner): Promise<string> {
    try {
        const rawExecStart = await readSystemdProperty(unit, "ExecStart", run);
        return parseSystemdExecStartPath(rawExecStart);
    } catch (error: unknown) {
        throw new Error(`Cannot verify ${unit} ExecStart: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function readMainPid(unit: string, run: HostIdentityCommandRunner): Promise<number> {
    try {
        const rawMainPid = await readSystemdProperty(unit, "MainPID", run);
        return parseSystemdMainPid(rawMainPid);
    } catch (error: unknown) {
        throw new Error(`Cannot verify ${unit} MainPID: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function resolveActiveExecutablePath(unit: string, procExecutablePath: string, readlink: (filePath: string) => string): string {
    try {
        return readlink(procExecutablePath).trim();
    } catch (error: unknown) {
        throw new Error(`Cannot resolve ${unit} active executable at ${procExecutablePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function hashActiveExecutable(unit: string, procExecutablePath: string, sha256: (filePath: string) => string): string {
    let digest: string;
    try {
        digest = sha256(procExecutablePath).trim().toLowerCase();
    } catch (error: unknown) {
        throw new Error(`Cannot hash ${unit} active executable at ${procExecutablePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`Cannot verify ${unit} active executable: invalid SHA-256 digest`);
    }
    return digest;
}

export async function inspectActiveSystemdBinary(
    unit: string,
    options: SystemdBinaryInspectorOptions = {},
): Promise<ActiveSystemdBinary> {
    const run = options.run ?? runHostIdentityCommand;
    const readlink = options.readlink ?? ((filePath: string) => readlinkSync(filePath, "utf8"));
    const sha256 = options.sha256 ?? sha256File;
    const execStartPath = await readExecStartPath(unit, run);
    const pid = await readMainPid(unit, run);
    const procExecutablePath = `/proc/${pid}/exe`;
    const executablePath = resolveActiveExecutablePath(unit, procExecutablePath, readlink);
    const digest = hashActiveExecutable(unit, procExecutablePath, sha256);
    const stablePid = await readMainPid(unit, run);
    if (stablePid !== pid) {
        throw new Error(`Cannot verify ${unit} active executable: MainPID changed from ${pid} to ${stablePid}`);
    }
    return { unit, execStartPath, pid, executablePath, sha256: digest };
}

export async function inspectActiveManagementBinary(
    options: SystemdBinaryInspectorOptions = {},
): Promise<ActiveSystemdBinary> {
    return inspectActiveSystemdBinary(MANAGEMENT_SERVICE_UNIT, options);
}

function assertCanonicalManagementBinary(snapshot: ActiveSystemdBinary, phase: string): void {
    if (snapshot.execStartPath !== BIN_TARGET) {
        throw new Error(`${phase}: ${snapshot.unit} ExecStart is ${snapshot.execStartPath}; upgrade target is ${BIN_TARGET}`);
    }
    if (snapshot.executablePath !== BIN_TARGET) {
        throw new Error(`${phase}: ${snapshot.unit} runs ${snapshot.executablePath}; expected ${BIN_TARGET}`);
    }
}

export async function verifyManagementUpgradePreflight(
    options: SystemdBinaryInspectorOptions = {},
): Promise<ActiveSystemdBinary> {
    const snapshot = await inspectActiveManagementBinary(options);
    assertCanonicalManagementBinary(snapshot, "Refusing to migrate");
    return snapshot;
}

export function verifyBackupPrivilegeDropPreflight(
    pathExists: (filePath: string) => boolean = existsSync,
): void {
    const setprivPath = ["/usr/bin/setpriv", "/bin/setpriv"].find(pathExists);
    const idPath = ["/usr/bin/id", "/bin/id"].find(pathExists);
    if (!setprivPath) throw new Error("Management upgrade requires setpriv for backup privilege separation");
    if (!idPath) throw new Error("Management upgrade requires id for backup account resolution");
}

export async function verifyActivatedManagementBinary(
    expectedSha256: string,
    options: SystemdBinaryInspectorOptions = {},
): Promise<ActiveSystemdBinary> {
    const normalizedExpected = expectedSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedExpected)) {
        throw new Error("Post-upgrade binary verification requires a valid staged SHA-256 digest");
    }
    const snapshot = await inspectActiveManagementBinary(options);
    assertCanonicalManagementBinary(snapshot, "Post-upgrade binary verification failed");
    if (snapshot.sha256 !== normalizedExpected) {
        throw new Error(`Post-upgrade binary verification failed: ${snapshot.unit} is running a binary whose SHA-256 does not match the staged release binary`);
    }
    return snapshot;
}

export async function verifyActivatedSystemdBinary(
    unit: string,
    targetPath: string,
    expectedSha256: string,
    options: SystemdBinaryInspectorOptions = {},
): Promise<ActiveSystemdBinary> {
    const normalizedExpected = expectedSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedExpected)) {
        throw new Error(`Post-upgrade ${unit} verification requires a valid staged SHA-256 digest`);
    }
    const snapshot = await inspectActiveSystemdBinary(unit, options);
    if (snapshot.execStartPath !== targetPath || snapshot.executablePath !== targetPath) {
        throw new Error(`Post-upgrade ${unit} verification failed: expected active target ${targetPath}`);
    }
    if (snapshot.sha256 !== normalizedExpected) {
        throw new Error(`Post-upgrade ${unit} verification failed: active SHA-256 does not match the staged release`);
    }
    return snapshot;
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
    preflight: () => Promise<void>;
    stage: () => Promise<void>;
    migrate: () => Promise<void>;
    activate: () => Promise<void>;
    restart: () => Promise<void>;
    healthCheck: () => Promise<void>;
    rollback: () => Promise<void>;
    cleanup?: () => Promise<void>;
};

export type UpgradeFailureKind =
    | "rollback-incomplete"
    | "cleanup-incomplete-after-commit"
    | "cleanup-incomplete-after-failure";

export class UpgradeTransactionError extends AggregateError {
    constructor(
        readonly kind: UpgradeFailureKind,
        errors: unknown[],
        message: string,
    ) {
        super(errors, message);
        this.name = "UpgradeTransactionError";
    }
}

async function executeUpgradePhases(operations: UpgradeTransactionOperations): Promise<void> {
    let activationStarted = false;
    try {
        await operations.preflight();
        await operations.stage();
        // Database migrations executed by the staged binary must remain backward
        // compatible because artifact rollback cannot reverse committed schema changes.
        await operations.migrate();
        activationStarted = true;
        await operations.activate();
        await operations.restart();
        await operations.healthCheck();
    } catch (error: unknown) {
        if (activationStarted) await rethrowAfterUpgradeRollback(operations, error);
        throw error;
    }
}

async function rethrowAfterUpgradeRollback(
    operations: UpgradeTransactionOperations,
    upgradeError: unknown,
): Promise<never> {
    try {
        await operations.rollback();
    } catch (rollbackError: unknown) {
        throw new UpgradeTransactionError(
            "rollback-incomplete",
            [upgradeError, rollbackError],
            "Upgrade failed and rollback did not complete",
        );
    }
    throw upgradeError;
}

function throwUpgradeOutcome(transactionError: unknown, cleanupError: unknown): void {
    if (transactionError && cleanupError) {
        throw new UpgradeTransactionError(
            "cleanup-incomplete-after-failure",
            [transactionError, cleanupError],
            "Upgrade failed and cleanup did not complete",
        );
    }
    if (transactionError) throw transactionError;
    if (cleanupError) {
        throw new UpgradeTransactionError(
            "cleanup-incomplete-after-commit",
            [cleanupError],
            "Upgrade committed but cleanup did not complete",
        );
    }
}

export async function executeUpgradeTransaction(operations: UpgradeTransactionOperations) {
    let transactionError: unknown;
    try {
        await executeUpgradePhases(operations);
    } catch (error: unknown) {
        transactionError = error;
    }

    let cleanupError: unknown;
    try {
        await operations.cleanup?.();
    } catch (error: unknown) {
        cleanupError = error;
    }
    throwUpgradeOutcome(transactionError, cleanupError);
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

async function fetchGithubApiJson(apiUrl: string, forceYes?: boolean) {
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
            throw new Error(`Unable to retrieve GitHub API JSON. Last error: ${lastError}`);
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

export function buildManagementPrivilegeDropIn() {
    return `[Service]
# Backup and PITR commands use setpriv from the root Management API process.
CapabilityBoundingSet=
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID
`;
}

function ensureManagementPrivilegeDropIn(filePath = DEFAULT_MANAGEMENT_PRIVILEGE_DROPIN) {
    writeFileAtomically(filePath, buildManagementPrivilegeDropIn(), 0o644);
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

export function supportsGithubOfflineAttestationVerification(exitCode: number, helpText: string): boolean {
    const helpTokens = helpText.split(/\s+/);
    return exitCode === 0
        && ["--bundle", "--signer-workflow", "--source-ref", "--deny-self-hosted-runners"].every(flag => (
            helpTokens.some(token => token === flag || token.startsWith(`${flag}=`))
        ));
}

function isJsonObject(candidate: unknown): candidate is Record<string, unknown> {
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

export function serializeGithubAttestationBundles(payload: unknown): string {
    if (!isJsonObject(payload) || !Array.isArray(payload.attestations) || payload.attestations.length === 0) {
        throw new Error("GitHub artifact attestation response did not contain a non-empty attestations array");
    }
    const bundles = payload.attestations.map((attestation, index) => {
        const bundle = isJsonObject(attestation) ? attestation.bundle : undefined;
        if (!isJsonObject(bundle)) {
            throw new Error(`GitHub artifact attestation ${index} did not contain a valid bundle object`);
        }
        return bundle;
    });
    return `${bundles.map(bundle => JSON.stringify(bundle)).join("\n")}\n`;
}

function throwAttestationVerificationOutcome(verificationError: unknown, cleanupError: unknown): void {
    if (verificationError && cleanupError) {
        throw new AggregateError(
            [verificationError, cleanupError],
            "GitHub artifact attestation verification failed and temporary bundle cleanup did not complete",
        );
    }
    if (verificationError) throw verificationError;
    if (cleanupError) {
        throw new AggregateError([cleanupError], "Temporary GitHub attestation bundle cleanup did not complete");
    }
}

type GithubCliCommandResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

async function runGithubCli(githubArguments: string[]): Promise<GithubCliCommandResult> {
    const executable = Bun.which("gh", { PATH: process.env.PATH });
    if (!executable) return { exitCode: 127, stdout: "", stderr: "gh not found" };
    const child = Bun.spawn([executable, ...githubArguments], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
}

async function runGithubAttestationVerification(filePath: string, bundlePath: string): Promise<void> {
    const verification = await runGithubCli([
        "attestation", "verify", filePath,
        "--bundle", bundlePath,
        "--repo", RELEASE_REPOSITORY,
        "--signer-workflow", RELEASE_SIGNER_WORKFLOW,
        "--source-ref", RELEASE_SOURCE_REF,
        "--deny-self-hosted-runners",
    ]);
    if (verification.exitCode !== 0) {
        throw new Error(`GitHub artifact attestation verification failed: ${verification.stderr.slice(-500)}`);
    }
}

async function verifyGithubAttestationBundle(filePath: string, bundleJsonl: string): Promise<void> {
    const bundleDirectory = mkdtempSync(path.join(os.tmpdir(), "supacloud-attestation-"));
    const bundlePath = path.join(bundleDirectory, "bundle.jsonl");
    let verificationError: unknown;
    try {
        writeFileSync(bundlePath, bundleJsonl, { mode: 0o600 });
        await runGithubAttestationVerification(filePath, bundlePath);
    } catch (error: unknown) {
        verificationError = error;
    }

    let cleanupError: unknown;
    try {
        rmSync(bundleDirectory, { recursive: true });
    } catch (error: unknown) {
        cleanupError = error;
    }
    throwAttestationVerificationOutcome(verificationError, cleanupError);
}

export type VerifyArtifactAttestationRequest = {
    filePath: string;
    forceYes?: boolean;
};

async function downloadGithubAttestationBundle(request: VerifyArtifactAttestationRequest): Promise<string> {
    const digest = sha256File(request.filePath);
    const apiUrl = `https://api.github.com/repos/${RELEASE_REPOSITORY}/attestations/sha256:${digest}`;
    const metadata = await fetchGithubApiJson(apiUrl, request.forceYes);
    return serializeGithubAttestationBundles(metadata.data);
}

export async function verifyArtifactAttestation(request: VerifyArtifactAttestationRequest) {
    const capability = await runGithubCli(["attestation", "verify", "--help"]);
    const helpText = `${capability.stdout}\n${capability.stderr}`;
    const verifierAvailable = supportsGithubOfflineAttestationVerification(capability.exitCode, helpText);
    const mode = resolveArtifactVerificationMode(verifierAvailable, process.env);
    if (mode === "attested") {
        const bundleJsonl = await downloadGithubAttestationBundle(request);
        await verifyGithubAttestationBundle(request.filePath, bundleJsonl);
        recordIntegrityMode("github-attestation+same-release-sha256");
        return;
    }

    p.log.warn("BREAK-GLASS LIMITED INTEGRITY MODE: artifact attestation verification is unavailable; only the same-release SHA256 checksum was verified.");
    recordIntegrityMode("break-glass:same-release-sha256-only");
}

async function validateElfBinaryArtifact(filePath: string, binaryName: string) {
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
}

export function parseManagementVersionOutput(stdout: string): string {
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) throw new Error("Management --version output must contain exactly one line");
    let message = lines[0] as string;
    if (message.startsWith("{")) {
        const payload = JSON.parse(message) as { message?: unknown };
        if (typeof payload.message !== "string") throw new Error("Management --version JSON is invalid");
        message = payload.message;
    }
    const match = message.match(/^SupaCloud Version: (\d+\.\d+\.\d+)$/);
    if (!match) throw new Error("Management --version output is invalid");
    return match[1] as string;
}

async function validateManagementBinaryArtifact(filePath: string, binaryName: string, expectedVersion: string) {
    await validateElfBinaryArtifact(filePath, binaryName);
    const smoke = Bun.spawn([filePath, "--version"], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => smoke.kill("SIGKILL"), 5_000);
    let smokeOutput: [number, string, string];
    try {
        smokeOutput = await Promise.all([
            smoke.exited,
            new Response(smoke.stdout).text(),
            new Response(smoke.stderr).text(),
        ]);
    } finally {
        clearTimeout(timeout);
    }
    const [exitCode, stdout, stderr] = smokeOutput;
    if (exitCode !== 0 || stderr.trim()) {
        throw new Error(`${binaryName} failed the --version smoke check`);
    }
    const actualVersion = parseManagementVersionOutput(stdout);
    if (actualVersion !== expectedVersion) {
        throw new Error(`${binaryName} reports ${actualVersion}; expected ${expectedVersion}`);
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
    sha256: string;
};

type StageBinaryRequest = {
    downloadUrl: string;
    binaryName: string;
    checksums: string;
    preferredEndpoint: GithubEndpoint;
    targetPath: string;
    validate: (filePath: string, binaryName: string) => Promise<void>;
    forceYes?: boolean;
};

async function stageBinary(request: StageBinaryRequest): Promise<StagedBinary> {
    const tmpBinary = path.join(os.tmpdir(), `${request.binaryName}-${process.pid}-${Date.now()}`);
    const stagedBinary = `${request.targetPath}.new-${process.pid}`;
    try {
        const endpoint = await downloadAsset(request.downloadUrl, tmpBinary, request.preferredEndpoint, request.forceYes);
        const releaseSha256 = verifyArtifactChecksum(tmpBinary, request.binaryName, request.checksums);
        await verifyArtifactAttestation({ filePath: tmpBinary, forceYes: request.forceYes });
        await request.validate(tmpBinary, request.binaryName);
        await $`install -m 0755 ${tmpBinary} ${stagedBinary}`;
        const stagedSha256 = sha256File(stagedBinary);
        if (stagedSha256 !== releaseSha256) {
            await $`rm -f ${stagedBinary}`.nothrow().quiet();
            throw new Error(`SHA256 mismatch for staged ${request.binaryName}`);
        }
        return { path: stagedBinary, endpoint, sha256: stagedSha256 };
    } catch (error: unknown) {
        await $`rm -f ${stagedBinary}`.nothrow().quiet();
        throw error;
    } finally {
        await $`rm -f ${tmpBinary}`.nothrow().quiet();
    }
}

type StageBundledBinaryRequest = {
    sourcePath: string;
    binaryName: string;
    expectedSha256: string;
    targetPath: string;
    validate: (filePath: string, binaryName: string) => Promise<void>;
};

async function stageBundledBinary(request: StageBundledBinaryRequest): Promise<StagedBinary> {
    const stagedBinary = `${request.targetPath}.new-${process.pid}`;
    try {
        copyFileSync(request.sourcePath, stagedBinary);
        chmodSync(stagedBinary, 0o755);
        await request.validate(stagedBinary, request.binaryName);
        const stagedSha256 = sha256File(stagedBinary);
        if (stagedSha256 !== request.expectedSha256) {
            throw new Error(`SHA256 mismatch for staged ${request.binaryName}`);
        }
        return { path: stagedBinary, endpoint: OFFLINE_BUNDLE_ENDPOINT, sha256: stagedSha256 };
    } catch (error: unknown) {
        rmSync(stagedBinary, { force: true });
        throw error;
    }
}

type StagedWebConsole = {
    releaseDir: string;
    endpoint: GithubEndpoint;
};

async function validateWebConsoleArchive(archivePath: string): Promise<void> {
    const listed = await $`tar -tzf ${archivePath}`.nothrow().quiet();
    if (listed.exitCode !== 0) throw new Error(`${WEB_CONSOLE_ASSET} is not a readable gzip tarball`);
    validateWebConsoleArchiveEntries(listed.stdout.toString());
    const verboseListing = await $`tar -tvzf ${archivePath}`.nothrow().quiet();
    const hasUnsafeEntry = verboseListing.stdout.toString().split(/\r?\n/)
        .filter(Boolean).some(line => !["-", "d"].includes(line[0] || ""));
    if (verboseListing.exitCode !== 0 || hasUnsafeEntry) {
        throw new Error(`${WEB_CONSOLE_ASSET} contains links or special files`);
    }
}

async function extractWebConsoleArchive(
    archivePath: string,
    version: string,
    endpoint: GithubEndpoint,
): Promise<StagedWebConsole> {
    const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
    const releaseDir = path.join(WEB_CONSOLE_RELEASES_DIR, `${safeVersion}-${process.pid}-${Date.now()}`);
    try {
        await validateWebConsoleArchive(archivePath);
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
    }
}

type StageWebConsoleBuildRequest = {
    downloadUrl: string;
    version: string;
    checksums: string;
    preferredEndpoint: GithubEndpoint;
    forceYes?: boolean;
};

async function stageWebConsoleBuild(request: StageWebConsoleBuildRequest): Promise<StagedWebConsole> {
    const archivePath = path.join(os.tmpdir(), `${WEB_CONSOLE_ASSET}-${Date.now()}`);

    try {
        const endpoint = await downloadAsset(
            request.downloadUrl, archivePath, request.preferredEndpoint, request.forceYes,
        );
        verifyArtifactChecksum(archivePath, WEB_CONSOLE_ASSET, request.checksums);
        await verifyArtifactAttestation({ filePath: archivePath, forceYes: request.forceYes });
        return await extractWebConsoleArchive(archivePath, request.version, endpoint);
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

export function assertExternalEdgeRuntimeUpgradeMode(mode: EdgeRuntimeMode): void {
    if (mode !== "external") {
        throw new Error("Edge Runtime component upgrade supports persisted external mode only");
    }
}

export function shouldCleanupUpgradeArtifacts(state: {
    committed: boolean;
    rollbackSucceeded: boolean;
    activationStarted: boolean;
}): boolean {
    return state.committed || state.rollbackSucceeded || !state.activationStarted;
}

async function reloadSystemdUnits() {
    const reload = await $`systemctl daemon-reload`.nothrow().quiet();
    if (reload.exitCode !== 0) {
        throw new Error(`Failed to reload systemd units: ${reload.stderr.toString().trim().slice(-500)}`);
    }
}

async function reconcileEmbeddedPrivilegeDropIn(
    mode: "embedded" | "external",
    identity: EdgeRuntimeIdentity,
    filePath: string,
) {
    if (mode === "embedded") {
        await ensureEmbeddedEdgeRuntimeSourceAccess(identity);
        writeFileAtomically(filePath, buildEmbeddedEdgePrivilegeDropIn(), 0o644);
    } else {
        rmSync(filePath, { force: true });
    }
}

export async function reconcileManagementPrivilegeDropIns(
    mode: "embedded" | "external",
    identity: EdgeRuntimeIdentity,
    options: {
        managementDropInPath?: string;
        embeddedDropInPath?: string;
        reloadSystemd?: () => Promise<void>;
    } = {},
) {
    await reconcileEmbeddedPrivilegeDropIn(
        mode,
        identity,
        options.embeddedDropInPath ?? embeddedEdgePrivilegeDropIn(),
    );
    ensureManagementPrivilegeDropIn(options.managementDropInPath);
    await (options.reloadSystemd ?? reloadSystemdUnits)();
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
    edgeBinary: BinaryBackupState | null;
    oldWebTarget: string | null;
    oldWebBackup: string | null;
    managementEnvState: FileState | null;
    edgeRuntimeEnvState: FileState | null;
    edgeRuntimeDropInState: FileState | null;
    managementPrivilegeDropInState: FileState | null;
    embeddedEdgePrivilegeDropInState: FileState | null;
};

type RunUpgradeOptions = {
    forceYes?: boolean;
    targetVersion?: string;
    edgeRuntimeVersion?: string;
    assetBundleDir?: string;
};

type EdgeRuntimeUpgradePlan = {
    binaryName: string;
    enabledState: SystemdEnabledState;
    endpoint: GithubEndpoint;
    release: GithubRelease;
    targetPath: string;
};

type EdgeRuntimeReleasePlanRequest = {
    binaryName: string;
    forceYes?: boolean;
    preflight: ActiveSystemdBinary | null;
    requestedVersion: string;
};

type UpgradeReleasePlan = {
    binaryName: string;
    endpoint: GithubEndpoint;
    edgeRuntime: EdgeRuntimeUpgradePlan | null;
    offlineBundle: OfflineUpgradeBundle | null;
    release: GithubRelease;
    remoteVersion: string;
};

type UpgradeExecutionState = {
    activatedEdgeRuntimeMode: EdgeRuntimeMode | null;
    activation: UpgradeActivationState | null;
    committed: boolean;
    downloadEndpointLabel: string;
    edgeRuntimeEndpointLabel: string | null;
    rollbackSucceeded: boolean;
    stagedEdgeRuntime: StagedBinary | null;
    stagedManagement: StagedBinary | null;
    stagedWebConsole: StagedWebConsole | null;
    webConsoleEndpointLabel: string | null;
};

type UpgradeExecutionContext = {
    checksums: string;
    edgeRuntimeChecksums: string | null;
    options: RunUpgradeOptions;
    plan: UpgradeReleasePlan;
    preparedSecrets: PreparedUpgradeSecrets;
    spinner: ReturnType<typeof p.spinner>;
    state: UpgradeExecutionState;
};

type UpgradeCleanupAction = {
    description: string;
    run: () => void;
};

async function activateArtifacts(
    stagedBinary: StagedBinary,
    stagedEdgeBinary: StagedBinary | null,
    stagedWeb: StagedWebConsole | null,
    state: UpgradeActivationState,
) {
    activateStagedBinary(stagedBinary.path, state.binary);

    if (stagedEdgeBinary && state.edgeBinary) {
        activateStagedBinary(stagedEdgeBinary.path, state.edgeBinary);
    }

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
    if (state.edgeBinary) restoreCurrentBinary(state.edgeBinary);

    if (stagedWeb) {
        rmSync(WEB_CONSOLE_CURRENT_LINK, { force: true, recursive: true });
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
    if (state.managementPrivilegeDropInState) {
        restoreFileState(state.managementPrivilegeDropInState);
    }
    if (state.embeddedEdgePrivilegeDropInState) {
        restoreFileState(state.embeddedEdgePrivilegeDropInState);
    }
    await reloadSystemdUnits();

    await restartServices(await runtimeModeForBinaryUpgrade());
    await waitForUpgradeHealth();
}

function createActivationState(edgeRuntimeTarget: string | null): UpgradeActivationState {
    return {
        binary: createBinaryBackupState(BIN_TARGET),
        edgeBinary: edgeRuntimeTarget ? createBinaryBackupState(edgeRuntimeTarget) : null,
        oldWebTarget: null,
        oldWebBackup: null,
        managementEnvState: null,
        edgeRuntimeEnvState: null,
        edgeRuntimeDropInState: null,
        managementPrivilegeDropInState: null,
        embeddedEdgePrivilegeDropInState: null,
    };
}

async function inspectEdgeRuntimeUpgradeTarget(requestedVersion: string): Promise<ActiveSystemdBinary | null> {
    if (!requestedVersion) return null;
    assertExternalEdgeRuntimeUpgradeMode(await runtimeModeForBinaryUpgrade());
    const preflight = await inspectActiveSystemdBinary(EDGE_RUNTIME_SERVICE_UNIT);
    assertEdgeRuntimeBinaryTarget(preflight.execStartPath);
    if (preflight.executablePath !== preflight.execStartPath) {
        throw new Error(`${EDGE_RUNTIME_SERVICE_UNIT} runs ${preflight.executablePath}; expected ${preflight.execStartPath}`);
    }
    return preflight;
}

async function resolveEdgeRuntimeUpgradePlan(
    request: EdgeRuntimeReleasePlanRequest,
): Promise<EdgeRuntimeUpgradePlan | null> {
    const { binaryName, forceYes, preflight, requestedVersion } = request;
    if (!preflight) return null;
    const metadata = await fetchGithubApiJson(resolveEdgeRuntimeReleaseApiUrl(requestedVersion), forceYes);
    const expectedTag = normalizeEdgeRuntimeReleaseTag(requestedVersion);
    return {
        binaryName,
        enabledState: await readSystemdEnabledState(EDGE_RUNTIME_SERVICE_UNIT),
        endpoint: metadata.endpoint,
        release: selectEdgeRuntimeRelease(metadata.data as GithubRelease, expectedTag, binaryName),
        targetPath: preflight.execStartPath,
    };
}

function offlineReleaseMetadata(bundle: OfflineReleaseBundle): GithubRelease {
    return {
        tag_name: bundle.manifest.release.tag,
        draft: false,
        prerelease: false,
        assets: [...bundle.assetPaths.keys()].map(name => ({ name })),
    };
}

async function resolveOfflineUpgradeReleasePlan(
    options: RunUpgradeOptions,
    binaryName: string,
    edgePreflight: ActiveSystemdBinary | null,
    requestedEdgeVersion: string,
): Promise<UpgradeReleasePlan> {
    const requestedManagementVersion = options.targetVersion
        || process.env.SUPACLOUD_UPGRADE_TAG
        || process.env.SUPACLOUD_UPGRADE_VERSION
        || "";
    const managementVersion = normalizeExactManagementVersion(requestedManagementVersion);
    const edgeVersion = requestedEdgeVersion
        ? normalizeEdgeRuntimeReleaseTag(requestedEdgeVersion).slice("edge-runtime-v".length)
        : "";
    const offlineBundle = await loadOfflineUpgradeBundle({
        assetBundleDir: options.assetBundleDir as string,
        management: { version: managementVersion, binaryName },
        ...(edgePreflight ? {
            edgeRuntime: { version: edgeVersion, binaryName: resolveEdgeRuntimeBinaryName(binaryName) },
        } : {}),
    });
    recordIntegrityMode("github-attestation+same-release-sha256");
    const edgeRuntime = edgePreflight && offlineBundle.edgeRuntime ? {
        binaryName: resolveEdgeRuntimeBinaryName(binaryName),
        enabledState: await readSystemdEnabledState(EDGE_RUNTIME_SERVICE_UNIT),
        endpoint: OFFLINE_BUNDLE_ENDPOINT,
        release: offlineReleaseMetadata(offlineBundle.edgeRuntime),
        targetPath: edgePreflight.execStartPath,
    } : null;
    return {
        binaryName,
        endpoint: OFFLINE_BUNDLE_ENDPOINT,
        edgeRuntime,
        offlineBundle,
        release: offlineReleaseMetadata(offlineBundle.management),
        remoteVersion: offlineBundle.management.manifest.release.tag,
    };
}

async function resolveUpgradeReleasePlan(options: RunUpgradeOptions): Promise<UpgradeReleasePlan> {
    const requestedEdgeVersion = options.edgeRuntimeVersion
        || process.env.SUPACLOUD_EDGE_RUNTIME_UPGRADE_TAG
        || "";
    const edgePreflight = await inspectEdgeRuntimeUpgradeTarget(requestedEdgeVersion);
    const binaryName = resolveLinuxBinaryName();
    if (options.assetBundleDir) {
        return resolveOfflineUpgradeReleasePlan(options, binaryName, edgePreflight, requestedEdgeVersion);
    }
    const metadata = await fetchGithubApiJson(resolveReleaseApiUrl(options.targetVersion), options.forceYes);
    const release = selectManagementRelease(metadata.data as GithubRelease | GithubRelease[], binaryName);
    const edgeRuntime = await resolveEdgeRuntimeUpgradePlan({
        binaryName: resolveEdgeRuntimeBinaryName(binaryName),
        forceYes: options.forceYes,
        preflight: edgePreflight,
        requestedVersion: requestedEdgeVersion,
    });
    return {
        binaryName,
        endpoint: metadata.endpoint,
        edgeRuntime,
        offlineBundle: null,
        release,
        remoteVersion: release.tag_name || "unknown",
    };
}

function upgradeConfirmationMessage(plan: UpgradeReleasePlan): string {
    const edgeSummary = plan.edgeRuntime
        ? ` and ${plan.edgeRuntime.targetPath} with ${plan.edgeRuntime.binaryName} from ${plan.edgeRuntime.release.tag_name}`
        : "";
    return `Replace ${BIN_TARGET} with ${plan.binaryName} from ${plan.remoteVersion}${edgeSummary}?`;
}

async function confirmUpgrade(plan: UpgradeReleasePlan, forceYes?: boolean): Promise<boolean> {
    if (forceYes) return true;
    const confirmation = await p.confirm({ message: upgradeConfirmationMessage(plan), initialValue: true });
    return !p.isCancel(confirmation) && confirmation;
}

function createUpgradeExecutionState(plan: UpgradeReleasePlan): UpgradeExecutionState {
    return {
        activatedEdgeRuntimeMode: null,
        activation: null,
        committed: false,
        downloadEndpointLabel: plan.endpoint.label,
        edgeRuntimeEndpointLabel: null,
        rollbackSucceeded: false,
        stagedEdgeRuntime: null,
        stagedManagement: null,
        stagedWebConsole: null,
        webConsoleEndpointLabel: null,
    };
}

async function createUpgradeExecutionContext(
    plan: UpgradeReleasePlan,
    options: RunUpgradeOptions,
    spinner: ReturnType<typeof p.spinner>,
): Promise<UpgradeExecutionContext> {
    const preparedSecrets = prepareUpgradeSecrets(await resolveUpgradeEnvironment());
    const checksums = plan.offlineBundle?.management.checksums
        ?? await downloadReleaseChecksums(plan.release, plan.endpoint, options.forceYes);
    const edgeRuntimeChecksums = plan.offlineBundle?.edgeRuntime?.checksums
        ?? (plan.edgeRuntime
            ? await downloadReleaseChecksums(plan.edgeRuntime.release, plan.edgeRuntime.endpoint, options.forceYes)
            : null);
    return {
        checksums,
        edgeRuntimeChecksums,
        options,
        plan,
        preparedSecrets,
        spinner,
        state: createUpgradeExecutionState(plan),
    };
}

async function verifyUpgradePreflight(context: UpgradeExecutionContext): Promise<void> {
    context.spinner.start(`Verifying ${MANAGEMENT_SERVICE_UNIT} uses the canonical upgrade target`);
    verifyBackupPrivilegeDropPreflight();
    await verifyManagementUpgradePreflight();
    const edgeRuntime = context.plan.edgeRuntime;
    if (!edgeRuntime) return;
    const current = await inspectActiveSystemdBinary(EDGE_RUNTIME_SERVICE_UNIT);
    if (current.execStartPath !== edgeRuntime.targetPath || current.executablePath !== edgeRuntime.targetPath) {
        throw new Error(`${EDGE_RUNTIME_SERVICE_UNIT} target changed during upgrade preflight`);
    }
}

function offlineAssetPath(bundle: OfflineReleaseBundle, name: string): string {
    const assetPath = bundle.assetPaths.get(name);
    if (!assetPath) throw new Error(`Offline release bundle does not contain ${name}`);
    return assetPath;
}

async function stageManagementUpgrade(context: UpgradeExecutionContext): Promise<void> {
    const { plan, state } = context;
    context.spinner.start(`Verifying and staging ${plan.binaryName}`);
    const offlineRelease = plan.offlineBundle?.management;
    const expectedVersion = normalizeExactManagementVersion(plan.remoteVersion);
    const validateManagementReleaseBinary = (filePath: string, binaryName: string) => (
        validateManagementBinaryArtifact(filePath, binaryName, expectedVersion)
    );
    state.stagedManagement = offlineRelease
        ? await stageBundledBinary({
            sourcePath: offlineAssetPath(offlineRelease, plan.binaryName),
            binaryName: plan.binaryName,
            expectedSha256: manifestArtifact(offlineRelease.manifest, plan.binaryName).sha256,
            targetPath: BIN_TARGET,
            validate: validateManagementReleaseBinary,
        })
        : await stageBinary({
            downloadUrl: releaseAssetUrl(plan.release, plan.binaryName),
            binaryName: plan.binaryName,
            checksums: context.checksums,
            preferredEndpoint: plan.endpoint,
            targetPath: BIN_TARGET,
            validate: validateManagementReleaseBinary,
            forceYes: context.options.forceYes,
        });
    state.downloadEndpointLabel = state.stagedManagement.endpoint.label;
}

async function stageEdgeRuntimeUpgrade(context: UpgradeExecutionContext): Promise<void> {
    const edgeRuntime = context.plan.edgeRuntime;
    if (!edgeRuntime || !context.edgeRuntimeChecksums) return;
    context.spinner.start(`Verifying and staging ${edgeRuntime.binaryName}`);
    const offlineRelease = context.plan.offlineBundle?.edgeRuntime;
    context.state.stagedEdgeRuntime = offlineRelease
        ? await stageBundledBinary({
            sourcePath: offlineAssetPath(offlineRelease, edgeRuntime.binaryName),
            binaryName: edgeRuntime.binaryName,
            expectedSha256: manifestArtifact(offlineRelease.manifest, edgeRuntime.binaryName).sha256,
            targetPath: edgeRuntime.targetPath,
            validate: validateElfBinaryArtifact,
        })
        : await stageBinary({
            downloadUrl: releaseAssetUrl(edgeRuntime.release, edgeRuntime.binaryName),
            binaryName: edgeRuntime.binaryName,
            checksums: context.edgeRuntimeChecksums,
            preferredEndpoint: edgeRuntime.endpoint,
            targetPath: edgeRuntime.targetPath,
            validate: validateElfBinaryArtifact,
            forceYes: context.options.forceYes,
        });
    context.state.edgeRuntimeEndpointLabel = context.state.stagedEdgeRuntime.endpoint.label;
}

async function stageWebConsoleUpgrade(context: UpgradeExecutionContext): Promise<void> {
    const { plan, state } = context;
    context.spinner.start(`Verifying and staging ${WEB_CONSOLE_ASSET}`);
    const offlineRelease = plan.offlineBundle?.management;
    state.stagedWebConsole = offlineRelease
        ? await extractWebConsoleArchive(
            offlineAssetPath(offlineRelease, WEB_CONSOLE_ASSET),
            plan.remoteVersion,
            OFFLINE_BUNDLE_ENDPOINT,
        )
        : await stageWebConsoleBuild({
            downloadUrl: releaseAssetUrl(plan.release, WEB_CONSOLE_ASSET),
            version: plan.remoteVersion,
            checksums: context.checksums,
            preferredEndpoint: plan.endpoint,
            forceYes: context.options.forceYes,
        });
    state.webConsoleEndpointLabel = state.stagedWebConsole.endpoint.label;
}

async function stageUpgradeArtifacts(context: UpgradeExecutionContext): Promise<void> {
    await stageManagementUpgrade(context);
    await stageEdgeRuntimeUpgrade(context);
    await stageWebConsoleUpgrade(context);
}

async function migrateUpgradeMetadata(context: UpgradeExecutionContext): Promise<void> {
    const stagedManagement = context.state.stagedManagement;
    if (!stagedManagement) throw new Error("Upgrade binary was not staged");
    context.spinner.start("Applying backward-compatible metadata database migrations with the staged binary");
    await runStagedDatabaseMigration(stagedManagement.path, context.preparedSecrets);
}

async function activateUpgradeArtifacts(context: UpgradeExecutionContext): Promise<void> {
    const { plan, state } = context;
    if (!state.stagedManagement) throw new Error("Upgrade binary was not staged");
    context.spinner.start("Atomically activating staged SupaCloud artifacts");
    state.activation = createActivationState(plan.edgeRuntime?.targetPath || null);
    await activateArtifacts(
        state.stagedManagement,
        state.stagedEdgeRuntime,
        state.stagedWebConsole,
        state.activation,
    );
}

function captureUpgradeRuntimeFiles(activation: UpgradeActivationState): void {
    activation.managementEnvState = captureFileState(managementEnvFile());
    activation.edgeRuntimeEnvState = captureFileState(edgeRuntimeEnvFile());
    activation.edgeRuntimeDropInState = captureFileState(edgeRuntimeCapacityDropIn());
    activation.managementPrivilegeDropInState = captureFileState(DEFAULT_MANAGEMENT_PRIVILEGE_DROPIN);
    activation.embeddedEdgePrivilegeDropInState = captureFileState(embeddedEdgePrivilegeDropIn());
}

async function applyUpgradeRuntimeSettings(context: UpgradeExecutionContext): Promise<void> {
    const activation = context.state.activation;
    if (!activation) throw new Error("Upgrade activation state is unavailable");
    context.spinner.start("Applying runtime settings and restarting SupaCloud services");
    captureUpgradeRuntimeFiles(activation);
    const edgeRuntimeIdentity = await ensurePersistedEdgeRuntimeIdentity(managementEnvFile());
    upsertPersistedEdgeRuntimePort(managementEnvFile(), edgeRuntimeEnvFile());
    const edgeRuntimeMode = await runtimeModeForBinaryUpgrade();
    context.state.activatedEdgeRuntimeMode = edgeRuntimeMode;
    await reconcileManagementPrivilegeDropIns(edgeRuntimeMode, edgeRuntimeIdentity);
    if (edgeRuntimeMode === "external") await ensureEdgeRuntimeCapacityDropIn(context.preparedSecrets.runtimeEnv);
    upsertManagementWebConsoleDir(managementEnvFile());
    await restartServices(edgeRuntimeMode);
}

async function verifyEdgeRuntimeUpgrade(context: UpgradeExecutionContext): Promise<void> {
    const { edgeRuntime } = context.plan;
    const stagedEdgeRuntime = context.state.stagedEdgeRuntime;
    if (!edgeRuntime || !stagedEdgeRuntime) return;
    await verifyActivatedSystemdBinary(
        EDGE_RUNTIME_SERVICE_UNIT,
        edgeRuntime.targetPath,
        stagedEdgeRuntime.sha256,
    );
    const enabledState = await readSystemdEnabledState(EDGE_RUNTIME_SERVICE_UNIT);
    if (enabledState !== edgeRuntime.enabledState) {
        throw new Error(`${EDGE_RUNTIME_SERVICE_UNIT} enabled state changed from ${edgeRuntime.enabledState} to ${enabledState}`);
    }
}

async function verifyUpgradeActivation(context: UpgradeExecutionContext): Promise<void> {
    const stagedManagement = context.state.stagedManagement;
    if (!context.state.activatedEdgeRuntimeMode) throw new Error("Edge Runtime mode was not resolved");
    if (!stagedManagement) throw new Error("Upgrade binary was not staged");
    context.spinner.start("Waiting for the SupaCloud health endpoint");
    await waitForUpgradeHealth();
    await verifyActivatedManagementBinary(stagedManagement.sha256);
    await verifyEdgeRuntimeUpgrade(context);
    context.state.committed = true;
}

async function rollbackUpgradeActivation(context: UpgradeExecutionContext): Promise<void> {
    const activation = context.state.activation;
    if (!activation) return;
    p.log.warn("Upgrade activation failed; restoring the previous binary and Web Console target.");
    await rollbackArtifacts(activation, context.state.stagedWebConsole);
    context.state.rollbackSucceeded = true;
}

function stagedArtifactCleanupActions(state: UpgradeExecutionState): UpgradeCleanupAction[] {
    const actions: UpgradeCleanupAction[] = [];
    const management = state.stagedManagement;
    if (management) actions.push({
        description: `remove staged Management binary ${management.path}`,
        run: () => rmSync(management.path, { force: true }),
    });
    const edgeRuntime = state.stagedEdgeRuntime;
    if (edgeRuntime) actions.push({
        description: `remove staged Edge Runtime binary ${edgeRuntime.path}`,
        run: () => rmSync(edgeRuntime.path, { force: true }),
    });
    const webConsole = state.stagedWebConsole;
    if (!state.committed && webConsole) actions.push({
        description: `remove staged Web Console ${webConsole.releaseDir}`,
        run: () => rmSync(webConsole.releaseDir, { force: true, recursive: true }),
    });
    return actions;
}

function activatedBackupCleanupActions(state: UpgradeExecutionState): UpgradeCleanupAction[] {
    const activation = state.activation;
    if (!activation) return [];
    const actions: UpgradeCleanupAction[] = [];
    const oldWebBackup = activation.oldWebBackup;
    if (state.committed && oldWebBackup) actions.push({
        description: `remove previous Web Console backup ${oldWebBackup}`,
        run: () => rmSync(oldWebBackup, { force: true, recursive: true }),
    });
    actions.push({
        description: `remove Management backup ${activation.binary.backupPath}`,
        run: () => cleanupBinaryBackup(activation.binary),
    });
    const edgeRuntimeBackup = activation.edgeBinary;
    if (edgeRuntimeBackup) actions.push({
        description: `remove Edge Runtime backup ${edgeRuntimeBackup.backupPath}`,
        run: () => cleanupBinaryBackup(edgeRuntimeBackup),
    });
    return actions;
}

function upgradeCleanupActions(context: UpgradeExecutionContext): UpgradeCleanupAction[] {
    return [
        ...stagedArtifactCleanupActions(context.state),
        ...activatedBackupCleanupActions(context.state),
    ];
}

function executeUpgradeCleanupActions(actions: UpgradeCleanupAction[]): void {
    const failures: Error[] = [];
    for (const action of actions) {
        try {
            action.run();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(new Error(`${action.description}: ${message}`));
        }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Upgrade artifact cleanup did not complete");
}

async function cleanupUpgradeArtifacts(context: UpgradeExecutionContext): Promise<void> {
    const { state } = context;
    const recoveryComplete = shouldCleanupUpgradeArtifacts({
        committed: state.committed,
        rollbackSucceeded: state.rollbackSucceeded,
        activationStarted: Boolean(state.activation),
    });
    if (recoveryComplete) executeUpgradeCleanupActions(upgradeCleanupActions(context));
}

function upgradeTransactionOperations(context: UpgradeExecutionContext): UpgradeTransactionOperations {
    return {
        preflight: () => verifyUpgradePreflight(context),
        stage: () => stageUpgradeArtifacts(context),
        migrate: () => migrateUpgradeMetadata(context),
        activate: () => activateUpgradeArtifacts(context),
        restart: () => applyUpgradeRuntimeSettings(context),
        healthCheck: () => verifyUpgradeActivation(context),
        rollback: () => rollbackUpgradeActivation(context),
        cleanup: () => cleanupUpgradeArtifacts(context),
    };
}

function upgradeRecoveryPaths(context: UpgradeExecutionContext | null): string[] {
    if (!context) return [];
    const { state } = context;
    const candidates = [
        state.activation?.binary.backupReady ? state.activation.binary.backupPath : null,
        state.activation?.edgeBinary?.backupReady ? state.activation.edgeBinary.backupPath : null,
        state.activation?.oldWebBackup,
        state.stagedManagement?.path,
        state.stagedEdgeRuntime?.path,
        state.stagedWebConsole?.releaseDir,
    ];
    return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate && existsSync(candidate))))];
}

function sanitizedUpgradeDiagnostic(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message
        .replace(/(\b(?:[A-Z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL)[A-Z0-9_]*|DATABASE_URL|DB_URI|DSN)=)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1[REDACTED]")
        .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@")
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 500);
}

function nestedUpgradeDiagnostics(error: unknown): string[] {
    if (error instanceof AggregateError) {
        return error.errors.flatMap(candidate => nestedUpgradeDiagnostics(candidate));
    }
    return [sanitizedUpgradeDiagnostic(error)];
}

function upgradeFailureHeading(error: unknown): string {
    if (!(error instanceof UpgradeTransactionError)) return "Upgrade failed";
    if (error.kind === "rollback-incomplete") return "Upgrade failed and rollback is incomplete";
    if (error.kind === "cleanup-incomplete-after-commit") return "Upgrade committed, but cleanup is incomplete";
    return "Upgrade failed and cleanup is incomplete";
}

export function formatUpgradeFailure(error: unknown, recoveryPaths: string[] = []): string {
    const summary = sanitizedUpgradeDiagnostic(error);
    const diagnostics = [...new Set(nestedUpgradeDiagnostics(error))].filter(message => message && message !== summary);
    const lines = [`${upgradeFailureHeading(error)}: ${summary}`];
    if (diagnostics.length > 0) lines.push(`Causes: ${diagnostics.join(" | ")}`);
    if (recoveryPaths.length > 0) lines.push(`Retained recovery paths: ${recoveryPaths.join(", ")}`);
    return lines.join("\n");
}

function upgradeSuccessMessage(context: UpgradeExecutionContext): string {
    const { plan, state } = context;
    const webSummary = state.webConsoleEndpointLabel
        ? ` and ${WEB_CONSOLE_ASSET} (${state.webConsoleEndpointLabel})`
        : "";
    const edgeSummary = plan.edgeRuntime
        ? `; Edge Runtime upgraded to ${plan.edgeRuntime.release.tag_name} at ${plan.edgeRuntime.targetPath} (${state.edgeRuntimeEndpointLabel})`
        : "; Edge Runtime was not upgraded";
    return `SupaCloud upgraded to ${plan.remoteVersion} via ${plan.binaryName} (${state.downloadEndpointLabel})${webSummary}${edgeSummary}`;
}

export async function runUpgrade(options: RunUpgradeOptions = {}) {
    p.intro("\x1b[46m SupaCloud Binary Upgrade \x1b[0m");

    const s = p.spinner();
    s.start(options.assetBundleDir
        ? "Verifying the protected offline release bundle"
        : "Retrieving GitHub release metadata");
    let executionContext: UpgradeExecutionContext | null = null;

    try {
        if (os.userInfo().uid !== 0) {
            throw new Error("Please run the upgrade with root privileges (sudo).");
        }
        const plan = await resolveUpgradeReleasePlan(options);
        s.stop(`Latest binary available: ${plan.remoteVersion} (${plan.binaryName}, via ${plan.endpoint.label})`);
        p.log.warn("Database migrations must be backward compatible. Automatic rollback restores the binary and Web Console target, not committed schema changes.");
        if (!await confirmUpgrade(plan, options.forceYes)) {
            p.cancel("Upgrade cancelled.");
            return;
        }
        executionContext = await createUpgradeExecutionContext(plan, options, s);
        await executeUpgradeTransaction(upgradeTransactionOperations(executionContext));
        p.outro(upgradeSuccessMessage(executionContext));
    } catch (error: unknown) {
        s.stop(formatUpgradeFailure(error, upgradeRecoveryPaths(executionContext)));
        process.exit(1);
    }
}
