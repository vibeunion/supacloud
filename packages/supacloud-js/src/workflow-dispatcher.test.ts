import { describe, expect, test } from "bun:test";
import type {
  SupaCloudWorkflowClaim,
  SupaCloudWorkflowClaimResult,
  SupaCloudWorkflowRun,
  SupaCloudWorkflowsClient,
} from "./workflows.js";
import {
  createSupaCloudWorkflowDispatcher,
  createSupaCloudWorkflowRegistry,
  createSupaCloudWorkflowTransport,
  SupaCloudWorkflowDispatchError,
  type SupaCloudWorkflowDefinition,
} from "./workflow-dispatcher.js";

const claim: SupaCloudWorkflowClaim = {
  status: "claimed",
  runId: "11111111-1111-4111-8111-111111111111",
  workflowName: "invoice.issue",
  workflowVersion: "1",
  stepId: "22222222-2222-4222-8222-222222222222",
  stepKey: "validate",
  input: { invoiceId: "inv-1" },
  messageId: "9",
  attempt: 1,
  maxAttempts: 3,
  workerId: "worker-1",
};

const run: SupaCloudWorkflowRun = {
  runId: claim.runId,
  workflowName: claim.workflowName,
  workflowVersion: claim.workflowVersion,
  status: "completed",
  input: claim.input,
  output: {},
  errorMessage: "",
  rowVersion: "2",
  createdAt: "2026-10-14T00:00:00.000Z",
  startedAt: "2026-10-14T00:00:00.000Z",
  completedAt: "2026-10-14T00:00:01.000Z",
  updatedAt: "2026-10-14T00:00:01.000Z",
  idempotent: false,
  steps: [],
};

function port(nextClaim: SupaCloudWorkflowClaimResult) {
  const calls: Array<{ name: string; request: Record<string, unknown> }> = [];
  const workflows: Pick<SupaCloudWorkflowsClient, "claim" | "advance" | "complete" | "retry" | "fail"> = {
    async claim() { return nextClaim; },
    async advance(request) { calls.push({ name: "advance", request }); return run; },
    async complete(request) { calls.push({ name: "complete", request }); return run; },
    async retry(request) { calls.push({ name: "retry", request }); return run; },
    async fail(request) { calls.push({ name: "fail", request }); return run; },
  };
  return { workflows, calls };
}

function definition(handler: SupaCloudWorkflowDefinition["handler"]): SupaCloudWorkflowDefinition {
  return {
    workflowName: claim.workflowName,
    workflowVersion: claim.workflowVersion,
    stepKey: claim.stepKey,
    handler,
  };
}

