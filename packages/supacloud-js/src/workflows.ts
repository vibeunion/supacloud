import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeServiceRoleRpc } from "./service-role-rpc.js";

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

  start(request: SupaCloudWorkflowStartRequest): Promise<SupaCloudWorkflowRun> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_start", request);
  }

  claim(request: SupaCloudWorkflowClaimRequest): Promise<SupaCloudWorkflowClaimResult> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_claim", request);
  }

  advance(request: SupaCloudWorkflowAdvanceRequest): Promise<SupaCloudWorkflowRun> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_advance", request);
  }

  complete(request: SupaCloudWorkflowCompleteRequest): Promise<SupaCloudWorkflowRun> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_complete", request);
  }

  retry(request: SupaCloudWorkflowRetryRequest): Promise<SupaCloudWorkflowRun> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_retry", request);
  }

  fail(request: SupaCloudWorkflowFailRequest): Promise<SupaCloudWorkflowRun> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_fail", request);
  }

  cancel(runId: string, reason: string): Promise<SupaCloudWorkflowRun> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_cancel", {
      runId,
      reason,
    });
  }

  get(runId: string): Promise<SupaCloudWorkflowRun | null> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_get", { runId });
  }

  events(
    runId: string,
    options: { afterEventId?: string; limit?: number } = {},
  ): Promise<SupaCloudWorkflowEvent[]> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_workflow_events", {
      runId,
      ...options,
    });
  }
}
