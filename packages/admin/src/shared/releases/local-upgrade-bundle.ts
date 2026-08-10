import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import {
    RELEASE_ATTESTATION_NAME,
    RELEASE_BUNDLE_SIZE_LIMITS,
    RELEASE_CHECKSUMS_NAME,
    RELEASE_MANIFEST_NAME,
    RELEASE_REPOSITORY,
    RELEASE_SIGNER_WORKFLOW,
    RELEASE_SOURCE_REF,
    manifestArtifact,
    parseReleaseChecksums,
    parseReleaseManifest,
    releaseAssetSizeLimit,
    releaseTag,
    type ReleaseComponent,
    type ReleaseManifest,
} from "../../../../management-api/src/release-manifest";

export type UpgradeArchitecture = "amd64" | "arm64";

export type LocalUpgradeFile = {
    localPath: string;
    relativePath: string;
    sha256: string;
    size: number;
};

export type PreparedLocalUpgradeBundle = {
    directory: string;
    files: LocalUpgradeFile[];
    verifierArchive: LocalUpgradeFile | null;
    managementBinaryName: string;
    edgeRuntimeBinaryName: string;
};

export type PrepareLocalUpgradeBundleRequest = {
    architecture: UpgradeArchitecture;
    managementVersion: string;
    edgeRuntimeVersion: string;
    verifierProvisioning: "installed" | "bundled";
};

type GithubReleaseAsset = {
    name: string;
    browser_download_url: string;
};

type GithubRelease = {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: GithubReleaseAsset[];
};

type ComponentDownloadRequest = {
    component: ReleaseComponent;
    version: string;
    assetNames: string[];
    destination: string;
};

type HttpsDownloadRequest = {
    url: URL;
    destination: string;
    maxBytes: number;
    redirects: number;
    deadline: number;
};

type LocalBundleLayout = {
    directory: string;
    managementDirectory: string;
    edgeDirectory: string;
    verifierDirectory: string;
    managementBinaryName: string;
    edgeRuntimeBinaryName: string;
};

type LocalBundleDownloadPromises = [
    Promise<LocalUpgradeFile[]>,
    Promise<LocalUpgradeFile[]>,
    Promise<LocalUpgradeFile | null>,
];

type LocalBundleDownloads = [LocalUpgradeFile[], LocalUpgradeFile[], LocalUpgradeFile | null];

const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases`;
const ATTESTATIONS_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/attestations`;
const GH_VERSION = "2.96.0";
const GH_ARCHIVE_SHA256: Record<UpgradeArchitecture, string> = {
    amd64: "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60",
    arm64: "06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909",
};
const MAX_GH_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const GH_CAPABILITY_TIMEOUT_MS = 30_000;
const GH_VERIFICATION_TIMEOUT_MS = 2 * 60_000;
const GH_TERMINATION_GRACE_MS = 2_000;
const MAX_REDIRECTS = 6;
const RETRYABLE_DOWNLOAD_CODES = new Set([
    "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
]);
const OFFICIAL_DOWNLOAD_HOSTS = new Set([
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
]);
export const STRICT_GITHUB_CAPABILITY_FLAGS = [
    "--bundle",
    "--signer-workflow",
    "--source-ref",
    "--source-digest",
    "--deny-self-hosted-runners",
] as const;

class RetryableDownloadError extends Error {}

export type GithubCliArchiveIdentity = {
    archiveName: string;
    member: string;
    sha256: string;
    version: string;
};

export function githubCliArchiveIdentity(architecture: UpgradeArchitecture): GithubCliArchiveIdentity {
    const directory = `gh_${GH_VERSION}_linux_${architecture}`;
    return {
        archiveName: `${directory}.tar.gz`,
        member: `${directory}/bin/gh`,
        sha256: GH_ARCHIVE_SHA256[architecture],
        version: GH_VERSION,
    };
}

