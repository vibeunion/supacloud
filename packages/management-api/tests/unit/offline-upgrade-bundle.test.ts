import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExactBundleMode,
  loadOfflineUpgradeBundle,
  runGithubCliWithTimeout,
} from "../../src/offline-upgrade-bundle";
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
  releaseAssetNames,
  releaseTag,
} from "../../src/release-manifest";

const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;
const fixtureRoots: string[] = [];
const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const managementVersion = "9.8.7";
const edgeVersion = "1.2.3";
const managementBinary = "supacloud-linux-amd64";
const edgeBinary = "supacloud-edge-runtime-linux-amd64";

type BundleFixture = {
  root: string;
  recordPath: string;
  managementDir: string;
  edgeDir: string;
};

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.GH_OFFLINE_RECORD;
  globalThis.fetch = originalFetch;
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeSecureFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function releaseAssetContent(component: ReleaseComponent, version: string, name: string): string {
  return `${component}:${version}:${name}\n`;
}

function manifestFixture(component: ReleaseComponent, version: string, commit: string): {
  manifest: ReleaseManifest;
  checksums: string;
} {
  const nonChecksumArtifacts = releaseAssetNames(component)
    .filter((name) => name !== RELEASE_CHECKSUMS_NAME)
    .map((name) => {
      const content = releaseAssetContent(component, version, name);
      return { name, sha256: sha256(content), size: Buffer.byteLength(content) };
    });
  const checksums = `${nonChecksumArtifacts.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`;
  const checksumArtifact = {
    name: RELEASE_CHECKSUMS_NAME,
    sha256: sha256(checksums),
    size: Buffer.byteLength(checksums),
  };
  const artifacts = [checksumArtifact, ...nonChecksumArtifacts]
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  return {
    manifest: {
      schemaVersion: 1,
      repository: RELEASE_REPOSITORY,
      source: { ref: RELEASE_SOURCE_REF, commit },
      workflow: RELEASE_SIGNER_WORKFLOW,
      release: { component, version, tag: releaseTag(component, version) },
      artifacts,
    },
    checksums,
  };
}

function writeComponentBundle(
  root: string,
  component: ReleaseComponent,
  version: string,
  binaryName: string,
  commit: string,
): string {
  const directory = join(root, component);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const { manifest, checksums } = manifestFixture(component, version, commit);
  writeSecureFile(join(directory, RELEASE_MANIFEST_NAME), `${JSON.stringify(manifest)}\n`);
  writeSecureFile(join(directory, RELEASE_ATTESTATION_NAME), '{"mediaType":"sigstore"}\n');
  writeSecureFile(join(directory, RELEASE_CHECKSUMS_NAME), checksums);
  writeSecureFile(join(directory, binaryName), releaseAssetContent(component, version, binaryName));
  if (component === "management-api") {
    writeSecureFile(
      join(directory, "web-console-build.tar.gz"),
      releaseAssetContent(component, version, "web-console-build.tar.gz"),
    );
  }
  return directory;
}

