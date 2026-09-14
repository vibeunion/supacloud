import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { captureWorkflowRunId, decodeWorkflowRun } from "./workflow-run.js";
import { captureWorkflowAttempt, workflowRequestFields } from "./workflow-attempt.js";
import { workflowJsonEqual, workflowJsonObject } from "./workflow-json.js";
import type { SupaCloudWorkflowCompleteRequest, SupaCloudWorkflowRun } from "./workflows.js";

export class SupaCloudWorkflowCompleteError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Workflow completion could not be validated", 0, {
      code: mutationMayHaveApplied ? "WORKFLOW_COMPLETE_UNCONFIRMED" : "WORKFLOW_COMPLETE_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudWorkflowCompleteError";
  }
}

export function captureWorkflowComplete(value: unknown): Required<SupaCloudWorkflowCompleteRequest> {
  try {
    const fields = workflowRequestFields(value, ["stepId", "messageId", "attempt", "workerId", "stepOutput", "runOutput"]);
    return {
      ...captureWorkflowAttempt(fields),
      stepOutput: workflowJsonObject(fields.stepOutput), runOutput: workflowJsonObject(fields.runOutput),
    };
  } catch {
    throw new SupaCloudWorkflowCompleteError();
  }
}

export function decodeWorkflowComplete(
  value: unknown,
  request: Required<SupaCloudWorkflowCompleteRequest>,
): SupaCloudWorkflowRun {
  try {
    const snapshot = queueJsonSnapshot(value);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error();
    const run = decodeWorkflowRun(snapshot, captureWorkflowRunId(snapshot.runId), true);
    const step = run?.steps.find(item => item.stepId === request.stepId);
    if (!run || !step || run.status !== "completed" || run.errorMessage !== "" || run.completedAt === null
      || step.status !== "completed" || step.queueMessageId !== request.messageId
      || step.attempts !== request.attempt || step.claimedBy !== request.workerId
      || step.completedAt === null || step.nextStepKey !== null || step.errorMessage !== ""
      || !workflowJsonEqual(step.output, request.stepOutput) || !workflowJsonEqual(run.output, request.runOutput)
      || run.steps.some(item => item.status === "queued" || item.status === "running")) throw new Error();
    return run;
  } catch {
    throw new SupaCloudWorkflowCompleteError(true);
  }
}
