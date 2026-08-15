import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import systemdUnitBrokerSource from "../../../scripts/lib/systemd_unit_broker.sh" with { type: "text" };

export const SYSTEMD_UNIT_BROKER_TARGET = "/usr/local/libexec/supacloud/systemd-unit";
export const EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE = systemdUnitBrokerSource;
export const EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256 = createHash("sha256")
  .update(Buffer.from(systemdUnitBrokerSource, "utf8"))
  .digest("hex");

export type PrivilegedHelperOwner = {
  uid: number;
  gid: number;
};

export type PrivilegedHelperIdentity = PrivilegedHelperOwner & {
  content: Buffer;
  dev: number;
  ino: number;
  mode: number;
  sha256: string;
};

export type StagedPrivilegedHelper = {
  path: string;
  sha256: string;
};

export type PrivilegedHelperActivationState = {
  targetPath: string;
  backupPath: string;
  previous: PrivilegedHelperIdentity;
  activatedIdentity: PrivilegedHelperIdentity;
  backupReady: boolean;
  activated: boolean;
};

export type PrepareSystemdUnitBrokerActivationRequest = {
  staged: StagedPrivilegedHelper;
  targetPath?: string;
  runId?: string;
  owner?: PrivilegedHelperOwner;
  expectedPrevious?: PrivilegedHelperIdentity;
};

export type PreparedSystemdUnitBrokerActivation = {
  owner: PrivilegedHelperOwner;
  parent: string;
  staged: StagedPrivilegedHelper;
  state: PrivilegedHelperActivationState;
};

export type SystemdUnitBrokerActivationOperations = {
  restore: (state: PrivilegedHelperActivationState, owner: PrivilegedHelperOwner) => void;
  syncDirectory: (directory: string) => void;
  verifyInstalled: (targetPath: string, owner: PrivilegedHelperOwner) => PrivilegedHelperIdentity;
};

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertOwner(uid: number, gid: number, owner: PrivilegedHelperOwner, label: string): void {
  if (uid !== owner.uid || gid !== owner.gid) {
    throw new Error(`${label} must be owned by uid ${owner.uid} and gid ${owner.gid}`);
  }
}

