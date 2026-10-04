import { Value } from "typebox/value";
import {
  ApplicationIdSchema, parseApplicationReleaseRecord, type ApplicationReleaseRecord,
  type WorkerExecutionGroup,
} from "@supacloud/delivery";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { installManagedSystemdUnit } from "./systemd-unit-broker";

const RUNTIME_ROOT = "/var/supacloud/application-runtime";
const ACTIVATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface ApplicationRuntimeInput {
  release: ApplicationReleaseRecord;
  activationId: string;
  environmentId: string;
  bunVersion?: string;
  ports: Readonly<Record<string, number>>;
}

export interface ApplicationRuntimeTarget {
  name: string;
  sourceTarget?: string;
  execution?: WorkerExecutionGroup;
  kind: "http" | "worker";
  objectId: string;
  unit: string;
  directory: string;
  environmentFile: string;
  entrypoint: string;
  port: number | null;
  unitContent: string;
}

export interface ApplicationRuntimePlan {
  projectRef: string;
  applicationId: string;
  releaseId: string;
  manifestSha256: string;
  activationId: string;
  environmentId: string;
  bunVersion: string;
  directory: string;
  targets: ApplicationRuntimeTarget[];
}

/** Concrete paths contain no mutable "current" pointer: one activation owns all targets. */
export function applicationRuntimePlan(input: ApplicationRuntimeInput): ApplicationRuntimePlan {
  const release = parseApplicationReleaseRecord(input.release);
  const bunVersion = input.bunVersion ?? "1.4.2";
  if (!/^[a-z0-9-]{1,20}$/.test(release.project_ref) || !ACTIVATION_ID.test(input.activationId)
    || !Value.Check(ApplicationIdSchema, input.environmentId) || !/^\d+\.\d+\.\d+$/.test(bunVersion)) {
    throw new Error("Invalid application runtime identity");
  }
  const httpTargets = release.targets.filter(target => target.kind === "http");
  if (Object.keys(input.ports).sort().join("\0") !== httpTargets.map(target => target.name).sort().join("\0")
    || new Set(Object.values(input.ports)).size !== httpTargets.length
    || Object.values(input.ports).some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error("Invalid application runtime ports");
  }
  const directory = join(RUNTIME_ROOT, release.project_ref, input.activationId);
  const plan: ApplicationRuntimePlan = {
    projectRef: release.project_ref, applicationId: release.application_id,
    releaseId: release.release_id, manifestSha256: release.manifest_sha256,
    activationId: input.activationId, environmentId: input.environmentId, bunVersion, directory,
    targets: [],
  };
  plan.targets = release.targets.flatMap(target => Array.from({ length: target.execution?.replicas ?? 1 }, (_, replica) => {
    const execution = target.execution;
    const name = execution ? `${target.name}-r${replica + 1}` : target.name;
    const unit = `supacloud-application-${release.project_ref}-${input.activationId}-${name}.service`;
    const objectDirectory = join(directory, "objects", target.object_id);
    const environmentFile = join(directory, `${name}.env`);
    const entrypoint = join(objectDirectory, target.entrypoint);
    const port = target.kind === "http" ? input.ports[target.name]! : null;
    const unitContent = `[Unit]
Description=SupaCloud Application ${release.application_id}: ${target.name}
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
User=supacloud-${release.project_ref}
Group=supacloud-${release.project_ref}
WorkingDirectory=${objectDirectory}
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=full
EnvironmentFile=${environmentFile}
Environment="NODE_ENV=production"
Environment="HOST=127.0.0.1"
${port === null ? "" : `Environment="PORT=${port}"\n`}Environment="SUPACLOUD_PROJECT_REF=${release.project_ref}"
Environment="SUPACLOUD_APPLICATION_ID=${release.application_id}"
Environment="SUPACLOUD_RELEASE_ID=${release.release_id}"
Environment="SUPACLOUD_ACTIVATION_ID=${input.activationId}"
Environment="SUPACLOUD_ENVIRONMENT_ID=${input.environmentId}"
Environment="SUPACLOUD_TARGET=${name}"
Environment="SUPACLOUD_OBJECT_ID=${target.object_id}"
Environment="SHUTDOWN_TIMEOUT_MS=${execution ? execution.lifecycle.shutdownGraceSeconds * 1000 : 10000}"
${execution ? `Environment="SUPACLOUD_WORKER_EXECUTION=${Buffer.from(JSON.stringify(execution)).toString("base64")}"
Environment="SUPACLOUD_WORKER_REPLICA=${replica + 1}"
CPUAccounting=true
MemoryAccounting=true
CPUQuota=${Math.round(execution.resources.cpuLimit * 100)}%
MemoryMax=${execution.resources.memoryLimitMiB * 1024 * 1024}
MemorySwapMax=0
KillMode=control-group
` : ""}ExecStart=/opt/supacloud/bun/${bunVersion}/bun --no-env-file ${entrypoint}
Restart=on-failure
RestartSec=3
TimeoutStopSec=${execution ? execution.lifecycle.shutdownGraceSeconds + 5 : 15}
LimitNOFILE=65536
SyslogIdentifier=${unit.slice(0, -8)}

[Install]
WantedBy=multi-user.target
`;
    return {
      name, kind: target.kind, objectId: target.object_id,
      ...(execution ? { sourceTarget: target.name, execution } : {}),
      unit, directory: objectDirectory, environmentFile, entrypoint, port, unitContent,
    };
  }));
  if (plan.targets.length > 32 || new Set(plan.targets.map(target => target.name)).size !== plan.targets.length) {
    throw new Error("APPLICATION_RUNTIME_TARGET_CONFLICT");
  }
  return plan;
}