function installFakeGithubCli(root: string): string {
  const binDirectory = join(root, "bin");
  mkdirSync(binDirectory, { mode: 0o700 });
  const executable = join(binDirectory, "gh");
  writeFileSync(executable, [
    "#!/bin/sh",
    'if [ "$1 $2 $3" = "attestation verify --help" ]; then',
    '  printf "%s\\n" "--bundle --signer-workflow --source-ref --source-digest --deny-self-hosted-runners"',
    "  exit 0",
    "fi",
    'printf "%s\\n" "$*" >> "$GH_OFFLINE_RECORD"',
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(executable, 0o755);
  process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;
  return join(root, "gh-calls.txt");
}

function bundleFixture(): BundleFixture {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-offline-bundle-")));
  fixtureRoots.push(fixtureRoot);
  const root = join(fixtureRoot, "bundle");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const commit = "a".repeat(40);
  const managementDir = writeComponentBundle(root, "management-api", managementVersion, managementBinary, commit);
  const edgeDir = writeComponentBundle(root, "edge-runtime", edgeVersion, edgeBinary, commit);
  const recordPath = installFakeGithubCli(fixtureRoot);
  process.env.GH_OFFLINE_RECORD = recordPath;
  return { root, recordPath, managementDir, edgeDir };
}

function loadFixture(fixture: BundleFixture) {
  return loadOfflineUpgradeBundle({
    assetBundleDir: fixture.root,
    management: { version: managementVersion, binaryName: managementBinary },
    edgeRuntime: { version: edgeVersion, binaryName: edgeBinary },
  });
}

describe("offline upgrade bundle", () => {
  test("verifies the exact local bundle without calling fetch", async () => {
    const fixture = bundleFixture();
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("offline bundle must not call fetch");
    }) as typeof fetch;
    const bundle = await loadFixture(fixture);
    expect(fetchCalls).toBe(0);
    expect(bundle.management.manifest.release.version).toBe(managementVersion);
    expect(bundle.edgeRuntime?.manifest.release.version).toBe(edgeVersion);
    const calls = readFileSync(fixture.recordPath, "utf8").trim().split("\n");
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call).toContain("--bundle");
      expect(call).toContain("--repo zuohuadong/supacloud");
      expect(call).toContain("--source-ref refs/heads/main");
      expect(call).toContain(`--source-digest ${"a".repeat(40)}`);
      expect(call).toContain("--deny-self-hosted-runners");
    }
  });

  test("allows two minutes for each bounded offline attestation verification", async () => {
    const fixture = bundleFixture();
    const timeout = spyOn(globalThis, "setTimeout");
    try {
      await loadFixture(fixture);
      expect(timeout.mock.calls.filter((call) => call[1] === 2 * 60_000)).toHaveLength(7);
    } finally {
      timeout.mockRestore();
    }
  });

  test("rejects extra files, unsafe modes, symlinks, hardlinks, and wrong ownership", async () => {
    const extra = bundleFixture();
    writeSecureFile(join(extra.root, "unexpected"), "unexpected");
    await expect(loadFixture(extra)).rejects.toThrow("allowlist");

    const unsafeMode = bundleFixture();
    chmodSync(join(unsafeMode.managementDir, managementBinary), 0o644);
    await expect(loadFixture(unsafeMode)).rejects.toThrow("mode must be exactly 0600");

    const unsafeDirectoryMode = bundleFixture();
    chmodSync(unsafeDirectoryMode.edgeDir, 0o755);
    await expect(loadFixture(unsafeDirectoryMode)).rejects.toThrow("mode must be exactly 0700");

    const symlink = bundleFixture();
    const web = join(symlink.managementDir, "web-console-build.tar.gz");
    const externalRoot = mkdtempSync(join(tmpdir(), "supacloud-bundle-link-target-"));
    fixtureRoots.push(externalRoot);
    const target = join(externalRoot, "web-target");
    writeSecureFile(target, "target");
    unlinkSync(web);
    symlinkSync(target, web);
    await expect(loadFixture(symlink)).rejects.toThrow("without links");

    const hardlink = bundleFixture();
    const hardlinkRoot = mkdtempSync(join(tmpdir(), "supacloud-bundle-hardlink-"));
    fixtureRoots.push(hardlinkRoot);
    linkSync(join(hardlink.edgeDir, edgeBinary), join(hardlinkRoot, "linked-edge"));
    await expect(loadFixture(hardlink)).rejects.toThrow("without links");

    const wrongOwner = bundleFixture();
    const originalGeteuid = process.geteuid;
    const originalGetegid = process.getegid;
    try {
      Object.defineProperty(process, "geteuid", { configurable: true, value: () => owner.uid + 1 });
      Object.defineProperty(process, "getegid", { configurable: true, value: () => owner.gid });
      await expect(loadOfflineUpgradeBundle({
        assetBundleDir: wrongOwner.root,
        management: { version: managementVersion, binaryName: managementBinary },
      })).rejects.toThrow("must be owned");
    } finally {
      Object.defineProperty(process, "geteuid", { configurable: true, value: originalGeteuid });
      Object.defineProperty(process, "getegid", { configurable: true, value: originalGetegid });
    }
  });

  test("rejects special permission bits independently of filesystem support", () => {
    for (const mode of [0o4600, 0o2600, 0o1600]) {
      expect(() => assertExactBundleMode(mode, 0o600, "Bundle file"))
        .toThrow("mode must be exactly 0600");
    }
    for (const mode of [0o4700, 0o2700, 0o1700]) {
      expect(() => assertExactBundleMode(mode, 0o700, "Bundle directory"))
        .toThrow("mode must be exactly 0700");
    }
    expect(() => assertExactBundleMode(0o100600, 0o600, "Bundle file")).not.toThrow();
    expect(() => assertExactBundleMode(0o040700, 0o700, "Bundle directory")).not.toThrow();
  });

  test("rejects digest and version mixing while allowing separately released components", async () => {
    const digestDrift = bundleFixture();
    writeSecureFile(join(digestDrift.managementDir, managementBinary), "substituted release binary\n");
    await expect(loadFixture(digestDrift)).rejects.toThrow("signed release manifest");

    const versionDrift = bundleFixture();
    await expect(loadOfflineUpgradeBundle({
      assetBundleDir: versionDrift.root,
      management: { version: "9.8.6", binaryName: managementBinary },
      edgeRuntime: { version: edgeVersion, binaryName: edgeBinary },
    })).rejects.toThrow("does not match");

    const mixed = bundleFixture();
    const edgeManifestPath = join(mixed.edgeDir, RELEASE_MANIFEST_NAME);
    const edgeManifest = JSON.parse(readFileSync(edgeManifestPath, "utf8")) as ReleaseManifest;
    edgeManifest.source.commit = "b".repeat(40);
    writeSecureFile(edgeManifestPath, `${JSON.stringify(edgeManifest)}\n`);
    await expect(loadFixture(mixed)).resolves.toMatchObject({
      management: { manifest: { source: { commit: "a".repeat(40) } } },
      edgeRuntime: { manifest: { source: { commit: "b".repeat(40) } } },
    });
  });

  test("rejects oversized Management, Edge, Web, and total bundles before attestation", async () => {
    const management = bundleFixture();
    truncateSync(
      join(management.managementDir, managementBinary),
      RELEASE_BUNDLE_SIZE_LIMITS.managementBinary + 1,
    );
    await expect(loadFixture(management)).rejects.toThrow(`${managementBinary} exceeds its size limit`);
    expect(existsSync(management.recordPath)).toBe(false);

    const edge = bundleFixture();
    truncateSync(join(edge.edgeDir, edgeBinary), RELEASE_BUNDLE_SIZE_LIMITS.edgeRuntimeBinary + 1);
    await expect(loadFixture(edge)).rejects.toThrow(`${edgeBinary} exceeds its size limit`);
    expect(existsSync(edge.recordPath)).toBe(false);

    const web = bundleFixture();
    truncateSync(
      join(web.managementDir, "web-console-build.tar.gz"),
      RELEASE_BUNDLE_SIZE_LIMITS.webConsole + 1,
    );
    await expect(loadFixture(web)).rejects.toThrow("web-console-build.tar.gz exceeds its size limit");
    expect(existsSync(web.recordPath)).toBe(false);

    const total = bundleFixture();
    truncateSync(join(total.managementDir, managementBinary), RELEASE_BUNDLE_SIZE_LIMITS.managementBinary);
    truncateSync(join(total.edgeDir, edgeBinary), RELEASE_BUNDLE_SIZE_LIMITS.edgeRuntimeBinary);
    truncateSync(join(total.managementDir, "web-console-build.tar.gz"), RELEASE_BUNDLE_SIZE_LIMITS.webConsole);
    await expect(loadFixture(total)).rejects.toThrow("total size limit");
    expect(existsSync(total.recordPath)).toBe(false);
  });

  test("terminates a stuck gh verification within its per-command timeout", async () => {
    const fixture = bundleFixture();
    const gh = Bun.which("gh", { PATH: process.env.PATH });
    if (!gh) throw new Error("Missing fake gh fixture");
    writeFileSync(gh, "#!/bin/sh\nexec sleep 10\n");
    chmodSync(gh, 0o755);
    const startedAt = Date.now();
    const githubTimeoutResult = await runGithubCliWithTimeout(["attestation", "verify", "--help"], 50);
    expect(githubTimeoutResult.exitCode).toBe(124);
    expect(githubTimeoutResult.stderr).toContain("timed out after 50ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(existsSync(fixture.recordPath)).toBe(false);
  });
});
