import { appendFileSync } from "node:fs";
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
const activationGenerationReadLog = process.env.EDGE_TEST_ACTIVATION_GENERATION_READ_LOG;
const ACTIVATION_GENERATION_FILE_PATTERN =
  /[\\/][a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const actualRealpath = fs.realpath;
const actualStat = fs.stat;

function recordActivationGenerationRead(
  operation: "realpath" | "stat",
  artifactPath: string,
): void {
  if (activationGenerationReadLog && ACTIVATION_GENERATION_FILE_PATTERN.test(artifactPath)) {
    appendFileSync(activationGenerationReadLog, `${operation} ${artifactPath}\n`);
  }
}

async function interceptedRealpath(artifactPath: Parameters<typeof fs.realpath>[0]) {
  recordActivationGenerationRead("realpath", String(artifactPath));
  const resolved = await actualRealpath(artifactPath);
  const failureCode = failureByArtifact.get(String(artifactPath));
  if (failureCode) pendingStatFailures.set(String(resolved), failureCode);
  return resolved;
}

async function interceptedStat(artifactPath: Parameters<typeof fs.stat>[0]) {
  recordActivationGenerationRead("stat", String(artifactPath));
  const failureCode = pendingStatFailures.get(String(artifactPath));
  if (!failureCode) return actualStat(artifactPath);
  pendingStatFailures.delete(String(artifactPath));
  throw Object.assign(new Error("Injected post-realpath stat failure"), { code: failureCode });
}

fs.realpath = interceptedRealpath as typeof fs.realpath;
fs.stat = interceptedStat as typeof fs.stat;
