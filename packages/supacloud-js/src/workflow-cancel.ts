import { SupaCloudApiError } from "./api-error.js";
import { captureWorkflowRunId, decodeWorkflowRun } from "./workflow-run.js";
import type { SupaCloudWorkflowRun } from "./workflows.js";

export class SupaCloudWorkflowCancelError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Workflow cancellation could not be validated", 0, {
      code: mutationMayHaveApplied ? "WORKFLOW_CANCEL_UNCONFIRMED" : "WORKFLOW_CANCEL_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudWorkflowCancelError";
  }
}

export function captureWorkflowCancel(runId: unknown, reason: unknown): { runId: string; reason: string } {
  try {
    const capturedId = captureWorkflowRunId(runId);
    if (typeof reason !== "string") throw new Error();
    const capturedReason = reason.replace(/^ +| +$/g, "");
    let length = 0;
    for (const character of capturedReason) {
      const point = character.codePointAt(0);
      if (++length > 4000 || point === 0 || (point !== undefined && point >= 0xd800 && point <= 0xdfff)) throw new Error();
    }
    if (length === 0) throw new Error();
    return { runId: capturedId, reason: capturedReason };
  } catch {
    throw new SupaCloudWorkflowCancelError();
  }
}

export function decodeWorkflowCancel(
  value: unknown,
  request: { runId: string; reason: string },
): SupaCloudWorkflowRun {
  try {
    const run = decodeWorkflowRun(value, request.runId, true);
    if (!run || run.status !== "cancelled" || run.errorMessage !== request.reason
      || run.completedAt === null) throw new Error();
    for (const step of run.steps) {
      if (step.status === "queued" || step.status === "running"
        || (step.status === "cancelled" && (step.errorMessage !== request.reason || step.completedAt === null))) {
        throw new Error();
      }
    }
    return run;
  } catch {
    throw new SupaCloudWorkflowCancelError(true);
  }
}
