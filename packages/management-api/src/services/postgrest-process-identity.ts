import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  killVerifiedProcessWithPidfd,
  type LinuxPidfdOperations,
} from "./linux-pidfd";

export const POSTGREST_PROCESS_IDENTITY_PROBE_FLAG = "--postgrest-process-identity-probe-v1";
export const POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG = "--postgrest-process-identity-terminate-v1";
export const POSTGREST_PROCESS_IDENTITY_STDOUT_LIMIT = 64 * 1024;

const POSTGREST_PROCESS_IDENTITY_STDERR_LIMIT = 4 * 1024;
const POSTGREST_PROCESS_IDENTITY_TIMEOUT_MS = 5_000;
const POSTGREST_PROCESS_TERMINATION_TIMEOUT_MS = 1_000;
const MAX_LINUX_PID = 2_147_483_647;
const MAX_LINUX_ID = 4_294_967_294;
const MAX_PROC_STATUS_BYTES = 16 * 1024;
const MAX_PROC_STAT_BYTES = 8 * 1024;
const MAX_PROC_COMMAND_LINE_BYTES = 128 * 1024;
const MAX_PROC_ENVIRONMENT_BYTES = 2 * 1024 * 1024;
const MAX_EXECUTABLE_PATH_BYTES = 4 * 1024;
const MAX_COMMAND_LINE_ARGUMENTS = 64;
const MAX_COMMAND_LINE_ARGUMENT_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_NAMES = 1_024;
const MAX_ENVIRONMENT_NAME_BYTES = 256;
const MAX_PROCESS_START_ID_BYTES = 32;
const SETPRIV_PATH = "/usr/bin/setpriv";
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

export interface PostgrestRuntimeIdentity {
  uid: number;
  gid: number;
}

export interface PostgrestProcessIdentityProbeResult {
  version: 1;
  startId: string;
  executable: string;
  commandLine: string[];
  environmentNames: string[];
}

export interface PostgrestProcessIdentity {
  startId: string;
  executable: string;
  commandLine: string[];
  environmentNames: string[];
}

export interface PostgrestProcessIdentityCollectorOperations {
  currentUid(): number | undefined;
  currentGid(): number | undefined;
  readLink(path: string): Promise<string>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
}

export interface PostgrestProcessMetadata {
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  isDirectory: boolean;
}

export interface PostgrestIdentityProbeProcess {
  pid: number;
  startId: string;
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnedPostgrestIdentityProbe extends PostgrestIdentityProbeProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export interface PostgrestProcessIdentityParentOperations {
  processMetadata(pid: number): Promise<PostgrestProcessMetadata>;
  executablePath(): Promise<string>;
  spawn(command: string[], options: {
    cwd: "/";
    environment: Record<string, string>;
    stdin: "ignore";
  }): Promise<SpawnedPostgrestIdentityProbe>;
}

export interface PostgrestProcessIdentityTerminationOperations {
  spawn(command: string[], options: {
    cwd: "/";
    environment: Record<string, string>;
    stdin: "ignore";
  }): { exited: Promise<number> };
}

type ProbeExecutionOptions = {
  timeoutMs?: number;
};

type CompletedProbeOutput = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

function parseBoundedDecimal(rawDecimal: string, minimum: number, maximum: number): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(rawDecimal)) return null;
  const parsed = Number(rawDecimal);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

export function parseLinuxProcessId(rawPid: string): number {
  const parsed = parseBoundedDecimal(rawPid, 1, MAX_LINUX_PID);
  if (parsed === null) throw new Error("Invalid Linux process id");
  return parsed;
}

export function parseSystemdMainPid(rawPid: string): number {
  const parsed = parseBoundedDecimal(rawPid, 0, MAX_LINUX_PID);
  if (parsed === null) throw new Error("Invalid systemd process id");
  return parsed;
}

export function parseLinuxRuntimeId(rawId: string): number {
  const parsed = parseBoundedDecimal(rawId, 1, MAX_LINUX_ID);
  if (parsed === null) throw new Error("Invalid Linux runtime id");
  return parsed;
}

