import { realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  readPostgrestPointerTarget,
  validatePostgrestGenerationTarget,
  type PostgrestControlOwnership,
} from "./postgrest-generation";
import {
  parseLinuxRuntimeId,
  parseSystemdMainPid,
  probePostgrestProcessIdentity,
  type PostgrestProcessIdentity,
  type PostgrestRuntimeIdentity,
} from "./postgrest-process-identity";

export type { PostgrestProcessIdentity } from "./postgrest-process-identity";

export type PostgrestAttestationState =
  | "loaded"
  | "stale"
  | "drifted"
  | "unverified_legacy"
  | "stopped"
  | "unreachable";

export interface PostgrestAttestation {
  desiredRevision: string | null;
  loadedRevision: string | null;
  attestationState: PostgrestAttestationState;
  matchesDesired: boolean | null;
  actual: "running" | "stopped" | "starting" | "error";
  health: "healthy" | "unhealthy" | "unknown";
  loadedAt: string | null;
}

export type PostgrestSystemdActivity =
  | "active"
  | "activating"
  | "reloading"
  | "deactivating"
  | "inactive"
  | "failed";

export interface SystemdProcessIdentity {
  activity: PostgrestSystemdActivity;
  mainPid: number;
  invocationId: string;
  startMonotonic: string;
  loadedAt: string | null;
}

export interface PostgrestAttestationOperations {
  systemdMainProcess(unit: string): Promise<SystemdProcessIdentity>;
  runtimeIdentity(projectRef: string): Promise<PostgrestRuntimeIdentity>;
  processIdentity(pid: number, identity: PostgrestRuntimeIdentity): Promise<PostgrestProcessIdentity>;
  health(port: number): Promise<"healthy" | "unhealthy">;
}

export interface PostgrestAttestationRequest {
  projectRef: string;
  desiredRevision: string | null;
  port: number;
  unit: string;
  tenantDirectory: string;
  postgrestBinary: string;
  controlOwnerUid?: number;
}

type ValidatedGeneration = { path: string; revision: string };
type ControlPointerObservation =
  | { kind: "valid"; target: string; generation: ValidatedGeneration }
  | { kind: "absent" | "invalid" };

const ID_PATH = "/usr/bin/id";

