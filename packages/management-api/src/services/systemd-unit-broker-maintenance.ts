import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import {
  SYSTEMD_UNIT_BROKER_TARGET,
  stageEmbeddedSystemdUnitBroker,
  verifyInstalledSystemdUnitBroker,
} from "../embedded-systemd-unit-broker";

const MANAGED_FAILED_UNIT_PATTERN = /^supacloud-systemd-unit@[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.service$/;

type MaintenanceLogger = {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
};

type HelperOwner = {
  uid: number;
  gid: number;
};

type SystemctlResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type SystemctlRunner = (args: string[]) => Promise<SystemctlResult>;

export type EnsureSystemdUnitBrokerOptions = {
  targetPath?: string;
  owner?: HelperOwner;
  getUid?: () => number | undefined;
  logger?: MaintenanceLogger;
};

export type EnsureSystemdUnitBrokerResult =
  | { status: "verified" }
  | { status: "repaired" }
  | { status: "skipped"; reason: string };

export type CleanupFailedSystemdUnitBrokerJobsOptions = {
  logger?: MaintenanceLogger;
  runSystemctl?: SystemctlRunner;
};

async function defaultRunSystemctl(args: string[]): Promise<SystemctlResult> {
  const child = Bun.spawn({ cmd: ["systemctl", ...args], stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function backupPathFor(targetPath: string, runId: string): string {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.bak-startup-${runId}`);
}

function moveExistingTargetToBackup(targetPath: string, backupPath: string): boolean {
  try {
    const existing = lstatSync(targetPath);
    if (existing.isDirectory()) {
      throw new Error(`Privileged systemd-unit helper path is a directory: ${targetPath}`);
    }
    renameSync(targetPath, backupPath);
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function installStagedSystemdUnitBroker(
  targetPath: string,
  owner: HelperOwner,
  runId: string,
): void {
  const staged = stageEmbeddedSystemdUnitBroker(targetPath, runId, owner);
  const backupPath = backupPathFor(targetPath, runId);
  let previousMoved = false;
  try {
    previousMoved = moveExistingTargetToBackup(targetPath, backupPath);
    try {
      renameSync(staged.path, targetPath);
      verifyInstalledSystemdUnitBroker(targetPath, owner);
    } catch (error: unknown) {
      rmSync(targetPath, { force: true });
      if (previousMoved) renameSync(backupPath, targetPath);
      throw error;
    }
    if (previousMoved) rmSync(backupPath, { force: true });
  } finally {
    rmSync(staged.path, { force: true });
    if (!previousMoved) rmSync(backupPath, { force: true });
  }
}

/**
 * Validates the privileged systemd-unit helper at Management startup.
 *
 * The helper is normally delivered by the upgrade transaction. A stale or
 * damaged helper must not leave the service in a crash loop where the first
 * managed-unit install fails with an opaque systemd 203/EXEC error. If the
 * installed helper is invalid, repair it atomically from the embedded release
 * artifact before any managed unit is touched.
 */
export function ensureSystemdUnitBrokerForStartup(
  options: EnsureSystemdUnitBrokerOptions = {},
): EnsureSystemdUnitBrokerResult {
  const targetPath = options.targetPath ?? SYSTEMD_UNIT_BROKER_TARGET;
  const owner = options.owner ?? { uid: 0, gid: 0 };
  const logger = options.logger;
  try {
    verifyInstalledSystemdUnitBroker(targetPath, owner);
    logger?.info("[Bootstrap] Privileged systemd-unit helper verified", { targetPath });
    return { status: "verified" };
  } catch (error: unknown) {
    const getUid = options.getUid ?? process.getuid;
    const uid = getUid?.();
    if (uid !== 0) {
      const reason = `Privileged systemd-unit helper is invalid and startup repair requires root: ${errorMessage(error)}`;
      logger?.warn("[Bootstrap] Privileged systemd-unit helper repair skipped", {
        targetPath,
        reason,
      });
      return { status: "skipped", reason };
    }
    logger?.warn("[Bootstrap] Privileged systemd-unit helper is invalid; repairing from embedded release", {
      targetPath,
      error: errorMessage(error),
    });
    try {
      installStagedSystemdUnitBroker(targetPath, owner, randomUUID());
    } catch (repairError: unknown) {
      throw new Error(
        `Privileged systemd-unit helper is invalid and automatic repair failed: `
          + `${errorMessage(repairError)}. Re-run the SupaCloud upgrade transaction to restore ${targetPath}.`,
        { cause: repairError },
      );
    }
    logger?.info("[Bootstrap] Privileged systemd-unit helper repaired", { targetPath });
    return { status: "repaired" };
  }
}

function failedSystemdUnitNames(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const name = line.trim().split(/\s+/)[0] ?? "";
    if (MANAGED_FAILED_UNIT_PATTERN.test(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Clears failed `supacloud-systemd-unit@*` oneshot jobs left behind by a
 * previous broker attempt. Request files are removed by the broker in its
 * finally block, so these units have no pending work; keeping them only makes
 * `systemctl --failed` permanently noisy.
 */
export async function cleanupFailedSystemdUnitBrokerJobs(
  options: CleanupFailedSystemdUnitBrokerJobsOptions = {},
): Promise<string[]> {
  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl;
  const listed = await runSystemctl([
    "list-units",
    "--failed",
    "--plain",
    "--no-legend",
    "supacloud-systemd-unit@*",
  ]);
  if (listed.exitCode !== 0) {
    throw new Error(`Unable to list failed systemd-unit broker jobs: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`);
  }
  const units = failedSystemdUnitNames(listed.stdout);
  if (units.length === 0) return [];
  options.logger?.warn("[Bootstrap] Clearing stale failed systemd-unit broker jobs", { units });
  const reset = await runSystemctl(["reset-failed", ...units]);
  if (reset.exitCode !== 0) {
    throw new Error(`Unable to reset failed systemd-unit broker jobs: ${reset.stderr.trim() || `exit ${reset.exitCode}`}`);
  }
  return units;
}