describe("SupaCloud workflow dispatcher", () => {
  test("routes a registered step and settles the exact claimed attempt", async () => {
    const { workflows, calls } = port(claim);
    const dispatcher = createSupaCloudWorkflowDispatcher({
      workflows,
      workerId: claim.workerId,
      registry: createSupaCloudWorkflowRegistry([definition({
        decode(input) { return input; },
        authorize(input, context) {
          expect(input).toEqual({ invoiceId: "inv-1" });
          expect(context.attempt).toBe(1);
          return true;
        },
        execute() {
          return { kind: "complete", stepOutput: { valid: true }, runOutput: { invoiceId: "inv-1" } };
        },
      })]),
    });

    expect(await dispatcher.dispatchOnce()).toMatchObject({ status: "completed" });
    expect(calls).toEqual([{
      name: "complete",
      request: {
        stepId: claim.stepId,
        messageId: claim.messageId,
        attempt: claim.attempt,
        workerId: claim.workerId,
        stepOutput: { valid: true },
        runOutput: { invoiceId: "inv-1" },
      },
    }]);
  });

  test("leaves unknown workflow versions and steps unsettled", async () => {
    const { workflows, calls } = port(claim);
    const dispatcher = createSupaCloudWorkflowDispatcher({
      workflows,
      workerId: claim.workerId,
      registry: createSupaCloudWorkflowRegistry([]),
    });

    await expect(dispatcher.dispatchOnce()).rejects.toMatchObject({
      name: "SupaCloudWorkflowDispatchError",
      code: "WORKFLOW_HANDLER_NOT_FOUND",
      claim,
    });
    expect(calls).toEqual([]);
  });

  test("supports explicit retry, failure and authorization outcomes", async () => {
    for (const [result, expected] of [
      [{
        kind: "advance", nextStepKey: "render", output: { valid: true },
        nextInput: { invoiceId: "inv-1" }, nextMaxAttempts: 2,
      }, "advance"],
      [{ kind: "retry", errorMessage: "temporary", delaySeconds: 10 }, "retry"],
      [{ kind: "fail", errorMessage: "permanent" }, "fail"],
    ] as const) {
      const { workflows, calls } = port(claim);
      const dispatcher = createSupaCloudWorkflowDispatcher({
        workflows,
        workerId: claim.workerId,
        registry: createSupaCloudWorkflowRegistry([definition({
          decode(input) { return input; },
          authorize() { return true; },
          execute() { return result; },
        })]),
      });
      expect(await dispatcher.dispatchOnce()).toMatchObject({
        status: expected === "advance" ? "advanced" : expected === "retry" ? "retried" : "failed",
      });
      expect(calls[0]?.name).toBe(expected === "advance" ? "advance" : expected);
    }

    const { workflows, calls } = port(claim);
    const dispatcher = createSupaCloudWorkflowDispatcher({
      workflows,
      workerId: claim.workerId,
      registry: createSupaCloudWorkflowRegistry([definition({
        decode(input) { return input; },
        authorize() { return false; },
        execute() { throw new Error("must not execute"); },
      })]),
    });
    expect(await dispatcher.dispatchOnce()).toMatchObject({ status: "failed" });
    expect(calls[0]?.request).toMatchObject({ errorMessage: "WORKFLOW_STEP_FORBIDDEN" });
  });

  test("rejects duplicate definitions and worker mismatches", async () => {
    const duplicate = definition({
      decode(input) { return input; },
      authorize() { return true; },
      execute() { return { kind: "complete" }; },
    });
    expect(() => createSupaCloudWorkflowRegistry([duplicate, duplicate]))
      .toThrow("WORKFLOW_DEFINITION_DUPLICATE");

    const { workflows, calls } = port({ ...claim, workerId: "other-worker" });
    const dispatcher = createSupaCloudWorkflowDispatcher({
      workflows,
      workerId: claim.workerId,
      registry: createSupaCloudWorkflowRegistry([duplicate]),
    });
    await expect(dispatcher.dispatchOnce()).rejects.toBeInstanceOf(SupaCloudWorkflowDispatchError);
    expect(calls).toEqual([]);
  });

  test("rejects malformed handler outcomes without settling the claim", async () => {
    const { workflows, calls } = port(claim);
    const dispatcher = createSupaCloudWorkflowDispatcher({
      workflows,
      workerId: claim.workerId,
      registry: createSupaCloudWorkflowRegistry([definition({
        decode(input) { return input; },
        authorize() { return true; },
        execute() { return { kind: "advance", nextStepKey: "render", nextInput: [] }; },
      })]),
    });

    await expect(dispatcher.dispatchOnce()).rejects.toMatchObject({
      code: "WORKFLOW_HANDLER_RESULT_INVALID",
      claim,
    });
    expect(calls).toEqual([]);
  });

  test("stops the polling loop on abort without adding a retry engine", async () => {
    let claims = 0;
    const controller = new AbortController();
    const workflows: Pick<SupaCloudWorkflowsClient, "claim" | "advance" | "complete" | "retry" | "fail"> = {
      async claim() {
        claims++;
        controller.abort();
        return null;
      },
      async advance() { return run; },
      async complete() { return run; },
      async retry() { return run; },
      async fail() { return run; },
    };
    const dispatcher = createSupaCloudWorkflowDispatcher({
      workflows,
      workerId: claim.workerId,
      pollIntervalMs: 0,
      registry: createSupaCloudWorkflowRegistry([]),
    });

    await dispatcher.run(controller.signal);
    expect(claims).toBe(1);
  });

  test("adapts claim and completion through the canonical Workflow mutations", async () => {
    const { workflows, calls } = port(claim);
    let accepted: SupaCloudWorkflowClaim | undefined;
    const transport = createSupaCloudWorkflowTransport({
      workflows,
      workerId: claim.workerId,
      visibilityTimeoutSeconds: 120,
      acceptClaim(value) {
        accepted = value;
      },
    });

    await expect(transport.claim(new AbortController().signal)).resolves.toEqual(claim);
    await transport.ack(claim, { artifactId: "artifact-1" });

    expect(accepted).toEqual(claim);
    expect(calls).toEqual([{
      name: "complete",
      request: {
        stepId: claim.stepId,
        messageId: claim.messageId,
        attempt: claim.attempt,
        workerId: claim.workerId,
        runOutput: { artifactId: "artifact-1" },
      },
    }]);
  });

  test("uses the Workflow retry budget and never settles discarded claim results", async () => {
    const first = port(claim);
    const transport = createSupaCloudWorkflowTransport({
      workflows: first.workflows,
      workerId: claim.workerId,
      retryDelaySeconds: 7,
    });
    await transport.fail(claim, new Error("temporary failure"));
    expect(first.calls).toEqual([{
      name: "retry",
      request: {
        stepId: claim.stepId,
        messageId: claim.messageId,
        attempt: claim.attempt,
        workerId: claim.workerId,
        errorMessage: "temporary failure",
        delaySeconds: 7,
      },
    }]);

    const exhaustedClaim = { ...claim, attempt: claim.maxAttempts };
    const exhausted = port(exhaustedClaim);
    const exhaustedTransport = createSupaCloudWorkflowTransport({
      workflows: exhausted.workflows,
      workerId: claim.workerId,
    });
    await exhaustedTransport.fail(exhaustedClaim, "permanent failure");
    expect(exhausted.calls[0]?.name).toBe("fail");

    for (const result of [
      { status: "dead_lettered", runId: claim.runId, stepId: claim.stepId, stepKey: claim.stepKey,
        messageId: claim.messageId, attempt: 4, maxAttempts: 3 },
      { status: "discarded", reason: "orphaned_message", messageId: claim.messageId },
    ] as const) {
      const discarded = port(result);
      const discardedTransport = createSupaCloudWorkflowTransport({
        workflows: discarded.workflows,
        workerId: claim.workerId,
      });
      await expect(discardedTransport.claim(new AbortController().signal)).resolves.toBeNull();
      expect(discarded.calls).toEqual([]);
    }
  });

  test("leaves a claimed step unsettled when the ownership guard rejects it", async () => {
    const { workflows, calls } = port(claim);
    const transport = createSupaCloudWorkflowTransport({
      workflows,
      workerId: claim.workerId,
      acceptClaim() {
        throw new Error("ownership mismatch");
      },
    });

    await expect(transport.claim(new AbortController().signal)).rejects.toThrow("ownership mismatch");
    expect(calls).toEqual([]);
  });
});