function systemdTimestamp(rawTimestamp: string): string | null {
  if (!rawTimestamp || rawTimestamp === "n/a") return null;
  const timestamp = Date.parse(rawTimestamp);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parsePostgrestSystemdShow(output: string): SystemdProcessIdentity {
  const properties = new Map(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const rawPid = properties.get("MainPID") || "";
  let mainPid: number;
  try {
    mainPid = parseSystemdMainPid(rawPid);
  } catch {
    throw new Error("Invalid systemd MainPID");
  }
  const activity = properties.get("ActiveState") || "";
  if (!["active", "activating", "reloading", "deactivating", "inactive", "failed"].includes(activity)) {
    throw new Error("Invalid systemd ActiveState");
  }
  const invocationId = properties.get("InvocationID") || "";
  const startMonotonic = properties.get("ExecMainStartTimestampMonotonic") || "";
  if (activity === "active" && (
    mainPid <= 0
    || !/^[a-f0-9]{32}$/.test(invocationId)
    || !/^\d+$/.test(startMonotonic)
  )) {
    throw new Error("Invalid active systemd process identity");
  }
  if (activity === "inactive" && mainPid !== 0) {
    throw new Error("Inactive systemd unit reported a main process");
  }
  return {
    activity: activity as PostgrestSystemdActivity,
    mainPid,
    invocationId,
    startMonotonic,
    loadedAt: systemdTimestamp(properties.get("ExecMainStartTimestamp") || ""),
  };
}

async function runCommand(command: string[]): Promise<string> {
  const child = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Command exited with code ${exitCode}`);
  }
  return stdout;
}

const defaultOperations: PostgrestAttestationOperations = {
  async systemdMainProcess(unit) {
    return parsePostgrestSystemdShow(await runCommand([
      "systemctl",
      "show",
      unit,
      "--property=ActiveState",
      "--property=MainPID",
      "--property=InvocationID",
      "--property=ExecMainStartTimestampMonotonic",
      "--property=ExecMainStartTimestamp",
    ]));
  },
  async runtimeIdentity(projectRef) {
    const runtimeUser = `supacloud-${projectRef}`;
    const [userId, groupId] = await Promise.all([
      runCommand([ID_PATH, "-u", runtimeUser]),
      runCommand([ID_PATH, "-g", runtimeUser]),
    ]);
    const uid = userId.trim();
    const gid = groupId.trim();
    try {
      return { uid: parseLinuxRuntimeId(uid), gid: parseLinuxRuntimeId(gid) };
    } catch {
      throw new Error("Invalid tenant runtime identity");
    }
  },
  processIdentity(pid, identity) {
    return probePostgrestProcessIdentity(pid, identity);
  },
  async health(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(3_000),
      });
      return response.status < 500 ? "healthy" : "unhealthy";
    } catch (error: unknown) {
      if (error instanceof Error) return "unhealthy";
      throw error;
    }
  },
};

async function loadedGeneration(
  configPath: string,
  request: PostgrestAttestationRequest,
  ownership: PostgrestControlOwnership,
): Promise<ValidatedGeneration | null> {
  const tenantDirectory = resolve(request.tenantDirectory);
  const absoluteConfigPath = resolve(configPath);
  const pointerTarget = relative(tenantDirectory, absoluteConfigPath);
  if (pointerTarget.startsWith("..") || resolve(tenantDirectory, pointerTarget) !== absoluteConfigPath) {
    return null;
  }
  try {
    return await validatePostgrestGenerationTarget(
      tenantDirectory,
      request.projectRef,
      pointerTarget,
      ownership,
    );
  } catch {
    return null;
  }
}

function sameProcess(
  beforeSystemd: SystemdProcessIdentity,
  afterSystemd: SystemdProcessIdentity,
  beforeProcess: PostgrestProcessIdentity,
  afterProcess: PostgrestProcessIdentity,
): boolean {
  return beforeSystemd.activity === "active" && afterSystemd.activity === "active"
    && beforeSystemd.mainPid === afterSystemd.mainPid
    && beforeSystemd.invocationId === afterSystemd.invocationId
    && beforeSystemd.startMonotonic === afterSystemd.startMonotonic
    && beforeProcess.startId === afterProcess.startId
    && beforeProcess.executable === afterProcess.executable
    && JSON.stringify(beforeProcess.commandLine) === JSON.stringify(afterProcess.commandLine)
    && JSON.stringify(beforeProcess.environmentNames) === JSON.stringify(afterProcess.environmentNames);
}

function actualState(health: "healthy" | "unhealthy" | "unknown"): "running" | "error" {
  return health === "healthy" ? "running" : "error";
}

type FailureAttestationDetails = {
  loadedAt?: string | null;
  loadedRevision?: string | null;
  matchesDesired?: boolean | null;
  actual?: PostgrestAttestation["actual"];
};

function failureAttestation(
  desiredRevision: string | null,
  state: "drifted" | "unverified_legacy" | "unreachable",
  health: "healthy" | "unhealthy" | "unknown",
  details: FailureAttestationDetails = {},
): PostgrestAttestation {
  return {
    desiredRevision,
    loadedRevision: details.loadedRevision ?? null,
    attestationState: state,
    matchesDesired: details.matchesDesired ?? null,
    actual: details.actual ?? actualState(health),
    health,
    loadedAt: details.loadedAt ?? null,
  };
}

async function controlPointerObservation(
  request: PostgrestAttestationRequest,
  ownership: PostgrestControlOwnership,
): Promise<ControlPointerObservation> {
  try {
    const pointerTarget = await readPostgrestPointerTarget(
      join(request.tenantDirectory, `${request.projectRef}_postgrest.current`),
      request.projectRef,
      ownership,
    );
    if (!pointerTarget) return { kind: "absent" };
    return {
      kind: "valid",
      target: pointerTarget,
      generation: await validatePostgrestGenerationTarget(
        request.tenantDirectory,
        request.projectRef,
        pointerTarget,
        ownership,
      ),
    };
  } catch {
    return { kind: "invalid" };
  }
}

function pointerRevision(observation: ControlPointerObservation): string | null {
  return observation.kind === "valid" ? observation.generation.revision : null;
}

function stableControlPointer(
  before: ControlPointerObservation,
  after: ControlPointerObservation,
): boolean {
  if (before.kind === "absent" || after.kind === "absent") {
    return before.kind === "absent" && after.kind === "absent";
  }
  if (before.kind !== "valid" || after.kind !== "valid") return false;
  return before.target === after.target
    && before.generation.path === after.generation.path
    && before.generation.revision === after.generation.revision;
}

function loadedMatchesDesired(
  desiredRevision: string | null,
  loadedRevision: string | null,
): boolean | null {
  return desiredRevision && loadedRevision ? desiredRevision === loadedRevision : null;
}

function legacyCommandLine(request: PostgrestAttestationRequest, commandLine: string[]): boolean {
  return commandLine.includes(join(request.tenantDirectory, `${request.projectRef}.conf`));
}

function managedConfigArgument(commandLine: string[]): string | null {
  const configArguments = commandLine.filter((argument) => argument.endsWith(".conf"));
  return configArguments.length === 1 && commandLine[1] === configArguments[0]
    ? configArguments[0]
    : null;
}

function hasPostgrestEnvironmentOverride(identity: PostgrestProcessIdentity): boolean {
  return identity.environmentNames.some((name) => name.startsWith("PGRST_"));
}

function nonActiveAttestation(
  request: PostgrestAttestationRequest,
  pointer: ControlPointerObservation,
  systemd: SystemdProcessIdentity,
): PostgrestAttestation | null {
  if (systemd.activity === "active") return null;
  if (systemd.activity === "inactive") {
    return {
      desiredRevision: request.desiredRevision,
      loadedRevision: null,
      attestationState: pointer.kind === "invalid" ? "drifted" : "stopped",
      matchesDesired: null,
      actual: "stopped",
      health: "unknown",
      loadedAt: null,
    };
  }
  const failed = systemd.activity === "failed";
  return failureAttestation(
    request.desiredRevision,
    "unreachable",
    failed ? "unhealthy" : "unknown",
    { actual: failed ? "error" : "starting" },
  );
}

type ActiveRuntimeObservation = {
  request: PostgrestAttestationRequest;
  pointerBefore: ControlPointerObservation;
  pointerAfter: ControlPointerObservation;
  systemdBefore: SystemdProcessIdentity;
  systemdAfter: SystemdProcessIdentity;
  beforeProcess: PostgrestProcessIdentity;
  afterProcess: PostgrestProcessIdentity;
  expectedExecutable: string;
  health: "healthy" | "unhealthy";
  loaded: ValidatedGeneration | null;
};

function changedUnitAttestation(
  request: PostgrestAttestationRequest,
  systemd: SystemdProcessIdentity,
  health: "healthy" | "unhealthy",
): PostgrestAttestation | null {
  if (systemd.activity === "active" && systemd.mainPid > 0) return null;
  const failed = systemd.activity === "failed";
  const actual = failed ? "error" : (systemd.activity === "inactive" ? "stopped" : "starting");
  return failureAttestation(
    request.desiredRevision,
    "unreachable",
    failed ? "unhealthy" : health,
    { actual },
  );
}

function bindingFailure(
  observation: ActiveRuntimeObservation,
  loadedRevision: string | null,
  matchesDesired: boolean | null,
): PostgrestAttestation | null {
  const { request, pointerBefore, pointerAfter, systemdAfter, beforeProcess } = observation;
  const details = { loadedAt: systemdAfter.loadedAt, loadedRevision, matchesDesired };
  if (!stableControlPointer(pointerBefore, pointerAfter)) {
    return failureAttestation(request.desiredRevision, "drifted", observation.health, details);
  }
  if (beforeProcess.executable !== observation.expectedExecutable
    || hasPostgrestEnvironmentOverride(beforeProcess)) {
    return failureAttestation(request.desiredRevision, "drifted", observation.health, {
      loadedAt: systemdAfter.loadedAt,
    });
  }
  if (legacyCommandLine(request, beforeProcess.commandLine)) {
    return failureAttestation(request.desiredRevision, "unverified_legacy", observation.health, {
      loadedAt: systemdAfter.loadedAt,
    });
  }
  return pointerAfter.kind !== "valid" || !observation.loaded
    ? failureAttestation(request.desiredRevision, "drifted", observation.health, details)
    : null;
}

function generationAttestation(
  observation: ActiveRuntimeObservation,
): PostgrestAttestation {
  const loadedRevision = observation.loaded?.revision || null;
  const matchesDesired = loadedMatchesDesired(observation.request.desiredRevision, loadedRevision);
  const failure = bindingFailure(observation, loadedRevision, matchesDesired);
  if (failure) return failure;
  const loaded = observation.loaded!;
  if (!observation.request.desiredRevision) {
    return failureAttestation(null, "unreachable", observation.health, {
      loadedAt: observation.systemdAfter.loadedAt,
      loadedRevision: loaded.revision,
    });
  }
  if (pointerRevision(observation.pointerAfter) !== loaded.revision && matchesDesired === true) {
    return failureAttestation(observation.request.desiredRevision, "drifted", observation.health, {
      loadedAt: observation.systemdAfter.loadedAt,
      loadedRevision: loaded.revision,
      matchesDesired: true,
    });
  }
  return {
    desiredRevision: observation.request.desiredRevision,
    loadedRevision: loaded.revision,
    attestationState: matchesDesired ? "loaded" : "stale",
    matchesDesired,
    actual: actualState(observation.health),
    health: observation.health,
    loadedAt: observation.systemdAfter.loadedAt,
  };
}

async function attestActivePostgrestRuntime(
  request: PostgrestAttestationRequest,
  operations: PostgrestAttestationOperations,
  ownership: PostgrestControlOwnership,
  runtimeIdentity: PostgrestRuntimeIdentity,
  pointerBefore: ControlPointerObservation,
  systemdBefore: SystemdProcessIdentity,
): Promise<PostgrestAttestation> {
  try {
    const beforeProcess = await operations.processIdentity(systemdBefore.mainPid, runtimeIdentity);
    const expectedExecutable = await realpath(request.postgrestBinary);
    const health = await operations.health(request.port);
    const configArgument = managedConfigArgument(beforeProcess.commandLine);
    const loaded = configArgument ? await loadedGeneration(configArgument, request, ownership) : null;
    const pointerAfter = await controlPointerObservation(request, ownership);
    const systemdAfter = await operations.systemdMainProcess(request.unit);
    const changedUnit = changedUnitAttestation(request, systemdAfter, health);
    if (changedUnit) return changedUnit;
    const afterProcess = await operations.processIdentity(systemdAfter.mainPid, runtimeIdentity);
    if (!sameProcess(systemdBefore, systemdAfter, beforeProcess, afterProcess)) {
      return failureAttestation(request.desiredRevision, "unreachable", health);
    }
    return generationAttestation({
      request,
      pointerBefore,
      pointerAfter,
      systemdBefore,
      systemdAfter,
      beforeProcess,
      afterProcess,
      expectedExecutable,
      health,
      loaded,
    });
  } catch {
    return failureAttestation(request.desiredRevision, "unreachable", "unknown");
  }
}

export async function attestPostgrestRuntime(
  request: PostgrestAttestationRequest,
  operations: PostgrestAttestationOperations = defaultOperations,
): Promise<PostgrestAttestation> {
  let ownership: PostgrestControlOwnership;
  let runtimeIdentity: PostgrestRuntimeIdentity;
  try {
    runtimeIdentity = await operations.runtimeIdentity(request.projectRef);
    ownership = {
      controlOwnerUid: request.controlOwnerUid ?? 0,
      runtimeGroupGid: runtimeIdentity.gid,
    };
  } catch {
    return failureAttestation(request.desiredRevision, "unreachable", "unknown");
  }

  const pointerBefore = await controlPointerObservation(request, ownership);
  let systemdBefore: SystemdProcessIdentity;
  try {
    systemdBefore = await operations.systemdMainProcess(request.unit);
  } catch {
    return failureAttestation(request.desiredRevision, "unreachable", "unknown");
  }
  const nonActive = nonActiveAttestation(request, pointerBefore, systemdBefore);
  return nonActive ?? attestActivePostgrestRuntime(
    request,
    operations,
    ownership,
    runtimeIdentity,
    pointerBefore,
    systemdBefore,
  );
}
