import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { captureWorkflowRunId, decodeWorkflowRun } from "./workflow-run.js";
import { captureWorkflowAttempt, captureWorkflowErrorMessage, workflowRequestFields } from "./workflow-attempt.js";
import type { SupaCloudWorkflowFailRequest, SupaCloudWorkflowRun } from "./workflows.js";

export class SupaCloudWorkflowFailError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Workflow failure transition could not be validated", 0, {
      code: mutationMayHaveApplied ? "WORKFLOW_FAIL_UNCONFIRMED" : "WORKFLOW_FAIL_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudWorkflowFailError";
  }
}

export function captureWorkflowFail(value: unknown): SupaCloudWorkflowFailRequest {
  try {
    const fields = workflowRequestFields(value, ["stepId", "messageId", "attempt", "workerId", "errorMessage"]);
    return { ...captureWorkflowAttempt(fields), errorMessage: captureWorkflowErrorMessage(fields.errorMessage) };
  } catch {
    throw new SupaCloudWorkflowFailError();
  }
}

export function decodeWorkflowFail(value: unknown, request: SupaCloudWorkflowFailRequest): SupaCloudWorkflowRun {
  try {
    const snapshot = queueJsonSnapshot(value);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error();
    const run = decodeWorkflowRun(snapshot, captureWorkflowRunId(snapshot.runId), true);
    const step = run?.steps.find(item => item.stepId === request.stepId);
    if (!run || !step || run.status !== "failed" || run.errorMessage !== request.errorMessage || run.completedAt === null
      || step.status !== "failed" || step.queueMessageId !== request.messageId
      || step.attempts !== request.attempt || step.claimedBy !== request.workerId
      || step.completedAt === null || step.errorMessage !== request.errorMessage
      || run.steps.some(item => item.status === "queued" || item.status === "running")) throw new Error();
    return run;
  } catch {
    throw new SupaCloudWorkflowFailError(true);
  }
}