function assertDirectRegularFile(
  filePath: string,
  owner: PrivilegedHelperOwner,
  expectedMode: number,
  label: string,
): void {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${label} must be a direct regular file with one link`);
  }
  assertOwner(stats.uid, stats.gid, owner, label);
  if ((stats.mode & 0o7777) !== expectedMode) {
    throw new Error(`${label} mode must be exactly 0${expectedMode.toString(8)}`);
  }
}

export function readPrivilegedHelperIdentity(
  filePath: string,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
  expectedMode = 0o755,
): PrivilegedHelperIdentity {
  if (!existsSync(filePath)) throw new Error(`Privileged systemd-unit helper is missing: ${filePath}`);
  assertDirectRegularFile(filePath, owner, expectedMode, "Privileged systemd-unit helper");

  const before = lstatSync(filePath);
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) {
      throw new Error("Privileged systemd-unit helper changed during identity capture");
    }
    assertOwner(opened.uid, opened.gid, owner, "Privileged systemd-unit helper");
    if ((opened.mode & 0o7777) !== expectedMode) {
      throw new Error(`Privileged systemd-unit helper mode must be exactly 0${expectedMode.toString(8)}`);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== content.length
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("Privileged systemd-unit helper changed while it was read");
    }
    return {
      content,
      dev: opened.dev,
      ino: opened.ino,
      uid: opened.uid,
      gid: opened.gid,
      mode: opened.mode & 0o7777,
      sha256: sha256(content),
    };
  } finally {
    closeSync(descriptor);
  }
}

function assertDirectParentDirectory(filePath: string, owner: PrivilegedHelperOwner): string {
  const parent = path.dirname(filePath);
  const stats = lstatSync(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Privileged systemd-unit helper parent must be a direct directory");
  }
  assertOwner(stats.uid, stats.gid, owner, "Privileged systemd-unit helper parent");
  if ((stats.mode & 0o022) !== 0) {
    throw new Error("Privileged systemd-unit helper parent must not be group- or world-writable");
  }
  return parent;
}

function writeExclusiveFile(
  filePath: string,
  content: Buffer,
  mode: number,
  owner: PrivilegedHelperOwner,
): void {
  const descriptor = openSync(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, content);
    fchmodSync(descriptor, mode);
    fchownSync(descriptor, owner.uid, owner.gid);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  assertDirectRegularFile(filePath, owner, mode, "Staged privileged systemd-unit helper");
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function stageEmbeddedSystemdUnitBroker(
  targetPath = SYSTEMD_UNIT_BROKER_TARGET,
  runId = randomUUID(),
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): StagedPrivilegedHelper {
  assertDirectParentDirectory(targetPath, owner);
  const stagedPath = `${targetPath}.new-${runId}`;
  const content = Buffer.from(EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE, "utf8");
  try {
    writeExclusiveFile(stagedPath, content, 0o755, owner);
    const staged = readPrivilegedHelperIdentity(stagedPath, owner);
    if (staged.sha256 !== EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256) {
      throw new Error("Staged privileged systemd-unit helper digest does not match the embedded helper");
    }
    return { path: stagedPath, sha256: staged.sha256 };
  } catch (error: unknown) {
    rmSync(stagedPath, { force: true });
    throw error;
  }
}

function sameHelperIdentity(
  left: PrivilegedHelperIdentity,
  right: PrivilegedHelperIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.sha256 === right.sha256;
}

function frozenPreviousIdentity(
  current: PrivilegedHelperIdentity,
  expected?: PrivilegedHelperIdentity,
): PrivilegedHelperIdentity {
  if (expected && !sameHelperIdentity(current, expected)) {
    throw new Error("Privileged systemd-unit helper changed after upgrade preflight");
  }
  return expected ?? current;
}

function createHelperActivationState(
  targetPath: string,
  runId: string,
  previous: PrivilegedHelperIdentity,
  activatedIdentity: PrivilegedHelperIdentity,
): PrivilegedHelperActivationState {
  return {
    targetPath,
    backupPath: `${targetPath}.bak-${runId}`,
    previous,
    activatedIdentity,
    backupReady: false,
    activated: false,
  };
}

function assertStagedHelperIdentity(
  staged: StagedPrivilegedHelper,
  owner: PrivilegedHelperOwner,
): PrivilegedHelperIdentity {
  const identity = readPrivilegedHelperIdentity(staged.path, owner);
  if (identity.sha256 !== staged.sha256 || identity.sha256 !== EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256) {
    throw new Error("Staged privileged systemd-unit helper identity changed before activation");
  }
  return identity;
}

function backupPreviousHelper(
  state: PrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
): void {
  writeExclusiveFile(state.backupPath, state.previous.content, state.previous.mode, owner);
  const backup = readPrivilegedHelperIdentity(state.backupPath, owner, state.previous.mode);
  if (backup.sha256 !== state.previous.sha256) {
    throw new Error("Privileged systemd-unit helper rollback backup digest mismatch");
  }
  state.backupReady = true;
}

function assertActivationTargetUnchanged(
  state: PrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
): void {
  const current = readPrivilegedHelperIdentity(state.targetPath, owner, state.previous.mode);
  if (!sameHelperIdentity(current, state.previous)) {
    throw new Error("Privileged systemd-unit helper changed before atomic activation");
  }
}

function rethrowAfterActivationRecovery(
  error: unknown,
  state: PrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
  restore: SystemdUnitBrokerActivationOperations["restore"],
): never {
  if (!state.activated) throw error;
  try {
    restore(state, owner);
  } catch (rollbackError: unknown) {
    throw new AggregateError(
      [error, rollbackError],
      "Privileged systemd-unit helper activation and rollback both failed",
    );
  }
  throw error;
}

export function prepareSystemdUnitBrokerActivation(
  request: PrepareSystemdUnitBrokerActivationRequest,
): PreparedSystemdUnitBrokerActivation {
  const targetPath = request.targetPath ?? SYSTEMD_UNIT_BROKER_TARGET;
  const runId = request.runId ?? randomUUID();
  const owner = request.owner ?? { uid: 0, gid: 0 };
  const parent = assertDirectParentDirectory(targetPath, owner);
  const current = readPrivilegedHelperIdentity(targetPath, owner);
  const previous = frozenPreviousIdentity(current, request.expectedPrevious);
  const activatedIdentity = assertStagedHelperIdentity(request.staged, owner);
  const state = createHelperActivationState(targetPath, runId, previous, activatedIdentity);

  try {
    backupPreviousHelper(state, owner);
    return { owner, parent, staged: request.staged, state };
  } catch (error: unknown) {
    rmSync(state.backupPath, { force: true });
    throw error;
  }
}

export function activatePreparedSystemdUnitBroker(
  prepared: PreparedSystemdUnitBrokerActivation,
  operations: SystemdUnitBrokerActivationOperations = {
    restore: restoreSystemdUnitBroker,
    syncDirectory: fsyncDirectory,
    verifyInstalled: verifyInstalledSystemdUnitBroker,
  },
): PrivilegedHelperActivationState {
  const { owner, parent, staged, state } = prepared;
  try {
    const stagedIdentity = assertStagedHelperIdentity(staged, owner);
    if (!sameHelperIdentity(stagedIdentity, state.activatedIdentity)) {
      throw new Error("Staged privileged systemd-unit helper changed after activation preparation");
    }
    assertActivationTargetUnchanged(state, owner);
    renameSync(staged.path, state.targetPath);
    state.activated = true;
    operations.syncDirectory(parent);
    const installed = operations.verifyInstalled(state.targetPath, owner);
    if (!sameHelperIdentity(installed, state.activatedIdentity)) {
      throw new Error("Installed privileged systemd-unit helper identity changed during activation");
    }
    return state;
  } catch (error: unknown) {
    rethrowAfterActivationRecovery(error, state, owner, operations.restore);
  }
}

export function verifyInstalledSystemdUnitBroker(
  targetPath = SYSTEMD_UNIT_BROKER_TARGET,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): PrivilegedHelperIdentity {
  const identity = readPrivilegedHelperIdentity(targetPath, owner);
  if (identity.sha256 !== EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256) {
    throw new Error("Installed privileged systemd-unit helper digest does not match the Management release");
  }
  return identity;
}

export function restoreSystemdUnitBroker(
  state: PrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): void {
  if (!state.activated) return;
  if (!state.backupReady || !existsSync(state.backupPath)) {
    throw new Error("Privileged systemd-unit helper rollback backup is unavailable");
  }
  const backup = readPrivilegedHelperIdentity(state.backupPath, owner, state.previous.mode);
  if (backup.sha256 !== state.previous.sha256) {
    throw new Error("Privileged systemd-unit helper rollback backup changed");
  }
  const activated = readPrivilegedHelperIdentity(state.targetPath, owner, state.activatedIdentity.mode);
  if (!sameHelperIdentity(activated, state.activatedIdentity)) {
    throw new Error("Activated privileged systemd-unit helper changed before rollback");
  }

  const parent = assertDirectParentDirectory(state.targetPath, owner);
  const restorePath = `${state.targetPath}.restore-${randomUUID()}`;
  try {
    writeExclusiveFile(restorePath, backup.content, state.previous.mode, owner);
    renameSync(restorePath, state.targetPath);
    fsyncDirectory(parent);
    const restored = readPrivilegedHelperIdentity(state.targetPath, owner, state.previous.mode);
    if (restored.sha256 !== state.previous.sha256) {
      throw new Error("Privileged systemd-unit helper rollback read-back failed");
    }
    state.activated = false;
  } finally {
    rmSync(restorePath, { force: true });
  }
}

export function cleanupSystemdUnitBrokerBackup(state: PrivilegedHelperActivationState): void {
  rmSync(state.backupPath, { force: true });
}