function sha256File(filePath: string): string {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertPrivateLocalFileMode(mode: number, label: string): void {
    if (process.platform !== "win32" && (mode & 0o7777) !== 0o600) {
        throw new Error(`${label} must use exact mode 0600 without special permission bits`);
    }
}

function localUpgradeFile(localPath: string, relativePath: string): LocalUpgradeFile {
    const stats = statSync(localPath);
    if (!stats.isFile()) throw new Error(`Local upgrade artifact is not a regular file: ${relativePath}`);
    assertPrivateLocalFileMode(stats.mode, relativePath);
    return { localPath, relativePath, sha256: sha256File(localPath), size: stats.size };
}

function assertExactStableVersion(version: string, field: string): void {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`${field} must be an exact stable semantic version`);
    }
}

function directChildPath(directory: string, name: string): string {
    if (basename(name) !== name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`Unsafe release asset name: ${name}`);
    }
    return join(directory, name);
}

function assertOfficialDownloadUrl(url: URL): void {
    if (url.protocol !== "https:" || url.username || url.password
        || url.port || !OFFICIAL_DOWNLOAD_HOSTS.has(url.hostname)) {
        throw new Error(`Release download URL is not an approved official GitHub endpoint: ${url.hostname}`);
    }
}

function boundedWriter(maxBytes: number): Transform {
    let receivedBytes = 0;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            receivedBytes += chunk.length;
            if (receivedBytes > maxBytes) callback(new Error(`Download exceeded ${maxBytes} bytes`));
            else callback(null, chunk);
        },
    });
}

function responseLocation(currentUrl: URL, location: string | undefined): URL {
    if (!location) throw new Error(`HTTPS redirect from ${currentUrl.hostname} did not include Location`);
    const redirected = new URL(location, currentUrl);
    assertOfficialDownloadUrl(redirected);
    return redirected;
}

function downloadCanRetry(error: unknown): boolean {
    return error instanceof RetryableDownloadError
        || RETRYABLE_DOWNLOAD_CODES.has((error as NodeJS.ErrnoException).code || "");
}

async function consumeDownloadResponse(response: IncomingMessage, download: HttpsDownloadRequest): Promise<void> {
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        await downloadHttpsResponse({
            ...download,
            url: responseLocation(download.url, response.headers.location),
            redirects: download.redirects + 1,
        });
        return;
    }
    if (response.statusCode !== 200) {
        response.resume();
        const message = `HTTPS download returned HTTP ${response.statusCode ?? "unknown"}`;
        if (response.statusCode && response.statusCode >= 500) throw new RetryableDownloadError(message);
        throw new Error(message);
    }
    const contentLength = Number(response.headers["content-length"] || 0);
    if (contentLength > download.maxBytes) {
        response.resume();
        throw new Error(`Download Content-Length exceeded ${download.maxBytes} bytes`);
    }
    response.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => response.destroy(new RetryableDownloadError("Release download stalled")));
    await pipeline(response, boundedWriter(download.maxBytes),
        createWriteStream(download.destination, { flags: "wx", mode: 0o600 }));
}

function requestDownloadResponse(download: HttpsDownloadRequest, remainingTime: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const request = get(download.url, { headers: { "User-Agent": "SupaCloud-Admin" } }, (response) => {
            consumeDownloadResponse(response, download).then(resolve, reject);
        });
        request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new RetryableDownloadError("Release download connection stalled")));
        request.on("error", reject);
        const totalTimer = setTimeout(() => request.destroy(new RetryableDownloadError("Release download timed out")), remainingTime);
        request.on("close", () => clearTimeout(totalTimer));
    });
}

async function downloadHttpsResponse(download: HttpsDownloadRequest): Promise<void> {
    if (download.redirects > MAX_REDIRECTS) throw new Error("Release download exceeded the redirect limit");
    const remainingTime = download.deadline - Date.now();
    if (remainingTime <= 0) throw new Error("Release download timed out");
    await requestDownloadResponse(download, remainingTime);
}

