import type { SQL } from "bun";
import { createServer } from "node:net";
import { Value } from "typebox/value";
import {
  ApplicationConfigurationIdSchema, parseApplicationReleaseRecord, workerResourceUsage, assertWorkerBudget,
  type WorkerResourceUsage,
} from "@supacloud/delivery";
import { config } from "../config";
import { sql } from "../db";
import { stableSha256, stableStringify } from "../utils/stable-json";
import { normalizeProjectConfig } from "../utils/project-config";
import { applicationRuntimePlan, type ApplicationRuntimeInput } from "./application-runtime";

export interface ApplicationRuntimeAllocationInput {
  runtime: Omit<ApplicationRuntimeInput, "ports">;
  configurationId: string;
}
export interface ApplicationRuntimeAllocation {
  schema: "supacloud.application-runtime-allocation.v1";
  runtime: ApplicationRuntimeInput;
  configurationId: string;
  createdAt: string;
  retiredAt?: string;
}
export interface ApplicationPortRange { start: number; end: number }
export interface ApplicationCapacityBudget extends WorkerResourceUsage {
  ports: number;
}
export interface ApplicationCapacityReport {
  schema: "supacloud.application-capacity-report.v1";
  projectRef: string;
  generatedAt: string;
  budget: ApplicationCapacityBudget | null;
  usage: ApplicationCapacityBudget;
  remaining: ApplicationCapacityBudget | null;
  pressure: "unknown" | "normal" | "elevated" | "exhausted";
  activeAllocations: number;
  activePorts: number;
  projectAllocations: number;
  projectUsage: WorkerResourceUsage;
  queueOwners: Array<{
    queue: string;
    projectRef: string;
    applicationId: string;
    environmentId: string;
    activationId: string;
  }>;
}
export interface ApplicationCapacityHistoryEntry {
  generatedAt: string;
  budget: ApplicationCapacityBudget | null;
  usage: ApplicationCapacityBudget;
  pressure: ApplicationCapacityReport["pressure"];
  activeAllocations: number;
  activePorts: number;
}
interface AllocationOptions {
  database?: SQL;
  range?: ApplicationPortRange;
  isAvailable?: (port: number) => Promise<boolean>;
  reservedPorts?: (transaction: SQL) => Promise<readonly number[]>;
  workerBudget?: unknown;
}
interface AllocationRow {
  project_ref: string;
  activation_id: string;
  configuration_id: string;
  request_fingerprint: string;
  runtime: ApplicationRuntimeInput;
  owned_ports: unknown;
  created_at: Date | string;
  retired_at: Date | string | null;
  retirement_fingerprint: string | null;
}

export function applicationResourceUsage(release: ApplicationRuntimeInput["release"]): WorkerResourceUsage {
  const usage = workerResourceUsage(release.targets.flatMap(target => target.execution ? [target.execution] : []));
  for (const target of release.targets) {
    if (!target.compute) continue;
    usage.cpu = Math.round((usage.cpu + target.compute.cpuLimit) * 10) / 10;
    usage.memoryMiB += target.compute.memoryLimitMiB;
  }
  return usage;
}

function emptyUsage(): WorkerResourceUsage {
  return { cpu: 0, memoryMiB: 0, connections: 0, concurrency: 0 };
}

function addUsage(left: WorkerResourceUsage, right: WorkerResourceUsage): WorkerResourceUsage {
  return {
    cpu: Math.round((left.cpu + right.cpu) * 10) / 10,
    memoryMiB: left.memoryMiB + right.memoryMiB,
    connections: left.connections + right.connections,
    concurrency: left.concurrency + right.concurrency,
  };
}

function capacityBudget(value: unknown): ApplicationCapacityBudget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const numbers = ["cpu", "memoryMiB", "connections", "concurrency", "ports"] as const;
  if (numbers.some(key => typeof candidate[key] !== "number"
    || !Number.isFinite(candidate[key]) || candidate[key] < 0)) return null;
  return {
    cpu: candidate["cpu"] as number,
    memoryMiB: candidate["memoryMiB"] as number,
    connections: candidate["connections"] as number,
    concurrency: candidate["concurrency"] as number,
    ports: candidate["ports"] as number,
  };
}

