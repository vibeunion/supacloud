import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
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
  type Stats,
} from "node:fs";
import path from "node:path";

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

export type EmbeddedPrivilegedHelper = {
  label: string;
  source: string;
  sha256: string;
  stagedLabel: string;
  targetPath: string;
};

export type StagedPrivilegedHelper = {
  path: string;
  sha256: string;
};

export type EmbeddedPrivilegedHelperActivationState = {
  targetPath: string;
  backupPath: string;
  previous: PrivilegedHelperIdentity | null;
  activatedIdentity: PrivilegedHelperIdentity;
  backupReady: boolean;
  activated: boolean;
};

export type PrepareEmbeddedPrivilegedHelperActivationRequest = {
  helper: EmbeddedPrivilegedHelper;
  staged: StagedPrivilegedHelper;
  targetPath?: string;
  runId?: string;
  owner?: PrivilegedHelperOwner;
  expectedPrevious?: PrivilegedHelperIdentity | null;
};

export type PreparedEmbeddedPrivilegedHelperActivation = {
  helper: EmbeddedPrivilegedHelper;
  owner: PrivilegedHelperOwner;
  parent: string;
  staged: StagedPrivilegedHelper;
  state: EmbeddedPrivilegedHelperActivationState;
};

export type EmbeddedPrivilegedHelperActivationOperations = {
  restore: (
    state: EmbeddedPrivilegedHelperActivationState,
    owner: PrivilegedHelperOwner,
    helper: EmbeddedPrivilegedHelper,
  ) => void;
  syncDirectory: (directory: string) => void;
  verifyInstalled: (
    targetPath: string,
    owner: PrivilegedHelperOwner,
    helper: EmbeddedPrivilegedHelper,
  ) => PrivilegedHelperIdentity;
};

type PrivilegedHelperFileContract = {
  label: string;
  mode: number;
  owner: PrivilegedHelperOwner;
};

type WritePrivilegedHelperFileRequest = PrivilegedHelperFileContract & {
  content: Buffer;
  filePath: string;
  onReserved: () => void;
};

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertOwner(uid: number, gid: number, owner: PrivilegedHelperOwner, label: string): void {
  if (uid !== owner.uid || gid !== owner.gid) {
    throw new Error(`${label} must be owned by uid ${owner.uid} and gid ${owner.gid}`);
  }
}

function assertDirectRegularFileStats(
  stats: Stats,
  contract: PrivilegedHelperFileContract,
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${contract.label} must be a direct regular file with one link`);
  }
  assertOwner(stats.uid, stats.gid, contract.owner, contract.label);
  if ((stats.mode & 0o7777) !== contract.mode) {
    throw new Error(`${contract.label} mode must be exactly 0${contract.mode.toString(8)}`);
  }
}

function directRegularFileStats(
  filePath: string,
  contract: PrivilegedHelperFileContract,
): Stats {
  const stats = lstatSync(filePath);
  assertDirectRegularFileStats(stats, contract);
  return stats;
}

function assertOpenedHelperIdentity(
  opened: Stats,
  before: Stats,
  contract: PrivilegedHelperFileContract,
): void {
  if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) {
    throw new Error(`${contract.label} changed during identity capture`);
  }
  assertOwner(opened.uid, opened.gid, contract.owner, contract.label);
  if ((opened.mode & 0o7777) !== contract.mode) {
    throw new Error(`${contract.label} mode must be exactly 0${contract.mode.toString(8)}`);
  }
}

function readStableHelperContent(descriptor: number, opened: Stats, label: string): Buffer {
  const content = readFileSync(descriptor);
  const after = fstatSync(descriptor);
  if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== content.length
    || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
    throw new Error(`${label} changed while it was read`);
  }
  return content;
}

function capturedHelperIdentity(opened: Stats, content: Buffer): PrivilegedHelperIdentity {
  return {
    content,
    dev: opened.dev,
    ino: opened.ino,
    uid: opened.uid,
    gid: opened.gid,
    mode: opened.mode & 0o7777,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function capturePrivilegedHelperIdentity(
  filePath: string,
  contract: PrivilegedHelperFileContract,
  before = directRegularFileStats(filePath, contract),
): PrivilegedHelperIdentity {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    assertOpenedHelperIdentity(opened, before, contract);
    return capturedHelperIdentity(opened, readStableHelperContent(descriptor, opened, contract.label));
  } finally {
    closeSync(descriptor);
  }
}

export function readPrivilegedHelperIdentity(
  filePath: string,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
  expectedMode = 0o755,
  label = "Privileged systemd-unit helper",
): PrivilegedHelperIdentity {
  try {
    return capturePrivilegedHelperIdentity(filePath, { owner, mode: expectedMode, label });
  } catch (error: unknown) {
    if (isMissingFileError(error)) throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
}

export function readOptionalPrivilegedHelperIdentity(
  filePath: string,
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
  expectedMode = 0o755,
  label = "Privileged helper",
): PrivilegedHelperIdentity | null {
  const contract = { owner, mode: expectedMode, label };
  const before = lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) return null;
  assertDirectRegularFileStats(before, contract);
  return capturePrivilegedHelperIdentity(filePath, contract, before);
}

function assertDirectParentDirectory(
  filePath: string,
  owner: PrivilegedHelperOwner,
  label: string,
): string {
  const parent = path.dirname(filePath);
  const stats = lstatSync(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} parent must be a direct directory`);
  }
  assertOwner(stats.uid, stats.gid, owner, `${label} parent`);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`${label} parent must not be group- or world-writable`);
  }
  return parent;
}

