import { queueMessageId } from "./queue-rpc.js";
import { captureWorkflowRunId } from "./workflow-run.js";
import { captureWorkflowClaimRequest } from "./workflow-claim.js";
import type { SupaCloudWorkflowAttemptRequest } from "./workflows.js";

export function workflowRequestFields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length !== 0) throw new Error();
  const fields = Object.getOwnPropertyDescriptors(value);
  const entries: Array<[string, unknown]> = [];
  for (const name of Object.keys(fields)) {
    const field = fields[name];
    if (!names.includes(name) || !field || !field.enumerable || !("value" in field)) throw new Error();
    entries.push([name, field.value]);
  }
  return Object.fromEntries(entries);
}

export function captureWorkflowAttempt(fields: Record<string, unknown>): SupaCloudWorkflowAttemptRequest {
  const { messageId, attempt } = fields;
  if (typeof messageId !== "string" || typeof attempt !== "number" || !Number.isSafeInteger(attempt)
    || attempt < 1 || attempt > 2147483647) throw new Error();
  return {
    stepId: captureWorkflowRunId(fields.stepId), messageId: queueMessageId(messageId), attempt,
    workerId: captureWorkflowClaimRequest({ workerId: fields.workerId }).workerId,
  };
}

export function captureWorkflowErrorMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error();
  const errorMessage = value.replace(/^ +| +$/g, "");
  let length = 0;
  for (const character of errorMessage) {
    const point = character.codePointAt(0);
    if (++length > 4000 || point === 0 || (point !== undefined && point >= 0xd800 && point <= 0xdfff)) throw new Error();
  }
  if (length === 0) throw new Error();
  return errorMessage;
}
