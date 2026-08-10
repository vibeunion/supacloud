import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import {
  RELEASE_ATTESTATION_NAME,
  RELEASE_BUNDLE_SIZE_LIMITS,
  RELEASE_CHECKSUMS_NAME,
  RELEASE_MANIFEST_NAME,
  RELEASE_REPOSITORY,
  RELEASE_SIGNER_WORKFLOW,
  RELEASE_SOURCE_REF,
  type ReleaseComponent,
  type ReleaseManifest,
  manifestArtifact,
  parseReleaseChecksums,
  parseReleaseManifest,
  releaseAssetSizeLimit,
} from "./release-manifest";
import { withSigstoreVerificationDirectory } from "./sigstore-trusted-root";

const GH_CAPABILITY_TIMEOUT_MS = 10_000;
// Released binaries can take more than a minute to hash on production storage.
const GH_VERIFICATION_TIMEOUT_MS = 2 * 60_000;

type BundleOwner = {
  uid: number;
  gid: number;
};

export type OfflineReleaseBundle = {
  directory: string;
  manifest: ReleaseManifest;
  checksums: string;
  assetPaths: Map<string, string>;
};

export type OfflineUpgradeBundle = {
  management: OfflineReleaseBundle;
  edgeRuntime: OfflineReleaseBundle | null;
};

export type OfflineUpgradeBundleRequest = {
  assetBundleDir: string;
  management: { version: string; binaryName: string };
  edgeRuntime?: { version: string; binaryName: string };
};

type OfflineReleaseRequest = {
  bundleRoot: string;
  component: ReleaseComponent;
  version: string;
  binaryName: string;
  owner: BundleOwner;
};

type PreparedOfflineRelease = {
  component: ReleaseComponent;
  version: string;
  directory: string;
  manifestText: string;
  sourceCommit: string;
  selectedAssetNames: string[];
  assetPaths: Map<string, string>;
};

type GithubCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function effectiveBundleOwner(): BundleOwner {
  const uid = process.geteuid?.() ?? process.getuid?.();
  const gid = process.getegid?.() ?? process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Offline upgrade bundles require POSIX effective ownership checks");
  }
  return { uid, gid };
}

function exactEntries(directory: string, expectedEntries: string[], label: string): void {
  const actualEntries = readdirSync(directory).sort();
  const expected = [...expectedEntries].sort();
  if (actualEntries.length !== expected.length
    || actualEntries.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} does not match the strict bundle allowlist`);
  }
}

function assertOwner(stats: Stats, owner: BundleOwner, label: string): void {
  if (stats.uid !== owner.uid || stats.gid !== owner.gid) {
    throw new Error(`${label} must be owned by uid ${owner.uid} and gid ${owner.gid}`);
  }
}

export function assertExactBundleMode(
  mode: number,
  expectedMode: 0o600 | 0o700,
  label: string,
): void {
  if ((mode & 0o7777) !== expectedMode) {
    throw new Error(`${label} mode must be exactly 0${expectedMode.toString(8)}`);
  }
}

function assertSecureDirectory(directory: string, owner: BundleOwner, label: string): void {
  const resolved = path.resolve(directory);
  const stats = lstatSync(resolved);
  if (!path.isAbsolute(directory) || !stats.isDirectory() || stats.isSymbolicLink()
    || realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be a canonical directory without symlinks`);
  }
  assertOwner(stats, owner, label);
  assertExactBundleMode(stats.mode, 0o700, label);
}

function assertSecureFile(filePath: string, owner: BundleOwner, label: string): Stats {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
    || realpathSync(filePath) !== filePath) {
    throw new Error(`${label} must be a direct regular file without links`);
  }
  assertOwner(stats, owner, label);
  assertExactBundleMode(stats.mode, 0o600, label);
  return stats;
}

function readBoundedFile(filePath: string, limit: number, label: string): string {
  const size = lstatSync(filePath).size;
  if (size <= 0 || size > limit) throw new Error(`${label} exceeds its size limit`);
  return readFileSync(filePath, "utf8");
}

function assertBoundedFile(filePath: string, limit: number, label: string): void {
  const size = lstatSync(filePath).size;
  if (size <= 0 || size > limit) throw new Error(`${label} exceeds its size limit`);
}

function sourceCommitFromUntrustedManifest(text: string): string {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new Error("Release manifest is not valid JSON");
  }
  const commit = (candidate as { source?: { commit?: unknown } } | null)?.source?.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Release manifest source commit is invalid");
  }
  return commit;
}