function parseProbeArguments(args: string[]): { pid: number; identity: PostgrestRuntimeIdentity } {
  if (args.length !== 3) throw new Error("Invalid PostgREST process identity probe arguments");
  let pid: number;
  let uid: number;
  let gid: number;
  try {
    pid = parseLinuxProcessId(args[0]!);
    uid = parseLinuxRuntimeId(args[1]!);
    gid = parseLinuxRuntimeId(args[2]!);
  } catch {
    throw new Error("Invalid PostgREST process identity probe arguments");
  }
  return { pid, identity: { uid, gid } };
}

function parseProcessStartId(rawStartId: string): string {
  if (!/^(?:0|[1-9]\d*)$/.test(rawStartId)
    || Buffer.byteLength(rawStartId, "utf8") > MAX_PROCESS_START_ID_BYTES) {
    throw new Error("Invalid process start identity");
  }
  return rawStartId;
}

function parseTerminationArguments(args: string[]): {
  pid: number;
  identity: PostgrestRuntimeIdentity;
  startId: string;
} {
  if (args.length !== 4) throw new Error("Invalid PostgREST process identity termination arguments");
  try {
    const { pid, identity } = parseProbeArguments(args.slice(0, 3));
    return { pid, identity, startId: parseProcessStartId(args[3]!) };
  } catch {
    throw new Error("Invalid PostgREST process identity termination arguments");
  }
}

async function readFileBounded(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const boundedBytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await file.read(
        boundedBytes,
        offset,
        Math.min(16 * 1024, maxBytes + 1 - offset),
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("PostgREST process identity input exceeded limit");
    return boundedBytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

const defaultCollectorOperations: PostgrestProcessIdentityCollectorOperations = {
  currentUid: () => process.getuid?.(),
  currentGid: () => process.getgid?.(),
  readLink: readlink,
  readFile: readFileBounded,
};

function decodeUtf8(rawBytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
}

function statusIdentity(status: string, label: "Uid" | "Gid"): number[] {
  const match = status.match(new RegExp(`^${label}:[ \\t]+([0-9]+)[ \\t]+([0-9]+)[ \\t]+([0-9]+)[ \\t]+([0-9]+)[ \\t]*$`, "m"));
  if (!match) throw new Error(`Invalid process ${label} identity`);
  const maximum = MAX_LINUX_ID;
  const parsedIds = match.slice(1).map((rawId) => parseBoundedDecimal(rawId!, 0, maximum));
  if (parsedIds.some((parsedId) => parsedId === null)) throw new Error(`Invalid process ${label} identity`);
  return parsedIds as number[];
}

function assertExactStatusIdentity(
  status: string,
  expected: PostgrestRuntimeIdentity,
  label: string,
): void {
  const uids = statusIdentity(status, "Uid");
  const gids = statusIdentity(status, "Gid");
  if (uids.some((uid) => uid !== expected.uid) || gids.some((gid) => gid !== expected.gid)) {
    throw new Error(`${label} has unexpected uid/gid`);
  }
}

function assertClearedSupplementaryGroups(status: string): void {
  const match = status.match(/^Groups:[ \t]*(.*)$/m);
  if (!match) throw new Error("Cannot verify probe supplementary groups");
  if (match[1]!.trim() !== "") throw new Error("Probe retained supplementary groups");
}

function assertClearedCapabilities(status: string): void {
  for (const label of ["CapInh", "CapPrm", "CapEff", "CapAmb"] as const) {
    const match = status.match(new RegExp(`^${label}:[ \\t]*([a-fA-F0-9]+)[ \\t]*$`, "m"));
    if (!match || BigInt(`0x${match[1]}`) !== 0n) {
      throw new Error("Probe retained process capabilities");
    }
  }
}

async function assertSandboxedRuntime(
  label: string,
  identity: PostgrestRuntimeIdentity,
  operations: PostgrestProcessIdentityCollectorOperations,
): Promise<void> {
  if (operations.currentUid() !== identity.uid || operations.currentGid() !== identity.gid) {
    throw new Error(`${label} has unexpected uid/gid`);
  }
  const selfStatus = decodeUtf8(await operations.readFile("/proc/self/status", MAX_PROC_STATUS_BYTES));
  assertExactStatusIdentity(selfStatus, identity, label);
  assertClearedSupplementaryGroups(selfStatus);
  assertClearedCapabilities(selfStatus);
}

function procStartId(statContent: string, expectedPid: number): string {
  const commandStart = statContent.indexOf(" (");
  const commandEnd = statContent.lastIndexOf(")");
  if (commandStart <= 0 || commandEnd <= commandStart + 1) {
    throw new Error("Invalid process start identity");
  }
  let observedPid: number;
  try {
    observedPid = parseLinuxProcessId(statContent.slice(0, commandStart).trim());
  } catch {
    throw new Error("Invalid process start identity");
  }
  if (observedPid !== expectedPid) throw new Error("Process stat has unexpected process id");
  const fieldsAfterCommand = statContent.slice(commandEnd + 1).trim().split(/\s+/);
  const startId = fieldsAfterCommand[19];
  if (!startId) throw new Error("Invalid process start identity");
  return parseProcessStartId(startId);
}

async function processStartId(
  pid: number,
  operations: PostgrestProcessIdentityCollectorOperations,
): Promise<string> {
  return procStartId(decodeUtf8(
    await operations.readFile(`/proc/${pid}/stat`, MAX_PROC_STAT_BYTES),
  ), pid);
}

function nulDelimitedEntries(rawBytes: Buffer, label: string): Buffer[] {
  if (rawBytes.length === 0) return [];
  if (rawBytes[rawBytes.length - 1] !== 0) throw new Error(`Invalid ${label}`);
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < rawBytes.length; index += 1) {
    if (rawBytes[index] !== 0) continue;
    entries.push(rawBytes.subarray(start, index));
    start = index + 1;
  }
  return entries;
}

function commandLine(commandLineBytes: Buffer): string[] {
  const entries = nulDelimitedEntries(commandLineBytes, "process command line");
  if (entries.length === 0 || entries.length > MAX_COMMAND_LINE_ARGUMENTS) {
    throw new Error("Invalid process command line");
  }
  return entries.map((entry) => {
    if (entry.length > MAX_COMMAND_LINE_ARGUMENT_BYTES) throw new Error("Invalid process command line");
    return decodeUtf8(entry);
  });
}

function environmentNames(environmentBytes: Buffer): string[] {
  const entries = nulDelimitedEntries(environmentBytes, "process environment");
  if (entries.length > MAX_ENVIRONMENT_NAMES) throw new Error("Invalid process environment");
  const names = entries.map((entry) => {
    const separator = entry.indexOf(0x3d);
    if (separator <= 0 || separator > MAX_ENVIRONMENT_NAME_BYTES) {
      throw new Error("Invalid process environment name");
    }
    const name = decodeUtf8(entry.subarray(0, separator));
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) throw new Error("Invalid process environment name");
    return name;
  }).sort();
  if (new Set(names).size !== names.length) throw new Error("Duplicate process environment name");
  return names;
}

