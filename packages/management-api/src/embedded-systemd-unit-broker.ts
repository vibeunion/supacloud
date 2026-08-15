import { createHash } from "node:crypto";
import systemdUnitBrokerSource from "../../../scripts/lib/systemd_unit_broker.sh" with { type: "text" };
import {
  activatePreparedEmbeddedPrivilegedHelper,
  cleanupEmbeddedPrivilegedHelperBackup,
  prepareEmbeddedPrivilegedHelperActivation,
  readPrivilegedHelperIdentity,
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

export {
  readPrivilegedHelperIdentity,
  type PrivilegedHelperIdentity,
  type PrivilegedHelperOwner,
  type StagedPrivilegedHelper,
} from "./embedded-privileged-helper";

export const SYSTEMD_UNIT_BROKER_TARGET = "/usr/local/libexec/supacloud/systemd-unit";
export const EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE = systemdUnitBrokerSource;
export const EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256 = createHash("sha256")
  .update(Buffer.from(systemdUnitBrokerSource, "utf8"))
  .digest("hex");

const SYSTEMD_UNIT_BROKER = {
  label: "Privileged systemd-unit helper",
  source: EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE,
  sha256: EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256,
  stagedLabel: "Staged privileged systemd-unit helper",
  targetPath: SYSTEMD_UNIT_BROKER_TARGET,
} as const;

export type PrivilegedHelperActivationState = EmbeddedPrivilegedHelperActivationState & {
  previous: PrivilegedHelperIdentity;
};

export type PrepareSystemdUnitBrokerActivationRequest = {
  staged: StagedPrivilegedHelper;
  targetPath?: string;
  runId?: string;
  owner?: PrivilegedHelperOwner;
  expectedPrevious?: PrivilegedHelperIdentity;
};

export type PreparedSystemdUnitBrokerActivation = PreparedEmbeddedPrivilegedHelperActivation & {
  state: PrivilegedHelperActivationState;
};

export type SystemdUnitBrokerActivationOperations = {
  restore: (state: PrivilegedHelperActivationState, owner: PrivilegedHelperOwner) => void;
  syncDirectory: (directory: string) => void;
  verifyInstalled: (targetPath: string, owner: PrivilegedHelperOwner) => PrivilegedHelperIdentity;
};

export function stageEmbeddedSystemdUnitBroker(
  targetPath = SYSTEMD_UNIT_BROKER_TARGET,
  runId?: string,
  owner?: PrivilegedHelperOwner,
): StagedPrivilegedHelper {
  return stageEmbeddedPrivilegedHelper(SYSTEMD_UNIT_BROKER, targetPath, runId, owner);
}

export function prepareSystemdUnitBrokerActivation(
  request: PrepareSystemdUnitBrokerActivationRequest,
): PreparedSystemdUnitBrokerActivation {
  const targetPath = request.targetPath ?? SYSTEMD_UNIT_BROKER_TARGET;
  const owner = request.owner ?? { uid: 0, gid: 0 };
  const current = readPrivilegedHelperIdentity(targetPath, owner);
  return prepareEmbeddedPrivilegedHelperActivation({
    helper: SYSTEMD_UNIT_BROKER,
    staged: request.staged,
    targetPath,
    runId: request.runId,
    owner,
    expectedPrevious: request.expectedPrevious ?? current,
  }) as PreparedSystemdUnitBrokerActivation;
}

function adaptOperations(
  operations: SystemdUnitBrokerActivationOperations,
): EmbeddedPrivilegedHelperActivationOperations {
  return {
    restore: (state, owner) => operations.restore(state as PrivilegedHelperActivationState, owner),
    syncDirectory: operations.syncDirectory,
    verifyInstalled: (targetPath, owner) => operations.verifyInstalled(targetPath, owner),
  };
}

export function activatePreparedSystemdUnitBroker(
  prepared: PreparedSystemdUnitBrokerActivation,
  operations?: SystemdUnitBrokerActivationOperations,
): PrivilegedHelperActivationState {
  if (!operations) {
    return activatePreparedEmbeddedPrivilegedHelper(prepared) as PrivilegedHelperActivationState;
  }
  return activatePreparedEmbeddedPrivilegedHelper(
    prepared,
    adaptOperations(operations),
  ) as PrivilegedHelperActivationState;
}

export function verifyInstalledSystemdUnitBroker(
  targetPath = SYSTEMD_UNIT_BROKER_TARGET,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): PrivilegedHelperIdentity {
  return verifyInstalledEmbeddedPrivilegedHelper(targetPath, owner, SYSTEMD_UNIT_BROKER);
}

export function restoreSystemdUnitBroker(
  state: PrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): void {
  restoreEmbeddedPrivilegedHelper(state, owner, SYSTEMD_UNIT_BROKER);
}

export function cleanupSystemdUnitBrokerBackup(
  state: PrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner = { uid: state.previous.uid, gid: state.previous.gid },
): void {
  cleanupEmbeddedPrivilegedHelperBackup(state, owner, SYSTEMD_UNIT_BROKER);
}
