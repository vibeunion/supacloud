import fs from "fs/promises";

type InjectedFailureCode = "ENOENT" | "ENOTDIR";

function configuredFailures(): Map<string, InjectedFailureCode> {
  const serialized = process.env.EDGE_TEST_REALPATH_STAT_FAILURES;
  if (!serialized) return new Map();
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  const entries = Object.entries(parsed).map(([artifactPath, code]) => {
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new Error(`Unsupported injected stat failure for ${artifactPath}`);
    }
    return [artifactPath, code] as const;
  });
  return new Map(entries);
}

const failureByArtifact = configuredFailures();
const pendingStatFailures = new Map<string, InjectedFailureCode>();
const actualRealpath = fs.realpath;
const actualStat = fs.stat;

async function interceptedRealpath(artifactPath: Parameters<typeof fs.realpath>[0]) {
  const resolved = await actualRealpath(artifactPath);
  const failureCode = failureByArtifact.get(String(artifactPath));
  if (failureCode) pendingStatFailures.set(String(resolved), failureCode);
  return resolved;
}

async function interceptedStat(artifactPath: Parameters<typeof fs.stat>[0]) {
  const failureCode = pendingStatFailures.get(String(artifactPath));
  if (!failureCode) return actualStat(artifactPath);
  pendingStatFailures.delete(String(artifactPath));
  throw Object.assign(new Error("Injected post-realpath stat failure"), { code: failureCode });
}

fs.realpath = interceptedRealpath as typeof fs.realpath;
fs.stat = interceptedStat as typeof fs.stat;