export function buildApplicationCapacityReport(input: {
  projectRef: string;
  allocations: readonly ApplicationRuntimeAllocation[];
  budget: ApplicationCapacityBudget | null;
  activePorts: number;
  queueOwners?: ApplicationCapacityReport["queueOwners"];
  generatedAt?: string;
}): ApplicationCapacityReport {
  const usage = input.allocations.reduce<ApplicationCapacityBudget>((total, candidate) => ({
    ...addUsage(total, applicationResourceUsage(candidate.runtime.release)),
    ports: total.ports + Object.keys(candidate.runtime.ports).length,
  }), { ...emptyUsage(), ports: 0 });
  const projectAllocations = input.allocations.filter(candidate =>
    candidate.runtime.release.project_ref === input.projectRef);
  const projectUsage = projectAllocations.reduce(
    (total, candidate) => addUsage(total, applicationResourceUsage(candidate.runtime.release)),
    emptyUsage(),
  );
  const remaining = input.budget ? {
    cpu: Math.max(0, Math.round((input.budget.cpu - usage.cpu) * 10) / 10),
    memoryMiB: Math.max(0, input.budget.memoryMiB - usage.memoryMiB),
    connections: Math.max(0, input.budget.connections - usage.connections),
    concurrency: Math.max(0, input.budget.concurrency - usage.concurrency),
    ports: Math.max(0, input.budget.ports - input.activePorts),
  } : null;
  const exhausted = remaining && Object.values(remaining).some(value => value === 0);
  const elevated = remaining && input.budget
    ? Object.entries(remaining).some(([key, value]) => value / input.budget![key as keyof ApplicationCapacityBudget] <= 0.2)
    : false;
  return {
    schema: "supacloud.application-capacity-report.v1",
    projectRef: input.projectRef,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    budget: input.budget,
    usage,
    remaining,
    pressure: !input.budget ? "unknown" : exhausted ? "exhausted" : elevated ? "elevated" : "normal",
    activeAllocations: input.allocations.length,
    activePorts: input.activePorts,
    projectAllocations: projectAllocations.length,
    projectUsage,
    queueOwners: input.queueOwners ?? [],
  };
}

function configuredCapacityBudget(): ApplicationCapacityBudget | null {
  try {
    const worker = JSON.parse(process.env["SUPACLOUD_APPLICATION_WORKER_BUDGET_JSON"] ?? "null");
    const ports = configuredApplicationPortRange();
    const parsed = capacityBudget({ ...((worker && typeof worker === "object") ? worker : {}), ports: ports.end - ports.start + 1 });
    return parsed;
  } catch {
    return null;
  }
}

function parseStoredBudget(value: unknown): ApplicationCapacityBudget | null {
  return capacityBudget(value);
}

function assertCapacityBudget(usage: WorkerResourceUsage, ports: number, budget: ApplicationCapacityBudget): void {
  if (usage.cpu > budget.cpu || usage.memoryMiB > budget.memoryMiB
    || usage.connections > budget.connections || usage.concurrency > budget.concurrency
    || ports > budget.ports) {
    throw new ApplicationRuntimeAllocationError("APPLICATION_CAPACITY_POLICY_EXCEEDED");
  }
}
export class ApplicationRuntimeAllocationError extends Error {
  constructor(readonly code: string) { super(code); }
}

function validRange(range: ApplicationPortRange): ApplicationPortRange {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
    || range.start < 1024 || range.end > 65535 || range.end < range.start) {
    throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_RANGE_INVALID");
  }
  return { start: range.start, end: range.end };
}

function parseRange(value: string): ApplicationPortRange {
  const match = /^([0-9]+)-([0-9]+)$/.exec(value);
  if (!match) throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_RANGE_INVALID");
  return validRange({ start: Number(match[1]), end: Number(match[2]) });
}

