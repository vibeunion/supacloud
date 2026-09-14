import { describe, expect, mock, spyOn, test } from "bun:test";
import { createSupaCloudClient } from "./index";
import { createClient } from "@supabase/supabase-js";
import { decodeCommandRead } from "./command-read";
import { captureCommandSubmit, decodeCommandSubmit } from "./command-submit";

function commandClient(errorStatus = 403) {
  const rpc = mock(async (functionName: string, params: { request: object }): Promise<{ data: unknown; error: unknown }> => ({
    data: functionName === "supacloud_command_get" ? null : { functionName, params }, error: null,
  }));
  const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || !("request" in body)
      || body.request === null || typeof body.request !== "object") throw new Error("Invalid request");
    const result = await rpc(new URL(request.url).pathname.split("/").at(-1) ?? "", { request: body.request });
    return Response.json(result.error ?? result.data, { status: result.error ? errorStatus : 200 });
  }, { preconnect: globalThis.fetch.preconnect });
  const supabase = createClient("http://local", "synthetic-key", {
    global: { fetch: transport },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    commands: createSupaCloudClient({
      supabase,
      managementApiUrl: "http://management-not-used",
      projectRef: "project-ref",
    }).commands,
    rpc,
  };
}

describe("SupaCloud command receipts client", () => {
  test("maps submit and get to service-role RPCs", async () => {
    const { commands, rpc } = commandClient();
    const request = validSubmitRequest();
    rpc.mockResolvedValueOnce({ data: validSubmission(), error: null });
    await commands.submit(request);
    await commands.get(request.commandId);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[0]).toBe("supacloud_command_submit");
    expect(rpc.mock.calls[1]?.[0]).toBe("supacloud_command_get");
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ request });
  });

  test("captures submit fields and rejects unsafe input before dispatch", async () => {
    const { commands, rpc } = commandClient();
    let getters = 0;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const request of [
      null, [], {}, { ...validSubmitRequest(), unknown: true },
      ...[
        { commandId: "bad" }, { commandType: "a".repeat(113) }, { targetType: "bad key" },
        { targetId: " " }, { targetId: "\u0000" }, { targetId: "\ud800" },
        { targetId: "a".repeat(501) }, { actorId: null }, { actorId: "bad" },
        { payload: [] }, { payload: cyclic }, { maxAttempts: 0 }, { maxAttempts: 101 },
        { maxAttempts: 1.5 }, { maxAttempts: "3" },
      ].map(patch => ({ ...validSubmitRequest(), ...patch })),
      Object.defineProperty(validSubmitRequest(), "payload", {
        enumerable: true, get() { getters++; return {}; },
      }),
    ]) {
      await expect(Reflect.apply(commands.submit, commands, [request])).rejects.toMatchObject({
        code: "COMMAND_SUBMIT_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(getters).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    const request = {
      ...validSubmitRequest(), commandId: commandId.toUpperCase(),
      commandType: " report.issue ", targetType: " report ", targetId: " report-1 ",
    };
    rpc.mockResolvedValueOnce({ data: validSubmission(), error: null });
    const pending = commands.submit(request);
    request.payload.changed = true;
    request.targetId = "changed";
    expect(await pending).toEqual(validSubmission());
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      request: { ...validSubmitRequest(), actorId: null },
    });
  });

  test("binds submit receipts but accepts idempotent snapshots after workflow progress", () => {
    const request = captureCommandSubmit(validSubmitRequest());
    const receipt = validSubmission();
    for (const value of [
      null, {}, { ...receipt, commandId: "22222222-2222-4222-8222-222222222222" },
      { ...receipt, workflow: { ...receipt.workflow, rowVersion: "2" } },
      { ...receipt, workflow: { ...receipt.workflow, steps: [{ ...receipt.workflow.steps[0], maxAttempts: 4 }] } },
    ]) {
      expect(() => decodeCommandSubmit(value, request)).toThrow("Command submission could not be validated");
    }
    expect(() => decodeCommandSubmit(receipt, { ...request, targetId: "other" })).toThrow();
    expect(() => decodeCommandSubmit(receipt, { ...request, payload: { different: true } })).toThrow();
    expect(() => decodeCommandSubmit(receipt, { ...request, actorId: "22222222-2222-4222-8222-222222222222" })).toThrow();
    const progressed = {
      ...receipt, idempotent: true,
      workflow: {
        ...receipt.workflow, status: "completed", rowVersion: "4", completedAt: receipt.createdAt,
        startedAt: receipt.createdAt,
        steps: receipt.workflow.steps.map(step => ({
          ...step, status: "completed", completedAt: receipt.createdAt,
          attempts: 1, claimedBy: "worker-1", claimedAt: receipt.createdAt,
        })),
      },
    };
    expect(decodeCommandSubmit(progressed, { ...request, maxAttempts: 100 })).toEqual(progressed);
  });

  test("never retries unavailable commands and preserves explicit SQL conflicts", async () => {
    for (const operation of ["get", "submit"]) {
      const { commands, rpc } = commandClient(503);
      rpc.mockResolvedValueOnce({ data: null, error: { code: "private", message: "private backend text" } });
      const pending = operation === "get" ? commands.get(commandId) : commands.submit(validSubmitRequest());
      await expect(pending).rejects.toMatchObject({
        code: operation === "get" ? "COMMAND_READ_INVALID" : "COMMAND_SUBMIT_UNCONFIRMED",
        mutationMayHaveApplied: operation === "submit",
      });
      expect(rpc).toHaveBeenCalledTimes(1);
    }
    const { commands, rpc } = commandClient(409);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "idempotency conflict" } });
    await expect(commands.submit(validSubmitRequest())).rejects.toMatchObject({ code: "23505" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test("bounds stalled command fetch and body waits even when cancellation is ignored", async () => {
    const original = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        original(callback, delay === 15000 ? 20 : delay, ...args),
      { __promisify__: original.__promisify__ },
    ));
    try {
      for (const operation of ["get", "submit"]) for (const mode of ["fetch", "body"]) {
        let calls = 0;
        let signal: AbortSignal | undefined;
        let deliver: ((response: Response) => void) | undefined;
        let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
        const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          signal = new Request(input, init).signal;
          if (mode === "body") return new Response(new ReadableStream<Uint8Array>({
            start(controller) { stream = controller; },
          }), { headers: { "content-type": "application/json" } });
          return new Promise<Response>(resolve => { deliver = resolve; });
        }, { preconnect: globalThis.fetch.preconnect });
        const supabase = createClient("http://local", "synthetic-key", {
          global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const commands = createSupaCloudClient({
          supabase, managementApiUrl: "http://management-not-used", projectRef: "fixture",
        }).commands;
        try {
          await expect(operation === "get" ? commands.get(commandId) : commands.submit(validSubmitRequest()))
            .rejects.toMatchObject({
              code: operation === "get" ? "COMMAND_READ_INVALID" : "COMMAND_SUBMIT_UNCONFIRMED",
              mutationMayHaveApplied: operation === "submit",
            });
          expect(calls).toBe(1);
          expect(signal?.aborted).toBe(true);
        } finally {
          deliver?.(Response.json(null));
          stream?.enqueue(new TextEncoder().encode("null"));
          stream?.close();
          await new Promise(resolve => original(resolve, 0));
        }
      }
    } finally { timers.mockRestore(); }
  });

  test("validates command IDs before dispatch and normalizes uppercase", async () => {
    const { commands, rpc } = commandClient();
    for (const id of ["", "bad", " " + commandId, 1, null, {}]) {
      await expect(Reflect.apply(commands.get, commands, [id])).rejects.toMatchObject({
        code: "COMMAND_READ_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(await commands.get(commandId.toUpperCase())).toBeNull();
    expect(rpc.mock.calls[0]?.[1]).toEqual({ request: { commandId } });
  });

  test("decodes the full receipt and detached workflow and preserves explicit errors", async () => {
    const { commands, rpc } = commandClient();
    const receipt = validReceipt();
    rpc.mockResolvedValueOnce({ data: { ...receipt, ignored: "extra" }, error: null });
    expect(await commands.get(commandId)).toEqual(receipt);
    const decoded = decodeCommandRead(receipt, commandId);
    receipt.workflow.input.payload.changed = true;
    expect(decoded?.workflow.input.payload).toEqual({});
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(commands.get(commandId)).rejects.toMatchObject({ code: "42501" });
  });

  test("rejects malformed fields and conflicting command/workflow identities", async () => {
    const { commands, rpc } = commandClient();
    const receipt = validReceipt();
    for (const value of [
      {}, [], false, { ...receipt, commandId: "22222222-2222-4222-8222-222222222222" },
      { ...receipt, idempotent: true }, { ...receipt, commandType: "bad type" },
      { ...receipt, targetType: "" }, { ...receipt, targetId: "a".repeat(501) },
      { ...receipt, targetId: "\u0000" }, { ...receipt, actorId: undefined },
      { ...receipt, actorId: "invalid" }, { ...receipt, payloadFingerprint: "a".repeat(64) },
      { ...receipt, createdAt: "2026-02-30T00:00:00Z" }, { ...receipt, workflow: null },
      ...[
        { runId: "22222222-2222-4222-8222-222222222222" }, { idempotent: true },
        { workflowName: "command.other" }, { workflowVersion: "2" },
        { rowVersion: 1 }, { steps: [] },
        ...["commandId", "commandType", "targetType", "targetId", "actorId", "payloadFingerprint", "payload"]
          .map(field => ({ input: {
            ...receipt.workflow.input,
            [field]: field === "actorId" ? "22222222-2222-4222-8222-222222222222" : null,
          } })),
        { steps: [{ ...receipt.workflow.steps[0], input: {} }] },
      ].map(workflow => ({ ...receipt, workflow: { ...receipt.workflow, ...workflow } })),
    ]) {
      rpc.mockResolvedValueOnce({ data: value, error: null });
      await expect(commands.get(commandId)).rejects.toMatchObject({
        code: "COMMAND_READ_INVALID", mutationMayHaveApplied: false,
      });
    }
  });

  test("locates the execute root independently of timestamp-tied SQL ordering", async () => {
    const { commands, rpc } = commandClient();
    const receipt = progressedReceipt();
    expect(receipt.workflow.steps[0]?.stepKey).toBe("finish");
    rpc.mockResolvedValueOnce({ data: receipt, error: null });
    expect(await commands.get(commandId)).toEqual(receipt);
    const replay = { ...receipt, idempotent: true };
    rpc.mockResolvedValueOnce({ data: replay, error: null });
    expect(await commands.submit(validSubmitRequest())).toEqual(replay);
    for (const steps of [
      receipt.workflow.steps.map(step => ({ ...step, nextStepKey: step.stepKey === "finish" ? "execute" : null })),
      receipt.workflow.steps.map(step => step.stepKey === "execute" ? { ...step, input: {} } : step),
      receipt.workflow.steps.filter(step => step.stepKey !== "execute"),
    ]) {
      rpc.mockResolvedValueOnce({ data: { ...receipt, workflow: { ...receipt.workflow, steps } }, error: null });
      await expect(commands.get(commandId)).rejects.toMatchObject({
        code: "COMMAND_READ_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(5);
  });

  test("maps invalid nested lifecycle receipts to command-specific uncertainty", async () => {
    const { commands, rpc } = commandClient();
    const receipt = progressedReceipt();
    for (const patch of [
      { completedAt: null }, { startedAt: null }, { status: "running" },
      { steps: receipt.workflow.steps.map(step => ({ ...step, claimedBy: null })) },
      { steps: receipt.workflow.steps.map(step => ({ ...step, attempts: 0 })) },
    ]) {
      const invalid = { ...receipt, workflow: { ...receipt.workflow, ...patch } };
      rpc.mockResolvedValueOnce({ data: invalid, error: null });
      await expect(commands.get(commandId)).rejects.toMatchObject({
        code: "COMMAND_READ_INVALID", mutationMayHaveApplied: false,
      });
      rpc.mockResolvedValueOnce({ data: { ...invalid, idempotent: true }, error: null });
      await expect(commands.submit(validSubmitRequest())).rejects.toMatchObject({
        code: "COMMAND_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
    }
    expect(rpc).toHaveBeenCalledTimes(10);
  });

  test("does not evaluate response getters or accept cyclic payloads", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "commandId", { enumerable: true, get() { reads++; return commandId; } });
    expect(() => decodeCommandRead(accessor, commandId)).toThrow();
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const receipt = validReceipt();
    expect(() => decodeCommandRead({ ...receipt, workflow: { ...receipt.workflow, input: cyclic } }, commandId)).toThrow();
  });
});

const commandId = "aaaaaaaa-1111-4111-8111-111111111111";
function validSubmitRequest() {
  const payload: Record<string, unknown> = {};
  return { commandId, commandType: "report.issue", targetType: "report", targetId: "report-1", payload, maxAttempts: 3 };
}
function validSubmission() {
  const receipt = validReceipt();
  return { ...receipt, workflow: { ...receipt.workflow, rowVersion: "1" } };
}
function progressedReceipt() {
  const receipt = validReceipt();
  const initial = receipt.workflow.steps[0];
  if (!initial) throw new Error("Expected execute step");
  const execute = {
    ...initial, status: "completed", attempts: 1, claimedBy: "worker-1",
    claimedAt: receipt.createdAt, completedAt: receipt.createdAt, nextStepKey: "finish",
  };
  return {
    ...receipt,
    workflow: {
      ...receipt.workflow, status: "completed", startedAt: receipt.createdAt, completedAt: receipt.createdAt,
      steps: [{
        ...execute, stepId: "00000000-2222-4222-8222-222222222222", stepKey: "finish",
        queueMessageId: "9007199254740994", input: { followup: true }, nextStepKey: null,
      }, execute],
    },
  };
}
function validReceipt() {
  const time = "2026-09-10T00:00:00.123456+00:00";
  const payload: Record<string, unknown> = {};
  const input = {
    commandId, commandType: "report.issue", targetType: "report", targetId: "report-1",
    actorId: null, payloadFingerprint: "md5:" + "a".repeat(32), payload,
  };
  return {
    commandId, commandType: input.commandType, targetType: input.targetType, targetId: input.targetId,
    actorId: input.actorId, payloadFingerprint: input.payloadFingerprint, createdAt: time, idempotent: false,
    workflow: {
      runId: commandId, workflowName: "command.report.issue", workflowVersion: "1",
      status: "queued", input, output: {}, errorMessage: "", rowVersion: "9007199254740993",
      createdAt: time, updatedAt: time, startedAt: null, completedAt: null, idempotent: false,
      steps: [{
        stepId: "bbbbbbbb-2222-4222-8222-222222222222", stepKey: "execute", status: "queued",
        input, output: {}, errorMessage: "", attempts: 0, maxAttempts: 3,
        retryDelaySeconds: 0, queueMessageId: "9007199254740993",
        claimedBy: null, claimedAt: null, completedAt: null, nextStepKey: null, createdAt: time, updatedAt: time,
      }],
    },
  };
}