function assertExecutablePath(executable: string): void {
  if (!isAbsolute(executable)
    || executable.includes("\0")
    || Buffer.byteLength(executable, "utf8") > MAX_EXECUTABLE_PATH_BYTES) {
    throw new Error("Invalid process executable path");
  }
}

export async function collectPostgrestProcessIdentity(
  args: string[],
  operations: PostgrestProcessIdentityCollectorOperations = defaultCollectorOperations,
): Promise<PostgrestProcessIdentityProbeResult> {
  const { pid, identity } = parseProbeArguments(args);
  await assertSandboxedRuntime("Probe", identity, operations);

  const targetStatusBefore = decodeUtf8(await operations.readFile(`/proc/${pid}/status`, MAX_PROC_STATUS_BYTES));
  assertExactStatusIdentity(targetStatusBefore, identity, "PostgREST process");
  const startIdBefore = await processStartId(pid, operations);
  const [executable, commandLineBytes, environmentBytes] = await Promise.all([
    operations.readLink(`/proc/${pid}/exe`),
    operations.readFile(`/proc/${pid}/cmdline`, MAX_PROC_COMMAND_LINE_BYTES),
    operations.readFile(`/proc/${pid}/environ`, MAX_PROC_ENVIRONMENT_BYTES),
  ]);
  const startIdAfter = await processStartId(pid, operations);
  const targetStatusAfter = decodeUtf8(await operations.readFile(`/proc/${pid}/status`, MAX_PROC_STATUS_BYTES));
  assertExactStatusIdentity(targetStatusAfter, identity, "PostgREST process");
  if (startIdBefore !== startIdAfter) throw new Error("PostgREST process changed during identity probe");
  assertExecutablePath(executable);

  return {
    version: 1,
    startId: startIdAfter,
    executable,
    commandLine: commandLine(commandLineBytes),
    environmentNames: environmentNames(environmentBytes),
  };
}

