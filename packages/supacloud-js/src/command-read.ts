import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { captureWorkflowRunId, decodeWorkflowRun } from "./workflow-run.js";
import { isWorkflowTimestamp } from "./workflow-timestamp.js";
import { workflowJsonEqual } from "./workflow-json.js";
import type { SupaCloudCommandReceipt } from "./commands.js";

export class SupaCloudCommandReadError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = false;
  constructor(input = false) {
    super("Command read could not be validated", 0, {
      code: input ? "COMMAND_READ_INPUT_INVALID" : "COMMAND_READ_INVALID",
      mutation_may_have_applied: false,
    });
    this.name = "SupaCloudCommandReadError";
  }
}

export function captureCommandId(value: unknown): string {
  try { return captureWorkflowRunId(value); }
  catch { throw new SupaCloudCommandReadError(true); }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
export function commandKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) throw new Error();
  return value;
}
export function commandTarget(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error();
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (++count > 500 || point === undefined || point === 0
      || (point >= 0xd800 && point <= 0xdfff)) throw new Error();
  }
  return value;
}

export function commandActor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error();
  return value;
}

export function decodeCommandRead(value: unknown, commandId: string, allowIdempotent = false): SupaCloudCommandReceipt | null {
  if (value === null) return null;
  try {
    const data = record(queueJsonSnapshot(value));
    if (data.commandId !== commandId || typeof data.idempotent !== "boolean"
      || (!allowIdempotent && data.idempotent)) throw new Error();
    const commandType = commandKey(data.commandType), targetType = commandKey(data.targetType), targetId = commandTarget(data.targetId);
    const actorId = commandActor(data.actorId);
    const fingerprint = data.payloadFingerprint;
    if (typeof fingerprint !== "string" || !/^md5:[0-9a-f]{32}$/.test(fingerprint)
      || !isWorkflowTimestamp(data.createdAt)) throw new Error();
    const workflow = decodeWorkflowRun(data.workflow, commandId);
    if (!workflow || workflow.workflowName !== `command.${commandType}` || workflow.workflowVersion !== "1") throw new Error();
    const input = workflow.input;
    if (input.commandId !== commandId || input.commandType !== commandType || input.targetType !== targetType
      || input.targetId !== targetId || input.actorId !== actorId || input.payloadFingerprint !== fingerprint) throw new Error();
    record(input.payload);
    const first = workflow.steps.find(step => step.stepKey === "execute");
    if (!first || !workflowJsonEqual(first.input, input)
      || workflow.steps.some(step => step.nextStepKey === "execute")) throw new Error();
    return {
      commandId, commandType, targetType, targetId, actorId,
      payloadFingerprint: fingerprint, createdAt: data.createdAt, idempotent: data.idempotent, workflow,
    };
  } catch {
    throw new SupaCloudCommandReadError();
  }
}
