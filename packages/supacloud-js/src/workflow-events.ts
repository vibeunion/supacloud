import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot, queueMessageId } from "./queue-rpc.js";
import { captureWorkflowRunId } from "./workflow-run.js";
import { workflowRequestFields } from "./workflow-attempt.js";
import { isWorkflowTimestamp } from "./workflow-timestamp.js";
import type { SupaCloudWorkflowEvent } from "./workflows.js";

export class SupaCloudWorkflowEventsError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = false;
  constructor(input = false) {
    super("Workflow events could not be validated", 0, {
      code: input ? "WORKFLOW_EVENTS_INPUT_INVALID" : "WORKFLOW_EVENTS_INVALID",
      mutation_may_have_applied: false,
    });
    this.name = "SupaCloudWorkflowEventsError";
  }
}
type EventRequest = { runId: string; afterEventId: string; limit: number };

export function captureWorkflowEvents(runId: unknown, options: unknown): EventRequest {
  try {
    const fields = workflowRequestFields(options, ["afterEventId", "limit"]);
    const afterEventId = fields.afterEventId === undefined ? "0" : fields.afterEventId;
    const limit = fields.limit === undefined ? 100 : fields.limit;
    if (typeof afterEventId !== "string" || (afterEventId !== "0" && queueMessageId(afterEventId) !== afterEventId)
      || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error();
    return { runId: captureWorkflowRunId(runId), afterEventId, limit };
  } catch {
    throw new SupaCloudWorkflowEventsError(true);
  }
}

export function decodeWorkflowEvents(value: unknown, request: EventRequest): SupaCloudWorkflowEvent[] {
  try {
    const snapshot = queueJsonSnapshot(value);
    if (!Array.isArray(snapshot) || snapshot.length > request.limit) throw new Error();
    let previous = BigInt(request.afterEventId);
    return snapshot.map(item => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error();
      const { eventId, runId, stepId, eventType, attempt, details, createdAt } = item;
      if (typeof eventId !== "string" || queueMessageId(eventId) !== eventId
        || BigInt(eventId) <= previous || runId !== request.runId
        || (stepId !== null && (typeof stepId !== "string" || captureWorkflowRunId(stepId) !== stepId))
        || typeof eventType !== "string" || ![
          "run_started", "step_claimed", "step_retried", "step_completed",
          "step_failed", "step_dead_lettered", "run_completed", "run_cancelled",
        ].includes(eventType)
        || (attempt !== null && (typeof attempt !== "number" || !Number.isSafeInteger(attempt)
          || attempt < 1 || attempt > 2147483647))
        || details === null || typeof details !== "object" || Array.isArray(details)
        || !isWorkflowTimestamp(createdAt)) throw new Error();
      previous = BigInt(eventId);
      return { eventId, runId, stepId, eventType, attempt, details, createdAt };
    });
  } catch {
    throw new SupaCloudWorkflowEventsError();
  }
}