/** The single-host application pool must be disjoint from the existing runtime pools. */
export function configuredApplicationPortRange(): ApplicationPortRange {
  const range = parseRange(config.applicationRuntimePortRange);
  const tenantParts = config.portRange.split("-").map(Number);
  const tenantSize = tenantParts.length === 2 ? tenantParts[1]! - tenantParts[0]! : tenantParts[0]!;
  if (!Number.isInteger(tenantSize) || tenantSize < 1) {
    throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_RANGE_INVALID");
  }
  const excluded = [
    // Legacy frontend SSR allocation is fixed at 30000 + deployment hash % 10000.
    { start: 30000, end: 39999 },
    parseRange(config.jitDatabaseGatewayPortRange),
    ...[config.pgrstPortBase, config.gotruePortBase].map(start =>
      validRange({ start, end: start + tenantSize - 1 + 99 })),
  ];
  const adminPort = Number(new URL(config.caddyAdminUrl).port || 80);
  for (const port of [config.port, config.pgPort, config.poolerPort, adminPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_RANGE_INVALID");
    }
    excluded.push({ start: port, end: port });
  }
  if (excluded.some(other => range.start <= other.end && other.start <= range.end)) {
    throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_RANGE_OVERLAP");
  }
  return range;
}

export async function isApplicationPortAvailable(port: number): Promise<boolean> {
  validRange({ start: port, end: port });
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolve(true));
    });
  });
}

async function persistedTenantPorts(database: SQL): Promise<number[]> {
  const rows = await database`SELECT config FROM projects`;
  const ports: number[] = [];
  for (const row of rows) {
    const project = normalizeProjectConfig(row.config);
    for (const name of ["postgrest_port", "gotrue_port"]) {
      const port = Number(project[name]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
    }
  }
  return ports;
}

function normalizedInput(input: ApplicationRuntimeAllocationInput): ApplicationRuntimeAllocationInput {
  const release = parseApplicationReleaseRecord(structuredClone(input.runtime.release));
  if (!Value.Check(ApplicationConfigurationIdSchema, input.configurationId)) {
    throw new ApplicationRuntimeAllocationError("APPLICATION_CONFIGURATION_INVALID_ID");
  }
  const runtime = {
    release, activationId: input.runtime.activationId, environmentId: input.runtime.environmentId,
    bunVersion: input.runtime.bunVersion ?? "1.4.2",
  };
  applicationRuntimePlan({
    ...runtime, ports: Object.fromEntries(release.targets.filter(target => target.kind === "http")
      .map((target, index) => [target.name, 20000 + index])),
  });
  return { runtime, configurationId: input.configurationId };
}

function allocation(row: AllocationRow): ApplicationRuntimeAllocation {
  applicationRuntimePlan(row.runtime);
  const input = normalizedInput({ runtime: row.runtime, configurationId: row.configuration_id });
  if (row.project_ref !== input.runtime.release.project_ref || row.activation_id !== input.runtime.activationId
    || stableSha256(input) !== row.request_fingerprint
    || (!row.retired_at && stableStringify(row.owned_ports) !== stableStringify(row.runtime.ports))
    || (row.retired_at && stableStringify(row.owned_ports) !== "{}")) {
    throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_CORRUPT");
  }
  return {
    schema: "supacloud.application-runtime-allocation.v1",
    runtime: structuredClone(row.runtime), configurationId: row.configuration_id,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.retired_at ? { retiredAt: new Date(row.retired_at).toISOString() } : {}),
  };
}

/** Global in this metadata database, which currently owns one systemd runtime host. */
export class ApplicationRuntimeAllocations {
  private readonly database: SQL;
  constructor(private readonly options: AllocationOptions = {}) { this.database = options.database ?? sql; }

