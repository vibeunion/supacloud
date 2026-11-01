import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseApplicationReleaseRecord, type ApplicationReleaseRecord } from "./application-release";
import { workerResourceUsage } from "./worker-execution";

const closed = { additionalProperties: false } as const;

/**
 * One tenant's capacity budget. `cpu` is a core reservation (the same unit as
 * worker `cpuLimit`). The other fields are counts or bytes.
 */
export const TenantCapacityBudgetSchema = Type.Object({
  cpu: Type.Number({ minimum: 0, maximum: 65536 }),
  memoryMiB: Type.Integer({ minimum: 0, maximum: 2 ** 40 }),
  connections: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  queue: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  storageBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  functionConcurrency: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
}, closed);

export const tenantCapacityDimensions = [
  "cpu",
  "memoryMiB",
  "connections",
  "queue",
  "storageBytes",
  "functionConcurrency",
] as const;

export type TenantCapacityDimension = typeof tenantCapacityDimensions[number];
export type TenantCapacityBudget = Record<TenantCapacityDimension, number>;

export interface TenantCapacityDecision {
  admitted: boolean;
  projectRef?: string;
  dimension?: TenantCapacityDimension;
  limit?: number;
  usage?: number;
  requested?: number;
  reason?: "exceeded" | "invalid";
}

/**
 * Limits the shared Edge Runtime process cannot isolate per tenant. The
 * function scheduler still enforces function concurrency, queue depth, and
 * recorded heap. These three are reserved or enforced on their owning path.
 */
export const sharedRuntimeCapacityGaps = [
  {
    dimension: "cpu",
    reason: "The shared Edge Runtime process has no per-tenant CPU controller. Dedicated application workers still use systemd CPUQuota, and application allocation reserves cpu against this budget.",
  },
  {
    dimension: "connections",
    reason: "Function isolates do not publish live database connection counts. Application allocation reserves engine and handler pools against this budget.",
  },
  {
    dimension: "storageBytes",
    reason: "Object bytes are enforced on the storage upload path, not inside the function scheduler. A copied object whose size metadata is missing is not charged.",
  },
] as const;

export function emptyTenantCapacity(): TenantCapacityBudget {
  return { cpu: 0, memoryMiB: 0, connections: 0, queue: 0, storageBytes: 0, functionConcurrency: 0 };
}

export function parseTenantCapacityBudget(value: unknown): TenantCapacityBudget | null {
  if (!Value.Check(TenantCapacityBudgetSchema, value)) return null;
  return {
    cpu: value.cpu,
    memoryMiB: value.memoryMiB,
    connections: value.connections,
    queue: value.queue,
    storageBytes: value.storageBytes,
    functionConcurrency: value.functionConcurrency,
  };
}

export function addTenantCapacity(left: TenantCapacityBudget, right: TenantCapacityBudget): TenantCapacityBudget {
  return {
    cpu: Math.round((left.cpu + right.cpu) * 10) / 10,
    memoryMiB: left.memoryMiB + right.memoryMiB,
    connections: left.connections + right.connections,
    queue: left.queue + right.queue,
    storageBytes: left.storageBytes + right.storageBytes,
    functionConcurrency: left.functionConcurrency + right.functionConcurrency,
  };
}

/** Matches application runtime allocation: worker groups plus target compute. */
export function tenantReservationFromRelease(release: ApplicationReleaseRecord): TenantCapacityBudget {
  const parsed = parseApplicationReleaseRecord(structuredClone(release));
  const groups = parsed.targets.flatMap(target => target.execution ? [target.execution] : []);
  const worker = workerResourceUsage(groups);
  let cpu = worker.cpu;
  let memoryMiB = worker.memoryMiB;
  for (const target of parsed.targets) {
    if (!target.compute) continue;
    cpu = Math.round((cpu + target.compute.cpuLimit) * 10) / 10;
    memoryMiB += target.compute.memoryLimitMiB;
  }
  return {
    cpu,
    memoryMiB,
    connections: worker.connections,
    queue: groups.reduce((sum, group) => sum + group.admission.maxOutstandingOperations, 0),
    storageBytes: 0,
    functionConcurrency: worker.concurrency,
  };
}

function withProject(
  projectRef: string | undefined,
  decision: Omit<TenantCapacityDecision, "projectRef">,
): TenantCapacityDecision {
  return projectRef === undefined ? decision : { ...decision, projectRef };
}

export function evaluateTenantCapacity(input: {
  projectRef?: string;
  budget: TenantCapacityBudget;
  usage: TenantCapacityBudget;
  requested?: Partial<TenantCapacityBudget>;
  enforce?: readonly TenantCapacityDimension[];
}): TenantCapacityDecision {
  const budget = parseTenantCapacityBudget(input.budget);
  if (!budget) {
    return withProject(input.projectRef, { admitted: false, reason: "invalid" });
  }
  const enforce = new Set(input.enforce ?? tenantCapacityDimensions);
  for (const dimension of tenantCapacityDimensions) {
    if (!enforce.has(dimension)) continue;
    const used = input.usage[dimension];
    const requested = input.requested?.[dimension] ?? 0;
    const numeric = dimension === "cpu"
      ? Number.isFinite(used) && used >= 0 && Number.isFinite(requested) && requested >= 0
      : Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(requested) && requested >= 0;
    if (!numeric) {
      return withProject(input.projectRef, { admitted: false, dimension, reason: "invalid", usage: used, requested });
    }
    const next = dimension === "cpu" ? Math.round((used + requested) * 10) / 10 : used + requested;
    if (next > budget[dimension]) {
      return withProject(input.projectRef, {
        admitted: false,
        dimension,
        limit: budget[dimension],
        usage: used,
        requested,
        reason: "exceeded",
      });
    }
  }
  return withProject(input.projectRef, { admitted: true });
}

