import path from "path";

export const BUNDLED_SOURCE_RUNTIME_ENTRY = ".supacloud-entry.js";
const ARTIFACT_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function attestedFunctionArtifactPath(
  projectRoot: string,
  functionName: string,
  version: string,
  artifactSha256: string,
): string {
  if (!ARTIFACT_SHA256_PATTERN.test(artifactSha256)) {
    throw new Error("Function activation artifact digest is invalid");
  }
  // The digest attests this immutable source entry while its directory remains
  // the base for bundled static assets resolved through import.meta.dir.
  return path.join(
    projectRoot,
    ".versions",
    functionName,
    version,
    "src",
    BUNDLED_SOURCE_RUNTIME_ENTRY,
  );
}

export function functionPathCandidates(
  projectRoot: string,
  functionName: string,
  requestedVersion?: string | null,
): string[] {
  if (requestedVersion) {
    const versionRoot = path.join(projectRoot, ".versions", functionName, requestedVersion);
    return [
      path.join(versionRoot, "src", BUNDLED_SOURCE_RUNTIME_ENTRY),
      path.join(versionRoot, "index.js"),
    ];
  }

  return [
    path.join(projectRoot, `.src-${functionName}`, BUNDLED_SOURCE_RUNTIME_ENTRY),
    path.join(projectRoot, `${functionName}.js`),
    path.join(projectRoot, `${functionName}.ts`),
  ];
}

export function activeFunctionPathCandidates(
  projectRoot: string,
  functionName: string,
  activeVersion: string | null,
): string[] {
  return activeVersion
    ? functionPathCandidates(projectRoot, functionName, activeVersion)
    : functionPathCandidates(projectRoot, functionName);
}
