import { describe, expect, mock, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, SupaCloudWorkflowClaimError } from "./index";
import { decodeWorkflowClaim } from "./workflow-claim";
import { decodeWorkflowRun, SupaCloudWorkflowReadError } from "./workflow-run";
import { decodeWorkflowEvents } from "./workflow-events";

function workflowClient(errorStatus = 403) {
  const rpc = mock(async (functionName: string, params: { request: object }): Promise<{ data: unknown; error: unknown }> => ({
    data: functionName === "supacloud_workflow_events" ? []
      : ["supacloud_workflow_claim", "supacloud_workflow_get"].includes(functionName) ? null : { functionName, params },
    error: null,
  }));
  const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || !("request" in body)
      || body.request === null || typeof body.request !== "object") throw new Error("Invalid RPC request");
    const result = await rpc(new URL(request.url).pathname.split("/").at(-1) ?? "", { request: body.request });
    return Response.json(result.error ?? result.data, { status: result.error ? errorStatus : 200 });
  }, { preconnect: globalThis.fetch.preconnect });
  const supabase = createClient("http://local", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: transport },
  });
  const client = createSupaCloudClient({
    supabase,
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
    rpc.mockResolvedValueOnce({ data: {
      ...validRun(), runId: "11111111-1111-4111-8111-111111111111", rowVersion: "1",
      input: { invoiceId: "inv-1" },
      steps: validRun().steps.map(step => ({
        ...step, stepKey: "validate", input: { invoiceId: "inv-1" }, maxAttempts: 4,
      })),
    }, error: null });
    await workflows.start({
      runId: "11111111-1111-4111-8111-111111111111",
      workflowName: "invoice.issue",
      workflowVersion: "1",
      firstStepKey: "validate",
      input: { invoiceId: "inv-1" },
      maxAttempts: 4,
    });
    await workflows.claim({ workerId: "worker-1", visibilityTimeoutSeconds: 90 });
    rpc.mockResolvedValueOnce({ data: {
      ...validAdvance(),
      steps: validAdvance().steps.map((step, index) => index === 0
        ? { ...step, queueMessageId: "9", output: { valid: true }, nextStepKey: "render" }
        : { ...step, stepKey: "render", input: { invoiceId: "inv-1" }, maxAttempts: 2 }),
    }, error: null });
    await workflows.advance({
      ...attempt,
      output: { valid: true },
      nextStepKey: "render",
      nextInput: { invoiceId: "inv-1" },
      nextMaxAttempts: 2,
    });
    rpc.mockResolvedValueOnce({ data: {
      ...validCompletion(), output: { artifactId: "a-1" },
      steps: validCompletion().steps.map(step => ({
        ...step, queueMessageId: "9", output: { rendered: true },
      })),
    }, error: null });
    await workflows.complete({ ...attempt, stepOutput: { rendered: true }, runOutput: { artifactId: "a-1" } });
    rpc.mockResolvedValueOnce({ data: {
      ...validRetry(), steps: validRetry().steps.map(step => ({ ...step, queueMessageId: "9", retryDelaySeconds: 30 })),
      retryReceipt: { ...validRetry().retryReceipt, messageId: "9", delaySeconds: 30 },
    }, error: null });
    await workflows.retry({ ...attempt, errorMessage: "temporary", delaySeconds: 30 });
    rpc.mockResolvedValueOnce({ data: {
      ...validFailure(), steps: validFailure().steps.map(step => ({ ...step, queueMessageId: "9" })),
    }, error: null });
    await workflows.fail({ ...attempt, errorMessage: "permanent" });
    rpc.mockResolvedValueOnce({ data: {
      ...validCancellation(), runId: "11111111-1111-4111-8111-111111111111",
    }, error: null });
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
    expect(rpc.mock.calls[2]?.[1]).toEqual({
      request: {
        ...attempt,
        output: { valid: true },
        nextStepKey: "render",
        nextInput: { invoiceId: "inv-1" },
        nextMaxAttempts: 2,
      },
    });
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
    expect(caught).toMatchObject(rpcError);
  });

  test("decodes all claim states and preserves exact IDs through the official transport", async () => {
    const { workflows, rpc } = workflowClient();
    for (const receipt of [
      validClaim(),
      {
        status: "dead_lettered", runId: validClaim().runId, stepId: validClaim().stepId,
        stepKey: "work", messageId: "9007199254740993", attempt: 4, maxAttempts: 3,
      },
      { status: "discarded", reason: "orphaned_message", messageId: "9007199254740993" },
      {
        status: "discarded", reason: "step_not_claimable", messageId: "9007199254740993",
        runId: validClaim().runId, stepId: validClaim().stepId,
      },
      null,
    ]) {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      const result = await workflows.claim({ workerId: "worker-1" });
      expect(result).toEqual(receipt);
    }
    expect(rpc).toHaveBeenCalledTimes(5);
  });

  test("rejects malformed claim receipts without retrying or exposing their contents", async () => {
    const { workflows, rpc } = workflowClient();
    const invalid: unknown[] = [
      {}, [], false, "secret response",
      { ...validClaim(), status: "unknown" },
      { ...validClaim(), messageId: 9007199254740992 },
      { ...validClaim(), messageId: "01" },
      { ...validClaim(), messageId: "9223372036854775808" },
      { ...validClaim(), runId: "invalid" },
      { ...validClaim(), stepId: null },
      { ...validClaim(), workerId: "" },
      { ...validClaim(), workflowName: null },
      { ...validClaim(), workflowVersion: 1 },
      { ...validClaim(), stepKey: "" },
      { ...validClaim(), input: [] },
      { ...validClaim(), input: null },
      { ...validClaim(), attempt: "1" },
      { ...validClaim(), attempt: 0 },
      { ...validClaim(), attempt: 1.5 },
      { ...validClaim(), attempt: 4 },
      { ...validClaim(), maxAttempts: 2147483648 },
      { ...validClaim(), status: "dead_lettered", attempt: 3 },
      { status: "discarded", reason: "", messageId: "1" },
      { status: "discarded", reason: "future_reason", messageId: "1", runId: null },
    ];
    for (const receipt of invalid) {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(workflows.claim({ workerId: "worker-1" })).rejects.toMatchObject({
        name: "SupaCloudWorkflowClaimError",
        mutationMayHaveApplied: true,
        code: "WORKFLOW_CLAIM_UNCONFIRMED",
        message: "Workflow claim response could not be validated",
      });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length);
  });

  test("snapshots JSON input and rejects accessors and cyclic payloads", () => {
    const source = validClaim();
    const result = decodeWorkflowClaim(source, "worker-1");
    source.input.nested.push("changed");
    expect(result?.status === "claimed" ? result.input : null).toEqual({ nested: ["original"] });
    let reads = 0;
    const accessor = Object.defineProperty({}, "status", {
      enumerable: true, get() { reads += 1; return "claimed"; },
    });
    expect(() => decodeWorkflowClaim(accessor, "worker-1")).toThrow(SupaCloudWorkflowClaimError);
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => decodeWorkflowClaim({ ...validClaim(), input: cyclic }, "worker-1")).toThrow(SupaCloudWorkflowClaimError);
  });

  test("does not retry a claim after a transient HTTP failure", async () => {
    const { workflows, rpc } = workflowClient(503);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "unavailable", message: "temporary" } });
    await expect(workflows.claim({ workerId: "worker-1" })).rejects.toMatchObject({
      code: "WORKFLOW_CLAIM_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid claim requests before sending an RPC or evaluating accessors", async () => {
    const { workflows, rpc } = workflowClient();
    let reads = 0;
    const invalid: unknown[] = [
      null, [], {}, { workerId: "" }, { workerId: "   " }, { workerId: 1 },
      { workerId: "w".repeat(201) }, { workerId: "\ud800" }, { workerId: "bad\u0000id" },
      { workerId: "worker-1", extra: true },
      Object.create({ workerId: "worker-1" }),
      Object.defineProperty({}, "workerId", { value: "worker-1" }),
      Object.defineProperty({}, "workerId", { enumerable: true, get() { reads++; return "worker-1"; } }),
      { workerId: "worker-1", [Symbol("hidden")]: true },
      ...[null, "300", true, NaN, Infinity, 14, 3601, 15.5].map(visibilityTimeoutSeconds => ({
        workerId: "worker-1", visibilityTimeoutSeconds,
      })),
    ];
    for (const request of invalid) {
      await expect(Reflect.apply(workflows.claim, workflows, [request])).rejects.toMatchObject({
        name: "SupaCloudWorkflowClaimInputError", mutationMayHaveApplied: false,
        code: "WORKFLOW_CLAIM_INPUT_INVALID",
      });
    }
    expect(reads).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("uses SQL-compatible worker normalization and explicit timeout boundaries", async () => {
    const { workflows, rpc } = workflowClient();
    const unicodeWorker = "\u{1f600}".repeat(200);
    for (const request of [
      { workerId: " worker-1 " },
      { workerId: unicodeWorker, visibilityTimeoutSeconds: 15 },
      { workerId: "\tworker\t", visibilityTimeoutSeconds: 3600 },
    ]) {
      await workflows.claim(request);
    }
    expect(rpc.mock.calls.map(call => call[1].request)).toEqual([
      { workerId: "worker-1", visibilityTimeoutSeconds: 300 },
      { workerId: unicodeWorker, visibilityTimeoutSeconds: 15 },
      { workerId: "\tworker\t", visibilityTimeoutSeconds: 3600 },
    ]);
  });

  test("captures the worker before asynchronous dispatch and rejects a mismatched receipt", async () => {
    const { workflows, rpc } = workflowClient();
    rpc.mockResolvedValueOnce({ data: validClaim(), error: null });
    const request = { workerId: " worker-1 ", visibilityTimeoutSeconds: 30 };
    const pending = workflows.claim(request);
    request.workerId = "worker-2";
    request.visibilityTimeoutSeconds = 60;
    expect(await pending).toMatchObject({ status: "claimed", workerId: "worker-1" });
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      request: { workerId: "worker-1", visibilityTimeoutSeconds: 30 },
    });
    rpc.mockResolvedValueOnce({ data: { ...validClaim(), workerId: "worker-2" }, error: null });
    await expect(workflows.claim({ workerId: "worker-1" })).rejects.toMatchObject({
      code: "WORKFLOW_CLAIM_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test("rejects claim metadata outside SQL limits while preserving valid boundary values", async () => {
    const { workflows, rpc } = workflowClient();
    for (const patch of [
      { maxAttempts: 101 }, { maxAttempts: 2147483647 },
      { stepKey: "bad key" }, { stepKey: "_bad" }, { stepKey: "a".repeat(121) },
      { workflowName: "bad name" }, { workflowName: ".bad" }, { workflowName: "a".repeat(121) },
      { workflowVersion: "a".repeat(81) }, { workflowVersion: "\u0000" },
      { workflowVersion: "\ud800" }, { workflowVersion: "\udfff" },
    ]) {
      rpc.mockResolvedValueOnce({ data: { ...validClaim(), ...patch }, error: null });
      await expect(workflows.claim({ workerId: "worker-1" })).rejects.toMatchObject({
        code: "WORKFLOW_CLAIM_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(12);
    const boundary = {
      ...validClaim(), stepKey: "s".repeat(120), workflowName: "w".repeat(120),
      workflowVersion: "\u{1f600}".repeat(80), attempt: 100, maxAttempts: 100,
    };
    rpc.mockResolvedValueOnce({ data: boundary, error: null });
    expect(await workflows.claim({ workerId: "worker-1" })).toEqual(boundary);
    const dead = {
      status: "dead_lettered", runId: boundary.runId, stepId: boundary.stepId,
      stepKey: boundary.stepKey, messageId: boundary.messageId, attempt: 101, maxAttempts: 100,
    };
    expect(decodeWorkflowClaim(dead, "worker-1")).toEqual(dead);
    for (const patch of [{ maxAttempts: 101, attempt: 102 }, { stepKey: "invalid key" }]) {
      expect(() => decodeWorkflowClaim({ ...dead, ...patch }, "worker-1"))
        .toThrow("Workflow claim response could not be validated");
    }
  });

  test("bounds stalled fetch and body reads even when transport ignores cancellation", async () => {
    const originalTimeout = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        originalTimeout(callback, delay === 15000 ? 20 : delay, ...args),
      { __promisify__: originalTimeout.__promisify__ },
    ));
    try {
      for (const { operation, mode } of ["claim", "start", "get", "events"].flatMap(operation =>
        ["fetch", "body", "late-error"].map(mode => ({ operation, mode })))) {
        let calls = 0;
        let signal: AbortSignal | undefined;
        let deliver: ((response: Response) => void) | undefined;
        let fail: ((error: Error) => void) | undefined;
        let body: ReadableStreamDefaultController<Uint8Array> | undefined;
        const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          signal = new Request(input, init).signal;
          if (mode === "body") {
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) { body = controller; },
            }), { headers: { "content-type": "application/json" } });
          }
          return new Promise<Response>((resolve, reject) => { deliver = resolve; fail = reject; });
        }, { preconnect: globalThis.fetch.preconnect });
        const supabase = createClient("http://local", "fixture-key", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: transport },
        });
        const workflows = createSupaCloudClient({
          supabase, managementApiUrl: "http://management-not-used", projectRef: "fixture",
        }).workflows;
        try {
          const pending = operation === "get" ? workflows.get(validRun().runId)
            : operation === "events" ? workflows.events(validRun().runId)
            : operation === "start"
            ? workflows.start(validStartRequest()) : workflows.claim({ workerId: "worker-1" });
          await expect(pending).rejects.toMatchObject({
            code: operation === "get" ? "WORKFLOW_READ_INVALID"
              : operation === "events" ? "WORKFLOW_EVENTS_INVALID"
              : operation === "start" ? "WORKFLOW_START_UNCONFIRMED" : "WORKFLOW_CLAIM_UNCONFIRMED",
            mutationMayHaveApplied: operation === "start" || operation === "claim",
          });
          expect(calls).toBe(1);
          expect(signal?.aborted).toBe(true);
        } finally {
          if (mode === "late-error") fail?.(new Error("late private transport error"));
          else deliver?.(Response.json(validClaim()));
          body?.enqueue(new TextEncoder().encode("null"));
          body?.close();
          await new Promise(resolve => originalTimeout(resolve, 0));
        }
        expect(calls).toBe(1);
      }
    } finally {
      timers.mockRestore();
    }
  });

  test("clears the deadline after success, invalid receipt and explicit RPC rejection", async () => {
    const clear = spyOn(globalThis, "clearTimeout");
    try {
      const { workflows, rpc } = workflowClient();
      for (const { operation, response } of ["claim", "start", "get", "events"].flatMap(operation => [
        { data: operation === "events" ? [] : operation === "start" ? { ...validRun(), rowVersion: "1" } : null, error: null },
        { data: {}, error: null },
        { data: null, error: { code: "42501", message: "permission denied" } },
      ].map(response => ({ operation, response })))) {
        const before = clear.mock.calls.length;
        rpc.mockResolvedValueOnce(response);
        const pending = operation === "get" ? workflows.get(validRun().runId)
          : operation === "events" ? workflows.events(validRun().runId)
          : operation === "start"
          ? workflows.start(validStartRequest()) : workflows.claim({ workerId: "worker-1" });
        await pending.catch(() => undefined);
        expect(clear.mock.calls.length).toBeGreaterThan(before);
      }
    } finally {
      clear.mockRestore();
    }
  });

  test("rejects failed reads without retries or leaking transport details", async () => {
    for (const operation of ["get", "events"]) {
      for (const mode of ["disconnect", "503", "json", "204", "403"]) {
        let calls = 0;
        const transport = Object.assign(async () => {
          calls++;
          if (mode === "disconnect") throw new Error("private transport detail");
          if (mode === "204") return new Response(null, { status: 204 });
          if (mode === "json") return new Response("private malformed body", { status: 200 });
          return Response.json({ code: "42501", message: "permission denied" }, {
            status: mode === "403" ? 403 : 503,
          });
        }, { preconnect: globalThis.fetch.preconnect });
        const supabase = createClient("http://local", "fixture-key", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: transport },
        });
        const workflows = createSupaCloudClient({
          supabase, managementApiUrl: "http://management-not-used", projectRef: "fixture",
        }).workflows;
        const pending = operation === "get"
          ? workflows.get(validRun().runId) : workflows.events(validRun().runId);
        if (mode === "403") {
          await expect(pending).rejects.toMatchObject({ code: "42501", message: "permission denied" });
        } else {
          await expect(pending).rejects.toMatchObject({
            code: operation === "get" ? "WORKFLOW_READ_INVALID" : "WORKFLOW_EVENTS_INVALID",
            mutationMayHaveApplied: false,
            message: operation === "get"
              ? "Workflow read could not be validated" : "Workflow events could not be validated",
          });
        }
        expect(calls).toBe(1);
      }
    }
  });

  test("rejects impossible calendar dates in every workflow timestamp field", async () => {
    const run = validRun();
    const event = validEvent();
    const request = { runId: run.runId, afterEventId: "0", limit: 1 };
    const invalidTimes = [
      "2026-02-29T08:00:00Z", "1900-02-29T08:00:00Z", "2100-02-29T08:00:00Z",
      "2024-02-30T08:00:00Z", "2026-04-31T08:00:00+08:00",
      "2026-06-31T08:00:00Z", "2026-09-31T08:00:00Z", "2026-11-31T08:00:00Z",
      "2026-00-10T08:00:00Z", "2026-13-10T08:00:00Z", "2026-01-00T08:00:00Z",
      "2026-01-32T08:00:00Z", "2026-09-10T24:00:00Z", "2026-09-10T08:60:00Z",
      "2026-09-10T08:00:60Z", "2026-09-10T08:00:00+24:00", "2026-09-10T08:00:00+00:60",
      "2026-09-10T08:00:00.1234567Z", "2026-09-10T08:00:00", "2026-09-10T08:00:00Z\n",
    ];
    for (const time of invalidTimes) {
      for (const field of ["createdAt", "updatedAt", "startedAt", "completedAt"]) {
        expect(() => decodeWorkflowRun({ ...run, [field]: time }, run.runId))
          .toThrow("Workflow read could not be validated");
      }
      for (const field of ["createdAt", "updatedAt", "claimedAt", "completedAt"]) {
        expect(() => decodeWorkflowRun({
          ...run, steps: run.steps.map(step => ({ ...step, [field]: time })),
        }, run.runId)).toThrow("Workflow read could not be validated");
      }
      expect(() => decodeWorkflowEvents([{ ...event, createdAt: time }], request))
        .toThrow("Workflow events could not be validated");
    }
    const { workflows, rpc } = workflowClient();
    rpc.mockResolvedValueOnce({
      data: { ...run, rowVersion: "1", createdAt: invalidTimes[0] }, error: null,
    });
    await expect(workflows.start(validStartRequest())).rejects.toMatchObject({
      code: "WORKFLOW_START_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test("preserves valid calendar timestamps with microseconds and timezone offsets", () => {
    const run = validCompletion();
    const event = validEvent();
    for (const time of [
      "2000-02-29T23:59:59.123456Z", "2024-02-29T00:00:00+08:00",
      "2026-02-28T23:59:59-03:30", "2026-04-30T00:00:00.1Z",
      "2026-01-31T12:00:00+05:45", "2026-12-31T23:59:59.123456+00:00",
    ]) {
      const snapshot = {
        ...run, createdAt: time, updatedAt: time, startedAt: time, completedAt: time,
        steps: run.steps.map(step => ({
          ...step, createdAt: time, updatedAt: time, claimedAt: time, completedAt: time,
        })),
      };
      expect(decodeWorkflowRun(snapshot, run.runId)).toEqual(snapshot);
      expect(decodeWorkflowEvents([{ ...event, createdAt: time }], {
        runId: run.runId, afterEventId: "0", limit: 1,
      })).toEqual([{ ...event, createdAt: time }]);
    }
  });

  test("validates run snapshots and binds the returned run to the requested ID", async () => {
    const { workflows, rpc } = workflowClient();
    const receipt = validRun();
    rpc.mockResolvedValueOnce({ data: { ...receipt, ignored: "extra" }, error: null });
    expect(await workflows.get(receipt.runId.toUpperCase())).toEqual(receipt);
    expect(rpc.mock.calls[0]?.[1]).toEqual({ request: { runId: receipt.runId } });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await workflows.get(receipt.runId)).toBeNull();
    const captured = decodeWorkflowRun(receipt, receipt.runId);
    receipt.steps[0].input.changed = true;
    expect(captured?.steps[0]?.input).toEqual({});
  });

  test("rejects malformed run and step snapshots without manufacturing typed data", async () => {
    const { workflows, rpc } = workflowClient();
    const receipt = validRun();
    const invalid: unknown[] = [
      {}, [], true, { ...receipt, runId: validClaim().stepId },
      { ...receipt, workflowName: "invalid name" }, { ...receipt, workflowVersion: "" },
      { ...receipt, status: "unknown" }, { ...receipt, rowVersion: 1 },
      { ...receipt, rowVersion: "9223372036854775808" },
      { ...receipt, idempotent: true }, { ...receipt, idempotent: "false" },
      { ...receipt, input: [] }, { ...receipt, output: null },
      { ...receipt, createdAt: "not-a-date" }, { ...receipt, startedAt: undefined },
      { ...receipt, steps: null }, { ...receipt, steps: [...receipt.steps, ...receipt.steps] },
    ];
    for (const patch of [
      { stepId: "invalid" }, { status: "unknown" }, { stepKey: "invalid key" },
      { attempts: -1 }, { attempts: "1" }, { maxAttempts: 101 }, { maxAttempts: 0 },
      { retryDelaySeconds: 86401 }, { queueMessageId: 9007199254740992 },
      { claimedBy: 1 }, { claimedAt: "invalid" }, { completedAt: undefined },
      { nextStepKey: false }, { input: [] }, { output: null }, { errorMessage: 1 },
    ]) invalid.push({ ...receipt, steps: [{ ...receipt.steps[0], ...patch }] });
    for (const body of invalid) {
      rpc.mockResolvedValueOnce({ data: body, error: null });
      await expect(workflows.get(receipt.runId)).rejects.toMatchObject({
        code: "WORKFLOW_READ_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length);
    const before = rpc.mock.calls.length;
    for (const value of ["", "bad", ` ${receipt.runId} `]) {
      await expect(workflows.get(value)).rejects.toMatchObject({ code: "WORKFLOW_READ_INPUT_INVALID" });
    }
    expect(rpc).toHaveBeenCalledTimes(before);
  });

  test("rejects broken step successor graphs through the public read boundary", async () => {
    const { workflows, rpc } = workflowClient();
    const run = validAdvance();
    const first = run.steps[0], last = run.steps[1];
    if (!first || !last) throw new Error("Expected two workflow steps");
    const invalid = [
      { ...run, steps: [] },
      { ...run, steps: [{ ...first, nextStepKey: "missing" }, last] },
      { ...run, steps: [{ ...first, nextStepKey: first.stepKey }, last] },
      { ...run, steps: [{ ...first, status: "running" }, last] },
      { ...run, steps: [{ ...first, completedAt: null }, last] },
      { ...run, steps: [first, {
        ...last, status: "completed", completedAt: last.updatedAt, nextStepKey: first.stepKey,
      }] },
    ];
    for (const receipt of invalid) {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(workflows.get(run.runId)).rejects.toMatchObject({
        code: "WORKFLOW_READ_INVALID", mutationMayHaveApplied: false,
      });
    }
    for (const status of ["queued", "running", "completed", "failed", "cancelled", "dead_lettered"]) {
      const terminal = !["queued", "running"].includes(status);
      const errorMessage = terminal && status !== "completed" ? "terminal reason" : "";
      const receipt = {
        ...run,
        status: terminal ? (status === "dead_lettered" ? "failed" : status) : "running",
        startedAt: run.updatedAt, completedAt: terminal ? run.updatedAt : null,
        errorMessage,
        steps: [first, {
          ...last, status, errorMessage,
          attempts: status === "queued" ? 0 : status === "dead_lettered" ? last.maxAttempts : 1,
          claimedBy: status === "queued" ? null : "worker-1",
          claimedAt: status === "queued" ? null : last.updatedAt,
          completedAt: terminal ? last.updatedAt : null,
        }],
      };
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      expect(await workflows.get(run.runId)).toEqual(receipt);
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length + 6);
  });

  test("validates long unordered histories and cycles outside the first step", () => {
    const run = validCompletion();
    const base = run.steps[0];
    if (!base) throw new Error("Expected completed workflow step");
    const steps = Array.from({ length: 200 }, (_, index) => ({
      ...base,
      stepId: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
      stepKey: `step-${index}`, queueMessageId: String(index + 1),
      nextStepKey: index === 199 ? null : `step-${index + 1}`,
    }));
    const receipt = { ...run, steps: steps.toReversed() };
    expect(decodeWorkflowRun(receipt, run.runId)).toEqual(receipt);
    const broken = {
      ...run, steps: steps.map((item, index) => ({
        ...item,
        nextStepKey: index === 0 ? null : index === 199 ? "step-100" : item.nextStepKey,
      })),
    };
    expect(() => decodeWorkflowRun(broken, run.runId)).toThrow(SupaCloudWorkflowReadError);
  });

  test("rejects disconnected and converging step histories for reads and completion receipts", async () => {
    const { workflows, rpc } = workflowClient();
    const run = validCompletion();
    const first = run.steps[0];
    if (!first) throw new Error("Expected completed step");
    const second = {
      ...first, stepId: "aaaaaaaa-0000-4000-8000-000000000002",
      stepKey: "second", queueMessageId: "2",
    };
    const third = {
      ...first, stepId: "aaaaaaaa-0000-4000-8000-000000000003",
      stepKey: "third", queueMessageId: "3",
    };
    for (const steps of [
      [first, second],
      [first, { ...second, nextStepKey: "third" }, third],
      [{ ...first, nextStepKey: "third" }, { ...second, nextStepKey: "third" }, third],
      [first, { ...second, nextStepKey: "third" }, { ...third, nextStepKey: "second" }],
    ]) {
      const receipt = { ...run, steps };
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(workflows.get(run.runId)).rejects.toMatchObject({
        code: "WORKFLOW_READ_INVALID", mutationMayHaveApplied: false,
      });
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(workflows.complete(validCompleteRequest())).rejects.toMatchObject({
        code: "WORKFLOW_COMPLETE_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    const connected = {
      ...run,
      steps: [third, { ...first, nextStepKey: "second" }, { ...second, nextStepKey: "third" }],
    };
    rpc.mockResolvedValueOnce({ data: connected, error: null });
    expect(await workflows.get(run.runId)).toEqual(connected);
    expect(rpc).toHaveBeenCalledTimes(9);
  });

  test("rejects contradictory lifecycle fields through the public read boundary", async () => {
    const { workflows, rpc } = workflowClient();
    const queued = validRun(), completed = validCompletion(), retry = retryRun(validRetry());
    const step = completed.steps[0];
    if (!step) throw new Error("Expected completed step");
    const invalid = [
      { ...queued, completedAt: queued.updatedAt },
      { ...queued, startedAt: queued.updatedAt },
      { ...completed, completedAt: null },
      { ...completed, startedAt: null },
      { ...completed, steps: queued.steps },
      { ...retry, steps: completed.steps },
      { ...retry, errorMessage: "unexpected run failure" },
      { ...completed, errorMessage: "unexpected run failure" },
      { ...validFailure(), errorMessage: "different failure" },
      { ...validCancellation(), steps: completed.steps },
      { ...retry, steps: retry.steps.map(item => ({ ...item, attempts: item.maxAttempts })) },
      { ...retry, steps: retry.steps.map(item => ({ ...item, claimedBy: null, claimedAt: null })) },
      { ...retry, steps: [...retry.steps, {
        ...retry.steps[0], stepId: queued.runId, stepKey: "extra", queueMessageId: "2",
      }] },
      ...[
        { completedAt: null }, { attempts: 0 }, { attempts: 4 },
        { claimedBy: null }, { claimedAt: null }, { retryDelaySeconds: 1 },
        { errorMessage: "unexpected step failure" },
      ].map(patch => ({ ...completed, steps: [{ ...step, ...patch }] })),
      ...[
        { claimedBy: "worker-1", claimedAt: queued.updatedAt },
        { completedAt: queued.updatedAt }, { retryDelaySeconds: 1 },
      ].map(patch => ({ ...queued, steps: [{ ...queued.steps[0], ...patch }] })),
    ];
    for (const receipt of invalid) {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(workflows.get(queued.runId)).rejects.toMatchObject({
        code: "WORKFLOW_READ_INVALID", mutationMayHaveApplied: false,
      });
    }
    const neverClaimedDead = {
      ...queued, status: "failed", errorMessage: "maximum attempts exceeded", completedAt: queued.updatedAt,
      steps: queued.steps.map(item => ({
        ...item, status: "dead_lettered", attempts: item.maxAttempts + 1,
        errorMessage: "maximum attempts exceeded", completedAt: item.updatedAt,
      })),
    };
    const cancelledRetry = {
      ...retry, status: "cancelled", errorMessage: "operator request", completedAt: retry.updatedAt,
      steps: retry.steps.map(item => ({
        ...item, status: "cancelled", errorMessage: "operator request",
        completedAt: item.updatedAt, retryDelaySeconds: 86400,
      })),
    };
    const prematureDead = {
      ...neverClaimedDead,
      steps: neverClaimedDead.steps.map(item => ({ ...item, attempts: item.maxAttempts })),
    };
    rpc.mockResolvedValueOnce({ data: prematureDead, error: null });
    await expect(workflows.get(queued.runId)).rejects.toMatchObject({
      code: "WORKFLOW_READ_INVALID", mutationMayHaveApplied: false,
    });
    for (const receipt of [
      queued, completed, retry, validAdvance(), validCancellation(), validFailure(), neverClaimedDead, cancelledRetry,
    ]) {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      expect(await workflows.get(queued.runId)).toEqual(receipt);
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length + 9);
  });

  test("validates start inputs before dispatch and captures nested values", async () => {
    const { workflows, rpc } = workflowClient();
    const base = validStartRequest();
    let reads = 0;
    for (const request of [
      null, {}, [], { ...base, runId: "invalid" }, { ...base, workflowName: "bad name" },
      { ...base, workflowVersion: "" }, { ...base, firstStepKey: "bad key" },
      { ...base, input: null }, { ...base, input: [] }, { ...base, input: { invalid: undefined } },
      { ...base, maxAttempts: null }, { ...base, maxAttempts: "3" },
      { ...base, maxAttempts: 0 }, { ...base, maxAttempts: 101 }, { ...base, maxAttempts: 1.5 },
      { ...base, extra: true }, Object.create(base),
      Object.defineProperty({ ...base }, "input", { enumerable: true, get() { reads++; return {}; } }),
    ]) {
      await expect(Reflect.apply(workflows.start, workflows, [request])).rejects.toMatchObject({
        code: "WORKFLOW_START_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(reads).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    const request = { ...base, workflowName: " invoice.issue ", input: { nested: ["original"] } };
    rpc.mockResolvedValueOnce({ data: {
      ...validRun(), rowVersion: "1", input: { nested: ["original"] },
      steps: validRun().steps.map(step => ({ ...step, input: { nested: ["original"] } })),
    }, error: null });
    const pending = workflows.start(request);
    request.input.nested.push("changed");
    expect((await pending).input).toEqual({ nested: ["original"] });
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      request: { ...base, input: { nested: ["original"] }, maxAttempts: 3 },
    });
  });

  test("checks the full start identity while allowing an idempotent terminal snapshot", async () => {
    const { workflows, rpc } = workflowClient();
    const request = validStartRequest();
    const receipt = { ...validRun(), rowVersion: "1" };
    for (const value of [
      null, {}, { ...receipt, runId: validClaim().runId },
      { ...receipt, workflowName: "other" }, { ...receipt, workflowVersion: "2" },
      { ...receipt, input: { changed: true } }, { ...receipt, steps: [] },
      { ...receipt, status: "running" }, { ...receipt, rowVersion: "2" },
      ...[{ input: { changed: true } }, { stepKey: "other" }, { maxAttempts: 4 }, { attempts: 1 }]
        .map(patch => ({ ...receipt, steps: [{ ...receipt.steps[0], ...patch }] })),
    ]) {
      rpc.mockResolvedValueOnce({ data: value, error: null });
      await expect(workflows.start(request)).rejects.toMatchObject({
        code: "WORKFLOW_START_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    const terminal = {
      ...receipt, idempotent: true, status: "completed", rowVersion: "9007199254740993",
      startedAt: receipt.updatedAt, completedAt: receipt.updatedAt,
      steps: receipt.steps.map(step => ({
        ...step, status: "completed", attempts: 1, claimedBy: "worker-1",
        claimedAt: step.updatedAt, completedAt: step.updatedAt,
      })),
    };
    rpc.mockResolvedValueOnce({ data: terminal, error: null });
    expect(await workflows.start(request)).toEqual(terminal);
  });

  test("does not retry uncertain start failures and preserves explicit idempotency conflicts", async () => {
    const { workflows, rpc } = workflowClient(503);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "unavailable", message: "private" } });
    await expect(workflows.start(validStartRequest())).rejects.toMatchObject({
      code: "WORKFLOW_START_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    const conflict = workflowClient(409);
    conflict.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "conflict" } });
    await expect(conflict.workflows.start(validStartRequest())).rejects.toMatchObject({ code: "23505" });
    expect(conflict.rpc).toHaveBeenCalledTimes(1);
  });

  test("validates cancellation inputs and both initial and idempotent receipts", async () => {
    const { workflows, rpc } = workflowClient();
    const receipt = validCancellation();
    for (const reason of ["", "   ", "x".repeat(4001), "\ud800", "bad\u0000reason"]) {
      await expect(workflows.cancel(receipt.runId, reason)).rejects.toMatchObject({
        code: "WORKFLOW_CANCEL_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    await expect(workflows.cancel("invalid", "operator request")).rejects.toMatchObject({
      code: "WORKFLOW_CANCEL_INPUT_INVALID",
    });
    expect(rpc).not.toHaveBeenCalled();
    for (const idempotent of [false, true]) {
      rpc.mockResolvedValueOnce({ data: { ...receipt, idempotent }, error: null });
      expect(await workflows.cancel(receipt.runId.toUpperCase(), " operator request "))
        .toEqual({ ...receipt, idempotent });
    }
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      request: { runId: receipt.runId, reason: "operator request" },
    });
  });

  test("does not accept an unrelated or incomplete cancellation snapshot", async () => {
    const { workflows, rpc } = workflowClient();
    const receipt = validCancellation();
    const invalid: unknown[] = [
      null, {}, { ...receipt, runId: validClaim().runId }, { ...receipt, status: "running" },
      { ...receipt, errorMessage: "other reason" }, { ...receipt, completedAt: null },
      ...[{ status: "running" }, { status: "queued" }, { errorMessage: "other" }, { completedAt: null }]
        .map(patch => ({ ...receipt, steps: [{ ...receipt.steps[0], ...patch }] })),
    ];
    for (const data of invalid) {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(workflows.cancel(receipt.runId, "operator request")).rejects.toMatchObject({
        code: "WORKFLOW_CANCEL_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length);
    const unavailable = workflowClient(503);
    unavailable.rpc.mockResolvedValueOnce({ data: null, error: { code: "unavailable", message: "private" } });
    await expect(unavailable.workflows.cancel(receipt.runId, "operator request")).rejects.toMatchObject({
      code: "WORKFLOW_CANCEL_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(unavailable.rpc).toHaveBeenCalledTimes(1);
  });

  test("captures completion credentials and output before dispatch", async () => {
    const { workflows, rpc } = workflowClient();
    const base = validCompleteRequest();
    let reads = 0;
    for (const request of [
      null, {}, { ...base, stepId: "invalid" }, { ...base, messageId: 1 },
      { ...base, messageId: "01" }, { ...base, messageId: "9223372036854775808" },
      { ...base, attempt: "1" }, { ...base, attempt: 0 }, { ...base, attempt: 1.5 },
      { ...base, workerId: "" }, { ...base, stepOutput: null }, { ...base, runOutput: [] },
      { ...base, runOutput: { invalid: undefined } }, { ...base, extra: true },
      Object.defineProperty({ ...base }, "runOutput", { enumerable: true, get() { reads++; return {}; } }),
    ]) {
      await expect(Reflect.apply(workflows.complete, workflows, [request])).rejects.toMatchObject({
        code: "WORKFLOW_COMPLETE_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(reads).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    const request = { ...base, workerId: " worker-1 ", runOutput: { nested: ["original"] } };
    rpc.mockResolvedValueOnce({ data: { ...validCompletion(), output: { nested: ["original"] } }, error: null });
    const pending = workflows.complete(request);
    request.runOutput.nested.push("changed");
    expect((await pending).output).toEqual({ nested: ["original"] });
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      request: { ...base, stepOutput: {}, runOutput: { nested: ["original"] } },
    });
  });

  test("binds completion receipts to the submitted attempt and both outputs", async () => {
    const { workflows, rpc } = workflowClient();
    const receipt = validCompletion();
    for (const idempotent of [false, true]) {
      rpc.mockResolvedValueOnce({ data: { ...receipt, idempotent }, error: null });
      expect(await workflows.complete(validCompleteRequest())).toEqual({ ...receipt, idempotent });
    }
    const invalid: unknown[] = [
      null, {}, { ...receipt, status: "running" }, { ...receipt, output: { wrong: true } },
      { ...receipt, completedAt: null }, { ...receipt, errorMessage: "error" },
      { ...receipt, steps: [] },
      ...[
        { stepId: validClaim().runId }, { queueMessageId: "2" }, { attempts: 2 },
        { claimedBy: "other" }, { status: "running" }, { output: { wrong: true } },
        { nextStepKey: "unexpected" }, { completedAt: null }, { errorMessage: "error" },
      ].map(patch => ({ ...receipt, steps: [{ ...receipt.steps[0], ...patch }] })),
    ];
    for (const data of invalid) {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(workflows.complete(validCompleteRequest())).rejects.toMatchObject({
        code: "WORKFLOW_COMPLETE_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length + 2);
    const failed = workflowClient(503);
    failed.rpc.mockResolvedValueOnce({ data: null, error: { code: "unavailable", message: "private" } });
    await expect(failed.workflows.complete(validCompleteRequest())).rejects.toMatchObject({
      code: "WORKFLOW_COMPLETE_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(failed.rpc).toHaveBeenCalledTimes(1);
  });

  test("validates failure credentials and normalized error text before sending", async () => {
    const { workflows, rpc } = workflowClient();
    const base = { ...validCompleteRequest(), errorMessage: "permanent" };
    let reads = 0;
    for (const request of [
      {}, { ...base, messageId: 1 }, { ...base, attempt: "1" }, { ...base, workerId: "" },
      { ...base, errorMessage: "" }, { ...base, errorMessage: "   " },
      { ...base, errorMessage: "x".repeat(4001) }, { ...base, errorMessage: "\ud800" },
      { ...base, errorMessage: "bad\u0000message" }, { ...base, extra: true },
      Object.defineProperty({ ...base }, "errorMessage", { enumerable: true, get() { reads++; return "permanent"; } }),
    ]) {
      await expect(Reflect.apply(workflows.fail, workflows, [request])).rejects.toMatchObject({
        code: "WORKFLOW_FAIL_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(reads).toBe(0);
    for (const idempotent of [false, true]) {
      rpc.mockResolvedValueOnce({ data: { ...validFailure(), idempotent }, error: null });
      expect(await workflows.fail({ ...base, errorMessage: " permanent ", workerId: " worker-1 " }))
        .toEqual({ ...validFailure(), idempotent });
    }
    expect(rpc.mock.calls[0]?.[1]).toEqual({ request: base });
  });

  test("rejects mismatched failure receipts and does not retry uncertain failures", async () => {
    const { workflows, rpc } = workflowClient();
    const base = { ...validCompleteRequest(), errorMessage: "permanent" };
    const receipt = validFailure();
    const invalid: unknown[] = [
      null, {}, { ...receipt, status: "completed" }, { ...receipt, errorMessage: "other" },
      { ...receipt, completedAt: null }, { ...receipt, steps: [] },
      ...[
        { stepId: validClaim().runId }, { queueMessageId: "2" }, { attempts: 2 },
        { claimedBy: "other" }, { status: "running" }, { errorMessage: "other" }, { completedAt: null },
      ].map(patch => ({ ...receipt, steps: [{ ...receipt.steps[0], ...patch }] })),
    ];
    for (const data of invalid) {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(workflows.fail(base)).rejects.toMatchObject({
        code: "WORKFLOW_FAIL_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length);
    const failed = workflowClient(503);
    failed.rpc.mockResolvedValueOnce({ data: null, error: { code: "unavailable", message: "private" } });
    await expect(failed.workflows.fail(base)).rejects.toMatchObject({
      code: "WORKFLOW_FAIL_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(failed.rpc).toHaveBeenCalledTimes(1);
  });

  test("captures advance credentials and next-step parameters before dispatch", async () => {
    const { workflows, rpc } = workflowClient();
    const base = { ...validCompleteRequest(), nextStepKey: "next" };
    for (const request of [
      {}, { ...base, messageId: 1 }, { ...base, attempt: 0 }, { ...base, workerId: "" },
      { ...base, nextStepKey: "bad key" }, { ...base, nextInput: null }, { ...base, output: [] },
      { ...base, nextMaxAttempts: null }, { ...base, nextMaxAttempts: 101 }, { ...base, nextMaxAttempts: 1.5 },
    ]) {
      await expect(Reflect.apply(workflows.advance, workflows, [request])).rejects.toMatchObject({
        code: "WORKFLOW_ADVANCE_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    const request = { ...base, nextStepKey: " next ", nextInput: { nested: ["original"] } };
    const receipt = validAdvance();
    rpc.mockResolvedValueOnce({ data: {
      ...receipt, steps: receipt.steps.map((step, index) => index === 1
        ? { ...step, input: { nested: ["original"] } } : step),
    }, error: null });
    const pending = workflows.advance(request);
    request.nextInput.nested.push("changed");
    expect((await pending).steps[1]?.input).toEqual({ nested: ["original"] });
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      request: { ...base, output: {}, nextInput: { nested: ["original"] }, nextMaxAttempts: 3 },
    });
  });

  test("binds both advance steps without rejecting progress after an idempotent replay", async () => {
    const { workflows, rpc } = workflowClient();
    const request = { ...validCompleteRequest(), nextStepKey: "next" };
    const receipt = validAdvance();
    rpc.mockResolvedValueOnce({ data: receipt, error: null });
    expect(await workflows.advance(request)).toEqual(receipt);
    const progressed = {
      ...receipt, idempotent: true, status: "completed", completedAt: receipt.updatedAt,
      steps: receipt.steps.map(step => ({
        ...step, status: "completed", attempts: 1, claimedBy: "worker-1",
        claimedAt: step.updatedAt, completedAt: step.updatedAt,
      })),
    };
    rpc.mockResolvedValueOnce({ data: progressed, error: null });
    expect(await workflows.advance(request)).toEqual(progressed);
    const invalid: unknown[] = [
      null, {}, { ...receipt, status: "completed" }, { ...receipt, steps: [receipt.steps[0]] },
      ...[
        { queueMessageId: "2" }, { attempts: 2 }, { claimedBy: "other" },
        { nextStepKey: "other" }, { output: { wrong: true } }, { status: "running" },
      ].map(patch => ({ ...receipt, steps: [{ ...receipt.steps[0], ...patch }, receipt.steps[1]] })),
      ...[
        { input: { wrong: true } }, { maxAttempts: 4 }, { status: "running" }, { attempts: 1 },
      ].map(patch => ({ ...receipt, steps: [receipt.steps[0], { ...receipt.steps[1], ...patch }] })),
    ];
    for (const data of invalid) {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(workflows.advance(request)).rejects.toMatchObject({
        code: "WORKFLOW_ADVANCE_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length + 2);
  });

  test("captures retry input and validates queued, dead-letter and progressed replay states", async () => {
    const { workflows, rpc } = workflowClient();
    const request = { ...validCompleteRequest(), errorMessage: "temporary" };
    for (const patch of [
      { delaySeconds: null }, { delaySeconds: "30" }, { delaySeconds: -1 }, { delaySeconds: 86401 },
      { delaySeconds: 0.5 }, { errorMessage: "" }, { attempt: 0 }, { messageId: 1 },
    ]) {
      await expect(Reflect.apply(workflows.retry, workflows, [{ ...request, ...patch }])).rejects.toMatchObject({
        code: "WORKFLOW_RETRY_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    const queued = validRetry();
    rpc.mockResolvedValueOnce({ data: queued, error: null });
    expect(await workflows.retry({ ...request, errorMessage: " temporary " })).toEqual(retryRun(queued));
    expect(rpc.mock.calls[0]?.[1]).toEqual({ request: { ...request, delaySeconds: 0 } });
    const exhausted = {
      ...queued, status: "failed", errorMessage: "temporary", completedAt: queued.updatedAt,
      steps: queued.steps.map(step => ({ ...step, status: "dead_lettered", maxAttempts: 1, completedAt: step.updatedAt })),
    };
    rpc.mockResolvedValueOnce({ data: exhausted, error: null });
    expect(await workflows.retry(request)).toEqual(retryRun(exhausted));
    const progressed = {
      ...queued, idempotent: true,
      steps: queued.steps.map(step => ({ ...step, status: "running", attempts: 2, claimedBy: "new-worker" })),
    };
    rpc.mockResolvedValueOnce({ data: progressed, error: null });
    expect(await workflows.retry(request)).toEqual(retryRun(progressed));
  });

  test("rejects mismatched first retry receipts and invalid stable identities on replay", async () => {
    const { workflows, rpc } = workflowClient();
    const request = { ...validCompleteRequest(), errorMessage: "temporary" };
    const receipt = validRetry();
    const invalid: unknown[] = [
      null, {}, { ...receipt, status: "failed" }, { ...receipt, steps: [] },
      ...[
        { queueMessageId: "2" }, { attempts: 0 }, { attempts: 2 }, { claimedBy: "other" },
        { errorMessage: "other" }, { retryDelaySeconds: 1 }, { status: "running" },
        { maxAttempts: 1 }, { completedAt: receipt.updatedAt },
      ].map(patch => ({ ...receipt, steps: [{ ...receipt.steps[0], ...patch }] })),
      ...[{ queueMessageId: "2" }, { attempts: 0 }].map(patch => ({
        ...receipt, idempotent: true, steps: [{ ...receipt.steps[0], ...patch }],
      })),
    ];
    for (const data of invalid) {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(workflows.retry(request)).rejects.toMatchObject({
        code: "WORKFLOW_RETRY_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length);
  });

  test("captures event pagination without coercion or run-ID overrides", async () => {
    const { workflows, rpc } = workflowClient();
    const runId = validRun().runId;
    let reads = 0;
    for (const options of [
      null, [], { runId }, { afterEventId: 1 }, { afterEventId: "-1" }, { afterEventId: "01" },
      { afterEventId: "9223372036854775808" }, { limit: null }, { limit: "1" },
      { limit: 0 }, { limit: 501 }, { limit: 1.5 },
      Object.defineProperty({}, "limit", { enumerable: true, get() { reads++; return 1; } }),
    ]) {
      await expect(Reflect.apply(workflows.events, workflows, [runId, options])).rejects.toMatchObject({
        code: "WORKFLOW_EVENTS_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(reads).toBe(0);
    expect(await workflows.events(runId.toUpperCase())).toEqual([]);
    expect(rpc.mock.calls[0]?.[1]).toEqual({ request: { runId, afterEventId: "0", limit: 100 } });
    const options = { afterEventId: "9007199254740992", limit: 2 };
    const page = [validEvent(), { ...validEvent(), eventId: "9007199254740994" }];
    rpc.mockResolvedValueOnce({ data: page, error: null });
    const pending = workflows.events(runId, options);
    options.afterEventId = "9007199254740994";
    options.limit = 1;
    expect(await pending).toEqual(page);
    expect(rpc.mock.calls[1]?.[1]).toEqual({
      request: { runId, afterEventId: "9007199254740992", limit: 2 },
    });
  });

  test("validates every event and rejects out-of-order, duplicate, foreign and oversized pages", async () => {
    const { workflows, rpc } = workflowClient();
    const event = validEvent();
    const invalid: unknown[] = [
      null, {}, [event, event], [event, { ...event, eventId: "9007199254740992" }],
      ...[
        { eventId: 9007199254740992 }, { eventId: "0" }, { eventId: "01" },
        { eventId: "9223372036854775808" }, { eventId: "9007199254740992" },
        { runId: validClaim().runId }, { stepId: "bad" }, { stepId: undefined },
        { eventType: "unknown" }, { attempt: 0 }, { attempt: "1" }, { attempt: 1.5 },
        { details: null }, { details: [] }, { createdAt: "invalid" },
      ].map(patch => [{ ...event, ...patch }]),
      [event, { ...event, eventId: "9007199254740994" }, { ...event, eventId: "9007199254740995" }],
    ];
    for (const data of invalid) {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(workflows.events(event.runId, { afterEventId: "9007199254740992", limit: 2 }))
        .rejects.toMatchObject({ code: "WORKFLOW_EVENTS_INVALID", mutationMayHaveApplied: false });
    }
    expect(rpc).toHaveBeenCalledTimes(invalid.length);
    const source = { ...event, details: { nested: ["original"] } };
    const decoded = decodeWorkflowEvents([source], { runId: event.runId, afterEventId: "0", limit: 1 });
    source.details.nested.push("changed");
    expect(decoded[0]?.details).toEqual({ nested: ["original"] });
  });
});

function validClaim() {
  return {
    status: "claimed", runId: "11111111-1111-4111-8111-111111111111",
    stepId: "22222222-2222-4222-8222-222222222222", stepKey: "work",
    workflowName: "invoice.issue", workflowVersion: "1", workerId: "worker-1",
    messageId: "9007199254740993", attempt: 1, maxAttempts: 3,
    input: { nested: ["original"] },
  };
}

function validRun() {
  const time = "2026-09-10T08:00:00.123456+00:00";
  const input: Record<string, unknown> = {};
  return {
    runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workflowName: "invoice.issue", workflowVersion: "1", status: "queued",
    input: {}, output: {}, errorMessage: "", rowVersion: "9007199254740993",
    createdAt: time, updatedAt: time, startedAt: null, completedAt: null, idempotent: false,
    steps: [{
      stepId: validClaim().stepId, stepKey: "work", status: "queued",
      input, output: {}, errorMessage: "", attempts: 0, maxAttempts: 3,
      retryDelaySeconds: 0, queueMessageId: "9007199254740993",
      claimedBy: null, claimedAt: null, completedAt: null, nextStepKey: null,
      createdAt: time, updatedAt: time,
    }],
  };
}

function validStartRequest() {
  return {
    runId: validRun().runId, workflowName: "invoice.issue", workflowVersion: "1", firstStepKey: "work",
  };
}

function validCancellation() {
  const run = validRun();
  return {
    ...run, status: "cancelled", errorMessage: "operator request", completedAt: run.updatedAt,
    steps: run.steps.map(step => ({
      ...step, status: "cancelled", errorMessage: "operator request", completedAt: step.updatedAt,
    })),
  };
}

function validCompleteRequest() {
  return {
    stepId: validClaim().stepId, messageId: "9007199254740993", attempt: 1, workerId: "worker-1",
  };
}

function validCompletion() {
  const run = validRun();
  return {
    ...run, status: "completed", startedAt: run.updatedAt, completedAt: run.updatedAt,
    steps: run.steps.map(step => ({
      ...step, status: "completed", attempts: 1, claimedBy: "worker-1",
      claimedAt: step.updatedAt, completedAt: step.updatedAt,
    })),
  };
}

function validFailure() {
  const run = validCompletion();
  return {
    ...run, status: "failed", errorMessage: "permanent",
    steps: run.steps.map(step => ({ ...step, status: "failed", errorMessage: "permanent" })),
  };
}

function validAdvance() {
  const run = validCompletion();
  const next = validRun().steps[0];
  return {
    ...run, status: "running", completedAt: null,
    steps: [
      ...run.steps.map(step => ({ ...step, nextStepKey: "next" })),
      { ...next, stepId: validClaim().runId, stepKey: "next", queueMessageId: "9007199254740994" },
    ],
  };
}

function validRetry() {
  const run = validCompletion();
  return {
    ...run, status: "running", completedAt: null,
    retryReceipt: { ...validCompleteRequest(), operation: "retry", errorMessage: "temporary", delaySeconds: 0 },
    steps: run.steps.map(step => ({
      ...step, status: "queued", completedAt: null, errorMessage: "temporary",
    })),
  };
}

function retryRun<T extends { retryReceipt: unknown }>(value: T): Omit<T, "retryReceipt"> {
  const { retryReceipt, ...run } = value;
  return run;
}

function validEvent() {
  return {
    eventId: "9007199254740993", runId: validRun().runId, stepId: null,
    eventType: "run_started", attempt: null, details: {},
    createdAt: "2026-09-10T08:00:00.123456+00:00",
  };
}