export interface ApplicationProcessObservation {
  target: string;
  unit: string;
  loadState: string;
  activeState: string;
  subState: string;
  mainPid: number;
  invocationId: string | null;
  result: string;
  processRunning: boolean;
  resourcesVerified?: boolean;
}

export interface ApplicationSystemdOperations {
  install(unit: string, content: string): Promise<void>;
  command(args: string[], signal?: AbortSignal): Promise<{ exitCode: number; stdout: string }>;
  resources?(target: ApplicationRuntimeTarget, controlGroup: string, signal?: AbortSignal): Promise<boolean>;
}

const operations: ApplicationSystemdOperations = {
  install: installManagedSystemdUnit,
  async resources(target, controlGroup, signal) {
    if (!target.execution || !/^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+$/.test(controlGroup)
      || controlGroup.split("/").some(part => part === "." || part === "..")
      || !controlGroup.endsWith(`/${target.unit}`)) return false;
    try {
      signal?.throwIfAborted();
      const root = `/sys/fs/cgroup${controlGroup}`;
      const [cpu, memory, swap] = await Promise.all([
        readFile(`${root}/cpu.max`, "utf8"), readFile(`${root}/memory.max`, "utf8"),
        readFile(`${root}/memory.swap.max`, "utf8"),
      ]);
      signal?.throwIfAborted();
      const match = /^([1-9][0-9]*) ([1-9][0-9]*)\n?$/.exec(cpu);
      return !!match && Math.abs(Number(match[1]) / Number(match[2]) - target.execution.resources.cpuLimit) < 0.00001
        && memory.trim() === String(target.execution.resources.memoryLimitMiB * 1024 * 1024) && swap.trim() === "0";
    } catch { return false; }
  },
  async command(args, signal) {
    signal?.throwIfAborted();
    const child = Bun.spawn({
      cmd: ["systemctl", ...args], stdout: "pipe", stderr: "ignore",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      signal?.throwIfAborted();
      return { stdout, exitCode };
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
    }
  },
};

function observation(target: ApplicationRuntimeTarget, stdout: string): ApplicationProcessObservation {
  const properties = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    const index = line.indexOf("=");
    if (index < 1 || properties.has(line.slice(0, index))) throw new Error("Invalid application process observation");
    properties.set(line.slice(0, index), line.slice(index + 1));
  }
  for (const key of ["LoadState", "ActiveState", "SubState", "MainPID", "InvocationID", "Result"]) {
    if (!properties.has(key)) throw new Error("Incomplete application process observation");
  }
  const pid = properties.get("MainPID")!;
  const invocation = properties.get("InvocationID")!;
  if (!/^(0|[1-9][0-9]*)$/.test(pid) || !Number.isSafeInteger(Number(pid))
    || (invocation !== "" && !/^[a-f0-9]{32}$/.test(invocation))) {
    throw new Error("Invalid application process identity");
  }
  const loadState = properties.get("LoadState")!;
  const activeState = properties.get("ActiveState")!;
  const subState = properties.get("SubState")!;
  const resourcesVerified = !target.execution || (
    systemdMicroseconds(properties.get("CPUQuotaPerSecUSec")) === Math.round(target.execution.resources.cpuLimit * 1_000_000)
    && properties.get("MemoryMax") === String(target.execution.resources.memoryLimitMiB * 1024 * 1024)
    && properties.get("MemorySwapMax") === "0"
    && properties.get("CPUAccounting") === "yes" && properties.get("MemoryAccounting") === "yes"
    && properties.get("KillMode") === "control-group");
  return {
    target: target.name, unit: target.unit, loadState, activeState, subState,
    mainPid: Number(pid), invocationId: invocation || null, result: properties.get("Result")!,
    ...(target.execution ? { resourcesVerified } : {}),
    // This is process liveness, deliberately not application/worker readiness.
    processRunning: loadState === "loaded" && activeState === "active" && subState === "running"
      && Number(pid) > 0 && invocation !== "",
  };
}