async function verifyTerminationTarget(
  pid: number,
  identity: PostgrestRuntimeIdentity,
  expectedStartId: string,
  operations: PostgrestProcessIdentityCollectorOperations,
): Promise<void> {
  const startIdBefore = await processStartId(pid, operations);
  const targetStatus = decodeUtf8(await operations.readFile(`/proc/${pid}/status`, MAX_PROC_STATUS_BYTES));
  assertExactStatusIdentity(targetStatus, identity, "PostgREST identity probe");
  const startIdAfter = await processStartId(pid, operations);
  if (startIdBefore !== expectedStartId || startIdAfter !== expectedStartId) {
    throw new Error("PostgREST identity probe process changed before termination");
  }
}

export async function terminatePostgrestIdentityProbeByPidfd(
  args: string[],
  operations: PostgrestProcessIdentityCollectorOperations = defaultCollectorOperations,
  pidfdOperations?: LinuxPidfdOperations,
): Promise<void> {
  const { pid, identity, startId } = parseTerminationArguments(args);
  await assertSandboxedRuntime("Termination helper", identity, operations);
  await killVerifiedProcessWithPidfd(
    pid,
    () => verifyTerminationTarget(pid, identity, startId, operations),
    pidfdOperations,
  );
}

function boundedProbeString(candidate: unknown, maxBytes: number): candidate is string {
  return typeof candidate === "string"
    && candidate.length > 0
    && Buffer.byteLength(candidate, "utf8") <= maxBytes;
}

function boundedProbeArgument(candidate: unknown): candidate is string {
  return typeof candidate === "string"
    && Buffer.byteLength(candidate, "utf8") <= MAX_COMMAND_LINE_ARGUMENT_BYTES
    && !candidate.includes("\0");
}

function strictProbeResult(candidate: unknown): PostgrestProcessIdentityProbeResult {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  const probeOutput = candidate as Record<string, unknown>;
  const keys = Object.keys(probeOutput).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "commandLine",
    "environmentNames",
    "executable",
    "startId",
    "version",
  ])) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  if (probeOutput.version !== 1
    || !boundedProbeString(probeOutput.startId, MAX_PROCESS_START_ID_BYTES)
    || !/^(?:0|[1-9]\d*)$/.test(probeOutput.startId)
    || !boundedProbeString(probeOutput.executable, MAX_EXECUTABLE_PATH_BYTES)
    || !isAbsolute(probeOutput.executable)
    || probeOutput.executable.includes("\0")) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  if (!Array.isArray(probeOutput.commandLine)
    || probeOutput.commandLine.length === 0
    || probeOutput.commandLine.length > MAX_COMMAND_LINE_ARGUMENTS
    || probeOutput.commandLine.some((argument) => !boundedProbeArgument(argument))) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  if (!Array.isArray(probeOutput.environmentNames)
    || probeOutput.environmentNames.length > MAX_ENVIRONMENT_NAMES
    || probeOutput.environmentNames.some((name) => !boundedProbeString(name, MAX_ENVIRONMENT_NAME_BYTES)
      || !ENVIRONMENT_NAME_PATTERN.test(name))) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  const sortedNames = [...probeOutput.environmentNames].sort();
  if (JSON.stringify(sortedNames) !== JSON.stringify(probeOutput.environmentNames)
    || new Set(probeOutput.environmentNames).size !== probeOutput.environmentNames.length) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  return probeOutput as unknown as PostgrestProcessIdentityProbeResult;
}

export function parsePostgrestProcessIdentityProbeOutput(
  output: Uint8Array,
): PostgrestProcessIdentity {
  if (output.byteLength === 0 || output.byteLength > POSTGREST_PROCESS_IDENTITY_STDOUT_LIMIT) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  let text: string;
  try {
    text = decodeUtf8(output);
  } catch {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    throw new Error("Invalid PostgREST process identity probe output");
  }
  const { version: _version, ...identity } = strictProbeResult(parsed);
  return identity;
}

