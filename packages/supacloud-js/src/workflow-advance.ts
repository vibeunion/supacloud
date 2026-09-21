import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { captureWorkflowRunId, decodeWorkflowRun } from "./workflow-run.js";
import { captureWorkflowAttempt, workflowRequestFields } from "./workflow-attempt.js";
import { workflowJsonEqual, workflowJsonObject } from "./workflow-json.js";
import type { SupaCloudWorkflowAdvanceRequest, SupaCloudWorkflowRun } from "./workflows.js";

export class SupaCloudWorkflowAdvanceError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Workflow advancement could not be validated", 0, {
      code: mutationMayHaveApplied ? "WORKFLOW_ADVANCE_UNCONFIRMED" : "WORKFLOW_ADVANCE_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudWorkflowAdvanceError";
  }
}

export function captureWorkflowAdvance(value: unknown): Required<SupaCloudWorkflowAdvanceRequest> {
  try {
    const fields = workflowRequestFields(value, [
      "stepId", "messageId", "attempt", "workerId", "output", "nextStepKey", "nextInput", "nextMaxAttempts",
    ]);
    if (typeof fields.nextStepKey !== "string") throw new Error();
    const nextStepKey = fields.nextStepKey.replace(/^ +| +$/g, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(nextStepKey)) throw new Error();
    const nextMaxAttempts = fields.nextMaxAttempts === undefined ? 3 : fields.nextMaxAttempts;
    if (typeof nextMaxAttempts !== "number" || !Number.isSafeInteger(nextMaxAttempts)
      || nextMaxAttempts < 1 || nextMaxAttempts > 100) throw new Error();
    return {
      ...captureWorkflowAttempt(fields), nextStepKey, nextMaxAttempts,
      output: workflowJsonObject(fields.output), nextInput: workflowJsonObject(fields.nextInput),
    };
  } catch {
    throw new SupaCloudWorkflowAdvanceError();
  }
}

export function decodeWorkflowAdvance(
  value: unknown, request: Required<SupaCloudWorkflowAdvanceRequest>,
): SupaCloudWorkflowRun {
  try {
    const snapshot = queueJsonSnapshot(value);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error();
    const run = decodeWorkflowRun(snapshot, captureWorkflowRunId(snapshot.runId), true);
    const current = run?.steps.find(step => step.stepId === request.stepId);
    const next = run?.steps.find(step => step.stepKey === request.nextStepKey);
    if (!run || !current || !next || current.stepId === next.stepId || current.status !== "completed"
      || current.queueMessageId !== request.messageId || current.attempts !== request.attempt
      || current.claimedBy !== request.workerId || current.completedAt === null || current.errorMessage !== ""
      || current.nextStepKey !== request.nextStepKey || next.maxAttempts !== request.nextMaxAttempts
      || !workflowJsonEqual(current.output, request.output) || !workflowJsonEqual(next.input, request.nextInput)) {
      throw new Error();
    }
    if (!run.idempotent && (run.status !== "running" || next.status !== "queued" || next.attempts !== 0)) throw new Error();
    return run;
  } catch {
    throw new SupaCloudWorkflowAdvanceError(true);
  }
}