function writeExclusiveFile(request: WritePrivilegedHelperFileRequest): void {
  const descriptor = openSync(
    request.filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  request.onReserved();
  try {
    writeFileSync(descriptor, request.content);
    fchmodSync(descriptor, request.mode);
    fchownSync(descriptor, request.owner.uid, request.owner.gid);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  directRegularFileStats(request.filePath, request);
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function throwWithCleanupFailure(primary: unknown, cleanup: unknown, message: string): never {
  throw new AggregateError([primary, cleanup], message);
}

function removeReservedPathAfterFailure(
  filePath: string,
  reserved: boolean,
  primary: unknown,
  message: string,
): never {
  if (!reserved) throw primary;
  try {
    rmSync(filePath, { force: true });
  } catch (cleanupError: unknown) {
    throwWithCleanupFailure(primary, cleanupError, message);
  }
  throw primary;
}

export function stageEmbeddedPrivilegedHelper(
  helper: EmbeddedPrivilegedHelper,
  targetPath = helper.targetPath,
  runId: string = randomUUID(),
  owner: PrivilegedHelperOwner = { uid: 0, gid: 0 },
): StagedPrivilegedHelper {
  assertDirectParentDirectory(targetPath, owner, helper.label);
  const stagedPath = `${targetPath}.new-${runId}`;
  const content = Buffer.from(helper.source, "utf8");
  let stagedReserved = false;
  try {
    writeExclusiveFile({
      filePath: stagedPath,
      content,
      mode: 0o755,
      owner,
      label: helper.stagedLabel,
      onReserved: () => { stagedReserved = true; },
    });
    const staged = readPrivilegedHelperIdentity(stagedPath, owner, 0o755, helper.stagedLabel);
    if (staged.sha256 !== helper.sha256) {
      throw new Error(`${helper.stagedLabel} digest does not match the embedded release artifact`);
    }
    return { path: stagedPath, sha256: staged.sha256 };
  } catch (error: unknown) {
    removeReservedPathAfterFailure(
      stagedPath,
      stagedReserved,
      error,
      `${helper.stagedLabel} staging and cleanup both failed`,
    );
  }
}

export function samePrivilegedHelperIdentity(
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

function sameOptionalPrivilegedHelperIdentity(
  left: PrivilegedHelperIdentity | null,
  right: PrivilegedHelperIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return samePrivilegedHelperIdentity(left, right);
}

function frozenPreviousIdentity(
  current: PrivilegedHelperIdentity | null,
  expected: PrivilegedHelperIdentity | null | undefined,
  label: string,
): PrivilegedHelperIdentity | null {
  if (expected !== undefined && !sameOptionalPrivilegedHelperIdentity(current, expected)) {
    throw new Error(`${label} changed after upgrade preflight`);
  }
  return expected === undefined ? current : expected;
}

function createHelperActivationState(
  targetPath: string,
  runId: string,
  previous: PrivilegedHelperIdentity | null,
  activatedIdentity: PrivilegedHelperIdentity,
): EmbeddedPrivilegedHelperActivationState {
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
  helper: EmbeddedPrivilegedHelper,
  staged: StagedPrivilegedHelper,
  owner: PrivilegedHelperOwner,
): PrivilegedHelperIdentity {
  const identity = readPrivilegedHelperIdentity(staged.path, owner, 0o755, helper.stagedLabel);
  if (identity.sha256 !== staged.sha256 || identity.sha256 !== helper.sha256) {
    throw new Error(`${helper.stagedLabel} identity changed before activation`);
  }
  return identity;
}

function backupPreviousHelper(
  helper: EmbeddedPrivilegedHelper,
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
): void {
  const previous = state.previous;
  if (!previous) return;
  let backupReserved = false;
  try {
    writeExclusiveFile({
      filePath: state.backupPath,
      content: previous.content,
      mode: previous.mode,
      owner,
      label: `${helper.label} rollback backup`,
      onReserved: () => { backupReserved = true; },
    });
    const backup = readPrivilegedHelperIdentity(
      state.backupPath,
      owner,
      previous.mode,
      `${helper.label} rollback backup`,
    );
    if (backup.sha256 !== previous.sha256) {
      throw new Error(`${helper.label} rollback backup digest mismatch`);
    }
    state.backupReady = true;
  } catch (error: unknown) {
    removeReservedPathAfterFailure(
      state.backupPath,
      backupReserved,
      error,
      `${helper.label} backup preparation and cleanup both failed`,
    );
  }
}

function assertActivationTargetUnchanged(
  helper: EmbeddedPrivilegedHelper,
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
): void {
  const expectedMode = state.previous?.mode ?? 0o755;
  const current = readOptionalPrivilegedHelperIdentity(state.targetPath, owner, expectedMode, helper.label);
  if (!sameOptionalPrivilegedHelperIdentity(current, state.previous)) {
    throw new Error(`${helper.label} changed before atomic activation`);
  }
}

function rethrowAfterActivationRecovery(
  error: unknown,
  helper: EmbeddedPrivilegedHelper,
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
  restore: EmbeddedPrivilegedHelperActivationOperations["restore"],
): never {
  if (!state.activated) throw error;
  try {
    restore(state, owner, helper);
  } catch (rollbackError: unknown) {
    throw new AggregateError(
      [error, rollbackError],
      `${helper.label} activation and rollback both failed`,
    );
  }
  throw error;
}

export function prepareEmbeddedPrivilegedHelperActivation(
  request: PrepareEmbeddedPrivilegedHelperActivationRequest,
): PreparedEmbeddedPrivilegedHelperActivation {
  const targetPath = request.targetPath ?? request.helper.targetPath;
  const runId = request.runId ?? randomUUID();
  const owner = request.owner ?? { uid: 0, gid: 0 };
  const parent = assertDirectParentDirectory(targetPath, owner, request.helper.label);
  const current = readOptionalPrivilegedHelperIdentity(targetPath, owner, 0o755, request.helper.label);
  const previous = frozenPreviousIdentity(current, request.expectedPrevious, request.helper.label);
  const activatedIdentity = assertStagedHelperIdentity(request.helper, request.staged, owner);
  const state = createHelperActivationState(targetPath, runId, previous, activatedIdentity);

  backupPreviousHelper(request.helper, state, owner);
  return { helper: request.helper, owner, parent, staged: request.staged, state };
}

export function verifyInstalledEmbeddedPrivilegedHelper(
  targetPath: string,
  owner: PrivilegedHelperOwner,
  helper: EmbeddedPrivilegedHelper,
): PrivilegedHelperIdentity {
  const identity = readPrivilegedHelperIdentity(targetPath, owner, 0o755, helper.label);
  if (identity.sha256 !== helper.sha256) {
    throw new Error(`${helper.label} digest does not match the Management release`);
  }
  return identity;
}

export function activatePreparedEmbeddedPrivilegedHelper(
  prepared: PreparedEmbeddedPrivilegedHelperActivation,
  operations: EmbeddedPrivilegedHelperActivationOperations = {
    restore: restoreEmbeddedPrivilegedHelper,
    syncDirectory: fsyncDirectory,
    verifyInstalled: verifyInstalledEmbeddedPrivilegedHelper,
  },
): EmbeddedPrivilegedHelperActivationState {
  try {
    return activatePreparedHelperTarget(prepared, operations);
  } catch (error: unknown) {
    const { helper, owner, state } = prepared;
    rethrowAfterActivationRecovery(error, helper, state, owner, operations.restore);
  }
}

function activatePreparedHelperTarget(
  prepared: PreparedEmbeddedPrivilegedHelperActivation,
  operations: EmbeddedPrivilegedHelperActivationOperations,
): EmbeddedPrivilegedHelperActivationState {
  const { helper, owner, parent, staged, state } = prepared;
  const stagedIdentity = assertStagedHelperIdentity(helper, staged, owner);
  if (!samePrivilegedHelperIdentity(stagedIdentity, state.activatedIdentity)) {
    throw new Error(`${helper.stagedLabel} changed after activation preparation`);
  }
  assertActivationTargetUnchanged(helper, state, owner);
  renameSync(staged.path, state.targetPath);
  state.activated = true;
  operations.syncDirectory(parent);
  const installed = operations.verifyInstalled(state.targetPath, owner, helper);
  if (!samePrivilegedHelperIdentity(installed, state.activatedIdentity)) {
    throw new Error(`${helper.label} identity changed during activation`);
  }
  return state;
}

function assertActivatedIdentity(
  helper: EmbeddedPrivilegedHelper,
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
): void {
  const activated = readPrivilegedHelperIdentity(
    state.targetPath,
    owner,
    state.activatedIdentity.mode,
    helper.label,
  );
  if (!samePrivilegedHelperIdentity(activated, state.activatedIdentity)) {
    throw new Error(`${helper.label} changed before rollback`);
  }
}

function restorePreviouslyAbsentHelper(
  helper: EmbeddedPrivilegedHelper,
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
  parent: string,
): void {
  assertActivatedIdentity(helper, state, owner);
  rmSync(state.targetPath);
  fsyncDirectory(parent);
  if (readOptionalPrivilegedHelperIdentity(state.targetPath, owner, 0o755, helper.label) !== null) {
    throw new Error(`${helper.label} rollback removal read-back failed`);
  }
  state.activated = false;
}

function cleanupRestorePath(
  restorePath: string,
  reserved: boolean,
  primary: unknown | null,
  helper: EmbeddedPrivilegedHelper,
): void {
  if (!reserved) {
    if (primary !== null) throw primary;
    return;
  }
  try {
    rmSync(restorePath, { force: true });
  } catch (cleanupError: unknown) {
    if (primary !== null) {
      throwWithCleanupFailure(
        primary,
        cleanupError,
        `${helper.label} rollback and temporary-path cleanup both failed`,
      );
    }
    throw cleanupError;
  }
  if (primary !== null) throw primary;
}

function readRollbackBackup(
  helper: EmbeddedPrivilegedHelper,
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
  previous: PrivilegedHelperIdentity,
): PrivilegedHelperIdentity {
  if (!state.backupReady) throw new Error(`${helper.label} rollback backup is unavailable`);
  const backup = readPrivilegedHelperIdentity(
    state.backupPath,
    owner,
    previous.mode,
    `${helper.label} rollback backup`,
  );
  if (backup.sha256 !== previous.sha256) throw new Error(`${helper.label} rollback backup changed`);
  return backup;
}

function installFrozenPreviousHelper(request: {
  backup: PrivilegedHelperIdentity;
  helper: EmbeddedPrivilegedHelper;
  owner: PrivilegedHelperOwner;
  parent: string;
  previous: PrivilegedHelperIdentity;
  restorePath: string;
  state: EmbeddedPrivilegedHelperActivationState;
  onReserved: () => void;
}): void {
  writeExclusiveFile({
    filePath: request.restorePath,
    content: request.backup.content,
    mode: request.previous.mode,
    owner: request.owner,
    label: `${request.helper.label} restore file`,
    onReserved: request.onReserved,
  });
  renameSync(request.restorePath, request.state.targetPath);
  fsyncDirectory(request.parent);
  const restored = readPrivilegedHelperIdentity(
    request.state.targetPath,
    request.owner,
    request.previous.mode,
    request.helper.label,
  );
  if (restored.sha256 !== request.previous.sha256) {
    throw new Error(`${request.helper.label} rollback read-back failed`);
  }
  request.state.activated = false;
}

function restorePreviousHelper(
  helper: EmbeddedPrivilegedHelper,
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
  parent: string,
  previous: PrivilegedHelperIdentity,
): void {
  const backup = readRollbackBackup(helper, state, owner, previous);
  assertActivatedIdentity(helper, state, owner);
  const restorePath = `${state.targetPath}.restore-${randomUUID()}`;
  let restoreReserved = false;
  let primary: unknown | null = null;
  try {
    installFrozenPreviousHelper({
      backup,
      helper,
      owner,
      parent,
      previous,
      restorePath,
      state,
      onReserved: () => { restoreReserved = true; },
    });
  } catch (error: unknown) {
    primary = error;
  }
  cleanupRestorePath(restorePath, restoreReserved, primary, helper);
}

export function restoreEmbeddedPrivilegedHelper(
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
  helper: EmbeddedPrivilegedHelper,
): void {
  if (!state.activated) return;
  const parent = assertDirectParentDirectory(state.targetPath, owner, helper.label);
  if (state.previous === null) {
    restorePreviouslyAbsentHelper(helper, state, owner, parent);
    return;
  }
  restorePreviousHelper(helper, state, owner, parent, state.previous);
}

export function cleanupEmbeddedPrivilegedHelperBackup(
  state: EmbeddedPrivilegedHelperActivationState,
  owner: PrivilegedHelperOwner,
  helper: EmbeddedPrivilegedHelper,
): void {
  if (!state.backupReady || state.previous === null) return;
  const backup = readPrivilegedHelperIdentity(
    state.backupPath,
    owner,
    state.previous.mode,
    `${helper.label} rollback backup`,
  );
  if (backup.sha256 !== state.previous.sha256) {
    throw new Error(`${helper.label} rollback backup changed before cleanup`);
  }
  rmSync(state.backupPath);
  fsyncDirectory(path.dirname(state.backupPath));
  state.backupReady = false;
}
