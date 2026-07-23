import path from "path";

export const BUNDLED_SOURCE_RUNTIME_ENTRY = ".supacloud-entry.js";

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
