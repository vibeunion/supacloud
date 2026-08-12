import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type WorkerPaths = {
  ready: string;
  attempt: string;
  begin: string;
  outcome: string;
};

type WorkerOutcome = {
  success: boolean;
  error_code: string | null;
  version: string | null;
  activation_id: string | null;
};

function descriptorLocksAvailable(): boolean {
  return (process.platform === "linux" && Bun.which("flock") !== null)
    || (process.platform === "darwin" && existsSync("/usr/bin/lockf"));
}

function workerPaths(fixtureRoot: string, workerName: string): WorkerPaths {
  return {
    ready: join(fixtureRoot, `${workerName}.ready`),
    attempt: join(fixtureRoot, `${workerName}.attempt`),
    begin: join(fixtureRoot, `${workerName}.begin`),
    outcome: join(fixtureRoot, `${workerName}.outcome.json`),
  };
}

async function waitForPaths(paths: string[]): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (paths.every((filePath) => existsSync(filePath))) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${paths.join(", ")}`);
}

async function waitForAnyPath(paths: string[]): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (paths.some((filePath) => existsSync(filePath))) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for one of ${paths.join(", ")}`);
}

function spawnDeployWorker(
  functionsRoot: string,
  sharedPaths: { start: string; release: string },
  paths: WorkerPaths,
  marker: string,
) {
  const helperPath = join(import.meta.dir, "../fixtures/edge-function-deploy-process.ts");
  return Bun.spawn([process.execPath, helperPath], {
    env: {
      ...process.env,
      EDGE_FUNCTIONS_DIR: functionsRoot,
      EDGE_RUNTIME_INTERNAL: "127.0.0.1:65535",
      FUNCTION_PROJECT_REF: "proj_cross_process_cas",
      FUNCTION_SLUG: "shared-function",
      FUNCTION_READY_PATH: paths.ready,
      FUNCTION_START_PATH: sharedPaths.start,
      FUNCTION_ATTEMPT_PATH: paths.attempt,
      FUNCTION_BEGIN_PATH: paths.begin,
      FUNCTION_RELEASE_PATH: sharedPaths.release,
      FUNCTION_OUTCOME_PATH: paths.outcome,
      FUNCTION_CODE_MARKER: marker,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function workerFailureDiagnostics(
  workers: ReturnType<typeof spawnDeployWorker>[],
): Promise<string[]> {
  return Promise.all(workers.map(async (worker) =>
    `${await new Response(worker.stdout).text()}\n${await new Response(worker.stderr).text()}`.trim()
  ));
}

async function readWorkerOutcome(filePath: string): Promise<WorkerOutcome> {
  return JSON.parse(await readFile(filePath, "utf8")) as WorkerOutcome;
}

async function stopWorkers(workers: ReturnType<typeof spawnDeployWorker>[]): Promise<void> {
  workers.forEach((worker) => worker.kill("SIGTERM"));
  await Promise.all(workers.map(({ exited }) => exited));
}

describe("edgeFunctionService cross-process activation locking", () => {
  test("serializes two Management processes and rejects the stale activation CAS", async () => {
    if (!descriptorLocksAvailable()) return;
    const fixtureRoot = await mkdtemp(join(homedir(), ".supacloud-function-process-lock-"));
    const functionsRoot = join(fixtureRoot, "functions");
    await mkdir(functionsRoot, { mode: 0o700 });
    const sharedPaths = {
      start: join(fixtureRoot, "start"),
      release: join(fixtureRoot, "release"),
    };
    const paths = [workerPaths(fixtureRoot, "first"), workerPaths(fixtureRoot, "second")];
    const workers = paths.map((worker, index) =>
      spawnDeployWorker(functionsRoot, sharedPaths, worker, `candidate-${index + 1}`)
    );

    try {
      await waitForPaths(paths.map(({ ready }) => ready));
      await writeFile(sharedPaths.start, "start");
      await waitForPaths(paths.map(({ attempt }) => attempt));
      await waitForAnyPath(paths.map(({ begin }) => begin));
      await Bun.sleep(300);
      expect(paths.filter(({ begin }) => existsSync(begin))).toHaveLength(1);

      await writeFile(sharedPaths.release, "release");
      const exitCodes = await Promise.all(workers.map(({ exited }) => exited));
      if (exitCodes.some((exitCode) => exitCode !== 0)) {
        throw new Error(JSON.stringify({ exitCodes, diagnostics: await workerFailureDiagnostics(workers) }));
      }

      const outcomes = await Promise.all(paths.map(({ outcome }) => readWorkerOutcome(outcome)));
      expect(outcomes.filter(({ success }) => success)).toHaveLength(1);
      expect(outcomes.filter(({ error_code }) =>
        error_code === "FUNCTION_ACTIVE_VERSION_CONFLICT")).toHaveLength(1);
      expect(outcomes.find(({ success }) => success)).toMatchObject({ version: "1" });

      const versionRoot = join(
        functionsRoot,
        "proj_cross_process_cas",
        ".versions",
        "shared-function",
      );
      expect(await readdir(versionRoot)).toEqual(["1"]);
      const manifest = JSON.parse(await readFile(join(
        functionsRoot,
        "proj_cross_process_cas",
        "shared-function.config.json",
      ), "utf8")) as Record<string, unknown>;
      expect(manifest.version).toBe("1");
    } finally {
      await writeFile(sharedPaths.release, "release");
      await stopWorkers(workers);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
