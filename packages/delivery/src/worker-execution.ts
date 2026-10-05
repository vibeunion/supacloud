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

export function parseWorkerExecutionGroup(value: unknown): WorkerExecutionGroup {
  if (!Value.Check(WorkerExecutionGroupSchema, value) || value.replicas > value.maxReplicas
    || !value.queue.endsWith(`_v${value.definitionVersion}`)
    || value.lifecycle.visibilityTimeoutSeconds
      < value.lifecycle.executionTimeoutSeconds + value.lifecycle.shutdownGraceSeconds + 30) {
    throw new Error("WORKER_EXECUTION_INVALID");
  }
  return structuredClone(value);
}

export function validateWorkerExecution(groups: readonly WorkerExecutionGroup[]): void {
  const names = new Set<string>(), targets = new Set<string>(), queues = new Set<string>(), routes = new Set<string>();
  for (const candidate of groups) {
    const group = parseWorkerExecutionGroup(candidate);
    const route = `${group.taskKey}:${group.definitionVersion}`;
    if (names.has(group.name) || targets.has(group.target) || queues.has(group.queue) || routes.has(route)) {
      throw new Error("WORKER_EXECUTION_CONFLICT");
    }
    names.add(group.name); targets.add(group.target); queues.add(group.queue); routes.add(route);
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
    cpu: Math.round((total.cpu + group.maxReplicas * group.resources.cpuLimit) * 10) / 10,
    memoryMiB: total.memoryMiB + group.maxReplicas * group.resources.memoryLimitMiB,
    connections: total.connections + group.maxReplicas
      * (group.database.engineConnectionsPerReplica + group.database.handlerConnectionsPerReplica),
    concurrency: total.concurrency + group.maxReplicas * group.concurrencyPerReplica,
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
