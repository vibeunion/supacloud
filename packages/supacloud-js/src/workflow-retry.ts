import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { captureWorkflowRunId, decodeWorkflowRun } from "./workflow-run.js";
import { captureWorkflowAttempt, captureWorkflowErrorMessage, workflowRequestFields } from "./workflow-attempt.js";
import type { SupaCloudWorkflowRetryRequest, SupaCloudWorkflowRun } from "./workflows.js";

export class SupaCloudWorkflowRetryError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Workflow retry could not be validated", 0, {
      code: mutationMayHaveApplied ? "WORKFLOW_RETRY_UNCONFIRMED" : "WORKFLOW_RETRY_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudWorkflowRetryError";
  }
}

export function captureWorkflowRetry(value: unknown): Required<SupaCloudWorkflowRetryRequest> {
  try {
    const fields = workflowRequestFields(value, ["stepId", "messageId", "attempt", "workerId", "errorMessage", "delaySeconds"]);
    const delaySeconds = fields.delaySeconds === undefined ? 0 : fields.delaySeconds;
    if (typeof delaySeconds !== "number" || !Number.isSafeInteger(delaySeconds)
      || delaySeconds < 0 || delaySeconds > 86400) throw new Error();
    return {
      ...captureWorkflowAttempt(fields), errorMessage: captureWorkflowErrorMessage(fields.errorMessage), delaySeconds,
    };
  } catch {
    throw new SupaCloudWorkflowRetryError();
  }
}

export function decodeWorkflowRetry(
  value: unknown, request: Required<SupaCloudWorkflowRetryRequest>,
): SupaCloudWorkflowRun {
  try {
    const snapshot = queueJsonSnapshot(value);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error();
    const receipt = snapshot.retryReceipt;
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)
      || receipt.operation !== "retry" || receipt.stepId !== request.stepId || receipt.messageId !== request.messageId
      || receipt.attempt !== request.attempt || receipt.workerId !== request.workerId
      || receipt.errorMessage !== request.errorMessage || receipt.delaySeconds !== request.delaySeconds) throw new Error();
    const run = decodeWorkflowRun(snapshot, captureWorkflowRunId(snapshot.runId), true);
    const step = run?.steps.find(item => item.stepId === request.stepId);
    if (!run || !step || step.queueMessageId !== request.messageId || step.attempts < request.attempt) throw new Error();
    // The stored receipt binds the historical request; the run snapshot may have progressed.
    if (run.idempotent) return run;
    if (step.attempts !== request.attempt || step.claimedBy !== request.workerId
      || step.errorMessage !== request.errorMessage) throw new Error();
    if (request.attempt >= step.maxAttempts) {
      if (step.status !== "dead_lettered" || run.status !== "failed" || run.errorMessage !== request.errorMessage
        || step.completedAt === null || run.completedAt === null
        || run.steps.some(item => item.status === "queued" || item.status === "running")) throw new Error();
    } else if (step.status !== "queued" || run.status !== "running" || step.completedAt !== null
      || step.retryDelaySeconds !== request.delaySeconds) throw new Error();
    return run;
  } catch {
    throw new SupaCloudWorkflowRetryError(true);
  }
}