async function downloadDirect(url: string, destination: string, maxBytes: number): Promise<void> {
    const parsed = new URL(url);
    assertOfficialDownloadUrl(parsed);
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    const retryFailures: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        rmSync(destination, { force: true });
        try {
            await downloadHttpsResponse({ url: parsed, destination, maxBytes, redirects: 0, deadline });
            chmodSync(destination, 0o600);
            return;
        } catch (error: unknown) {
            if (!downloadCanRetry(error)) throw error;
            retryFailures.push(error);
        }
    }
    throw new AggregateError(retryFailures, `Unable to download ${parsed.hostname}${parsed.pathname}`);
}

function parseJsonFile(filePath: string, label: string): unknown {
    const contents = readFileSync(filePath, "utf8");
    try {
        return JSON.parse(contents);
    } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error(`${label} is not valid JSON`);
    }
}

export function parseGithubReleaseMetadata(candidate: unknown, expectedTag: string): GithubRelease {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("GitHub release metadata must be an object");
    }
    const release = candidate as Record<string, unknown>;
    if (release.tag_name !== expectedTag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
        throw new Error(`GitHub release metadata does not describe stable release ${expectedTag}`);
    }
    const assets = release.assets.map((asset) => githubReleaseAsset(asset, expectedTag));
    if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
        throw new Error(`GitHub release ${expectedTag} contains duplicate asset names`);
    }
    return { tag_name: expectedTag, draft: false, prerelease: false, assets };
}

function githubReleaseAsset(candidate: unknown, expectedTag: string): GithubReleaseAsset {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("GitHub release asset metadata must be an object");
    }
    const asset = candidate as Record<string, unknown>;
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
        throw new Error("GitHub release asset metadata is incomplete");
    }
    const downloadUrl = new URL(asset.browser_download_url);
    assertOfficialDownloadUrl(downloadUrl);
    const expectedPath = `/${RELEASE_REPOSITORY}/releases/download/${expectedTag}/${asset.name}`;
    if (!/^[A-Za-z0-9._-]+$/.test(asset.name) || downloadUrl.hostname !== "github.com"
        || downloadUrl.pathname !== expectedPath
        || downloadUrl.search || downloadUrl.hash) {
        throw new Error(`Release asset ${asset.name} does not use its official GitHub release path`);
    }
    return { name: asset.name, browser_download_url: downloadUrl.toString() };
}

function releaseAssetUrl(release: GithubRelease, name: string): string {
    const matching = release.assets.find((asset) => asset.name === name);
    if (!matching) throw new Error(`Release ${release.tag_name} does not contain ${name}`);
    return matching.browser_download_url;
}

export function serializeAttestationBundles(candidate: unknown): string {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("GitHub attestation response must be an object");
    }
    const attestations = (candidate as Record<string, unknown>).attestations;
    if (!Array.isArray(attestations) || attestations.length === 0) {
        throw new Error("GitHub attestation response did not contain attestations");
    }
    const bundles = attestations.map((attestation) => {
        if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
            throw new Error("GitHub attestation entry is invalid");
        }
        const bundle = (attestation as Record<string, unknown>).bundle;
        if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
            throw new Error("GitHub attestation entry did not contain a bundle");
        }
        return JSON.stringify(bundle);
    });
    return `${bundles.join("\n")}\n`;
}

function directEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
        if (/(?:^|_)proxy$/i.test(key)
            || /^(?:SUPACLOUD_GITHUB_PROXIES|NODE_USE_ENV_PROXY)$/.test(key)) {
            delete environment[key];
        }
    }
    return environment;
}

