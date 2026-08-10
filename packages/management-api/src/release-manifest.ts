export const RELEASE_MANIFEST_NAME = "SUPACLOUD-RELEASE.json";
export const RELEASE_ATTESTATION_NAME = "SUPACLOUD-RELEASE.attestation.jsonl";
export const RELEASE_CHECKSUMS_NAME = "SHA256SUMS";
export const RELEASE_REPOSITORY = "zuohuadong/supacloud";
export const RELEASE_SOURCE_REF = "refs/heads/main";
export const RELEASE_SIGNER_WORKFLOW = `${RELEASE_REPOSITORY}/.github/workflows/release-please.yml`;
const MEBIBYTE = 1024 * 1024;

export const RELEASE_BUNDLE_SIZE_LIMITS = {
  manifest: MEBIBYTE,
  checksums: MEBIBYTE,
  attestation: 32 * MEBIBYTE,
  managementBinary: 160 * MEBIBYTE,
  edgeRuntimeBinary: 160 * MEBIBYTE,
  webConsole: 64 * MEBIBYTE,
  caddy: 96 * MEBIBYTE,
  total: 384 * MEBIBYTE,
} as const;

export type ReleaseComponent = "management-api" | "edge-runtime";

const RELEASE_ASSETS: Record<ReleaseComponent, readonly string[]> = {
  "management-api": [
    "SHA256SUMS",
    "SHA256SUMS.caddy",
    "supacloud-caddy-linux-amd64",
    "supacloud-caddy-linux-arm64",
    "supacloud-linux-amd64",
    "supacloud-linux-arm64",
    "supacloud-macos-amd64",
    "supacloud-macos-arm64",
    "web-console-build.tar.gz",
  ],
  "edge-runtime": [
    "SHA256SUMS",
    "supacloud-edge-runtime-linux-amd64",
    "supacloud-edge-runtime-linux-arm64",
    "supacloud-edge-runtime-macos-amd64",
    "supacloud-edge-runtime-macos-arm64",
  ],
};

export type ReleaseManifestArtifact = {
  name: string;
  sha256: string;
  size: number;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  repository: typeof RELEASE_REPOSITORY;
  source: {
    ref: typeof RELEASE_SOURCE_REF;
    commit: string;
  };
  workflow: typeof RELEASE_SIGNER_WORKFLOW;
  release: {
    component: ReleaseComponent;
    version: string;
    tag: string;
  };
  artifacts: ReleaseManifestArtifact[];
};

export type ExpectedReleaseManifest = {
  component: ReleaseComponent;
  version: string;
};

function manifestObject(candidate: unknown, label: string): Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return candidate as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function exactStableVersion(version: unknown): string {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Release manifest version must be an exact stable version");
  }
  return version;
}

export function releaseTag(component: ReleaseComponent, version: string): string {
  exactStableVersion(version);
  return `${component}-v${version}`;
}

export function releaseAssetNames(component: ReleaseComponent): readonly string[] {
  return RELEASE_ASSETS[component];
}

export function releaseAssetSizeLimit(component: ReleaseComponent, name: string): number {
  if (name === "SHA256SUMS" || name === "SHA256SUMS.caddy") {
    return RELEASE_BUNDLE_SIZE_LIMITS.checksums;
  }
  if (name === "web-console-build.tar.gz") return RELEASE_BUNDLE_SIZE_LIMITS.webConsole;
  if (name.startsWith("supacloud-caddy-")) return RELEASE_BUNDLE_SIZE_LIMITS.caddy;
  return component === "management-api"
    ? RELEASE_BUNDLE_SIZE_LIMITS.managementBinary
    : RELEASE_BUNDLE_SIZE_LIMITS.edgeRuntimeBinary;
}

function parseSource(candidate: unknown): ReleaseManifest["source"] {
  const source = manifestObject(candidate, "Release manifest source");
  assertExactKeys(source, ["ref", "commit"], "Release manifest source");
  if (source.ref !== RELEASE_SOURCE_REF || typeof source.commit !== "string"
    || !/^[0-9a-f]{40}$/.test(source.commit)) {
    throw new Error("Release manifest source is invalid");
  }
  return { ref: RELEASE_SOURCE_REF, commit: source.commit };
}

