import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RELEASE_CHECKSUMS_NAME,
  RELEASE_MANIFEST_NAME,
  RELEASE_REPOSITORY,
  RELEASE_SIGNER_WORKFLOW,
  RELEASE_SOURCE_REF,
  type ReleaseComponent,
  type ReleaseManifest,
  type ReleaseManifestArtifact,
  parseReleaseChecksums,
  parseReleaseManifest,
  releaseAssetNames,
  releaseTag,
} from "../packages/management-api/src/release-manifest";

type GeneratorOptions = {
  component: ReleaseComponent;
  packageJson: string;
  assetsDir: string;
  tag: string;
  sourceCommit: string;
};

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const candidate = index >= 0 ? process.argv[index + 1] : undefined;
  if (!candidate || candidate.startsWith("--")) throw new Error(`Missing required argument ${name}`);
  return candidate;
}

function generatorOptions(): GeneratorOptions {
  const component = argument("--component");
  if (component !== "management-api" && component !== "edge-runtime") {
    throw new Error("--component must be management-api or edge-runtime");
  }
  return {
    component,
    packageJson: resolve(argument("--package-json")),
    assetsDir: resolve(argument("--assets-dir")),
    tag: argument("--tag"),
    sourceCommit: argument("--source-commit"),
  };
}

function packageVersion(packageJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
    throw new Error("Package version must be an exact stable version");
  }
  return parsed.version;
}

function assertSourceCommit(sourceCommit: string): void {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Source commit must be a lowercase Git SHA");
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd() });
  if (head.exitCode !== 0 || head.stdout.toString().trim() !== sourceCommit) {
    throw new Error("Source commit does not match the checked out release commit");
  }
}

function assertAssetDirectory(options: GeneratorOptions): void {
  const expected = releaseAssetNames(options.component);
  const actual = readdirSync(options.assetsDir).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${options.component} release assets do not match the strict allowlist`);
  }
}

function releaseArtifact(assetsDir: string, name: string): ReleaseManifestArtifact {
  const filePath = resolve(realpathSync(assetsDir), name);
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || realpathSync(filePath) !== filePath) {
    throw new Error(`Release asset is not a direct regular file: ${name}`);
  }
  return {
    name,
    sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    size: stats.size,
  };
}

function releaseManifest(options: GeneratorOptions): ReleaseManifest {
  const version = packageVersion(options.packageJson);
  if (options.tag !== releaseTag(options.component, version)) {
    throw new Error("Release tag does not match the package version");
  }
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    repository: RELEASE_REPOSITORY,
    source: { ref: RELEASE_SOURCE_REF, commit: options.sourceCommit },
    workflow: RELEASE_SIGNER_WORKFLOW,
    release: { component: options.component, version, tag: options.tag },
    artifacts: releaseAssetNames(options.component).map((name) => releaseArtifact(options.assetsDir, name)),
  };
  return parseReleaseManifest(JSON.stringify(manifest), { component: options.component, version });
}

function writeReleaseManifest(options: GeneratorOptions): string {
  assertSourceCommit(options.sourceCommit);
  assertAssetDirectory(options);
  const manifest = releaseManifest(options);
  parseReleaseChecksums(
    readFileSync(resolve(options.assetsDir, RELEASE_CHECKSUMS_NAME), "utf8"),
    manifest,
  );
  const outputPath = resolve(options.assetsDir, RELEASE_MANIFEST_NAME);
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return outputPath;
}

if (import.meta.main) {
  try {
    console.log(writeReleaseManifest(generatorOptions()));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
