import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY,
  RELEASE_REPOSITORY,
  RELEASE_SIGNER_WORKFLOW,
  RELEASE_CHECKSUMS_NAME,
  RELEASE_BUNDLE_SIZE_LIMITS,
  RELEASE_MANIFEST_NAME,
  type ReleaseComponent,
  type ReleaseManifest,
  parseReleaseChecksums,
  parseReleaseManifest,
  releaseAssetNames,
  releaseTag,
} from "../../src/release-manifest";

const repoRoot = join(import.meta.dir, "../../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function releaseFixture(component: ReleaseComponent, version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), `supacloud-${component}-manifest-`));
  temporaryDirectories.push(root);
  const assetsDir = join(root, "assets");
  mkdirSync(assetsDir);
  const checksums: string[] = [];
  for (const name of releaseAssetNames(component)) {
    if (name === RELEASE_CHECKSUMS_NAME) continue;
    const content = `${component}:${version}:${name}\n`;
    writeFileSync(join(assetsDir, name), content);
    checksums.push(`${sha256(content)}  ${name}`);
  }
  writeFileSync(join(assetsDir, RELEASE_CHECKSUMS_NAME), `${checksums.join("\n")}\n`);
  const packageJson = join(root, "package.json");
  writeFileSync(packageJson, JSON.stringify({ version }));
  return { assetsDir, packageJson, version };
}

function sourceCommit(): string {
  const command = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot });
  expect(command.exitCode).toBe(0);
  return command.stdout.toString().trim();
}

function generateManifest(component: ReleaseComponent): ReleaseManifest {
  const fixture = releaseFixture(component);
  const command = Bun.spawnSync([
    "bun", "run", "scripts/generate_release_manifest.ts",
    "--component", component,
    "--package-json", fixture.packageJson,
    "--assets-dir", fixture.assetsDir,
    "--tag", releaseTag(component, fixture.version),
    "--source-commit", sourceCommit(),
  ], { cwd: repoRoot });
  expect(command.exitCode, command.stderr.toString()).toBe(0);
  return parseReleaseManifest(
    readFileSync(join(fixture.assetsDir, RELEASE_MANIFEST_NAME), "utf8"),
    { component, version: fixture.version },
  );
}

describe("signed release manifest", () => {
  test("generates complete strict manifests for both independently released components", () => {
    for (const component of ["management-api", "edge-runtime"] as const) {
      const manifest = generateManifest(component);
      expect(manifest.release.tag).toBe(releaseTag(component, "1.2.3"));
      expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual(releaseAssetNames(component));
      expect(manifest.source.commit).toBe(sourceCommit());
    }
  });

  test("rejects identity drift, extra fields, and reordered release assets", () => {
    const manifest = generateManifest("management-api");
    const expected = { component: "management-api" as const, version: "1.2.3" };
    expect(() => parseReleaseManifest(JSON.stringify({ ...manifest, extra: true }), expected))
      .toThrow("unsupported or missing fields");
    expect(() => parseReleaseManifest(JSON.stringify({ ...manifest, repository: "other/repo" }), expected))
      .toThrow("identity");
    expect(() => parseReleaseManifest(JSON.stringify({
      ...manifest,
      artifacts: [...manifest.artifacts].reverse(),
    }), expected)).toThrow("allowlist");
    const oversized = structuredClone(manifest);
    const web = oversized.artifacts.find((artifact) => artifact.name === "web-console-build.tar.gz");
    if (!web) throw new Error("Missing Web Console fixture");
    web.size = RELEASE_BUNDLE_SIZE_LIMITS.webConsole + 1;
    expect(() => parseReleaseManifest(JSON.stringify(oversized), expected)).toThrow("size limit");
    expect(() => parseReleaseManifest(JSON.stringify(manifest), { ...expected, version: "1.2.4" }))
      .toThrow("does not match");
  });

  test("accepts only the exact pre-transfer Edge Runtime 0.18.2 identity", () => {
    const current = generateManifest("edge-runtime");
    const legacy = {
      ...current,
      repository: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.repository,
      workflow: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.workflow,
      source: {
        ref: current.source.ref,
        commit: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.sourceCommit,
      },
      release: {
        component: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.component,
        version: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.version,
        tag: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.tag,
      },
    };
    const expected = { component: "edge-runtime" as const, version: "0.18.2" };

    expect(parseReleaseManifest(JSON.stringify(legacy), expected)).toMatchObject({
      repository: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.repository,
      workflow: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.workflow,
      source: { commit: LEGACY_EDGE_RUNTIME_RELEASE_IDENTITY.sourceCommit },
      release: expected,
    });
    for (const drift of [
      { ...legacy, repository: RELEASE_REPOSITORY },
      { ...legacy, workflow: RELEASE_SIGNER_WORKFLOW },
      { ...legacy, source: { ...legacy.source, commit: "f".repeat(40) } },
    ]) {
      expect(() => parseReleaseManifest(JSON.stringify(drift), expected)).toThrow("identity");
    }
    expect(() => parseReleaseManifest(JSON.stringify({
      ...legacy,
      release: { component: "edge-runtime", version: "0.18.3", tag: "edge-runtime-v0.18.3" },
    }), { component: "edge-runtime", version: "0.18.3" })).toThrow("identity");
  });

  test("requires SHA256SUMS to agree exactly with the signed manifest", () => {
    const manifest = generateManifest("edge-runtime");
    const valid = manifest.artifacts
      .filter((artifact) => artifact.name !== RELEASE_CHECKSUMS_NAME)
      .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
      .join("\n");
    expect(parseReleaseChecksums(`${valid}\n`, manifest).size).toBe(manifest.artifacts.length - 1);
    expect(() => parseReleaseChecksums(`${"0".repeat(64)}${valid.slice(64)}\n`, manifest))
      .toThrow("disagree");
  });

  test("release workflow publishes a manifest and offline bundle for Management and Edge", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release-please.yml"), "utf8");
    const managementPackage = readFileSync(join(repoRoot, "packages/management-api/package.json"), "utf8");
    const edgePackage = readFileSync(join(repoRoot, "packages/edge-runtime/package.json"), "utf8");
    expect(workflow).toContain("Generate strict Management release manifest");
    expect(workflow).toContain("Generate strict Edge Runtime release manifest");
    expect(workflow.match(/SUPACLOUD-RELEASE\.attestation\.jsonl/g)).toHaveLength(2);
    expect(workflow.match(/id: attest-(?:management|edge-runtime)-release/g)).toHaveLength(2);
    expect(managementPackage).toContain('"release:manifest"');
    expect(edgePackage).toContain('"release:manifest"');
  });

  test("Management CLI exposes the exact offline component contract without probing Edge version", () => {
    const index = readFileSync(join(repoRoot, "packages/management-api/src/index.ts"), "utf8");
    const upgrade = readFileSync(join(repoRoot, "packages/management-api/src/upgrade.ts"), "utf8");
    expect(index).toContain('readArgValue("--edge-runtime-version")');
    expect(index).toContain('readArgValue("--asset-bundle-dir")');
    const edgeStage = upgrade.slice(
      upgrade.indexOf("async function stageEdgeRuntimeUpgrade"),
      upgrade.indexOf("async function stageWebConsoleUpgrade"),
    );
    expect(edgeStage).toContain("validateElfBinaryArtifact");
    expect(edgeStage).not.toContain('"--version"');
  });
});
