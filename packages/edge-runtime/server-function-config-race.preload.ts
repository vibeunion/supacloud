import { appendFileSync } from "node:fs";
import fs from "fs/promises";
import { mock } from "bun:test";

type InjectedFailureCode = "ENOENT" | "ENOTDIR";

const DESCRIPTOR_PATH_PATTERN = /^\/proc\/self\/fd\/\d+\/(.+)$/;

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
const activationGenerationReadLog = process.env.EDGE_TEST_ACTIVATION_GENERATION_READ_LOG;
const ACTIVATION_GENERATION_FILE_PATTERN =
  /[\\/][a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const actualRealpath = fs.realpath;
const actualStat = fs.stat;
const actualOpen = fs.open;

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
  return actualRealpath(artifactPath);
}

async function interceptedStat(artifactPath: Parameters<typeof fs.stat>[0]) {
  recordActivationGenerationRead("stat", String(artifactPath));
  return actualStat(artifactPath);
}

async function interceptedOpen(...openArguments: Parameters<typeof fs.open>) {
  const requestedPath = await requestedArtifactPath(String(openArguments[0]));
  const failureCode = failureByArtifact.get(requestedPath);
  if (!failureCode) return actualOpen(...openArguments);
  failureByArtifact.delete(requestedPath);
  throw Object.assign(new Error("Injected descriptor-bound open failure"), { code: failureCode });
}

async function requestedArtifactPath(candidatePath: string): Promise<string> {
  const descriptorMatch = DESCRIPTOR_PATH_PATTERN.exec(candidatePath);
  if (!descriptorMatch) return candidatePath;
  const descriptorRoot = candidatePath.slice(0, candidatePath.length - descriptorMatch[1].length - 1);
  return `${await actualRealpath(descriptorRoot)}/${descriptorMatch[1]}`;
}

mock.module("node:fs/promises", () => ({
  ...fs,
  realpath: interceptedRealpath,
  stat: interceptedStat,
  open: interceptedOpen,
}));