  async allocate(candidate: ApplicationRuntimeAllocationInput): Promise<ApplicationRuntimeAllocation> {
    const input = normalizedInput(candidate);
    const fingerprint = stableSha256(input);
    return this.database.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('supacloud-application-runtime-ports-v1', 0))`;
      const existing = await this.readRow(transaction, input.runtime.release.project_ref, input.runtime.activationId);
      if (existing) {
        if (existing.retired_at) {
          throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_RETIRED");
        }
        if (existing.request_fingerprint !== fingerprint) {
          throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_CONFLICT");
        }
        return allocation(existing);
      }
      const range = this.options.range ? validRange(this.options.range) : configuredApplicationPortRange();
      const groups = input.runtime.release.targets.flatMap(target => target.execution ? [target.execution] : []);
      let policyBudget: ApplicationCapacityBudget | null = null;
      {
        const [policy] = await transaction`
          SELECT budget FROM application_capacity_policies
          WHERE project_ref = ${input.runtime.release.project_ref}
        `;
        policyBudget = parseStoredBudget(policy?.budget);
      }
      if (groups.length || input.runtime.release.targets.some(target => target.compute)) {
        // The existing host-wide allocation lock serializes both ports and compute reservations.
        const active: { runtime: ApplicationRuntimeInput }[] = await transaction`
          SELECT runtime FROM application_runtime_allocations WHERE retired_at IS NULL`;
        const requested = applicationResourceUsage(input.runtime.release);
        const total = active.reduce<WorkerResourceUsage>((sum, row) => {
          const release = parseApplicationReleaseRecord(row.runtime.release);
          if (release.project_ref === input.runtime.release.project_ref) {
            for (const target of release.targets) {
              const previous = target.execution;
              if (!previous || !groups.some(group => group.queue === previous.queue)) continue;
              const next = groups.find(group => group.queue === previous.queue)!;
              if (release.application_id !== input.runtime.release.application_id
                || row.runtime.environmentId !== input.runtime.environmentId
                || previous.taskKey !== next.taskKey || previous.definitionVersion !== next.definitionVersion
                || previous.name !== next.name) throw new ApplicationRuntimeAllocationError("WORKER_QUEUE_OWNER_CONFLICT");
            }
          }
          const usage = applicationResourceUsage(release);
          return {
            cpu: Math.round((sum.cpu + usage.cpu) * 10) / 10,
            memoryMiB: sum.memoryMiB + usage.memoryMiB,
            connections: sum.connections + usage.connections,
            concurrency: sum.concurrency + usage.concurrency,
          };
        }, requested);
        let budget: unknown = this.options.workerBudget;
        if (policyBudget) budget = policyBudget;
        if (budget === undefined) {
          try { budget = JSON.parse(process.env["SUPACLOUD_APPLICATION_WORKER_BUDGET_JSON"] ?? "null"); }
          catch { throw new ApplicationRuntimeAllocationError("WORKER_BUDGET_REQUIRED"); }
        }
        assertWorkerBudget(total, budget);
      }
      if (policyBudget) {
        const active = await transaction`
          SELECT runtime FROM application_runtime_allocations WHERE retired_at IS NULL
        ` as Array<{ runtime: ApplicationRuntimeInput }>;
        const totalUsage = active.reduce<WorkerResourceUsage>((sum, row) =>
          addUsage(sum, applicationResourceUsage(parseApplicationReleaseRecord(row.runtime.release))),
        emptyUsage());
        const requested = applicationResourceUsage(input.runtime.release);
        const activePorts = await transaction`SELECT count(*)::int AS count FROM application_runtime_ports`;
        assertCapacityBudget(addUsage(totalUsage, requested),
          Number(activePorts[0]?.count ?? 0) + input.runtime.release.targets.filter(target => target.kind === "http").length,
          policyBudget);
      }
      const claimed: { port: number }[] = await transaction`SELECT port FROM application_runtime_ports`;
      const unavailable = new Set<number>([
        ...claimed.map(row => Number(row.port)),
        ...await (this.options.reservedPorts ?? persistedTenantPorts)(transaction),
      ]);
      const ports: Record<string, number> = {};
      const size = range.end - range.start + 1;
      const start = Number.parseInt(fingerprint.slice(0, 8), 16) % size;
      let scanned = 0;
      for (const target of input.runtime.release.targets.filter(target => target.kind === "http")
        .sort((a, b) => a.name.localeCompare(b.name))) {
        let selected: number | undefined;
        while (scanned < size) {
          const port = range.start + (start + scanned++) % size;
          if (!unavailable.has(port) && await (this.options.isAvailable ?? isApplicationPortAvailable)(port)) {
            selected = port;
            break;
          }
        }
        if (selected === undefined) throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_RANGE_EXHAUSTED");
        ports[target.name] = selected;
      }
      const runtime = { ...input.runtime, ports };
      await transaction`
        INSERT INTO application_runtime_allocations
          (project_ref, activation_id, configuration_id, request_fingerprint, runtime)
        VALUES (${runtime.release.project_ref}, ${runtime.activationId}, ${input.configurationId}, ${fingerprint}, ${runtime}::jsonb)
      `;
      for (const [target, port] of Object.entries(ports)) {
        await transaction`
          INSERT INTO application_runtime_ports (project_ref, activation_id, target, port)
          VALUES (${runtime.release.project_ref}, ${runtime.activationId}, ${target}, ${port})
        `;
      }
      const stored = await this.readRow(transaction, runtime.release.project_ref, runtime.activationId);
      if (!stored) throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_MISSING");
      return allocation(stored);
    });
  }

  async read(projectRef: string, activationId: string): Promise<ApplicationRuntimeAllocation | null> {
    const row = await this.readRow(this.database, projectRef, activationId);
    return row ? allocation(row) : null;
  }

  async capacityReport(projectRef: string): Promise<ApplicationCapacityReport> {
    const rows = await this.database`
      SELECT allocation.*, COALESCE((
        SELECT jsonb_object_agg(port.target, port.port) FROM application_runtime_ports port
        WHERE port.project_ref = allocation.project_ref AND port.activation_id = allocation.activation_id
      ), '{}'::jsonb) AS owned_ports
      FROM application_runtime_allocations allocation
      WHERE allocation.retired_at IS NULL
      ORDER BY allocation.created_at ASC
    ` as AllocationRow[];
    const allocations = rows.map(allocation);
    const queueOwners = allocations.flatMap(candidate => candidate.runtime.release.targets.flatMap(target =>
      target.execution ? [{
        queue: target.execution.queue,
        projectRef: candidate.runtime.release.project_ref,
        applicationId: candidate.runtime.release.application_id,
        environmentId: candidate.runtime.environmentId,
        activationId: candidate.runtime.activationId,
      }] : []));
    const [policy] = await this.database`
      SELECT budget FROM application_capacity_policies WHERE project_ref = ${projectRef}
    `;
    const report = buildApplicationCapacityReport({
      projectRef,
      allocations,
      budget: parseStoredBudget(policy?.budget) ?? configuredCapacityBudget(),
      activePorts: allocations.reduce((total, candidate) => total + Object.keys(candidate.runtime.ports).length, 0),
      queueOwners,
    });
    await this.database`
      INSERT INTO application_capacity_history
        (project_ref, generated_at, budget, usage, pressure, active_allocations, active_ports)
      VALUES (
        ${projectRef}, ${report.generatedAt}, ${report.budget}, ${report.usage},
        ${report.pressure}, ${report.activeAllocations}, ${report.activePorts}
      )
    `;
    return report;
  }

  async capacityHistory(projectRef: string, limit = 50): Promise<ApplicationCapacityHistoryEntry[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const rows = await this.database`
      SELECT generated_at, budget, usage, pressure, active_allocations, active_ports
      FROM application_capacity_history
      WHERE project_ref = ${projectRef}
      ORDER BY generated_at DESC, id DESC
      LIMIT ${bounded}
    `;
    return rows.map((row: Record<string, unknown>) => {
      const budget = parseStoredBudget(row["budget"]);
      const usage = parseStoredBudget(row["usage"]);
      if (!usage) throw new Error("APPLICATION_CAPACITY_HISTORY_CORRUPT");
      const pressure = row["pressure"];
      if (pressure !== "unknown" && pressure !== "normal" && pressure !== "elevated" && pressure !== "exhausted") {
        throw new Error("APPLICATION_CAPACITY_HISTORY_CORRUPT");
      }
      return {
        generatedAt: new Date(String(row["generated_at"])).toISOString(),
        budget,
        usage,
        pressure,
        activeAllocations: Number(row["active_allocations"]),
        activePorts: Number(row["active_ports"]),
      };
    });
  }

  async setCapacityPolicy(projectRef: string, budget: ApplicationCapacityBudget, updatedBy?: string) {
    if (!capacityBudget(budget)) throw new Error("APPLICATION_CAPACITY_BUDGET_INVALID");
    const [row] = await this.database`
      INSERT INTO application_capacity_policies(project_ref, budget, updated_by)
      VALUES (${projectRef}, ${budget}, ${updatedBy ?? null})
      ON CONFLICT (project_ref) DO UPDATE SET
        budget = EXCLUDED.budget,
        updated_by = EXCLUDED.updated_by,
        updated_at = clock_timestamp()
      RETURNING project_ref, budget, updated_by, updated_at
    `;
    return {
      projectRef: row.project_ref as string,
      budget: parseStoredBudget(row.budget)!,
      updatedBy: (row.updated_by as string | null) ?? null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /**
   * Retirement is explicit and observational. The caller must own the
   * mutation/recovery decision and prove that the process is stopped and the
   * route is absent; this method never stops, reroutes or retries a runtime.
   */
  async retire(
    projectRef: string,
    activationId: string,
    verifyStoppedAndUnrouted: (allocation: ApplicationRuntimeAllocation) => Promise<void>,
  ): Promise<ApplicationRuntimeAllocation> {
    const before = await this.readRow(this.database, projectRef, activationId);
    if (!before) throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_MISSING");
    const initial = allocation(before);
    if (before.retired_at) return initial;
    await verifyStoppedAndUnrouted(initial);
    const retirementFingerprint = stableSha256({
      schema: "supacloud.application-runtime-retirement.v1",
      projectRef, activationId, requestFingerprint: before.request_fingerprint,
    });
    return this.database.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('supacloud-application-runtime-ports-v1', 0))`;
      const current = await this.readRow(transaction, projectRef, activationId);
      if (!current) throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_MISSING");
      if (current.retired_at) return allocation(current);
      if (current.request_fingerprint !== before.request_fingerprint
        || stableStringify(current.runtime) !== stableStringify(before.runtime)) {
        throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_CHANGED");
      }
      await transaction`
        DELETE FROM application_runtime_ports
        WHERE project_ref = ${projectRef} AND activation_id = ${activationId}
      `;
      await transaction`
        UPDATE application_runtime_allocations
        SET retired_at = clock_timestamp(), retirement_fingerprint = ${retirementFingerprint}
        WHERE project_ref = ${projectRef} AND activation_id = ${activationId}
      `;
      const retired = await this.readRow(transaction, projectRef, activationId);
      if (!retired?.retired_at || retired.retirement_fingerprint !== retirementFingerprint) {
        throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_RETIREMENT_UNCONFIRMED");
      }
      return allocation(retired);
    });
  }

  private async readRow(database: SQL, projectRef: string, activationId: string) {
    if (!/^[a-z0-9-]{1,20}$/.test(projectRef) || !Value.Check(ApplicationConfigurationIdSchema, activationId)) {
      throw new ApplicationRuntimeAllocationError("APPLICATION_PORT_ALLOCATION_IDENTITY_INVALID");
    }
    const [row] = await database`
      SELECT allocation.*, COALESCE((
        SELECT jsonb_object_agg(port.target, port.port) FROM application_runtime_ports port
        WHERE port.project_ref = allocation.project_ref AND port.activation_id = allocation.activation_id
      ), '{}'::jsonb) AS owned_ports
      FROM application_runtime_allocations allocation
      WHERE allocation.project_ref = ${projectRef} AND allocation.activation_id = ${activationId}
    `;
    return row as AllocationRow | undefined;
  }
}