export function buildPostgrestProcessIdentityProbeCommand(
  executable: string,
  pid: number,
  identity: PostgrestRuntimeIdentity,
): string[] {
  parseProbeArguments([String(pid), String(identity.uid), String(identity.gid)]);
  if (!isAbsolute(executable)) {
    throw new Error("Invalid PostgREST process identity probe executable");
  }
  return [
    SETPRIV_PATH,
    "--reuid",
    String(identity.uid),
    "--regid",
    String(identity.gid),
    "--clear-groups",
    "--",
    executable,
    POSTGREST_PROCESS_IDENTITY_PROBE_FLAG,
    String(pid),
    String(identity.uid),
    String(identity.gid),
  ];
}

export function buildPostgrestProcessIdentityTerminationCommand(
  executable: string,
  child: PostgrestIdentityProbeProcess,
  identity: PostgrestRuntimeIdentity,
): string[] {
  parseTerminationArguments([
    String(child.pid),
    String(identity.uid),
    String(identity.gid),
    child.startId,
  ]);
  if (!isAbsolute(executable)) {
    throw new Error("Invalid PostgREST process identity termination executable");
  }
  return [
    SETPRIV_PATH,
    "--reuid",
    String(identity.uid),
    "--regid",
    String(identity.gid),
    "--clear-groups",
    "--",
    executable,
    POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG,
    String(child.pid),
    String(identity.uid),
    String(identity.gid),
    child.startId,
  ];
}

function isPermissionDenied(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

const defaultTerminationOperations: PostgrestProcessIdentityTerminationOperations = {
  spawn(command, options) {
    const terminator = Bun.spawn({
      cmd: command,
      cwd: options.cwd,
      env: options.environment,
      stdin: options.stdin,
      stdout: "ignore",
      stderr: "ignore",
    });
    return { exited: terminator.exited };
  },
};

async function processExitWithin(
  exited: Promise<number>,
  timeoutMessage: string,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), POSTGREST_PROCESS_TERMINATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function terminateProbeAsTenant(
  child: PostgrestIdentityProbeProcess,
  identity: PostgrestRuntimeIdentity,
  executable: string,
  operations: PostgrestProcessIdentityTerminationOperations,
): Promise<void> {
  const terminator = operations.spawn(
    buildPostgrestProcessIdentityTerminationCommand(executable, child, identity),
    {
      cwd: "/",
      environment: { LANG: "C", LC_ALL: "C" },
      stdin: "ignore",
    },
  );
  const exitCode = await processExitWithin(
    terminator.exited,
    "PostgREST process identity termination helper timed out",
  );
  if (exitCode !== 0) {
    throw new Error("Failed to terminate PostgREST process identity probe");
  }
}

export async function terminatePostgrestIdentityProbe(
  child: PostgrestIdentityProbeProcess,
  identity: PostgrestRuntimeIdentity,
  executable: string,
  operations: PostgrestProcessIdentityTerminationOperations = defaultTerminationOperations,
): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    await terminateProbeAsTenant(child, identity, executable, operations);
  }
  await processExitWithin(
    child.exited,
    "PostgREST process identity probe did not exit after termination",
  );
}

function sameProcessMetadata(
  before: PostgrestProcessMetadata,
  after: PostgrestProcessMetadata,
): boolean {
  return before.isDirectory && after.isDirectory
    && before.uid === after.uid
    && before.gid === after.gid
    && before.dev === after.dev
    && before.ino === after.ino;
}

function assertProcessOwner(
  metadata: PostgrestProcessMetadata,
  identity: PostgrestRuntimeIdentity,
): void {
  if (!metadata.isDirectory || metadata.uid !== identity.uid || metadata.gid !== identity.gid) {
    throw new Error("PostgREST process has unexpected owner");
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: "stdout" | "stderr",
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`PostgREST process identity probe ${label} output exceeded limit`);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

const defaultParentOperations: PostgrestProcessIdentityParentOperations = {
  async processMetadata(pid) {
    const metadata = await lstat(`/proc/${pid}`);
    return {
      uid: metadata.uid,
      gid: metadata.gid,
      dev: metadata.dev,
      ino: metadata.ino,
      isDirectory: metadata.isDirectory(),
    };
  },
  executablePath: () => realpath(process.execPath),
  async spawn(command, options) {
    const child = Bun.spawn({
      cmd: command,
      cwd: options.cwd,
      env: options.environment,
      stdin: options.stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
    const startId = procStartId(decodeUtf8(
      await readFileBounded(`/proc/${child.pid}/stat`, MAX_PROC_STAT_BYTES),
    ), child.pid);
    return {
      pid: child.pid,
      startId,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal) => { child.kill(signal); },
    };
  },
};

async function completedProbeOutput(
  child: SpawnedPostgrestIdentityProbe,
): Promise<CompletedProbeOutput> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBoundedStream(child.stdout, POSTGREST_PROCESS_IDENTITY_STDOUT_LIMIT, "stdout"),
    readBoundedStream(child.stderr, POSTGREST_PROCESS_IDENTITY_STDERR_LIMIT, "stderr"),
  ]);
  return { exitCode, stdout, stderr };
}

