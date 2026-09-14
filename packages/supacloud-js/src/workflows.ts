import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeWorkflowMutation, invokeWorkflowRead } from "./workflow-rpc.js";
import { captureWorkflowClaimRequest, decodeWorkflowClaim, SupaCloudWorkflowClaimError } from "./workflow-claim.js";
import { captureWorkflowRunId, decodeWorkflowRun, SupaCloudWorkflowReadError } from "./workflow-run.js";
import { captureWorkflowStart, decodeWorkflowStart, SupaCloudWorkflowStartError } from "./workflow-start.js";
import { captureWorkflowCancel, decodeWorkflowCancel, SupaCloudWorkflowCancelError } from "./workflow-cancel.js";
import { captureWorkflowComplete, decodeWorkflowComplete, SupaCloudWorkflowCompleteError } from "./workflow-complete.js";
import { captureWorkflowFail, decodeWorkflowFail, SupaCloudWorkflowFailError } from "./workflow-fail.js";
import { captureWorkflowAdvance, decodeWorkflowAdvance, SupaCloudWorkflowAdvanceError } from "./workflow-advance.js";
import { captureWorkflowRetry, decodeWorkflowRetry, SupaCloudWorkflowRetryError } from "./workflow-retry.js";
import { captureWorkflowEvents, decodeWorkflowEvents, SupaCloudWorkflowEventsError } from "./workflow-events.js";
export { SupaCloudWorkflowClaimError, SupaCloudWorkflowClaimInputError } from "./workflow-claim.js";
export { SupaCloudWorkflowReadError } from "./workflow-run.js";
export { SupaCloudWorkflowStartError } from "./workflow-start.js";
export { SupaCloudWorkflowCancelError } from "./workflow-cancel.js";
export { SupaCloudWorkflowCompleteError } from "./workflow-complete.js";
export { SupaCloudWorkflowFailError } from "./workflow-fail.js";
export { SupaCloudWorkflowAdvanceError } from "./workflow-advance.js";
export { SupaCloudWorkflowRetryError } from "./workflow-retry.js";
export { SupaCloudWorkflowEventsError } from "./workflow-events.js";

export type SupaCloudWorkflowRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SupaCloudWorkflowStepStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "dead_lettered"
  | "cancelled";

export type SupaCloudWorkflowJson = Record<string, unknown>;

export interface SupaCloudWorkflowStep {
  stepId: string;
  stepKey: string;
  status: SupaCloudWorkflowStepStatus;
  input: SupaCloudWorkflowJson;
  output: SupaCloudWorkflowJson;
  errorMessage: string;
  attempts: number;
  maxAttempts: number;
  retryDelaySeconds: number;
  queueMessageId: string;
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  nextStepKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupaCloudWorkflowRun {
  runId: string;
  workflowName: string;
  workflowVersion: string;
  status: SupaCloudWorkflowRunStatus;
  input: SupaCloudWorkflowJson;
  output: SupaCloudWorkflowJson;
  errorMessage: string;
  rowVersion: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  idempotent: boolean;
  steps: SupaCloudWorkflowStep[];
}

export interface SupaCloudWorkflowStartRequest {
  runId: string;
  workflowName: string;
  workflowVersion: string;
  firstStepKey: string;
  input?: SupaCloudWorkflowJson;
  maxAttempts?: number;
}

export interface SupaCloudWorkflowClaimRequest {
  workerId: string;
  visibilityTimeoutSeconds?: number;
}

export interface SupaCloudWorkflowClaim {
  status: "claimed";
  runId: string;
  workflowName: string;
  workflowVersion: string;
  stepId: string;
  stepKey: string;
  input: SupaCloudWorkflowJson;
  messageId: string;
  attempt: number;
  maxAttempts: number;
  workerId: string;
}

export interface SupaCloudWorkflowDeadLetter {
  status: "dead_lettered";
  runId: string;
  stepId: string;
  stepKey: string;
  messageId: string;
  attempt: number;
  maxAttempts: number;
}

export interface SupaCloudWorkflowDiscardedMessage {
  status: "discarded";
  reason: "invalid_message" | "orphaned_message" | "step_not_claimable" | string;
  messageId: string;
  runId?: string;
  stepId?: string;
}

export type SupaCloudWorkflowClaimResult =
  | SupaCloudWorkflowClaim
  | SupaCloudWorkflowDeadLetter
  | SupaCloudWorkflowDiscardedMessage
  | null;

export interface SupaCloudWorkflowAttemptRequest {
  stepId: string;
  messageId: string;
  attempt: number;
  workerId: string;
}

export interface SupaCloudWorkflowAdvanceRequest extends SupaCloudWorkflowAttemptRequest {
  output?: SupaCloudWorkflowJson;
  nextStepKey: string;
  nextInput?: SupaCloudWorkflowJson;
  nextMaxAttempts?: number;
}

export interface SupaCloudWorkflowCompleteRequest extends SupaCloudWorkflowAttemptRequest {
  stepOutput?: SupaCloudWorkflowJson;
  runOutput?: SupaCloudWorkflowJson;
}

export interface SupaCloudWorkflowRetryRequest extends SupaCloudWorkflowAttemptRequest {
  errorMessage: string;
  delaySeconds?: number;
}

export interface SupaCloudWorkflowFailRequest extends SupaCloudWorkflowAttemptRequest {
  errorMessage: string;
}

export interface SupaCloudWorkflowEvent {
  eventId: string;
  runId: string;
  stepId: string | null;
  eventType: string;
  attempt: number | null;
  details: SupaCloudWorkflowJson;
  createdAt: string;
}

/**
 * Service-role-only durable workflow RPC client. Constructed by
 * `createSupaCloudClient`; never expose a service-role key in browser code.
 */
export class SupaCloudWorkflowsClient<TClient extends SupabaseClient = SupabaseClient> {
  constructor(private readonly supabase: TClient) {}