export async function runGithubCliWithTimeout(
  githubArguments: string[],
  timeoutMs: number,
): Promise<GithubCliResult> {
  const executable = Bun.which("gh", { PATH: process.env.PATH });
  if (!executable) return { exitCode: 127, stdout: "", stderr: "gh not found" };
  const child = Bun.spawn([executable, ...githubArguments], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return timedOut
      ? { exitCode: 124, stdout, stderr: `gh command timed out after ${timeoutMs}ms` }
      : { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function supportsStrictOfflineVerification(capabilityResult: GithubCliResult): boolean {
  const helpTokens = `${capabilityResult.stdout}\n${capabilityResult.stderr}`.split(/\s+/);
  const requiredFlags = [
    "--bundle",
    "--custom-trusted-root",
    "--signer-workflow",
    "--source-ref",
    "--source-digest",
    "--deny-self-hosted-runners",
  ];
  return capabilityResult.exitCode === 0 && requiredFlags.every((flag) => (
    helpTokens.some((token) => token === flag || token.startsWith(`${flag}=`))
  ));
}

async function assertStrictOfflineVerifier(): Promise<void> {
  const capability = await runGithubCliWithTimeout(
    ["attestation", "verify", "--help"], GH_CAPABILITY_TIMEOUT_MS,
  );
  if (!supportsStrictOfflineVerification(capability)) {
    throw new Error("Offline release bundle verification requires a current gh attestation verifier");
  }
}

async function verifyOfflineAttestation(
  prepared: PreparedOfflineRelease,
  artifactPath: string,
  trustedRootPath: string,
): Promise<void> {
  const attestationPath = requiredPath(prepared.assetPaths, RELEASE_ATTESTATION_NAME);
  const verification = await runGithubCliWithTimeout([
    "attestation", "verify", artifactPath,
    "--bundle", attestationPath,
    "--custom-trusted-root", trustedRootPath,
    "--repo", RELEASE_REPOSITORY,
    "--signer-workflow", RELEASE_SIGNER_WORKFLOW,
    "--source-ref", RELEASE_SOURCE_REF,
    "--source-digest", prepared.sourceCommit,
    "--deny-self-hosted-runners",
  ], GH_VERIFICATION_TIMEOUT_MS);
  if (verification.exitCode !== 0) {
    throw new Error(`Offline GitHub artifact attestation verification failed: ${verification.stderr.slice(-500)}`);
  }
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertManifestArtifact(filePath: string, manifest: ReleaseManifest, name: string): void {
  const expected = manifestArtifact(manifest, name);
  const stats = lstatSync(filePath);
  if (stats.size !== expected.size || sha256File(filePath) !== expected.sha256) {
    throw new Error(`${name} does not match the signed release manifest`);
  }
}

function selectedAssetNames(component: ReleaseComponent, binaryName: string): string[] {
  return component === "management-api"
    ? [binaryName, "web-console-build.tar.gz"]
    : [binaryName];
}

function componentFileNames(selectedNames: string[]): string[] {
  return [RELEASE_MANIFEST_NAME, RELEASE_ATTESTATION_NAME, RELEASE_CHECKSUMS_NAME, ...selectedNames];
}

function secureComponentPaths(request: OfflineReleaseRequest, selectedNames: string[]): Map<string, string> {
  const directory = path.join(request.bundleRoot, request.component);
  const fileNames = componentFileNames(selectedNames);
  assertSecureDirectory(directory, request.owner, `${request.component} bundle directory`);
  exactEntries(directory, fileNames, `${request.component} bundle directory`);
  return new Map(fileNames.map((name) => {
    const filePath = path.join(directory, name);
    assertSecureFile(filePath, request.owner, `${request.component} bundle file ${name}`);
    return [name, filePath];
  }));
}

function requiredPath(assetPaths: Map<string, string>, name: string): string {
  const filePath = assetPaths.get(name);
  if (!filePath) throw new Error(`Offline release bundle does not contain ${name}`);
  return filePath;
}

function assertReleaseFileSizes(
  component: ReleaseComponent,
  assetPaths: Map<string, string>,
  selectedNames: string[],
): void {
  const fixedLimits = [
    [RELEASE_ATTESTATION_NAME, RELEASE_BUNDLE_SIZE_LIMITS.attestation],
    [RELEASE_CHECKSUMS_NAME, RELEASE_BUNDLE_SIZE_LIMITS.checksums],
  ] as const;
  for (const [name, limit] of fixedLimits) {
    assertBoundedFile(requiredPath(assetPaths, name), limit, name);
  }
  for (const name of selectedNames) {
    assertBoundedFile(requiredPath(assetPaths, name), releaseAssetSizeLimit(component, name), name);
  }
}

function prepareOfflineRelease(request: OfflineReleaseRequest): PreparedOfflineRelease {
  const selectedNames = selectedAssetNames(request.component, request.binaryName);
  const assetPaths = secureComponentPaths(request, selectedNames);
  const manifestPath = requiredPath(assetPaths, RELEASE_MANIFEST_NAME);
  const manifestText = readBoundedFile(
    manifestPath, RELEASE_BUNDLE_SIZE_LIMITS.manifest, RELEASE_MANIFEST_NAME,
  );
  assertReleaseFileSizes(request.component, assetPaths, selectedNames);
  return {
    component: request.component,
    version: request.version,
    directory: path.join(request.bundleRoot, request.component),
    manifestText,
    sourceCommit: sourceCommitFromUntrustedManifest(manifestText),
    selectedAssetNames: selectedNames,
    assetPaths,
  };
}

function assertTotalBundleSize(preparedReleases: PreparedOfflineRelease[]): void {
  const paths = new Set(preparedReleases.flatMap((prepared) => [...prepared.assetPaths.values()]));
  const totalSize = [...paths].reduce((sum, filePath) => sum + lstatSync(filePath).size, 0);
  if (!Number.isSafeInteger(totalSize) || totalSize > RELEASE_BUNDLE_SIZE_LIMITS.total) {
    throw new Error("Offline upgrade bundle exceeds its total size limit");
  }
}

async function verifiedChecksums(
  prepared: PreparedOfflineRelease,
  manifest: ReleaseManifest,
  trustedRootPath: string,
): Promise<{ text: string; byName: Map<string, string> }> {
  const checksumsPath = requiredPath(prepared.assetPaths, RELEASE_CHECKSUMS_NAME);
  assertManifestArtifact(checksumsPath, manifest, RELEASE_CHECKSUMS_NAME);
  await verifyOfflineAttestation(prepared, checksumsPath, trustedRootPath);
  const text = readFileSync(checksumsPath, "utf8");
  return { text, byName: parseReleaseChecksums(text, manifest) };
}

async function verifySelectedAssets(
  prepared: PreparedOfflineRelease,
  manifest: ReleaseManifest,
  checksums: Map<string, string>,
  trustedRootPath: string,
): Promise<void> {
  for (const name of prepared.selectedAssetNames) {
    const assetPath = requiredPath(prepared.assetPaths, name);
    assertManifestArtifact(assetPath, manifest, name);
    if (checksums.get(name) !== manifestArtifact(manifest, name).sha256) {
      throw new Error(`${name} does not match SHA256SUMS`);
    }
    await verifyOfflineAttestation(prepared, assetPath, trustedRootPath);
  }
}

async function loadOfflineRelease(
  prepared: PreparedOfflineRelease,
  trustedRootPath: string,
): Promise<OfflineReleaseBundle> {
  const manifestPath = requiredPath(prepared.assetPaths, RELEASE_MANIFEST_NAME);
  await verifyOfflineAttestation(prepared, manifestPath, trustedRootPath);
  const manifest = parseReleaseManifest(prepared.manifestText, {
    component: prepared.component,
    version: prepared.version,
  });
  const checksums = await verifiedChecksums(prepared, manifest, trustedRootPath);
  await verifySelectedAssets(prepared, manifest, checksums.byName, trustedRootPath);
  return {
    directory: prepared.directory,
    manifest,
    checksums: checksums.text,
    assetPaths: prepared.assetPaths,
  };
}

function prepareUpgradeReleases(
  request: OfflineUpgradeBundleRequest,
  owner: BundleOwner,
): { management: PreparedOfflineRelease; edgeRuntime: PreparedOfflineRelease | null } {
  const management = prepareOfflineRelease({
    bundleRoot: request.assetBundleDir,
    component: "management-api",
    ...request.management,
    owner,
  });
  const edgeRuntime = request.edgeRuntime ? prepareOfflineRelease({
    bundleRoot: request.assetBundleDir,
    component: "edge-runtime",
    ...request.edgeRuntime,
    owner,
  }) : null;
  return { management, edgeRuntime };
}

export async function loadOfflineUpgradeBundle(request: OfflineUpgradeBundleRequest): Promise<OfflineUpgradeBundle> {
  const owner = effectiveBundleOwner();
  assertSecureDirectory(request.assetBundleDir, owner, "Offline upgrade bundle directory");
  exactEntries(
    request.assetBundleDir,
    request.edgeRuntime ? ["management-api", "edge-runtime"] : ["management-api"],
    "Offline upgrade bundle directory",
  );
  const prepared = prepareUpgradeReleases(request, owner);
  assertTotalBundleSize([prepared.management, ...(prepared.edgeRuntime ? [prepared.edgeRuntime] : [])]);
  await assertStrictOfflineVerifier();
  return withSigstoreVerificationDirectory(async ({ trustedRootPath }) => {
    const management = await loadOfflineRelease(prepared.management, trustedRootPath);
    const edgeRuntime = prepared.edgeRuntime
      ? await loadOfflineRelease(prepared.edgeRuntime, trustedRootPath)
      : null;
    return { management, edgeRuntime };
  });
}