function successfulProbeStdout(completed: CompletedProbeOutput): Uint8Array {
  if (completed.exitCode !== 0 || completed.stderr.byteLength !== 0) {
    throw new Error("PostgREST process identity probe failed");
  }
  return completed.stdout;
}

async function throwProbeFailureAfterTermination(
  child: SpawnedPostgrestIdentityProbe,
  identity: PostgrestRuntimeIdentity,
  executable: string,
  probeError: unknown,
): Promise<never> {
  try {
    await terminatePostgrestIdentityProbe(child, identity, executable);
  } catch (terminationError) {
    throw new AggregateError(
      [probeError, terminationError],
      "PostgREST process identity probe failed and could not be terminated",
    );
  }
  throw probeError;
}

async function boundedProbeStdout(
  child: SpawnedPostgrestIdentityProbe,
  identity: PostgrestRuntimeIdentity,
  executable: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("PostgREST process identity probe timed out"));
    }, timeoutMs);
  });
  let completed: CompletedProbeOutput;
  try {
    completed = await Promise.race([
      completedProbeOutput(child),
      timeoutFailure,
    ]);
  } catch (error) {
    return throwProbeFailureAfterTermination(child, identity, executable, error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return successfulProbeStdout(completed);
}

export async function probePostgrestProcessIdentity(
  pid: number,
  identity: PostgrestRuntimeIdentity,
  operations: PostgrestProcessIdentityParentOperations = defaultParentOperations,
  options: ProbeExecutionOptions = {},
): Promise<PostgrestProcessIdentity> {
  parseProbeArguments([String(pid), String(identity.uid), String(identity.gid)]);
  const timeoutMs = options.timeoutMs ?? POSTGREST_PROCESS_IDENTITY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > POSTGREST_PROCESS_IDENTITY_TIMEOUT_MS) {
    throw new Error("Invalid PostgREST process identity probe timeout");
  }
  const before = await operations.processMetadata(pid);
  assertProcessOwner(before, identity);
  const executable = await operations.executablePath();
  const child = await operations.spawn(
    buildPostgrestProcessIdentityProbeCommand(executable, pid, identity),
    {
      cwd: "/",
      environment: { LANG: "C", LC_ALL: "C" },
      stdin: "ignore",
    },
  );
  const stdout = await boundedProbeStdout(child, identity, executable, timeoutMs);
  const probeIdentity = parsePostgrestProcessIdentityProbeOutput(stdout);
  const after = await operations.processMetadata(pid);
  assertProcessOwner(after, identity);
  if (!sameProcessMetadata(before, after)) {
    throw new Error("PostgREST process changed during identity probe");
  }
  return probeIdentity;
}

export async function runPostgrestProcessIdentityProbe(args: string[]): Promise<number> {
  try {
    const probeIdentity = await collectPostgrestProcessIdentity(args);
    const output = `${JSON.stringify(probeIdentity)}\n`;
    if (Buffer.byteLength(output, "utf8") > POSTGREST_PROCESS_IDENTITY_STDOUT_LIMIT) {
      throw new Error("PostgREST process identity probe output exceeded limit");
    }
    process.stdout.write(output);
    return 0;
  } catch {
    process.stderr.write("PostgREST process identity probe failed\n");
    return 1;
  }
}

export async function runPostgrestProcessIdentityTermination(args: string[]): Promise<number> {
  try {
    await terminatePostgrestIdentityProbeByPidfd(args);
    return 0;
  } catch {
    process.stderr.write("PostgREST process identity termination failed\n");
    return 1;
  }
}
