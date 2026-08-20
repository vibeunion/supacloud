import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "@supacloud/js";

type WorkflowClaim = {
  outboxId: string;
  claimToken: string;
  runId: string;
  workflowName: string;
  workflowVersion: string;
  firstStepKey: string;
  input: Record<string, unknown>;
};

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: process.env.SUPACLOUD_MANAGEMENT_URL!,
  projectRef: process.env.SUPACLOUD_PROJECT_REF!,
});
const workerId = process.env.WORKER_ID || `review-workflow-${crypto.randomUUID()}`;

async function invokeWorkflowBridgeRpc<T>(
  name: string,
  request: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.rpc(name, { request });
  if (error) throw error;
  return data as T;
}

export async function dispatchOne(): Promise<boolean> {
  const claim = await invokeWorkflowBridgeRpc<WorkflowClaim | null>(
    "claim_review_document_workflow",
    { workerId, leaseSeconds: 300 },
  );
  if (!claim) return false;

  try {
    await supacloud.workflows.start({
      runId: claim.runId,
      workflowName: claim.workflowName,
      workflowVersion: claim.workflowVersion,
      firstStepKey: claim.firstStepKey,
      input: claim.input,
      maxAttempts: 5,
    });
    await invokeWorkflowBridgeRpc("complete_review_document_workflow_dispatch", {
      outboxId: claim.outboxId,
      claimToken: claim.claimToken,
      workerId,
    });
    return true;
  } catch {
    try {
      await invokeWorkflowBridgeRpc("release_review_document_workflow_dispatch", {
        outboxId: claim.outboxId,
        claimToken: claim.claimToken,
        workerId,
        errorMessage: "workflow start or acknowledgement failed",
        terminal: false,
      });
    } catch {
      // Completion may have committed before its response was lost.
    }
    return false;
  }
}

// Run dispatchOne() from a trusted Scheduled Function or long-running Worker.
// A fixed runId makes retry safe when workflow start committed but its response
// was lost. Never bundle this file into a browser or ship the service-role key.
