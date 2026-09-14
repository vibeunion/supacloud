import { describe, expect, mock, test } from "bun:test";
import { createSupaCloudClient } from "./index";

function workflowClient() {
  const rpc = mock<[string, { request: object }], Promise<{ data: unknown; error: unknown }>>(async (functionName, params) => ({
    data: { functionName, params },
    error: null,
  }));
  const supabase = {
    rpc,
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  };
  const client = createSupaCloudClient({
    supabase: supabase as never,
    managementApiUrl: "http://management-not-used",
    projectRef: "project-ref",
  });
  return { workflows: client.workflows, rpc };
}

describe("SupaCloud durable workflows client", () => {
  test("maps typed workflow operations to one-request public RPCs", async () => {
    const { workflows, rpc } = workflowClient();
    const attempt = {
      stepId: "22222222-2222-4222-8222-222222222222",
      messageId: "9",
      attempt: 1,
      workerId: "worker-1",
    };

    await workflows.start({
      runId: "11111111-1111-4111-8111-111111111111",
      workflowName: "invoice.issue",
      workflowVersion: "1",
      firstStepKey: "validate",
      input: { invoiceId: "inv-1" },
      maxAttempts: 4,
    });
    await workflows.claim({ workerId: "worker-1", visibilityTimeoutSeconds: 90 });
    await workflows.advance({
      ...attempt,
      output: { valid: true },
      nextStepKey: "render",
      nextInput: { invoiceId: "inv-1" },
      nextMaxAttempts: 2,
    });
    await workflows.complete({ ...attempt, stepOutput: { rendered: true }, runOutput: { artifactId: "a-1" } });
    await workflows.retry({ ...attempt, errorMessage: "temporary", delaySeconds: 30 });
    await workflows.fail({ ...attempt, errorMessage: "permanent" });
    await workflows.cancel("11111111-1111-4111-8111-111111111111", "operator request");
    await workflows.get("11111111-1111-4111-8111-111111111111");
    await workflows.events("11111111-1111-4111-8111-111111111111", { afterEventId: "8", limit: 25 });

    expect(JSON.stringify(rpc.mock.calls.map((call) => call[0]))).toBe(JSON.stringify([
      "supacloud_workflow_start",
      "supacloud_workflow_claim",
      "supacloud_workflow_advance",
      "supacloud_workflow_complete",
      "supacloud_workflow_retry",
      "supacloud_workflow_fail",
      "supacloud_workflow_cancel",
      "supacloud_workflow_get",
      "supacloud_workflow_events",
    ]));
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).toBe(JSON.stringify({
      request: {
        runId: "11111111-1111-4111-8111-111111111111",
        workflowName: "invoice.issue",
        workflowVersion: "1",
        firstStepKey: "validate",
        input: { invoiceId: "inv-1" },
        maxAttempts: 4,
      },
    }));
    expect(JSON.stringify(rpc.mock.calls[2]?.[1])).toBe(JSON.stringify({
      request: {
        ...attempt,
        output: { valid: true },
        nextStepKey: "render",
        nextInput: { invoiceId: "inv-1" },
        nextMaxAttempts: 2,
      },
    }));
    expect(JSON.stringify(rpc.mock.calls[8]?.[1])).toBe(JSON.stringify({
      request: {
        runId: "11111111-1111-4111-8111-111111111111",
        afterEventId: "8",
        limit: 25,
      },
    }));
  });

  test("preserves Supabase RPC errors", async () => {
    const { workflows, rpc } = workflowClient();
    const rpcError = { code: "42501", message: "permission denied" };
    rpc.mockResolvedValueOnce({ data: null, error: rpcError });

    let caught: unknown;
    try {
      await workflows.claim({ workerId: "worker-1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(rpcError);
  });
});
