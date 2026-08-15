import { createHash } from "node:crypto";
import postgrestLauncherSource from "../../../scripts/lib/postgrest_launcher.sh" with { type: "text" };
import {
  activatePreparedEmbeddedPrivilegedHelper,
  cleanupEmbeddedPrivilegedHelperBackup,
  prepareEmbeddedPrivilegedHelperActivation,
  readOptionalPrivilegedHelperIdentity,
  restoreEmbeddedPrivilegedHelper,
  stageEmbeddedPrivilegedHelper,
  verifyInstalledEmbeddedPrivilegedHelper,
  type EmbeddedPrivilegedHelperActivationOperations,
  type EmbeddedPrivilegedHelperActivationState,
  type PreparedEmbeddedPrivilegedHelperActivation,
  type PrivilegedHelperIdentity,
  type PrivilegedHelperOwner,
  type StagedPrivilegedHelper,
} from "./embedded-privileged-helper";

export const POSTGREST_LAUNCHER_TARGET = "/usr/local/libexec/supacloud/postgrest-launcher";
export const EMBEDDED_POSTGREST_LAUNCHER_SOURCE = postgrestLauncherSource;
export const EMBEDDED_POSTGREST_LAUNCHER_SHA256 = createHash("sha256")
  .update(Buffer.from(postgrestLauncherSource, "utf8"))
  .digest("hex");

const POSTGREST_LAUNCHER = {
  label: "PostgREST launcher",
  source: EMBEDDED_POSTGREST_LAUNCHER_SOURCE,
  sha256: EMBEDDED_POSTGREST_LAUNCHER_SHA256,
  stagedLabel: "Staged PostgREST launcher",
  targetPath: POSTGREST_LAUNCHER_TARGET,
} as const;

export type PostgrestLauncherActivationState = EmbeddedPrivilegedHelperActivationState;
export type PostgrestLauncherPreflight = PrivilegedHelperIdentity | null;
export type PreparedPostgrestLauncherActivation = PreparedEmbeddedPrivilegedHelperActivation;
export type PostgrestLauncherActivationOperations = EmbeddedPrivilegedHelperActivationOperations;

export function readPostgrestLauncherPreflight(
  targetPath = POSTGREST_LAUNCHER_TARGET,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): PostgrestLauncherPreflight {
  return readOptionalPrivilegedHelperIdentity(targetPath, owner, 0o755, POSTGREST_LAUNCHER.label);
}

export function stageEmbeddedPostgrestLauncher(
  targetPath = POSTGREST_LAUNCHER_TARGET,
  runId?: string,
  owner?: PrivilegedHelperOwner,
): StagedPrivilegedHelper {
  return stageEmbeddedPrivilegedHelper(POSTGREST_LAUNCHER, targetPath, runId, owner);
}

export function preparePostgrestLauncherActivation(request: {
  staged: StagedPrivilegedHelper;
  targetPath?: string;
  runId?: string;
  owner?: PrivilegedHelperOwner;
  expectedPrevious: PostgrestLauncherPreflight;
}): PreparedPostgrestLauncherActivation {
  return prepareEmbeddedPrivilegedHelperActivation({
    helper: POSTGREST_LAUNCHER,
    staged: request.staged,
    targetPath: request.targetPath,
    runId: request.runId,
    owner: request.owner,
    expectedPrevious: request.expectedPrevious,
  });
}

export function activatePreparedPostgrestLauncher(
  prepared: PreparedPostgrestLauncherActivation,
  operations?: PostgrestLauncherActivationOperations,
): PostgrestLauncherActivationState {
  return activatePreparedEmbeddedPrivilegedHelper(prepared, operations);
}

export function verifyInstalledPostgrestLauncher(
  targetPath = POSTGREST_LAUNCHER_TARGET,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): PrivilegedHelperIdentity {
  return verifyInstalledEmbeddedPrivilegedHelper(targetPath, owner, POSTGREST_LAUNCHER);
}

export function restorePostgrestLauncher(
  state: PostgrestLauncherActivationState,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): void {
  restoreEmbeddedPrivilegedHelper(state, owner, POSTGREST_LAUNCHER);
}

export function cleanupPostgrestLauncherBackup(
  state: PostgrestLauncherActivationState,
  owner: PrivilegedHelperOwner = {
    uid: state.previous?.uid ?? state.activatedIdentity.uid,
    gid: state.previous?.gid ?? state.activatedIdentity.gid,
  },
): void {
  cleanupEmbeddedPrivilegedHelperBackup(state, owner, POSTGREST_LAUNCHER);
}