function githubCliExecutable(environment: NodeJS.ProcessEnv): string {
    for (const directory of (environment.PATH || "").split(delimiter).filter(Boolean)) {
        const candidate = join(directory, "gh");
        try {
            accessSync(candidate, fsConstants.X_OK);
            const stats = statSync(candidate);
            if (stats.isFile()) {
                if (process.platform !== "win32" && (stats.mode & 0o7777) > 0o777) {
                    throw new Error(`GitHub CLI executable has special permission bits: ${candidate}`);
                }
                return candidate;
            }
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT"
                && (error as NodeJS.ErrnoException).code !== "EACCES"
                && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
        }
    }
    throw new Error("GitHub CLI executable was not found in PATH");
}

type GithubCliResult = { exitCode: number; stdout: string; stderr: string };

export async function runGithubCli(arguments_: string[], timeoutMs: number): Promise<GithubCliResult> {
    return await new Promise<GithubCliResult>((resolve, reject) => {
        const environment = directEnvironment();
        const child = spawn(githubCliExecutable(environment), arguments_, {
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forceKillTimer = setTimeout(() => child.kill("SIGKILL"), GH_TERMINATION_GRACE_MS);
        }, timeoutMs);
        const settleExecution = (error: Error | undefined, exitCode: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            if (error) reject(error);
            else resolve({ exitCode: timedOut ? 124 : exitCode, stdout, stderr });
        };
        child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-8_000); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8_000); });
        child.once("error", (error) => settleExecution(error, 127));
        child.once("close", (code) => settleExecution(undefined, code ?? 1));
    });
}

function supportsStrictGithubVerification(execution: GithubCliResult): boolean {
    const tokens = `${execution.stdout}\n${execution.stderr}`.split(/\s+/);
    return execution.exitCode === 0 && STRICT_GITHUB_CAPABILITY_FLAGS.every((flag) => (
        tokens.some((token) => token === flag || token.startsWith(`${flag}=`))
    ));
}

export async function assertLocalGithubVerifier(): Promise<void> {
    const help = await runGithubCli(["attestation", "verify", "--help"], GH_CAPABILITY_TIMEOUT_MS);
    if (!supportsStrictGithubVerification(help)) {
        throw new Error("Local artifact transport requires a current gh attestation verifier");
    }
}

async function verifyManifestAttestation(manifestPath: string, bundlePath: string, manifest: ReleaseManifest): Promise<void> {
    const verification = await runGithubCli([
        "attestation", "verify", manifestPath,
        "--bundle", bundlePath,
        "--repo", RELEASE_REPOSITORY,
        "--signer-workflow", RELEASE_SIGNER_WORKFLOW,
        "--source-ref", RELEASE_SOURCE_REF,
        "--source-digest", manifest.source.commit,
        "--deny-self-hosted-runners",
    ], GH_VERIFICATION_TIMEOUT_MS);
    if (verification.exitCode !== 0) {
        throw new Error(`gh attestation verify failed: ${verification.stderr.trim().slice(-1_000) || verification.exitCode}`);
    }
}

export function assertSignedArtifact(filePath: string, manifest: ReleaseManifest): string {
    const artifact = manifestArtifact(manifest, basename(filePath));
    const fileStats = statSync(filePath);
    if (!fileStats.isFile() || fileStats.size !== artifact.size) {
        throw new Error(`${artifact.name} does not match the signed release size`);
    }
    assertPrivateLocalFileMode(fileStats.mode, artifact.name);
    const digest = sha256File(filePath);
    if (digest !== artifact.sha256) {
        throw new Error(`${artifact.name} does not match the signed release hashes`);
    }
    return digest;
}

function verifyDownloadedFile(filePath: string, manifest: ReleaseManifest, checksums: Map<string, string>): void {
    const digest = assertSignedArtifact(filePath, manifest);
    if (checksums.get(basename(filePath)) !== digest) {
        throw new Error(`${basename(filePath)} does not match SHA256SUMS`);
    }
}

