import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import type { SupaCloudWorkflowClaimRequest, SupaCloudWorkflowClaimResult } from "./workflows.js";

export class SupaCloudWorkflowClaimInputError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = false;

  constructor() {
    super("Workflow claim request could not be validated", 0, {
      code: "WORKFLOW_CLAIM_INPUT_INVALID", mutation_may_have_applied: false,
    });
    this.name = "SupaCloudWorkflowClaimInputError";
  }
}

export function captureWorkflowClaimRequest(value: unknown): Required<SupaCloudWorkflowClaimRequest> {
  const fail = (): never => { throw new SupaCloudWorkflowClaimInputError(); };
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length !== 0) return fail();
    const properties = Object.getOwnPropertyDescriptors(value);
    for (const name of Object.keys(properties)) {
      const descriptor = properties[name];
      if ((name !== "workerId" && name !== "visibilityTimeoutSeconds")
        || !descriptor || !descriptor.enumerable || !("value" in descriptor)) return fail();
    }
    const worker: unknown = properties.workerId?.value;
    const timeout: unknown = properties.visibilityTimeoutSeconds?.value;
    if (typeof worker !== "string") return fail();
    // Match PostgreSQL btrim(text), which strips ordinary spaces, not all whitespace.
    const workerId = worker.replace(/^ +| +$/g, "");
    let characters = 0;
    for (const character of workerId) {
      const point = character.codePointAt(0);
      if (++characters > 200 || point === undefined || point === 0
        || (point >= 0xd800 && point <= 0xdfff)) return fail();
    }
    if (characters === 0) return fail();
    const visibilityTimeoutSeconds = timeout === undefined ? 300 : timeout;
    if (typeof visibilityTimeoutSeconds !== "number" || !Number.isSafeInteger(visibilityTimeoutSeconds)
      || visibilityTimeoutSeconds < 15 || visibilityTimeoutSeconds > 3600) return fail();
    return { workerId, visibilityTimeoutSeconds };
  } catch {
    return fail();
  }
}

export class SupaCloudWorkflowClaimError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = true;

  constructor() {
    super("Workflow claim response could not be validated", 0, {
      code: "WORKFLOW_CLAIM_UNCONFIRMED", mutation_may_have_applied: true,
    });
    this.name = "SupaCloudWorkflowClaimError";
  }
}

function invalid(): never { throw new SupaCloudWorkflowClaimError(); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : invalid();
}
function key(value: unknown): string {
  const result = text(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(result) ? result : invalid();
}
function version(value: unknown): string {
  const result = text(value);
  let characters = 0;
  for (const character of result) {
    const point = character.codePointAt(0);
    if (++characters > 80 || point === undefined || point === 0
      || (point >= 0xd800 && point <= 0xdfff)) return invalid();
  }
  return result;
}
function uuid(value: unknown): string {
  const result = text(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)
    ? result : invalid();
}
function id(value: unknown): string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n ? value : invalid();
}
function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    && value <= 2147483647 ? value : invalid();
}

export function decodeWorkflowClaim(value: unknown, expectedWorkerId: string): SupaCloudWorkflowClaimResult {
  if (value === null) return null;
  try {
    // Snapshot before accessing fields: reject accessors, cycles and non-JSON values.
    const data = record(queueJsonSnapshot(value));
    const messageId = id(data.messageId);
    if (data.status === "discarded") {
      const reason = text(data.reason);
      return {
        status: "discarded", reason, messageId,
        ...(data.runId === undefined ? {} : { runId: uuid(data.runId) }),
        ...(data.stepId === undefined ? {} : { stepId: uuid(data.stepId) }),
      };
    }
    const runId = uuid(data.runId);
    const stepId = uuid(data.stepId);
    const stepKey = key(data.stepKey);
    const attempt = positiveInteger(data.attempt);
    const maxAttempts = positiveInteger(data.maxAttempts);
    if (maxAttempts > 100) return invalid();
    if (data.status === "dead_lettered" && attempt > maxAttempts) {
      return { status: "dead_lettered", runId, stepId, stepKey, messageId, attempt, maxAttempts };
    }
    if (data.status !== "claimed" || attempt > maxAttempts || data.workerId !== expectedWorkerId) return invalid();
    return {
      status: "claimed", runId, stepId, stepKey, messageId, attempt, maxAttempts,
      workflowName: key(data.workflowName),
      workflowVersion: version(data.workflowVersion),
      workerId: text(data.workerId),
      input: record(data.input),
    };
  } catch {
    return invalid();
  }
}