function parseRelease(candidate: unknown, expected: ExpectedReleaseManifest): ReleaseManifest["release"] {
  const release = manifestObject(candidate, "Release manifest release");
  assertExactKeys(release, ["component", "version", "tag"], "Release manifest release");
  const version = exactStableVersion(release.version);
  if (release.component !== expected.component || version !== expected.version
    || release.tag !== releaseTag(expected.component, expected.version)) {
    throw new Error("Release manifest component, version, or tag does not match the requested release");
  }
  return { component: expected.component, version, tag: release.tag as string };
}

function parseArtifact(candidate: unknown, index: number): ReleaseManifestArtifact {
  const artifact = manifestObject(candidate, `Release manifest artifact ${index}`);
  assertExactKeys(artifact, ["name", "sha256", "size"], `Release manifest artifact ${index}`);
  if (typeof artifact.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(artifact.name)
    || typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.size) || (artifact.size as number) <= 0) {
    throw new Error(`Release manifest artifact ${index} is invalid`);
  }
  return artifact as ReleaseManifestArtifact;
}

function parseArtifacts(candidate: unknown, component: ReleaseComponent): ReleaseManifestArtifact[] {
  if (!Array.isArray(candidate)) throw new Error("Release manifest artifacts must be an array");
  const artifacts = candidate.map(parseArtifact);
  const expectedNames = releaseAssetNames(component);
  const actualNames = artifacts.map((artifact) => artifact.name);
  if (actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error(`Release manifest artifacts do not match the ${component} allowlist`);
  }
  const oversized = artifacts.find((artifact) => artifact.size > releaseAssetSizeLimit(component, artifact.name));
  if (oversized) throw new Error(`Release manifest artifact ${oversized.name} exceeds its size limit`);
  return artifacts;
}

export function parseReleaseManifest(text: string, expected: ExpectedReleaseManifest): ReleaseManifest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new Error("Release manifest is not valid JSON");
  }
  const manifest = manifestObject(candidate, "Release manifest");
  assertExactKeys(manifest, ["schemaVersion", "repository", "source", "workflow", "release", "artifacts"], "Release manifest");
  if (manifest.schemaVersion !== 1 || manifest.repository !== RELEASE_REPOSITORY
    || manifest.workflow !== RELEASE_SIGNER_WORKFLOW) {
    throw new Error("Release manifest identity is invalid");
  }
  return {
    schemaVersion: 1,
    repository: RELEASE_REPOSITORY,
    source: parseSource(manifest.source),
    workflow: RELEASE_SIGNER_WORKFLOW,
    release: parseRelease(manifest.release, expected),
    artifacts: parseArtifacts(manifest.artifacts, expected.component),
  };
}

export function manifestArtifact(manifest: ReleaseManifest, name: string): ReleaseManifestArtifact {
  const artifact = manifest.artifacts.find((candidate) => candidate.name === name);
  if (!artifact) throw new Error(`Release manifest does not contain ${name}`);
  return artifact;
}

export function parseReleaseChecksums(text: string, manifest: ReleaseManifest): Map<string, string> {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const expectedNames = releaseAssetNames(manifest.release.component)
    .filter((name) => name !== RELEASE_CHECKSUMS_NAME);
  if (lines.length !== expectedNames.length) throw new Error("SHA256SUMS has an unexpected number of entries");
  const checksums = new Map<string, string>();
  lines.forEach((line, index) => {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/);
    if (!match || match[2] !== expectedNames[index]) throw new Error("SHA256SUMS is not strict or sorted");
    const [digest, name] = [match[1] as string, match[2] as string];
    if (manifestArtifact(manifest, name).sha256 !== digest) {
      throw new Error(`SHA256SUMS and release manifest disagree for ${name}`);
    }
    checksums.set(name, digest);
  });
  return checksums;
}
