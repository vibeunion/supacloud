import {
  parseWorkerExecutionGroup, workerShardCount, workerShardForKey, workerShardQueue,
  type WorkerExecutionGroup,
} from "@supacloud/delivery/worker-execution";
import type { Json } from "@pgflow/edge-worker";

export function workerExecutionFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkerExecutionGroup {
  const encoded = environment.SUPACLOUD_WORKER_EXECUTION;
  if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("WORKER_EXECUTION_REQUIRED");
  }
  try {
    const group = parseWorkerExecutionGroup(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
    const replica = environment.SUPACLOUD_WORKER_REPLICA;
    const shard = environment.SUPACLOUD_WORKER_SHARD ?? "0";
    const shardCount = workerShardCount(group);
    const expectedTarget = shardCount === 1
      ? `${group.target}-r${replica}`
      : `${group.target}-r${replica}-s${Number(shard).toString(36).padStart(2, "0")}`;
    if (!replica || !/^[1-9][0-9]*$/.test(replica) || Number(replica) > group.replicas
      || !/^[0-9]+$/.test(shard) || Number(shard) >= shardCount
      || environment.SUPACLOUD_TARGET !== expectedTarget) {
      throw new Error("WORKER_EXECUTION_BINDING_INVALID");
    }
    return group;
  } catch { throw new Error("WORKER_EXECUTION_BINDING_INVALID"); }
}

export function workerShardFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = environment.SUPACLOUD_WORKER_SHARD ?? "0";
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("WORKER_SHARD_INVALID");
  return Number(value);
}

export function executionQueueOptions(group: WorkerExecutionGroup, shard = 0) {
  const policy = parseWorkerExecutionGroup(group);
  const shardCount = workerShardCount(policy);
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= shardCount) throw new Error("WORKER_SHARD_INVALID");
  return {
    queueName: workerShardQueue(policy, shard),
    taskKey: policy.taskKey,
    definitionVersion: policy.definitionVersion,
    concurrency: policy.concurrencyPerReplica,
    maxPgConnections: policy.database.engineConnectionsPerReplica,
    visibilityTimeoutSeconds: policy.lifecycle.visibilityTimeoutSeconds,
    // pgflow 0.16: retry.limit excludes the first read.
    retryLimit: policy.retry.maxAttempts - 1,
    shard,
    shardCount,
    shardGroup: policy,
  };
}

export function workerEnvelope(
  group: WorkerExecutionGroup, projectRef: string, operationId: string, input: unknown, orderingKey = operationId,
) {
  const policy = parseWorkerExecutionGroup(group);
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(projectRef) || !/^[A-Za-z0-9_.:@/-]{1,200}$/.test(operationId)) {
    throw new Error("WORKER_TASK_INVALID");
  }
  let wireInput: Json;
  try {
    const serialized = JSON.stringify(input, (_key, value: unknown) => {
      if (value === undefined || ["bigint", "function", "symbol"].includes(typeof value)
        || (typeof value === "number" && !Number.isFinite(value))) throw new Error("invalid JSON");
      return value;
    });
    if (Buffer.byteLength(serialized) > 65536) throw new Error("oversized JSON");
    wireInput = JSON.parse(serialized) as Json;
  } catch { throw new Error("WORKER_TASK_INVALID"); }
  const shard = workerShardForKey(policy, orderingKey);
  const envelope = {
    schemaVersion: 2, projectRef, taskKey: policy.taskKey,
    definitionVersion: policy.definitionVersion, idempotencyKey: operationId, orderingKey,
    shard, input: wireInput,
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > 65536) throw new Error("WORKER_TASK_TOO_LARGE");
  return envelope;
}