function systemdMicroseconds(value: string | undefined): number | null {
  if (!value || !/^(?:[0-9]+(?:\.[0-9]+)?(?:us|ms|s|min|h)(?: |$))+$/.test(value)) return null;
  const units: Record<string, number> = { us: 1, ms: 1000, s: 1_000_000, min: 60_000_000, h: 3_600_000_000 };
  return value.split(" ").reduce((sum, part) => {
    const match = /^([0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h)$/.exec(part)!;
    return sum + Number(match[1]) * units[match[2]!]!;
  }, 0);
}

export class ApplicationSystemdRuntime {
  constructor(private readonly systemd: ApplicationSystemdOperations = operations) {}

  async install(input: ApplicationRuntimeInput): Promise<ApplicationRuntimePlan> {
    const plan = applicationRuntimePlan(input);
    for (const target of plan.targets) await this.systemd.install(target.unit, target.unitContent);
    return plan;
  }

  async start(input: ApplicationRuntimeInput): Promise<ApplicationProcessObservation[]> {
    const plan = applicationRuntimePlan(input);
    const result = await this.systemd.command(["start", ...plan.targets.map(target => target.unit)]);
    if (result.exitCode !== 0) throw new Error("APPLICATION_RUNTIME_START_FAILED");
    return this.inspect(input);
  }

  async stop(input: ApplicationRuntimeInput): Promise<ApplicationProcessObservation[]> {
    const plan = applicationRuntimePlan(input);
    const result = await this.systemd.command(["stop", ...plan.targets.map(target => target.unit)]);
    if (result.exitCode !== 0) throw new Error("APPLICATION_RUNTIME_STOP_FAILED");
    return this.requireStopped(input);
  }

  async requireStopped(input: ApplicationRuntimeInput, signal?: AbortSignal): Promise<ApplicationProcessObservation[]> {
    const states = await this.inspect(input, signal);
    if (states.some(state => state.mainPid !== 0 || !["inactive", "failed"].includes(state.activeState))) {
      throw new Error("APPLICATION_RUNTIME_STOP_UNCONFIRMED");
    }
    return states;
  }

  async inspect(input: ApplicationRuntimeInput, signal?: AbortSignal): Promise<ApplicationProcessObservation[]> {
    signal?.throwIfAborted();
    const plan = applicationRuntimePlan(input);
    return Promise.all(plan.targets.map(async target => {
      const result = await this.systemd.command([
        "show", target.unit,
        `--property=LoadState,ActiveState,SubState,MainPID,InvocationID,Result${target.execution
          ? ",CPUQuotaPerSecUSec,MemoryMax,MemorySwapMax,CPUAccounting,MemoryAccounting,KillMode,ControlGroup" : ""}`,
        "--all", "--no-pager",
      ], signal);
      signal?.throwIfAborted();
      if (result.exitCode !== 0) throw new Error("APPLICATION_RUNTIME_OBSERVATION_FAILED");
      const state = observation(target, result.stdout);
      if (target.execution && state.resourcesVerified) {
        const controlGroup = result.stdout.split("\n").find(line => line.startsWith("ControlGroup="))?.slice(13);
        state.resourcesVerified = !!controlGroup && await this.systemd.resources?.(target, controlGroup, signal) === true;
      }
      return state;
    }));
  }
}