async function downloadReleaseMetadata(component: ReleaseComponent, version: string, directory: string): Promise<GithubRelease> {
    const expectedTag = releaseTag(component, version);
    const metadataPath = join(directory, `.release-${randomUUID()}.json`);
    try {
        await downloadDirect(`${RELEASES_API}/tags/${expectedTag}`, metadataPath, RELEASE_BUNDLE_SIZE_LIMITS.manifest);
        return parseGithubReleaseMetadata(parseJsonFile(metadataPath, "GitHub release metadata"), expectedTag);
    } finally {
        rmSync(metadataPath, { force: true });
    }
}

async function downloadManifestAttestation(manifestPath: string, destination: string): Promise<void> {
    const responsePath = `${destination}.response`;
    try {
        await downloadDirect(
            `${ATTESTATIONS_API}/sha256:${sha256File(manifestPath)}`,
            responsePath,
            RELEASE_BUNDLE_SIZE_LIMITS.attestation,
        );
        const bundles = serializeAttestationBundles(parseJsonFile(responsePath, "GitHub attestation response"));
        writeFileSync(destination, bundles, { mode: 0o600, flag: "wx" });
        chmodSync(destination, 0o600);
    } finally {
        rmSync(responsePath, { force: true });
    }
}

async function downloadComponent(request: ComponentDownloadRequest): Promise<LocalUpgradeFile[]> {
    const release = await downloadReleaseMetadata(request.component, request.version, request.destination);
    const manifestPath = directChildPath(request.destination, RELEASE_MANIFEST_NAME);
    const attestationPath = directChildPath(request.destination, RELEASE_ATTESTATION_NAME);
    await downloadDirect(
        releaseAssetUrl(release, RELEASE_MANIFEST_NAME), manifestPath, RELEASE_BUNDLE_SIZE_LIMITS.manifest,
    );
    const manifest = parseReleaseManifest(readFileSync(manifestPath, "utf8"), request);
    await downloadManifestAttestation(manifestPath, attestationPath);
    await verifyManifestAttestation(manifestPath, attestationPath, manifest);

    const checksumsPath = directChildPath(request.destination, RELEASE_CHECKSUMS_NAME);
    await downloadDirect(
        releaseAssetUrl(release, RELEASE_CHECKSUMS_NAME), checksumsPath, RELEASE_BUNDLE_SIZE_LIMITS.checksums,
    );
    assertSignedArtifact(checksumsPath, manifest);
    const checksums = parseReleaseChecksums(readFileSync(checksumsPath, "utf8"), manifest);
    for (const assetName of request.assetNames) {
        const assetPath = directChildPath(request.destination, assetName);
        await downloadDirect(
            releaseAssetUrl(release, assetName), assetPath, releaseAssetSizeLimit(request.component, assetName),
        );
        verifyDownloadedFile(assetPath, manifest, checksums);
    }
    return [RELEASE_MANIFEST_NAME, RELEASE_ATTESTATION_NAME, RELEASE_CHECKSUMS_NAME, ...request.assetNames]
        .map((name) => localUpgradeFile(
            directChildPath(request.destination, name), `bundle/${request.component}/${name}`,
        ));
}

async function downloadPinnedGithubCli(directory: string, architecture: UpgradeArchitecture): Promise<LocalUpgradeFile> {
    const identity = githubCliArchiveIdentity(architecture);
    const archivePath = directChildPath(directory, identity.archiveName);
    const url = `https://github.com/cli/cli/releases/download/v${identity.version}/${identity.archiveName}`;
    await downloadDirect(url, archivePath, MAX_GH_ARCHIVE_BYTES);
    if (sha256File(archivePath) !== identity.sha256) {
        throw new Error("Pinned GitHub CLI archive SHA256 mismatch");
    }
    return localUpgradeFile(archivePath, `verifier/${identity.archiveName}`);
}

export function cleanupLocalUpgradeBundle(bundle: PreparedLocalUpgradeBundle): void {
    rmSync(bundle.directory, { recursive: true, force: true });
}