  async start(request: SupaCloudWorkflowStartRequest): Promise<SupaCloudWorkflowRun> {
    const captured = captureWorkflowStart(request);
    const result = await invokeWorkflowMutation(
      this.supabase, "supacloud_workflow_start", captured, () => new SupaCloudWorkflowStartError(true),
    );
    return decodeWorkflowStart(result, captured);
  }

  async claim(request: SupaCloudWorkflowClaimRequest): Promise<SupaCloudWorkflowClaimResult> {
    const captured = captureWorkflowClaimRequest(request);
    const result = await invokeWorkflowMutation(
      this.supabase, "supacloud_workflow_claim", captured, () => new SupaCloudWorkflowClaimError(),
    );
    return decodeWorkflowClaim(result, captured.workerId);
  }

  async advance(request: SupaCloudWorkflowAdvanceRequest): Promise<SupaCloudWorkflowRun> {
    const captured = captureWorkflowAdvance(request);
    const result = await invokeWorkflowMutation(
      this.supabase, "supacloud_workflow_advance", captured, () => new SupaCloudWorkflowAdvanceError(true),
    );
    return decodeWorkflowAdvance(result, captured);
  }

  async complete(request: SupaCloudWorkflowCompleteRequest): Promise<SupaCloudWorkflowRun> {
    const captured = captureWorkflowComplete(request);
    const result = await invokeWorkflowMutation(
      this.supabase, "supacloud_workflow_complete", captured, () => new SupaCloudWorkflowCompleteError(true),
    );
    return decodeWorkflowComplete(result, captured);
  }

  async retry(request: SupaCloudWorkflowRetryRequest): Promise<SupaCloudWorkflowRun> {
    const captured = captureWorkflowRetry(request);
    const result = await invokeWorkflowMutation(
      this.supabase, "supacloud_workflow_retry", captured, () => new SupaCloudWorkflowRetryError(true),
    );
    return decodeWorkflowRetry(result, captured);
  }

  async fail(request: SupaCloudWorkflowFailRequest): Promise<SupaCloudWorkflowRun> {
    const captured = captureWorkflowFail(request);
    const result = await invokeWorkflowMutation(
      this.supabase, "supacloud_workflow_fail", captured, () => new SupaCloudWorkflowFailError(true),
    );
    return decodeWorkflowFail(result, captured);
  }

  async cancel(runId: string, reason: string): Promise<SupaCloudWorkflowRun> {
    const captured = captureWorkflowCancel(runId, reason);
    const result = await invokeWorkflowMutation(
      this.supabase, "supacloud_workflow_cancel", captured, () => new SupaCloudWorkflowCancelError(true),
    );
    return decodeWorkflowCancel(result, captured);
  }

  async get(runId: string): Promise<SupaCloudWorkflowRun | null> {
    const captured = captureWorkflowRunId(runId);
    const result = await invokeWorkflowRead(
      this.supabase, "supacloud_workflow_get", { runId: captured }, () => new SupaCloudWorkflowReadError(),
    );
    return decodeWorkflowRun(result, captured);
  }

  async events(
    runId: string,
    options: { afterEventId?: string; limit?: number } = {},
  ): Promise<SupaCloudWorkflowEvent[]> {
    const captured = captureWorkflowEvents(runId, options);
    const result = await invokeWorkflowRead(
      this.supabase, "supacloud_workflow_events", captured, () => new SupaCloudWorkflowEventsError(),
    );
    return decodeWorkflowEvents(result, captured);
  }
}
