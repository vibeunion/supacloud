import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false } as const;
const positive = (maximum: number) => Type.Integer({ minimum: 1, maximum });
export const ComputeResourcesSchema = Type.Object({
  cpuLimit: Type.Number({ minimum: 0.1, maximum: 64, multipleOf: 0.1 }),
  memoryLimitMiB: Type.Integer({ minimum: 64, maximum: 262144 }),
}, closed);
export type ComputeResources = Static<typeof ComputeResourcesSchema>;
export const WorkerExecutionGroupSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
  target: Type.String({ pattern: "^[a-z][a-z0-9-]{0,53}$" }),
  workloadClass: Type.Union([Type.Literal("interactive"), Type.Literal("batch")]),
  executor: Type.Literal("pgflow-queue"),
  runtime: Type.Literal("bun"),
  queue: Type.String({ pattern: "^scw_[a-z0-9_]{1,40}$" }),
  taskKey: Type.String({ pattern: "^[a-z][a-z0-9_.-]{0,99}$" }),
  definitionVersion: Type.String({ pattern: "^[1-9][0-9]{0,8}$" }),
  replicas: positive(16),
  maxReplicas: positive(16),
  /** Number of independent queue shards consumed by every replica. */
  shardCount: Type.Optional(positive(64)),
  concurrencyPerReplica: positive(32),
  resources: ComputeResourcesSchema,
  database: Type.Object({
    engineConnectionsPerReplica: positive(16),
    handlerConnectionsPerReplica: positive(16),
  }, closed),
  lifecycle: Type.Object({
    executionTimeoutSeconds: positive(3500),
    visibilityTimeoutSeconds: Type.Integer({ minimum: 15, maximum: 3600 }),
    shutdownGraceSeconds: positive(300),
  }, closed),
  retry: Type.Object({ maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }) }, closed),
  admission: Type.Object({ maxOutstandingOperations: positive(1_000_000) }, closed),
}, closed);

export const WorkerExecutionSchema = Type.Object({
  groups: Type.Array(WorkerExecutionGroupSchema, { minItems: 1, maxItems: 32 }),
}, closed);

export type WorkerExecutionGroup = Static<typeof WorkerExecutionGroupSchema>;
export type WorkerExecution = Static<typeof WorkerExecutionSchema>;

export function workerShardCount(group: Pick<WorkerExecutionGroup, "shardCount">): number {
  return group.shardCount ?? 1;
}

function shardSuffix(shard: number): string {
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= 64) {
    throw new Error("WORKER_SHARD_INVALID");
  }
  return `s${shard.toString(36).padStart(2, "0")}`;
}

/** Stable queue identity for one execution-group shard. */
export function workerShardQueue(group: Pick<WorkerExecutionGroup, "queue" | "shardCount">, shard: number): string {
  const count = workerShardCount(group);
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= count) {
    throw new Error("WORKER_SHARD_INVALID");
  }
  if (count === 1) return group.queue;
  const queue = `${group.queue}_${shardSuffix(shard)}`;
  if (!/^scw_[a-z0-9_]{1,40}$/.test(queue)) throw new Error("WORKER_QUEUE_INVALID");
  return queue;
}

/** Cross-runtime deterministic FNV-1a routing. Keep this algorithm stable. */
export function workerShardForKey(group: Pick<WorkerExecutionGroup, "shardCount">, key: string): number {
  const count = workerShardCount(group);
  if (typeof key !== "string" || key.length < 1 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("WORKER_SHARD_KEY_INVALID");
  }
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % count;
}

export function parseWorkerExecutionGroup(value: unknown): WorkerExecutionGroup {
  if (!Value.Check(WorkerExecutionGroupSchema, value) || value.replicas > value.maxReplicas
    || !value.queue.endsWith(`_v${value.definitionVersion}`)
    || value.lifecycle.visibilityTimeoutSeconds
      < value.lifecycle.executionTimeoutSeconds + value.lifecycle.shutdownGraceSeconds + 30) {
    throw new Error("WORKER_EXECUTION_INVALID");
  }
  const group = structuredClone(value) as WorkerExecutionGroup;
  // Validate every derived queue name up front so deployment cannot create a
  // partially routable execution group.
  for (let shard = 0; shard < workerShardCount(group); shard += 1) workerShardQueue(group, shard);
  return group;
}

export function validateWorkerExecution(groups: readonly WorkerExecutionGroup[]): void {
  const names = new Set<string>(), targets = new Set<string>(), queues = new Set<string>(), routes = new Set<string>();
  for (const candidate of groups) {
    const group = parseWorkerExecutionGroup(candidate);
    const route = `${group.taskKey}:${group.definitionVersion}`;
    const physicalQueues = Array.from({ length: workerShardCount(group) }, (_, shard) => workerShardQueue(group, shard));
    if (names.has(group.name) || targets.has(group.target) || queues.has(group.queue)
      || physicalQueues.some(queue => queues.has(queue)) || routes.has(route)) {
      throw new Error("WORKER_EXECUTION_CONFLICT");
    }
    names.add(group.name); targets.add(group.target); queues.add(group.queue);
    physicalQueues.forEach(queue => queues.add(queue)); routes.add(route);
  }
}

export interface WorkerResourceUsage {
  cpu: number;
  memoryMiB: number;
  connections: number;
  concurrency: number;
}

/** Reserve maximum replicas, including both engine and domain connection pools. */
export function workerResourceUsage(groups: readonly WorkerExecutionGroup[]): WorkerResourceUsage {
  validateWorkerExecution(groups);
  return groups.reduce<WorkerResourceUsage>((total, group) => ({
    cpu: Math.round((total.cpu + group.maxReplicas * workerShardCount(group) * group.resources.cpuLimit) * 10) / 10,
    memoryMiB: total.memoryMiB + group.maxReplicas * workerShardCount(group) * group.resources.memoryLimitMiB,
    connections: total.connections + group.maxReplicas * workerShardCount(group)
      * (group.database.engineConnectionsPerReplica + group.database.handlerConnectionsPerReplica),
    concurrency: total.concurrency + group.maxReplicas * workerShardCount(group) * group.concurrencyPerReplica,
  }), { cpu: 0, memoryMiB: 0, connections: 0, concurrency: 0 });
}

/** Operator-owned residual budget, after API, maintenance and other services. */
export function assertWorkerBudget(usage: WorkerResourceUsage, budget: unknown): void {
  const schema = Type.Object({
    cpu: Type.Number({ minimum: 0, maximum: 65536 }),
    memoryMiB: Type.Integer({ minimum: 0, maximum: 2 ** 40 }),
    connections: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    concurrency: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  }, closed);
  if (!Value.Check(schema, budget)) throw new Error("WORKER_BUDGET_REQUIRED");
  for (const key of ["cpu", "memoryMiB", "connections", "concurrency"] as const) {
    if (!Number.isFinite(usage[key]) || usage[key] < 0 || usage[key] > budget[key]) {
      throw new Error("WORKER_BUDGET_EXCEEDED");
    }
  }
}

/** Exact, server-owned routing. No client-selected tag or language fallback. */
export function resolveWorkerRoute(groups: readonly WorkerExecutionGroup[], taskKey: string, definitionVersion: string) {
  validateWorkerExecution(groups);
  const group = groups.find(item => item.taskKey === taskKey && item.definitionVersion === definitionVersion);
  if (!group) throw new Error("WORKER_ROUTE_UNAVAILABLE");
  return parseWorkerExecutionGroup(group);
}
