import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { isWorkflowTimestamp } from "./workflow-timestamp.js";
import type { SupaCloudWorkflowRun, SupaCloudWorkflowStep } from "./workflows.js";

export class SupaCloudWorkflowReadError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = false;

  constructor(code = "WORKFLOW_READ_INVALID") {
    super("Workflow read could not be validated", 0, {
      code, mutation_may_have_applied: false,
    });
    this.name = "SupaCloudWorkflowReadError";
  }
}

function invalid(): never { throw new SupaCloudWorkflowReadError(); }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function captureWorkflowRunId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value.toLowerCase())) {
    throw new SupaCloudWorkflowReadError("WORKFLOW_READ_INPUT_INVALID");
  }
  return value.toLowerCase();
}

function uuid(value: unknown): string {
  return typeof value === "string" && uuidPattern.test(value) ? value : invalid();
}
function record(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return invalid();
}
function text(value: unknown, min = 0, max = 4000): string {
  if (typeof value !== "string") return invalid();
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (++count > max || point === 0 || (point !== undefined && point >= 0xd800 && point <= 0xdfff)) return invalid();
  }
  return count >= min ? value : invalid();
}
function key(value: unknown): string {
  const result = text(value, 1, 120);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(result) ? result : invalid();
}
function id(value: unknown): string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n ? value : invalid();
}
function integer(value: unknown, min: number, max = 2147483647): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function timestamp(value: unknown): string {
  return isWorkflowTimestamp(value) ? value : invalid();
}
function nullable<T>(value: unknown, decode: (value: unknown) => T): T | null {
  return value === null ? null : decode(value);
}
function state<T extends string>(value: unknown, values: readonly T[]): T {
  for (const candidate of values) if (candidate === value) return candidate;
  return invalid();
}
function step(value: unknown): SupaCloudWorkflowStep {
  const data = record(value);
  return {
    stepId: uuid(data.stepId), stepKey: key(data.stepKey),
    status: state(data.status, ["queued", "running", "completed", "failed", "dead_lettered", "cancelled"]),
    input: record(data.input), output: record(data.output), errorMessage: text(data.errorMessage),
    attempts: integer(data.attempts, 0), maxAttempts: integer(data.maxAttempts, 1, 100),
    retryDelaySeconds: integer(data.retryDelaySeconds, 0, 86400), queueMessageId: id(data.queueMessageId),
    claimedBy: nullable(data.claimedBy, value => text(value, 1, 200)),
    claimedAt: nullable(data.claimedAt, timestamp), completedAt: nullable(data.completedAt, timestamp),
    nextStepKey: nullable(data.nextStepKey, key),
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt),
  };
}

function validateStepSuccessors(steps: SupaCloudWorkflowStep[]): void {
  if (steps.length === 0) return invalid();
  const byKey = new Map(steps.map(item => [item.stepKey, item]));
  const successors = new Set<string>();
  for (const item of steps) {
    if (item.nextStepKey !== null) {
      if (item.status !== "completed" || item.completedAt === null
        || !byKey.has(item.nextStepKey) || successors.has(item.nextStepKey)) return invalid();
      successors.add(item.nextStepKey);
    }
  }
  const roots = steps.filter(item => !successors.has(item.stepKey));
  if (roots.length !== 1) return invalid();
  // Walk iteratively so deep histories cannot exhaust the call stack.
  const visited = new Set<string>();
  let current: SupaCloudWorkflowStep | undefined = roots[0];
  while (current) {
    if (visited.has(current.stepKey)) return invalid();
    visited.add(current.stepKey);
    current = current.nextStepKey === null ? undefined : byKey.get(current.nextStepKey);
  }
  if (visited.size !== steps.length) return invalid();
}

function validateLifecycle(run: SupaCloudWorkflowRun): void {
  const active = run.status === "queued" || run.status === "running";
  if (active !== (run.completedAt === null)) return invalid();
  if ((run.status === "running" || run.status === "completed") && run.startedAt === null) return invalid();
  if (run.status === "queued" && (run.startedAt !== null || run.steps.length !== 1
    || run.steps[0]?.status !== "queued" || run.steps[0]?.attempts !== 0)) return invalid();
  if ((active || run.status === "completed") && run.errorMessage !== "") return invalid();
  let activeSteps = 0;
  let terminalSteps = 0;
  for (const item of run.steps) {
    const stepActive = item.status === "queued" || item.status === "running";
    if (stepActive) activeSteps++;
    if (stepActive !== (item.completedAt === null)) return invalid();
    if ((item.claimedBy === null) !== (item.claimedAt === null)) return invalid();
    if (item.claimedBy !== null && (item.attempts === 0 || run.startedAt === null)) return invalid();
    // Exhaustion on queue read can precede any successful worker claim.
    if (item.status === "dead_lettered") {
      if (item.attempts < item.maxAttempts
        || (item.claimedBy === null && item.attempts === item.maxAttempts)) return invalid();
    } else if (item.attempts > item.maxAttempts
      || (item.attempts > 0 && item.claimedBy === null)) return invalid();
    if (item.status === "queued" && item.attempts >= item.maxAttempts) return invalid();
    if (["running", "completed", "failed"].includes(item.status)
      && (item.attempts === 0 || item.retryDelaySeconds !== 0)) return invalid();
    if (item.attempts === 0 && item.retryDelaySeconds !== 0) return invalid();
    if (item.status === "completed" && item.errorMessage !== "") return invalid();
    if (item.status === "failed" || item.status === "dead_lettered" || item.status === "cancelled") {
      terminalSteps++;
      const expected = item.status === "cancelled" ? "cancelled" : "failed";
      if (run.status !== expected || item.errorMessage === "" || item.errorMessage !== run.errorMessage) return invalid();
    }
  }
  if (activeSteps !== (active ? 1 : 0)) return invalid();
  if (terminalSteps !== (run.status === "failed" || run.status === "cancelled" ? 1 : 0)) return invalid();
}

export function decodeWorkflowRun(value: unknown, expectedRunId: string, allowIdempotent = false): SupaCloudWorkflowRun | null {
  if (value === null) return null;
  try {
    const data = record(queueJsonSnapshot(value));
    const runId = uuid(data.runId);
    if (runId !== expectedRunId || typeof data.idempotent !== "boolean"
      || (!allowIdempotent && data.idempotent) || !Array.isArray(data.steps)) return invalid();
    const steps = data.steps.map(step);
    for (const field of ["stepId", "stepKey", "queueMessageId"] as const) {
      if (new Set(steps.map(item => item[field])).size !== steps.length) return invalid();
    }
    validateStepSuccessors(steps);
    const run: SupaCloudWorkflowRun = {
      runId, workflowName: key(data.workflowName), workflowVersion: text(data.workflowVersion, 1, 80),
      status: state(data.status, ["queued", "running", "completed", "failed", "cancelled"]),
      input: record(data.input), output: record(data.output), errorMessage: text(data.errorMessage),
      rowVersion: id(data.rowVersion), createdAt: timestamp(data.createdAt),
      startedAt: nullable(data.startedAt, timestamp), completedAt: nullable(data.completedAt, timestamp),
      updatedAt: timestamp(data.updatedAt), idempotent: data.idempotent, steps,
    };
    validateLifecycle(run);
    return run;
  } catch {
    return invalid();
  }
}