export function assertLocalUpgradeBundleSize(files: readonly LocalUpgradeFile[]): void {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > RELEASE_BUNDLE_SIZE_LIMITS.total) {
        throw new Error("Local upgrade bundle exceeds its total size limit");
    }
}

async function observeDownloadFailure<T>(download: Promise<T>, failures: unknown[]): Promise<T> {
    try {
        return await download;
    } catch (error: unknown) {
        failures.push(error);
        throw error;
    }
}

function fulfilledDownload<T>(settlement: PromiseSettledResult<T>): T {
    if (settlement.status === "rejected") throw settlement.reason;
    return settlement.value;
}

export async function settleLocalBundleDownloads(downloads: LocalBundleDownloadPromises): Promise<LocalBundleDownloads> {
    const failures: unknown[] = [];
    const settlements = await Promise.allSettled([
        observeDownloadFailure(downloads[0], failures),
        observeDownloadFailure(downloads[1], failures),
        observeDownloadFailure(downloads[2], failures),
    ]);
    if (failures.length > 0) throw failures[0];
    return [
        fulfilledDownload(settlements[0]),
        fulfilledDownload(settlements[1]),
        fulfilledDownload(settlements[2]),
    ];
}

function createLocalBundleLayout(request: PrepareLocalUpgradeBundleRequest): LocalBundleLayout {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-admin-upgrade-"));
    chmodSync(directory, 0o700);
    const bundleDirectory = join(directory, "bundle");
    const managementDirectory = join(bundleDirectory, "management-api");
    const edgeDirectory = join(bundleDirectory, "edge-runtime");
    const verifierDirectory = join(directory, "verifier");
    for (const createdDirectory of [bundleDirectory, managementDirectory, edgeDirectory, verifierDirectory]) {
        mkdirSync(createdDirectory, { recursive: true, mode: 0o700 });
        chmodSync(createdDirectory, 0o700);
    }
    return {
        directory, managementDirectory, edgeDirectory, verifierDirectory,
        managementBinaryName: `supacloud-linux-${request.architecture}`,
        edgeRuntimeBinaryName: `supacloud-edge-runtime-linux-${request.architecture}`,
    };
}

async function downloadLocalBundle(request: PrepareLocalUpgradeBundleRequest, layout: LocalBundleLayout): Promise<PreparedLocalUpgradeBundle> {
    const { managementBinaryName, edgeRuntimeBinaryName } = layout;
    const [managementFiles, edgeFiles, verifierArchive] = await settleLocalBundleDownloads([
        downloadComponent({
            component: "management-api", version: request.managementVersion,
            assetNames: [managementBinaryName, "web-console-build.tar.gz"], destination: layout.managementDirectory,
        }),
        downloadComponent({
            component: "edge-runtime", version: request.edgeRuntimeVersion,
            assetNames: [edgeRuntimeBinaryName], destination: layout.edgeDirectory,
        }),
        request.verifierProvisioning === "bundled"
            ? downloadPinnedGithubCli(layout.verifierDirectory, request.architecture)
            : Promise.resolve(null),
    ]);
    const files = [...managementFiles, ...edgeFiles];
    assertLocalUpgradeBundleSize([...files, ...(verifierArchive ? [verifierArchive] : [])]);
    return { directory: layout.directory, files, verifierArchive, managementBinaryName, edgeRuntimeBinaryName };
}

export async function prepareLocalUpgradeBundle(request: PrepareLocalUpgradeBundleRequest): Promise<PreparedLocalUpgradeBundle> {
    assertExactStableVersion(request.managementVersion, "version");
    assertExactStableVersion(request.edgeRuntimeVersion, "edge_runtime_version");
    await assertLocalGithubVerifier();
    const layout = createLocalBundleLayout(request);
    try {
        return await downloadLocalBundle(request, layout);
    } catch (error: unknown) {
        rmSync(layout.directory, { recursive: true, force: true });
        throw error;
    }
}