export function evaluateTenantReservation(input: {
  projectRef: string;
  budget: TenantCapacityBudget;
  active: readonly ApplicationReleaseRecord[];
  requested: ApplicationReleaseRecord;
}): TenantCapacityDecision {
  const usage = input.active.reduce(
    (sum, release) => addTenantCapacity(sum, tenantReservationFromRelease(release)),
    emptyTenantCapacity(),
  );
  return evaluateTenantCapacity({
    projectRef: input.projectRef,
    budget: input.budget,
    usage,
    requested: tenantReservationFromRelease(input.requested),
    enforce: ["cpu", "memoryMiB", "connections", "queue", "functionConcurrency"],
  });
}

/**
 * Edge scheduler admission. Function concurrency and queue depth delay or
 * reject only this tenant. Heap is the memory signal the pool already records.
 * CPU, database connections, and storage bytes are not observed here.
 */
export function edgeTenantAdmission(input: {
  projectRef: string;
  budget: TenantCapacityBudget;
  inflight: number;
  queued: number;
  heapBytes: number;
}): { action: "run" | "delay" | "reject"; decision: TenantCapacityDecision } {
  const budget = parseTenantCapacityBudget(input.budget);
  if (!budget) {
    return { action: "reject", decision: { admitted: false, projectRef: input.projectRef, reason: "invalid" } };
  }
  if (!Number.isSafeInteger(input.inflight) || input.inflight < 0
    || !Number.isSafeInteger(input.queued) || input.queued < 0
    || !Number.isSafeInteger(input.heapBytes) || input.heapBytes < 0) {
    return { action: "reject", decision: { admitted: false, projectRef: input.projectRef, reason: "invalid" } };
  }
  const memoryMiB = input.heapBytes === 0 ? 0 : Math.ceil(input.heapBytes / (1024 * 1024));
  const usage = {
    ...emptyTenantCapacity(),
    memoryMiB,
    queue: input.queued,
    functionConcurrency: input.inflight,
  };
  const memory = evaluateTenantCapacity({
    projectRef: input.projectRef,
    budget,
    usage,
    enforce: ["memoryMiB"],
  });
  if (!memory.admitted) return { action: "reject", decision: memory };
  if (input.inflight < budget.functionConcurrency) {
    return { action: "run", decision: { admitted: true, projectRef: input.projectRef } };
  }
  const queued = evaluateTenantCapacity({
    projectRef: input.projectRef,
    budget,
    usage,
    requested: { queue: 1 },
    enforce: ["queue"],
  });
  if (!queued.admitted) {
    return {
      action: "reject",
      decision: { ...queued, dimension: "functionConcurrency", limit: budget.functionConcurrency, usage: input.inflight, requested: 1 },
    };
  }
  return { action: "delay", decision: { admitted: true, projectRef: input.projectRef } };
}

export function edgeTenantQueueAdmission(input: {
  projectRef: string;
  budget: TenantCapacityBudget;
  queued: number;
}): TenantCapacityDecision {
  const budget = parseTenantCapacityBudget(input.budget);
  if (!budget) return { admitted: false, projectRef: input.projectRef, reason: "invalid" };
  return evaluateTenantCapacity({
    projectRef: input.projectRef,
    budget,
    usage: { ...emptyTenantCapacity(), queue: input.queued },
    requested: { queue: 1 },
    enforce: ["queue"],
  });
}

export function parseTenantCapacityMap(value: unknown): Map<string, TenantCapacityBudget> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SUPACLOUD_TENANT_CAPACITY_JSON must be a project map");
  }
  const map = new Map<string, TenantCapacityBudget>();
  for (const [projectRef, budget] of Object.entries(value)) {
    const parsed = parseTenantCapacityBudget(budget);
    if (!/^[a-z0-9-]{1,20}$/.test(projectRef) || !parsed) {
      throw new Error(`SUPACLOUD_TENANT_CAPACITY_JSON has an invalid budget for ${projectRef}`);
    }
    map.set(projectRef, parsed);
  }
  return map;
}

export function tenantCapacityFromEnvironment(
  env: Record<string, string | undefined>,
): ((projectRef: string) => TenantCapacityBudget | null) | undefined {
  const raw = env["SUPACLOUD_TENANT_CAPACITY_JSON"];
  if (raw === undefined || raw.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("SUPACLOUD_TENANT_CAPACITY_JSON must be JSON");
  }
  const map = parseTenantCapacityMap(value);
  if (!map) return undefined;
  return projectRef => map.get(projectRef) ?? null;
}
