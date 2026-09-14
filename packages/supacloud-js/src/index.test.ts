import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createClient, FunctionsHttpError } from "@supabase/supabase-js";
import { createSupaCloudClient, createSupaCloudTaskFetch, SupaCloudApiError, SupaCloudTaskSubmitError } from "./index";

function createFakeSupabase() {
  const removeChannel = mock(async () => "ok");
  const rpc = mock(async (_fn: string, _params: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => ({
    data: null,
    error: null,
  }));
  const schema = mock((_name: string) => ({
    rpc: (fn: string, params: Record<string, unknown>) => ({
      retry: (_enabled: boolean) => rpc(fn, params),
    }),
  }));
  type FakeChannel = {
    on: ReturnType<typeof mock>;
    subscribe: ReturnType<typeof mock>;
  };

  let channelInstance: FakeChannel;
  channelInstance = {
    on: mock(function () {
      return channelInstance;
    }),
    subscribe: mock(function () {
      return channelInstance;
    }),
  };

  const supabase = {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "token-123" } },
        error: null,
      }),
    },
    functions: {
      invoke: mock(),
    },
    schema,
    channel: mock(() => channelInstance),
    removeChannel,
  };

  return { supabase, channelInstance, removeChannel, schema, rpc };
}

describe("@supacloud/js", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("submit preserves plain invoke options and returns a receipt", async () => {
    const requests: Request[] = [];
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ task_id: "tsk_123", status: "enqueued", project_ref: "proj_1" }, { status: 202 });
      } },
    });

    const client = createSupaCloudClient({
      supabase,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const receipt = await client.tasks.submit("aorist-ai/generate/crop", {
      body: { image_id: "img_1" },
      retries: 2,
      timeoutSec: 300,
      idempotencyKey: "crop-img_1-v1",
    });

    expect(receipt.taskId).toBe("tsk_123");
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("Expected function request");
    expect(request.url).toBe("http://local/functions/v1/aorist-ai/generate/crop");
    expect(await request.json()).toEqual({ image_id: "img_1" });
    expect(request.headers.get("x-supacloud-idempotency-key")).toBe("crop-img_1-v1");
  });

  test("submit throws a dedicated error when enqueue cannot be confirmed", async () => {
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async () => Response.json({
        prediction: { image: "https://example.com/image.png" },
      }) },
    });

    const client = createSupaCloudClient({
      supabase,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
    });

    await expect(
      client.tasks.submit("aorist-ai/generate/crop"),
    ).rejects.toBeInstanceOf(SupaCloudTaskSubmitError);
  });

  test("submit validates receipt identity and status through the real functions client", async () => {
    let payload: unknown;
    let calls = 0;
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async () => {
        calls++;
        return Response.json(payload, { status: 202 });
      } },
    });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
    });
    const canonical = "abcdef01-2345-6789-abcd-0123456789ab";
    for (const receipt of [
      { task_id: "task-1", status: "enqueued", project_ref: "fixture" },
      { taskId: "task-1", status: "succeeded" },
      { task_id: "task-1", taskId: "task-1", status: "future_state" },
      { task_id: canonical.toUpperCase(), taskId: canonical.replaceAll("-", ""), status: "running" },
    ]) {
      payload = { project_ref: "fixture", ...receipt };
      const result = await client.tasks.submit("worker");
      expect(result.taskId).toBe(receipt.task_id?.includes("ABCDEF") ? canonical : "task-1");
      expect(result.status).toBe(receipt.status);
    }
    for (const invalid of [
      null, [], "task-1", { prediction: true },
      { task_id: "task-1" },
      ...["", " ", ".", "..", " padded", "bad\nid", "\ud800", null, 1].map(task_id => ({ task_id, status: "enqueued" })),
      ...[null, 1, {}, [], "", " running", "running\n"].map(status => ({ task_id: "task-1", status })),
      { task_id: "task-1", taskId: "task-2", status: "enqueued" },
      { task_id: null, taskId: "task-1", status: "enqueued" },
      { task_id: "task-1", taskId: "", status: "enqueued" },
      ...["other-project", "FIXTURE", "", null, 42, {}, ["fixture"]].map(project_ref => ({
        task_id: "task-1", status: "enqueued", project_ref,
      })),
    ]) {
      payload = invalid && typeof invalid === "object" && !Array.isArray(invalid)
        ? { project_ref: "fixture", ...invalid } : invalid;
      const before = calls;
      const error = await client.tasks.submit("worker").catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SupaCloudTaskSubmitError);
      if (!(error instanceof SupaCloudTaskSubmitError)) throw new Error("Expected submit error");
      expect(error.code).toBe("TASK_SUBMIT_UNCONFIRMED");
      expect(error.mutationMayHaveApplied).toBe(true);
      expect(calls).toBe(before + 1);
    }

    for (const missingProject of [
      { task_id: "task-1", status: "pending" },
      { taskId: "task-1", status: "pending", projectRef: "fixture" },
    ]) {
      payload = missingProject;
      const before = calls;
      await expect(client.tasks.submit("worker")).rejects.toMatchObject({
        code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(calls).toBe(before + 1);
    }

    let reads = 0;
    const accessor = { project_ref: "fixture", status: "enqueued", get task_id() { reads++; return "task-1"; } };
    const functions = supabase.functions;
    const functionsProperty = Object.getOwnPropertyDescriptor(supabase, "functions");
    Object.defineProperty(supabase, "functions", { configurable: true, value: functions });
    const invoke = spyOn(functions, "invoke").mockResolvedValue({
      data: accessor, error: null, response: Response.json({}, { status: 202 }),
    });
    try {
      await expect(client.tasks.submit("worker")).rejects.toBeInstanceOf(SupaCloudTaskSubmitError);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(reads).toBe(0);
    } finally {
      invoke.mockRestore();
      if (functionsProperty) Object.defineProperty(supabase, "functions", functionsProperty);
      else Reflect.deleteProperty(supabase, "functions");
    }
  });

  test("accepts only non-redirected HTTP 202 submission responses", async () => {
    const payload = { task_id: "task-1", status: "pending", project_ref: "fixture" };
    let response = Response.json(payload, { status: 202 });
    let calls = 0;
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async () => { calls++; return response; } },
    });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
    });
    for (const status of [200, 201, 203, 204, 205, 206]) {
      response = status === 204 || status === 205 ? new Response(null, { status })
        : Response.json(payload, { status });
      const before = calls;
      await expect(client.tasks.submit("worker")).rejects.toMatchObject({
        code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(calls).toBe(before + 1);
    }
    response = Response.json(payload, { status: 202 });
    Object.defineProperty(response, "redirected", { value: true });
    await expect(client.tasks.submit("worker")).rejects.toMatchObject({
      code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    response = Response.json(payload, { status: 202 });
    expect(await client.tasks.submit("worker")).toMatchObject({ taskId: "task-1", status: "pending" });
    const functions = supabase.functions;
    const property = Object.getOwnPropertyDescriptor(supabase, "functions");
    Object.defineProperty(supabase, "functions", { configurable: true, value: functions });
    const invoke = spyOn(functions, "invoke").mockResolvedValue({ data: payload, error: null });
    try {
      await expect(client.tasks.submit("worker")).rejects.toMatchObject({
        code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      invoke.mockRestore();
      if (property) Object.defineProperty(supabase, "functions", property);
      else Reflect.deleteProperty(supabase, "functions");
    }
  });

  test("bounds task submission waiting and signals cancellation without replay", async () => {
    const originalTimer = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        originalTimer(callback, delay === 15000 ? 20 : delay, ...args),
      { __promisify__: originalTimer.__promisify__ },
    ));
    const clearTimer = spyOn(globalThis, "clearTimeout");
    try {
      for (const mode of ["fetch", "body", "success", "http-error"] as const) {
        let calls = 0;
        let signal: AbortSignal | null | undefined;
        let releaseFetch: ((response: Response) => void) | undefined;
        let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
        const supabase = createClient("http://local", "fixture-key", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: async (_input, init) => {
            calls++;
            signal = init?.signal;
            if (mode === "fetch") return new Promise<Response>(resolve => { releaseFetch = resolve; });
            if (mode === "body") return new Response(new ReadableStream<Uint8Array>({
              start(controller) { stream = controller; },
            }), { headers: { "content-type": "application/json" } });
            return Response.json({ task_id: "task-1", status: "pending", project_ref: "fixture" },
              { status: mode === "http-error" ? 403 : 202 });
          } },
        });
        const client = createSupaCloudClient({
          supabase, managementApiUrl: "http://management", projectRef: "fixture",
        });
        const beforeClear = clearTimer.mock.calls.length;
        try {
          if (mode === "success") {
            expect(await client.tasks.submit("worker")).toMatchObject({ taskId: "task-1", status: "pending" });
            expect(signal?.aborted).toBe(false);
          } else if (mode === "http-error") {
            await expect(client.tasks.submit("worker")).rejects.toMatchObject({ name: "FunctionsHttpError" });
            expect(signal?.aborted).toBe(false);
          } else {
            await expect(client.tasks.submit("worker")).rejects.toMatchObject({
              code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
              message: "Background task submission timed out; outcome is unconfirmed",
            });
            expect(signal?.aborted).toBe(true);
          }
          expect(calls).toBe(1);
          expect(clearTimer.mock.calls.length).toBeGreaterThan(beforeClear);
        } finally {
          releaseFetch?.(Response.json({ task_id: "task-1", status: "pending", project_ref: "fixture" }));
          stream?.enqueue(new TextEncoder().encode('{"task_id":"task-1","status":"pending","project_ref":"fixture"}'));
          stream?.close();
          await new Promise(resolve => originalTimer(resolve, 0));
        }
        expect(calls).toBe(1);
      }
    } finally {
      timers.mockRestore();
      clearTimer.mockRestore();
    }
  });

  test("classifies uncertain submit failures without replay or private error leakage", async () => {
    let calls = 0;
    let mode = "network";
    let cancellations = 0;
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async () => {
        calls++;
        if (mode === "network") throw new Error("private credential detail");
        if (mode === "json") return new Response("{private", {
          status: 202, headers: { "content-type": "application/json" },
        });
        if (mode === "client") return Response.json({ reason: "invalid request" }, { status: 409 });
        return new Response(new ReadableStream<Uint8Array>({
          cancel() { cancellations++; },
        }), {
          status: mode === "server" ? 503 : 403,
          headers: mode === "relay" ? { "x-relay-error": "true" } : {},
        });
      } },
    });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
    });
    for (mode of ["network", "json", "server", "relay"]) {
      const before = calls;
      const error: unknown = await client.tasks.submit("worker").catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SupaCloudTaskSubmitError);
      expect(error).toMatchObject({
        code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
        message: "Background task submission could not be confirmed", responseBody: undefined,
      });
      expect(calls).toBe(before + 1);
    }
    expect(cancellations).toBe(2);
    mode = "client";
    const explicit: unknown = await client.tasks.submit("worker").catch((cause: unknown) => cause);
    expect(explicit).toBeInstanceOf(FunctionsHttpError);
    if (!(explicit instanceof FunctionsHttpError)) throw new Error("Expected official HTTP error");
    const context: unknown = explicit.context;
    if (!(context instanceof Response)) throw new Error("Expected HTTP response");
    expect(context.status).toBe(409);
    expect(await context.json()).toEqual({ reason: "invalid request" });

    const functions = supabase.functions;
    const functionsProperty = Object.getOwnPropertyDescriptor(supabase, "functions");
    Object.defineProperty(supabase, "functions", { configurable: true, value: functions });
    const invoke = spyOn(functions, "invoke");
    try {
      for (const error of [0, false, "", { message: "private detail" }]) {
        invoke.mockResolvedValueOnce({ data: null, error });
        await expect(client.tasks.submit("worker")).rejects.toMatchObject({
          code: "TASK_SUBMIT_UNCONFIRMED", responseBody: undefined,
        });
      }
      invoke.mockImplementationOnce(() => { throw new Error("private synchronous failure"); });
      await expect(client.tasks.submit("worker")).rejects.toMatchObject({
        message: "Background task submission could not be confirmed", responseBody: undefined,
      });
      invoke.mockRejectedValueOnce(new SupaCloudTaskSubmitError("private forged timeout", "private body"));
      await expect(client.tasks.submit("worker")).rejects.toMatchObject({
        message: "Background task submission could not be confirmed", responseBody: undefined,
      });
      expect(invoke).toHaveBeenCalledTimes(6);
    } finally {
      invoke.mockRestore();
      if (functionsProperty) Object.defineProperty(supabase, "functions", functionsProperty);
      else Reflect.deleteProperty(supabase, "functions");
    }
  });

  test("bounds opted-in task function transport before the official client parses responses", async () => {
    const payload = { task_id: "task-1", status: "pending", project_ref: "fixture" };
    let mode = "valid";
    const requests: Request[] = [];
    let cancelled = 0;
    const urls = ["http://local/functions/v1/worker"];
    const transport = createSupaCloudTaskFetch({
      functionUrls: urls,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const headers = { "content-type": "application/json" };
        if (mode === "size") return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
          cancel() { cancelled++; },
        }), { status: 202, headers });
        if (mode === "length") return new Response("{}", {
          status: 202, headers: { ...headers, "content-length": "1048577" },
        });
        if (mode === "utf8") return new Response(new Uint8Array([255]), { status: 202, headers });
        if (mode === "mime") return new Response("{}", { status: 202 });
        if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "http://elsewhere" } });
        return Response.json(payload, { status: mode === "client" ? 409 : 202 });
      },
    });
    urls[0] = "http://changed/functions/v1/worker";
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
    });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
    });
    for (mode of ["size", "length", "utf8", "mime", "redirect"]) {
      const before = requests.length;
      await expect(client.tasks.submit("worker")).rejects.toMatchObject({
        code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(requests.length).toBe(before + 1);
      expect(requests.at(-1)?.redirect).toBe("error");
      expect(requests.at(-1)?.cache).toBe("no-store");
    }
    expect(cancelled).toBe(1);
    mode = "valid";
    expect(await client.tasks.submit("worker")).toMatchObject({ taskId: "task-1" });
    mode = "client";
    const error: unknown = await client.tasks.submit("worker").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(FunctionsHttpError);
    if (error instanceof FunctionsHttpError) {
      const response: unknown = error.context;
      if (response instanceof Response) await response.body?.cancel();
    }
    mode = "mime";
    for (const url of ["http://local/auth/v1/token", "http://other/functions/v1/worker", "http://local/functions/v1/other"]) {
      const response = await transport(url);
      expect(response.status).toBe(202);
      expect(requests.at(-1)?.redirect).toBe("follow");
      expect(requests.at(-1)?.cache).toBe("default");
      await response.body?.cancel();
    }
    for (const functionUrls of [[], [""], ["file:///worker"], ["https://user:password@local/worker"],
      ["http://local/worker?x=1"], ["http://local/worker#part"]]) {
      expect(() => createSupaCloudTaskFetch({ functionUrls })).toThrow("Invalid task function URLs");
    }
  });

  test("protected submissions block actual redirects and late-auth network dispatch", async () => {
    let destinationCalls = 0, sourceCalls = 0, networkCalls = 0;
    let mode = "redirect";
    const receipt = { task_id: "task-1", status: "pending", project_ref: "fixture" };
    const destination = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { destinationCalls++; return Response.json(receipt, { status: 202 }); },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        sourceCalls++;
        await request.text();
        if (mode === "redirect") return new Response(null, {
          status: 307, headers: { location: new URL("/capture", destination.url).href },
        });
        if (mode === "size") return Response.json({
          ...receipt, metadata: { text: "\u4e2d".repeat(350000) },
        }, { status: 202 });
        return Response.json(receipt, { status: 202 });
      },
    });
    let delayedToken: Promise<string | null> | undefined;
    let releaseToken: ((token: string) => void) | undefined;
    let guardFinished: (() => void) | undefined;
    const guarded = createSupaCloudTaskFetch({
      functionUrls: [new URL("/functions/v1/worker", source.url).href],
      fetch: (input, init) => { networkCalls++; return originalFetch(input, init); },
    });
    const supabase = createClient(source.url.origin, "fixture-key", {
      accessToken: () => delayedToken ?? Promise.resolve("fixture-token"),
      global: { fetch: async (input, init) => {
        try { return await guarded(input, init); }
        finally { guardFinished?.(); }
      } },
    });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: source.url.origin, projectRef: "fixture",
      getAccessToken: () => "fixture-token",
    });
    const originalTimer = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        originalTimer(callback, delay === 15000 ? 100 : delay, ...args),
      { __promisify__: originalTimer.__promisify__ },
    ));
    try {
      for (mode of ["redirect", "size"]) {
        const before = sourceCalls;
        await expect(client.tasks.submit("worker", { body: { work: true } })).rejects.toMatchObject({
          code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
        });
        expect(sourceCalls).toBe(before + 1);
        expect(destinationCalls).toBe(0);
      }
      mode = "valid";
      expect(await client.tasks.submit("worker")).toMatchObject({ taskId: "task-1", status: "pending" });
      expect(networkCalls).toBe(3);
      expect(sourceCalls).toBe(3);
      delayedToken = new Promise(resolve => { releaseToken = resolve; });
      const afterGuard = new Promise<void>(resolve => { guardFinished = resolve; });
      await expect(client.tasks.submit("worker")).rejects.toMatchObject({
        code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
        message: "Background task submission timed out; outcome is unconfirmed",
      });
      expect(networkCalls).toBe(3);
      releaseToken?.("fixture-late-token");
      await afterGuard;
      expect(networkCalls).toBe(3);
      expect(sourceCalls).toBe(3);
      expect(destinationCalls).toBe(0);
    } finally {
      releaseToken?.("fixture-cleanup-token");
      timers.mockRestore();
      await source.stop(true);
      await destination.stop(true);
    }
  });

  test("get/list/cancel/retry build management-api requests with bearer auth", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Request[] = [];

    globalThis.fetch = Object.assign(mock((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = request.url;
      calls.push(request);
      const task = { id: "tsk_123", status: "running", project_ref: "proj_1" };
      const payload = url.includes("/tasks?") || url.includes("/tasks/dlq")
        ? [task]
        : task;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
      );
    }), { preconnect: originalFetch.preconnect });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    await client.tasks.get("tsk_123");
    await client.tasks.list({ status: ["running", "failed"], functionSlug: "aorist-ai", limit: 5 });
    await client.tasks.cancel("tsk_123");
    await client.tasks.retry("tsk_123");
    await client.tasks.listDlq(10);

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123");
    expect(calls[1]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks?status=running%2Cfailed&function_slug=aorist-ai&limit=5");
    expect(calls[2]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123/cancel");
    expect(calls[2]?.method).toBe("POST");
    expect(calls[3]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123/retry");
    expect(calls[4]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks?dlq=true&limit=10");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer token-123");
  });

  test("validates task list filters before auth and preserves the requested DLQ limit", async () => {
    let authCalls = 0;
    const urls: string[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return Response.json([]);
    }, { preconnect: originalFetch.preconnect });
    const client = createSupaCloudClient({
      supabase: createClient("http://local", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => { authCalls++; return "fixture-token"; },
    });
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "limit", {
      enumerable: true, get() { getterCalls++; return 5; },
    });
    for (const invalid of [
      null, [], "filters", { unknown: 1 }, accessor,
      ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null].map(limit => ({ limit })),
      ...[[], [""], [1], "running,failed", " running", "\ud800", null].map(status => ({ status })),
      { taskType: ["valid", "queue:one,queue:two"] }, { taskType: {} },
      { functionSlug: "" }, { functionSlug: "worker\n" }, { dlq: "false" },
    ]) {
      // Exercise untyped callers without weakening the SDK's public signature.
      const result: unknown = Reflect.apply(client.tasks.list, client.tasks, [invalid]);
      await expect(result).rejects.toThrow("Invalid task list filters");
      expect(authCalls).toBe(0);
      expect(urls).toHaveLength(0);
    }
    expect(getterCalls).toBe(0);
    for (const limit of [0, -1, 0.5, NaN, Infinity]) {
      await expect(client.tasks.listDlq(limit)).rejects.toThrow("Invalid task list filters");
      expect(authCalls).toBe(0);
    }
    await client.tasks.list({
      status: ["running", "future_state"], taskType: ["queue:one", "custom/type"],
      functionSlug: "worker/path?#", dlq: false, limit: 7,
    });
    const query = new URL(urls[0] ?? "").searchParams;
    expect(query.get("status")).toBe("running,future_state");
    expect(query.get("task_type")).toBe("queue:one,custom/type");
    expect(query.get("function_slug")).toBe("worker/path?#");
    expect(query.has("dlq")).toBe(false);
    expect(query.get("limit")).toBe("7");
    await client.tasks.listDlq(3);
    expect(urls.at(-1)).toBe("http://management/v1/projects/fixture/tasks?dlq=true&limit=3");
    await client.tasks.listDlq();
    expect(urls.at(-1)).toBe("http://management/v1/projects/fixture/tasks?dlq=true&limit=100");
    expect(authCalls).toBe(3);
  });

  test("validates every declared task detail field before returning typed data", async () => {
    let payload: unknown;
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls++;
      return Response.json(payload);
    }, { preconnect: originalFetch.preconnect });
    const client = createSupaCloudClient({
      supabase: createClient("http://local", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: "http://management",
      projectRef: "fixture",
      getAccessToken: () => "fixture-token",
    });
    const log = { timestamp: "2026-09-10T00:00:00Z", stream: "stdout", level: "info", message: "done" };
    const attempt = {
      attempt_no: 1, status: "succeeded", started_at: log.timestamp, completed_at: log.timestamp,
      duration_ms: 1, response_status: 200, error: null, logs: [log],
    };
    const valid = {
      id: "task-1", status: "succeeded", project_ref: "fixture", function_slug: "worker", function_version: null,
      attempt: 1, max_attempts: 3, progress: 100, error: null, error_message: "",
      result: { ok: true }, payload: { input: [false, null] }, attempts: [attempt], latest_logs: [log],
      correlation_id: null, business_task_id: "business-1", metadata: { extra: true },
      created_at: log.timestamp, updated_at: log.timestamp, future_field: { preserved: true },
    };
    const invalid: unknown[] = [
      ...["function_slug", "function_version", "error", "error_message", "correlation_id", "business_task_id",
        "created_at", "updated_at"].map(key => ({ ...valid, [key]: 1 })),
      ...["attempt", "max_attempts", "progress"].map(key => ({ ...valid, [key]: "1" })),
      ...["payload", "metadata"].map(key => ({ ...valid, [key]: [] })),
      { ...valid, payload: null }, { ...valid, attempts: {} }, { ...valid, latest_logs: null },
      ...[
        { attempt_no: "1" }, { status: null }, { started_at: 1 }, { completed_at: false },
        { duration_ms: "1" }, { response_status: "200" }, { error: {} }, { logs: null },
        { logs: [{ ...log, stream: "other" }] },
      ].map(patch => ({ ...valid, attempts: [{ ...attempt, ...patch }] })),
      ...["timestamp", "stream", "level", "message"].map(key => ({
        ...valid, latest_logs: [{ ...log, [key]: null }],
      })),
      { ...valid, attempts: [{}] }, { ...valid, latest_logs: [{}] },
    ];
    for (const value of invalid) {
      payload = value;
      await expect(client.tasks.get("task-1")).rejects.toThrow("Invalid task");
    }
    for (const operation of [
      () => client.tasks.list(), () => client.tasks.listDlq(),
    ]) {
      payload = [valid, { ...valid, attempts: [{}] }];
      await expect(operation()).rejects.toThrow("Invalid task");
    }
    for (const operation of [
      () => client.tasks.cancel("task-1"), () => client.tasks.retry("task-1"),
    ]) {
      payload = { ...valid, latest_logs: [{}] };
      await expect(operation()).rejects.toThrow("Invalid task");
    }
    for (const value of [
      valid, { id: "task-1", status: "future_status", project_ref: "fixture" },
      { ...valid, metadata: null, progress: null, attempt: null, attempts: [], latest_logs: [] },
      { ...valid, attempts: [{ ...attempt, started_at: null, completed_at: null,
        duration_ms: null, response_status: null, error: null }] },
    ]) {
      payload = value;
      expect(await client.tasks.get("task-1")).toEqual(value);
    }
    expect(calls).toBe(invalid.length + 8);
  });

  test("binds task receipts to captured IDs and protects task URL segments", async () => {
    let payload: unknown;
    const urls: string[] = [];
    let authorizations = 0;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return Response.json(payload);
    }, { preconnect: originalFetch.preconnect });
    const client = createSupaCloudClient({
      supabase: createClient("http://local", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => { authorizations++; return "fixture-token"; },
    });
    for (const operation of ["get", "cancel", "retry"] as const) {
      payload = { id: "another-task", status: "running", project_ref: "fixture" };
      await expect(client.tasks[operation]("task-1")).rejects.toMatchObject({
        code: operation === "get" ? "TASK_READ_INVALID" : `TASK_${operation.toUpperCase()}_UNCONFIRMED`,
        mutationMayHaveApplied: operation !== "get",
      });
      payload = { id: "task-1", status: "running", attempts: [{}], project_ref: "fixture" };
      await expect(client.tasks[operation]("task-1")).rejects.toMatchObject({
        mutationMayHaveApplied: operation !== "get",
      });
      for (const id of ["", " ", ".", "..", " task-1", "task-1 ", "task\u0000", "\ud800"]) {
        const before = urls.length, beforeAuth = authorizations;
        await expect(client.tasks[operation](id)).rejects.toThrow("Invalid task ID");
        expect(urls.length).toBe(before);
        expect(authorizations).toBe(beforeAuth);
      }
      for (const id of ["legacy_task-1", "job/segment?#", "aaaaaaaa-AAAA-4aaa-8aaa-AAAAAAAAAAAA"]) {
        const canonical = id.includes("AAAA") ? id.toLowerCase() : id;
        payload = { id: canonical, status: "running", project_ref: "fixture" };
        expect(await client.tasks[operation](id)).toEqual(payload);
        const suffix = operation === "get" ? "" : `/${operation}`;
        expect(urls.at(-1)).toBe(`http://management/v1/projects/fixture/tasks/${encodeURIComponent(canonical)}${suffix}`);
      }
    }
    expect(urls).toHaveLength(15);
    expect(authorizations).toBe(15);
  });

  test("rejects task responses with conflicting project scope across all management operations", async () => {
    let requests = 0;
    let payload: unknown;
    globalThis.fetch = Object.assign(async () => {
      requests++;
      return Response.json(payload);
    }, { preconnect: originalFetch.preconnect });
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const options = {
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => {
        options.projectRef = "changed-during-auth";
        return "fixture-token";
      },
    };
    const client = createSupaCloudClient(options);
    const operations = [
      { run: () => client.tasks.get("task-1"), code: "TASK_READ_INVALID", list: false, mutation: false },
      { run: () => client.tasks.cancel("task-1"), code: "TASK_CANCEL_UNCONFIRMED", list: false, mutation: true },
      { run: () => client.tasks.retry("task-1"), code: "TASK_RETRY_UNCONFIRMED", list: false, mutation: true },
      { run: () => client.tasks.list(), code: "TASK_READ_INVALID", list: true, mutation: false },
      { run: () => client.tasks.listDlq(), code: "TASK_READ_INVALID", list: true, mutation: false },
    ];
    const valid = { id: "task-1", status: "pending", project_ref: "fixture" };
    for (const operation of operations) {
      payload = operation.list ? [valid] : valid;
      expect(await operation.run()).toEqual(payload);
      for (const project_ref of [undefined, "other-project", "FIXTURE", "", null, 42, {}, ["fixture"]]) {
        const row = { ...valid, project_ref };
        payload = operation.list ? [valid, row] : row;
        const before = requests;
        await expect(operation.run()).rejects.toMatchObject({
          code: operation.code, mutationMayHaveApplied: operation.mutation,
        });
        expect(requests).toBe(before + 1);
      }
    }
  });

  test("rejects unsafe task HTTP responses once while preserving explicit client errors", async () => {
    const client = createSupaCloudClient({
      supabase: createClient("http://local", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => "fixture-token",
    });
    const operations = [
      { run: () => client.tasks.get("task-1"), code: "TASK_READ_INVALID", mutation: false },
      { run: () => client.tasks.list(), code: "TASK_READ_INVALID", mutation: false },
      { run: () => client.tasks.listDlq(), code: "TASK_READ_INVALID", mutation: false },
      { run: () => client.tasks.cancel("task-1"), code: "TASK_CANCEL_UNCONFIRMED", mutation: true },
      { run: () => client.tasks.retry("task-1"), code: "TASK_RETRY_UNCONFIRMED", mutation: true },
    ];
    for (const operation of operations) {
      for (const mode of ["size", "length", "utf8", "mime", "redirect", "empty", "unavailable", "json", "created"]) {
        let calls = 0;
        globalThis.fetch = Object.assign(async () => {
          calls++;
          const headers = { "content-type": mode === "mime" ? "text/plain" : "application/json" };
          if (mode === "size") return new Response(" ".repeat(1024 * 1024 + 1), { headers });
          if (mode === "length") return new Response("{}", { headers: { ...headers, "content-length": "1048577" } });
          if (mode === "utf8") return new Response(new Uint8Array([255]), { headers });
          if (mode === "redirect") return new Response("{}", { status: 307, headers: { ...headers, location: "http://other" } });
          if (mode === "empty") return new Response(null, { status: 204 });
          if (mode === "unavailable") return Response.json({ message: "private upstream failure" }, { status: 503 });
          if (mode === "json") return new Response("{", { headers });
          return new Response(JSON.stringify({ id: "task-1", status: "running", project_ref: "fixture" }), {
            status: mode === "created" ? 201 : 200, headers,
          });
        }, { preconnect: originalFetch.preconnect });
        await expect(operation.run()).rejects.toMatchObject({
          code: operation.code, mutationMayHaveApplied: operation.mutation,
        });
        expect(calls).toBe(1);
      }
      globalThis.fetch = Object.assign(async () => Response.json({
        code: "409", message: "Task is already completed",
      }, { status: 409 }), { preconnect: originalFetch.preconnect });
      await expect(operation.run()).rejects.toMatchObject({ status: 409, code: "409" });
    }
  });

  test("bounds stalled task fetch and response bodies even when cancellation is ignored", async () => {
    const original = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        original(callback, delay === 15000 ? 20 : delay, ...args),
      { __promisify__: original.__promisify__ },
    ));
    try {
      const client = createSupaCloudClient({
        supabase: createClient("http://local", "fixture-key", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
        managementApiUrl: "http://management", projectRef: "fixture",
        getAccessToken: () => "fixture-token",
      });
      for (const operation of ["get", "cancel", "retry"] as const) for (const mode of ["fetch", "body"]) {
        let calls = 0, cancelled = 0;
        let signal: AbortSignal | undefined;
        let deliver: ((response: Response) => void) | undefined;
        const response = () => new Response(new ReadableStream<Uint8Array>({
          cancel() { cancelled++; },
        }), { headers: { "content-type": "application/json" } });
        globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          const request = new Request(input, init);
          signal = request.signal;
          expect(request.redirect).toBe("error");
          expect(request.cache).toBe("no-store");
          if (mode === "body") return response();
          return new Promise<Response>(resolve => { deliver = resolve; });
        }, { preconnect: originalFetch.preconnect });
        try {
          await expect(client.tasks[operation]("task-1")).rejects.toMatchObject({
            mutationMayHaveApplied: operation !== "get",
          });
          expect(calls).toBe(1);
          expect(signal?.aborted).toBe(true);
        } finally {
          deliver?.(response());
          await new Promise(resolve => original(resolve, 0));
        }
        expect(cancelled).toBe(1);
      }
    } finally { timers.mockRestore(); }
  });

  test("rejects invalid task authentication before dispatch without coercion or secret leakage", async () => {
    let calls = 0, coercions = 0, resolutions = 0;
    globalThis.fetch = Object.assign(async () => {
      calls++;
      return Response.json({ id: "task-1", status: "running", project_ref: "fixture" });
    }, { preconnect: originalFetch.preconnect });
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    for (const token of [null, "", " ", "token\r\ninjected", "\u4e2d", 42, {
      toString() { coercions++; return "private-coerced-token"; },
    }]) {
      const options = {
        supabase, managementApiUrl: "http://management", projectRef: "fixture",
        getAccessToken: () => "fixture-token",
      };
      Object.defineProperty(options, "getAccessToken", {
        value: () => { resolutions++; return token; },
      });
      const tasks = createSupaCloudClient(options).tasks;
      for (const operation of [() => tasks.get("task-1"), () => tasks.list(), () => tasks.listDlq(),
        () => tasks.cancel("task-1"), () => tasks.retry("task-1")]) {
        await expect(operation()).rejects.toMatchObject({
          code: "TASK_AUTH_INVALID", mutationMayHaveApplied: false,
          message: "Task authentication could not be validated",
        });
      }
    }
    for (const asynchronous of [false, true]) {
      const tasks = createSupaCloudClient({
        supabase, managementApiUrl: "http://management", projectRef: "fixture",
        getAccessToken() {
          if (asynchronous) return Promise.reject(new Error("private provider credentials"));
          throw new Error("private provider credentials");
        },
      }).tasks;
      await expect(tasks.retry("task-1")).rejects.toMatchObject({
        code: "TASK_AUTH_INVALID", mutationMayHaveApplied: false,
        message: "Task authentication could not be validated",
      });
    }
    expect(calls).toBe(0);
    expect(coercions).toBe(0);
    expect(resolutions).toBe(35);
  });

  test("times out task token resolution and prevents late credentials from dispatching requests", async () => {
    const original = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        original(callback, delay === 15000 ? 20 : delay, ...args),
      { __promisify__: original.__promisify__ },
    ));
    const clears = spyOn(globalThis, "clearTimeout");
    try {
      const supabase = createClient("http://local", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      let calls = 0;
      globalThis.fetch = Object.assign(async () => {
        calls++;
        return Response.json({ id: "task-1", status: "running", project_ref: "fixture" });
      }, { preconnect: originalFetch.preconnect });
      for (const operation of ["get", "cancel", "retry"] as const) {
        let release: (token: string) => void = () => {};
        const tasks = createSupaCloudClient({
          supabase, managementApiUrl: "http://management", projectRef: "fixture",
          getAccessToken: () => new Promise<string>(resolve => { release = resolve; }),
        }).tasks;
        const before = clears.mock.calls.length;
        try {
          await expect(tasks[operation]("task-1")).rejects.toMatchObject({
            code: "TASK_AUTH_TIMEOUT", mutationMayHaveApplied: false,
          });
          expect(clears.mock.calls.length).toBeGreaterThan(before);
          expect(calls).toBe(0);
        } finally {
          release("late-token");
          await new Promise(resolve => original(resolve, 0));
        }
        expect(calls).toBe(0);
      }
    } finally {
      clears.mockRestore();
      timers.mockRestore();
    }
  });

  test("queue client uses official pgmq_public RPCs for documented Supabase Queues APIs", async () => {
    const { supabase, schema, rpc } = createFakeSupabase();
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "send") return { data: [101], error: null };
      if (fn === "send_batch") return { data: [102, 103], error: null };
      if (fn === "read") return {
        data: [{ msg_id: 104, read_ct: 1, message: { hello: "world" }, enqueued_at: "2026-09-10T00:00:00Z", vt: "2026-09-10T00:00:30Z" }],
        error: null,
      };
      if (fn === "pop") return {
        data: [{ msg_id: 105, read_ct: 1, message: { popped: true }, enqueued_at: "2026-09-10T00:00:00Z", vt: "2026-09-10T00:00:30Z" }],
        error: null,
      };
      if (fn === "archive") return { data: true, error: null };
      if (fn === "delete") return { data: true, error: null };
      return { data: null, error: null };
    });

    globalThis.fetch = Object.assign(mock(() => {
      throw new Error("official queue methods must not call the management API");
    }), { preconnect: originalFetch.preconnect });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });
    const queue = client.queue("emails");

    const sent = await queue.send({ hello: "world" }, { sleepSeconds: 30 });
    const sentBatch = await queue.sendBatch([{ a: 1 }, { b: 2 }], { delayMs: 5000 });
    const read = await queue.read({ sleep_seconds: 60, n: 2 });
    const received = await queue.receive({ visibilityTimeoutSec: 45 });
    const popped = await queue.pop();
    const archived = await queue.archive(104);
    const acked = await queue.ack(104);
    const failed = await queue.fail(104);
    const deleted = await queue.delete(104);

    expect(schema.mock.calls[0]?.[0]).toBe("pgmq_public");
    expect(JSON.stringify(rpc.mock.calls.map((call) => call[0]))).toBe(JSON.stringify([
      "send",
      "send_batch",
      "read",
      "read",
      "pop",
      "archive",
      "archive",
      "archive",
      "delete",
    ]));
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).toBe(JSON.stringify({
      queue_name: "emails",
      message: { hello: "world" },
      sleep_seconds: 30,
    }));
    expect(JSON.stringify(rpc.mock.calls[1]?.[1])).toBe(JSON.stringify({
      queue_name: "emails",
      messages: [{ a: 1 }, { b: 2 }],
      sleep_seconds: 5,
    }));
    expect(JSON.stringify(rpc.mock.calls[2]?.[1])).toBe(JSON.stringify({
      queue_name: "emails",
      sleep_seconds: 60,
      n: 2,
    }));
    expect(JSON.stringify(rpc.mock.calls[3]?.[1])).toBe(JSON.stringify({
      queue_name: "emails",
      sleep_seconds: 45,
      n: 1,
    }));
    expect(sent).toMatchObject({ msg_id: "101", queue_name: "emails", status: "pending" });
    expect(sentBatch.map((message) => message.msg_id)).toEqual(["102", "103"]);
    expect(read[0]).toMatchObject({ msg_id: "104", payload: { hello: "world" }, status: "leased" });
    expect(received).toMatchObject({ msg_id: "104", payload: { hello: "world" } });
    expect(popped).toMatchObject({ msg_id: "105", payload: { popped: true }, status: "deleted" });
    expect(archived).toMatchObject({ msg_id: "104", status: "archived", success: true });
    expect(acked).toMatchObject({ msg_id: "104", status: "archived", success: true });
    expect(failed).toMatchObject({ msg_id: "104", status: "archived", success: true });
    expect(deleted).toMatchObject({ msg_id: "104", status: "deleted", success: true });
  });

  test("queue management extensions use management-api requests with bearer auth", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    globalThis.fetch = Object.assign(mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      let payload: unknown;
      if (url.endsWith("/tasks/queues")) {
        payload = (init?.method ?? "GET") === "POST"
          ? { queue_name: "emails" }
          : [{ queue_name: "emails" }];
      } else if (url.endsWith("/tasks/queues/emails")) {
        payload = undefined;
      } else if (url.endsWith("/messages?archived=true&limit=10")) {
        payload = [{ id: "123", msg_id: 123, payload: { hello: "world" } }];
      } else if (url.endsWith("/stats")) {
        payload = {
          queue_name: "emails",
          queue_length: 1,
          newest_msg_age_sec: null,
          oldest_msg_age_sec: null,
          total_messages: 1,
          scrape_time: "now",
        };
      } else if (url.endsWith("/settings")) {
        payload = {
          max_in_flight: 20,
          default_visibility_timeout_sec: 60,
          max_attempts: 3,
          rate_limit_per_minute: 100,
        };
      } else if (url.endsWith("/purge")) {
        payload = { queue_name: "emails", purged: 1 };
      } else {
        payload = { id: "123", msg_id: 123, status: "leased", payload: { hello: "world" } };
      }
      if (url.endsWith("/tasks/queues/emails") && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
      );
    }), { preconnect: originalFetch.preconnect });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });
    const queue = client.queue("emails");

    await client.queues.list();
    await client.queues.create("emails", { unlogged: true });
    await client.queues.drop("emails");
    await queue.list({ archived: true, limit: 10 });
    await queue.stats();
    await queue.getSettings();
    await queue.updateSettings({ max_in_flight: 20 });
    await queue.release(123, { delayMs: 5000, error: "retry later" });
    await queue.purge();
    await queue.get("123");
    await queue.retry("123");

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues");
    expect(calls[1]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[2]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails");
    expect(calls[2]?.init?.method).toBe("DELETE");
    expect(calls[3]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages?archived=true&limit=10");
    expect(calls[4]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/stats");
    expect(calls[5]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/settings");
    expect(calls[6]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/settings");
    expect(calls[6]?.init?.method).toBe("PATCH");
    expect(calls[7]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/123/release");
    expect(calls[8]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/purge");
    expect(calls[9]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/123");
    expect(calls[10]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/123/retry");
    expect((calls[0]?.init?.headers as Record<string, string>)?.authorization).toBe("Bearer token-123");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ queue_name: "emails", unlogged: true });
    expect(JSON.parse(String(calls[7]?.init?.body))).toMatchObject({ sleep_seconds: 5, error: "retry later" });
  });

  test("management-api errors preserve status, code, and response body", async () => {
    const { supabase } = createFakeSupabase();
    const errorBody = {
      message: "Queue message cannot be replayed from its current state",
      code: "409",
    };

    globalThis.fetch = Object.assign(mock(() => Promise.resolve(
      new Response(JSON.stringify(errorBody), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    )), { preconnect: originalFetch.preconnect });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    try {
      await client.queue("emails").retry("123");
      throw new Error("Expected retry to fail");
    } catch (error) {
      expect(error instanceof SupaCloudApiError).toBe(true);
      expect((error as SupaCloudApiError).status).toBe(409);
      expect((error as SupaCloudApiError).code).toBe("409");
      expect((error as SupaCloudApiError).responseBody).toMatchObject(errorBody);
      expect((error as Error).message).toBe(errorBody.message);
    }
  });

  test("queue receive returns null when no message is available", async () => {
    const { supabase, rpc } = createFakeSupabase();
    rpc.mockResolvedValue({ data: [], error: null });
    globalThis.fetch = Object.assign(mock(() => {
      throw new Error("receive should use pgmq_public.read");
    }), { preconnect: originalFetch.preconnect });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const message = await client.queue("emails").receive();
    expect(message).toBe(null);
  });

  test("oauth helpers call management api and build authorize urls", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const oauthClientId = "12345678-1234-4234-8234-123456789abc";
    const oauthClient = {
      client_id: oauthClientId, client_name: "App", client_type: "confidential",
      redirect_uris: ["https://app.example.com/callback"],
      token_endpoint_auth_method: "client_secret_basic", registration_type: "manual",
    };
    const signingPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    );
    const publicKey = {
      ...await crypto.subtle.exportKey("jwk", signingPair.publicKey),
      kid: "key-1", alg: "ES256", use: "sig",
    };
    const statusPayload = {
      project_ref: "proj_1",
      organization_id: "org_1",
      account_isolated: true,
      state_source: "configuration",
      runtime_verified: false,
      authorization_path: "/authorize.html",
      enabled: true,
      allow_dynamic_registration: true,
      issuer: "https://proj.example.com/auth/v1",
      discovery_url: "https://proj.example.com/auth/v1/.well-known/openid-configuration",
      oauth_authorization_server_metadata_url: "https://proj.example.com/.well-known/oauth-authorization-server/auth/v1",
      jwks_url: "https://proj.example.com/auth/v1/.well-known/jwks.json",
      authorization_endpoint: "https://proj.example.com/auth/v1/oauth/authorize",
      token_endpoint: "https://proj.example.com/auth/v1/oauth/token",
      userinfo_endpoint: "https://proj.example.com/auth/v1/oauth/userinfo",
      registration_endpoint: "https://proj.example.com/auth/v1/oauth/clients/register",
      signing_alg: "ES256",
      key_id: "key-1",
      oidc_id_token_ready: true,
      migration_status: "oidc_es256_migrated",
      warnings: [],
    };

    globalThis.fetch = Object.assign(mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });

      if (
        url.endsWith("/auth/oauth-server")
        || url.endsWith("/auth/oauth-server/migrate")
      ) {
        return Promise.resolve(
          new Response(JSON.stringify(statusPayload), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url === statusPayload.discovery_url) {
        return Promise.resolve(
          new Response(JSON.stringify({
            issuer: statusPayload.issuer, authorization_endpoint: statusPayload.authorization_endpoint,
            token_endpoint: statusPayload.token_endpoint, jwks_uri: statusPayload.jwks_url,
            response_types_supported: ["code"], subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["ES256"],
          }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url === statusPayload.jwks_url) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [publicKey] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith("/auth/oauth-clients")) {
        if ((init?.method ?? "GET") === "POST") {
          return Promise.resolve(
            new Response(JSON.stringify({ ...oauthClient, client_type: "public", token_endpoint_auth_method: "none" }), {
              status: 201, headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ clients: [oauthClient] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith(`/auth/oauth-clients/${oauthClientId}/regenerate-secret`)) {
        return Promise.resolve(
          new Response(JSON.stringify({ ...oauthClient, client_secret: "secret_2" }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith(`/auth/oauth-clients/${oauthClientId}`)) {
        if ((init?.method ?? "GET") === "PUT") {
          return Promise.resolve(
            new Response(JSON.stringify({ ...oauthClient, client_name: "App 2" }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if ((init?.method ?? "GET") === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify(oauthClient), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }), { preconnect: originalFetch.preconnect });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const status = await client.auth.oauthServer.getStatus();
    await client.auth.oauthServer.migrateToOidc({
      allowDynamicRegistration: true,
      authorizationPath: "/authorize.html",
    });
    const discovery = await client.auth.oauthServer.getDiscovery();
    const jwks = await client.auth.oauthServer.getJwks();
    const authorizeUrl = await client.auth.oauthServer.buildAuthorizeUrl({
      clientId: "client_1",
      redirectUri: "https://app.example.com/callback",
      scope: ["openid", "email"],
      state: "state_1",
      codeChallenge: "A".repeat(43),
      codeChallengeMethod: "S256",
      nonce: "nonce_1",
      resource: "https://api.example.com",
    });
    await client.auth.oauthClients.list();
    await client.auth.oauthClients.create({
      redirect_uris: ["https://app.example.com/callback"],
      client_name: "App",
      client_type: "public",
      token_endpoint_auth_method: "none",
    });
    await client.auth.oauthClients.get(oauthClientId);
    await client.auth.oauthClients.update(oauthClientId, { client_name: "App 2" });
    await client.auth.oauthClients.regenerateSecret(oauthClientId);
    await client.auth.oauthClients.delete(oauthClientId);

    expect(status.account_isolated).toBe(true);
    expect(status.signing_alg).toBe("ES256");
    expect(status.oidc_id_token_ready).toBe(true);
    expect(discovery.issuer).toBe(statusPayload.issuer);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe("key-1");

    const authUrl = new URL(authorizeUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(statusPayload.authorization_endpoint);
    expect(authUrl.searchParams.get("client_id")).toBe("client_1");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(authUrl.searchParams.get("scope")).toBe("openid email");
    expect(authUrl.searchParams.get("state")).toBe("state_1");
    expect(authUrl.searchParams.get("code_challenge")).toBe("A".repeat(43));
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("nonce")).toBe("nonce_1");
    expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com");

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/auth/oauth-server");
    expect(calls[0]?.init?.headers instanceof Headers || typeof calls[0]?.init?.headers === "object").toBe(true);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer token-123");
    expect(calls.some((call) => call.url.endsWith("/auth/oauth-server/migrate"))).toBe(true);
    const migrationCall = calls.find((call) => call.url.endsWith("/auth/oauth-server/migrate"));
    expect(JSON.parse(String(migrationCall?.init?.body))).toMatchObject({
      allow_dynamic_registration: true,
      authorization_path: "/authorize.html",
    });
    expect(calls.some((call) => call.url.endsWith("/auth/oauth-clients"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith(`/auth/oauth-clients/${oauthClientId}`))).toBe(true);
  });

  test("wait rejects malformed options without reading accessors or starting a task read", async () => {
    const client = createSupaCloudClient({
      supabase: createClient("https://project.example.test", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: "https://admin.example.test", projectRef: "proj_1",
    });
    const get = spyOn(client.tasks, "get").mockResolvedValue({
      id: "task-1", status: "completed", project_ref: "proj_1",
    });
    let getterReads = 0;
    const getter = () => { getterReads++; throw new Error("Getter must not run"); };
    const intervalGetter = Object.defineProperty({}, "intervalMs", { enumerable: true, get: getter });
    const signalGetter = Object.defineProperty({}, "signal", { enumerable: true, get: getter });
    const invalid: unknown[] = [
      null, 42, [], new Date(), Object.create({ intervalMs: 1 }),
      { signal: null }, { signal: {} }, { extra: true }, { [Symbol("extra")]: 1 },
      intervalGetter, signalGetter,
    ];
    for (const options of invalid) {
      await expect(Reflect.apply(client.tasks.wait, client.tasks, ["task-1", options]))
        .rejects.toThrow("Invalid task wait options");
    }
    expect(getterReads).toBe(0);
    expect(get).not.toHaveBeenCalled();
    const nullPrototype: unknown = Object.setPrototypeOf({ intervalMs: 1 }, null);
    expect(await Reflect.apply(client.tasks.wait, client.tasks, ["task-1", nullPrototype]))
      .toMatchObject({ status: "completed" });
    get.mockClear();
    for (const reason of [null, false, 0, "", { reason: "stop" }]) {
      const controller = new AbortController();
      controller.abort(reason);
      let rejected: unknown = Symbol("not rejected");
      try { await client.tasks.wait("task-1", { signal: controller.signal }); }
      catch (error) { rejected = error; }
      expect(rejected).toBe(reason);
    }
    expect(get).not.toHaveBeenCalled();
    get.mockResolvedValue({ id: "task-1", status: "running", project_ref: "proj_1" });
    for (const reason of [null, false, 0, "", { reason: "stop during delay" }]) {
      const controller = new AbortController();
      const removeListener = spyOn(controller.signal, "removeEventListener");
      const waiting = client.tasks.wait("task-1", { signal: controller.signal, intervalMs: 1000 });
      await Promise.resolve();
      controller.abort(reason);
      let rejected: unknown = Symbol("not rejected");
      try { await waiting; }
      catch (error) { rejected = error; }
      expect(rejected).toBe(reason);
      expect(removeListener).toHaveBeenCalledTimes(1);
    }
  });

  test("wait keeps captured options while the caller replaces its cancellation signal", async () => {
    const client = createSupaCloudClient({
      supabase: createClient("https://project.example.test", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: "https://admin.example.test", projectRef: "proj_1",
    });
    const original = new AbortController();
    const replacement = new AbortController();
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const get = spyOn(client.tasks, "get")
      .mockImplementationOnce(async () => {
        await pending;
        return { id: "task-1", status: "running", project_ref: "proj_1" };
      })
      .mockResolvedValueOnce({ id: "task-1", status: "completed", project_ref: "proj_1" });
    const options = { intervalMs: 1, signal: original.signal };
    const waiting = client.tasks.wait("task-1", options);
    expect(get).toHaveBeenCalledWith("task-1", original.signal);
    options.signal = replacement.signal;
    options.intervalMs = 2147483647;
    replacement.abort(new Error("Replacement signal must not cancel the original wait"));
    let getterReads = 0;
    Object.defineProperty(options, "signal", { get() { getterReads++; throw new Error("Late getter"); } });
    release();
    expect(await waiting).toMatchObject({ status: "completed" });
    expect(get.mock.calls).toEqual([["task-1", original.signal], ["task-1", original.signal]]);
    expect(getterReads).toBe(0);
  });

  test("wait polls until a terminal task status is reached and cleans each delay", async () => {
    const { supabase } = createFakeSupabase();
    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });
    const controller = new AbortController();
    const addListenerSpy = spyOn(controller.signal, "addEventListener");
    const removeListenerSpy = spyOn(controller.signal, "removeEventListener");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", project_ref: "proj_1" })
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", project_ref: "proj_1" })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed", project_ref: "proj_1" });

    const task = await client.tasks.wait("tsk_123", {
      signal: controller.signal,
    });

    expect(task.status).toBe("completed");
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(addListenerSpy).toHaveBeenCalledTimes(2);
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  test("wait preserves polling errors after cleaning the completed delay", async () => {
    const { supabase } = createFakeSupabase();
    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });
    const controller = new AbortController();
    const removeListenerSpy = spyOn(controller.signal, "removeEventListener");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    const pollingError = new Error("poll failed");
    let rejectedWith: unknown;

    spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", project_ref: "proj_1" })
      .mockImplementation(() => Promise.reject(pollingError));

    try {
      await client.tasks.wait("tsk_123", { signal: controller.signal });
    } catch (error) {
      rejectedWith = error;
    }
    expect(rejectedWith).toBe(pollingError);
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  test("wait preserves the abort reason and cleans the active delay", async () => {
    const { supabase } = createFakeSupabase();
    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1000,
    });
    const controller = new AbortController();
    const addListenerSpy = spyOn(controller.signal, "addEventListener");
    const removeListenerSpy = spyOn(controller.signal, "removeEventListener");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    const abortReason = new Error("stop waiting");
    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValue({ id: "tsk_123", status: "running", project_ref: "proj_1" });
    let rejectedWith: unknown;

    const waitPromise = client.tasks.wait("tsk_123", {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(abortReason);

    try {
      await waitPromise;
    } catch (error) {
      rejectedWith = error;
    }
    expect(rejectedWith).toBe(abortReason);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(addListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  test("task read and wait cancellation preserve reasons across authentication and transport phases", async () => {
    const cases = (["pre-aborted", "auth", "fetch", "body"] as const).flatMap(phase =>
      [new Error("caller cancelled waiting"), null, false, 0, "", { reason: "cancel" }].flatMap(reason =>
        (["get", "wait"] as const).map(operation => ({ phase, reason, operation }))));
    for (const { phase, reason, operation } of cases) {
      let ready: () => void = () => {};
      const started = new Promise<void>(resolve => { ready = resolve; });
      let token: ((value: string) => void) | undefined;
      let response: ((value: Response) => void) | undefined;
      let calls = 0, cancellations = 0, authCalls = 0;
      const body = () => new Response(new ReadableStream<Uint8Array>({
        cancel() { cancellations++; },
      }), { headers: { "content-type": "application/json" } });
      globalThis.fetch = Object.assign(async () => {
        calls++;
        ready();
        if (phase === "fetch") return new Promise<Response>(resolve => { response = resolve; });
        return body();
      }, { preconnect: originalFetch.preconnect });
      const client = createSupaCloudClient({
        supabase: createClient("http://local", "fixture-key", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
        managementApiUrl: "http://management", projectRef: "fixture",
        getAccessToken: () => {
          authCalls++;
          if (phase !== "auth") return "fixture-token";
          ready();
          return new Promise<string>(resolve => { token = resolve; });
        },
      });
      const controller = new AbortController();
      if (phase === "pre-aborted") controller.abort(reason);
      const removed = spyOn(controller.signal, "removeEventListener");
      const waiting = operation === "get"
        ? client.tasks.get("task-1", controller.signal)
        : client.tasks.wait("task-1", { signal: controller.signal });
      try {
        if (phase !== "pre-aborted") await started;
        controller.abort(reason);
        await expect(waiting).rejects.toBe(reason);
        token?.("late-token");
        response?.(body());
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(authCalls).toBe(phase === "pre-aborted" ? 0 : 1);
        expect(calls).toBe(phase === "auth" || phase === "pre-aborted" ? 0 : 1);
        expect(cancellations).toBe(phase === "auth" || phase === "pre-aborted" ? 0 : 1);
        if (phase === "pre-aborted") expect(removed).not.toHaveBeenCalled();
        else expect(removed).toHaveBeenCalled();
      } finally {
        controller.abort(reason);
        token?.("cleanup-token");
        response?.(body());
        removed.mockRestore();
      }
    }
  });

  test("unsubscribe aborts an active read and suppresses late read errors", async () => {
    let ready: () => void = () => {}, finish: () => void = () => {};
    const started = new Promise<void>(resolve => { ready = resolve; });
    const closed = new Promise<void>(resolve => { finish = resolve; });
    let rejectFetch: ((error: Error) => void) | undefined;
    let signal: AbortSignal | undefined;
    let calls = 0;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      signal = new Request(input, init).signal;
      ready();
      return new Promise<Response>((_, reject) => { rejectFetch = reject; });
    }, { preconnect: originalFetch.preconnect });
    const client = createSupaCloudClient({
      supabase: createClient("http://local", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: "http://management", projectRef: "fixture", getAccessToken: () => "fixture-token",
    });
    const errors: unknown[] = [], updates: unknown[] = [];
    const subscription = client.tasks.subscribe("task-1", {
      onUpdate: task => { updates.push(task); },
      onError: error => { errors.push(error); },
      onStateChange: state => { if (state === "closed") finish(); },
    });
    try {
      await started;
      subscription.unsubscribe();
      await closed;
      expect(signal?.aborted).toBe(true);
      rejectFetch?.(new Error("late read failure"));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(subscription.connectionState).toBe("closed");
      expect(errors).toEqual([]);
      expect(updates).toEqual([]);
      expect(calls).toBe(1);
    } finally {
      subscription.unsubscribe();
      rejectFetch?.(new Error("fixture cleanup"));
    }
  });

  test("rejects invalid task timing options before requests or channel creation", async () => {
    let requests = 0, authCalls = 0;
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const channel = spyOn(supabase, "channel");
    globalThis.fetch = Object.assign(async () => {
      requests++;
      return Response.json({ id: "task-1", project_ref: "fixture", status: "completed" });
    }, { preconnect: originalFetch.preconnect });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => { authCalls++; return "fixture-token"; },
    });
    const invalidValues = [-1, 0.5, NaN, Infinity, 2147483648, null, "1", {}];
    for (const interval of [0, ...invalidValues]) {
      const waiting: unknown = Reflect.apply(client.tasks.wait, client.tasks, ["task-1", { intervalMs: interval }]);
      await expect(waiting).rejects.toThrow("Invalid task timer interval");
      expect(() => Reflect.apply(client.tasks.subscribe, client.tasks, ["task-1", {
        pollingIntervalMs: interval, onUpdate() {},
      }])).toThrow("Invalid task timer interval");
    }
    for (const key of ["realtimeTimeoutMs", "reconcileIntervalMs"]) {
      for (const interval of invalidValues) {
        expect(() => Reflect.apply(client.tasks.subscribe, client.tasks, ["task-1", {
          realtime: { schema: "public", table: "task_updates" }, [key]: interval, onUpdate() {},
        }])).toThrow("Invalid task timer interval");
      }
    }
    expect(requests).toBe(0);
    expect(authCalls).toBe(0);
    expect(channel).not.toHaveBeenCalled();
    for (const intervalMs of [1, 2147483647]) {
      expect(await client.tasks.wait("task-1", { intervalMs })).toMatchObject({ status: "completed" });
    }
    const invalidDefault = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
      pollingIntervalMs: Infinity, getAccessToken: () => "fixture-token",
    });
    await expect(invalidDefault.tasks.wait("task-1")).rejects.toThrow("Invalid task timer interval");
    expect(() => invalidDefault.tasks.subscribe("task-1", { onUpdate() {} }))
      .toThrow("Invalid task timer interval");
    expect(requests).toBe(2);
  });

  test("captures subscription callbacks and rejects malformed options before effects", async () => {
    let calls = 0, reads = 0;
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const channel = spyOn(supabase, "channel");
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => "fixture-token",
    });
    globalThis.fetch = Object.assign(async () => {
      calls++;
      return Response.json({ id: "task-1", project_ref: "fixture", status: "completed" });
    }, { preconnect: originalFetch.preconnect });
    const callback = () => {};
    const accessor = Object.defineProperty({}, "onUpdate", {
      enumerable: true, get() { reads++; return callback; },
    });
    for (const invalid of [
      null, [], {}, { onUpdate: "callback" }, accessor,
      { onUpdate: callback, onError: false }, { onUpdate: callback, onStateChange: {} },
      { onUpdate: callback, stopOnTerminal: "false" }, { onUpdate: callback, stopOnTerminal: null },
      { onUpdate: callback, unknown: true }, Object.create({ onUpdate: callback }),
    ]) {
      expect(() => Reflect.apply(client.tasks.subscribe, client.tasks, ["task-1", invalid]))
        .toThrow("Invalid task subscription options");
    }
    expect(reads).toBe(0);
    expect(calls).toBe(0);
    expect(channel).not.toHaveBeenCalled();
    const updates: string[] = [], states: string[] = [];
    let replaced = 0;
    let finish: () => void = () => {};
    const done = new Promise<void>(resolve => { finish = resolve; });
    const options = {
      stopOnTerminal: true,
      onUpdate: (task: { status: string }) => { updates.push(task.status); },
      onStateChange: (state: string) => { states.push(state); if (state === "closed") finish(); },
    };
    const subscription = client.tasks.subscribe("task-1", options);
    options.onUpdate = () => { replaced++; };
    options.onStateChange = () => { replaced++; };
    options.stopOnTerminal = false;
    try {
      await done;
      expect(updates).toEqual(["completed"]);
      expect(states).toEqual(["polling", "closed"]);
      expect(replaced).toBe(0);
      expect(calls).toBe(1);
      expect(subscription.connectionState).toBe("closed");
    } finally { subscription.unsubscribe(); }
  });

  test("closes subscriptions on synchronous and asynchronous callback failures without recursion", async () => {
    for (const mode of ["update-sync", "update-async", "state-sync", "state-async", "error-sync", "error-async"]) {
      const fault = new Error("synthetic callback failure");
      const reported: unknown[] = [];
      let calls = 0, finished: () => void = () => {};
      const closed = new Promise<void>(resolve => { finished = resolve; });
      globalThis.fetch = Object.assign(async () => {
        calls++;
        return Response.json({ id: "task-1", project_ref: mode.startsWith("error") ? "foreign" : "fixture", status: "running" });
      }, { preconnect: originalFetch.preconnect });
      const client = createSupaCloudClient({
        supabase: createClient("http://local", "fixture-key", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
        managementApiUrl: "http://management", projectRef: "fixture", getAccessToken: () => "fixture-token",
      });
      const fail = () => {
        if (mode.endsWith("async")) return Promise.reject(fault);
        throw fault;
      };
      const subscription = client.tasks.subscribe("task-1", {
        stopOnTerminal: false,
        onUpdate() { if (mode.startsWith("update")) return fail(); },
        onStateChange(state) {
          if (state === "closed") finished();
          else if (mode.startsWith("state")) return fail();
        },
        onError(error) {
          reported.push(error);
          if (mode.startsWith("error")) return fail();
        },
      });
      try {
        await closed;
        expect(subscription.connectionState).toBe("closed");
        expect(reported).toHaveLength(1);
        if (!mode.startsWith("error")) expect(reported[0]).toBe(fault);
        else expect(reported[0]).toMatchObject({ code: "TASK_READ_INVALID" });
        expect(calls).toBeLessThanOrEqual(1);
      } finally { subscription.unsubscribe(); }
    }
  });

  test("handles callback failure during synchronous channel subscription and failed channel removal", async () => {
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const channel = supabase.channel("callback-fixture");
    spyOn(supabase, "channel").mockReturnValue(channel);
    const removalError = new Error("synthetic remove failure");
    const remove = spyOn(supabase, "removeChannel").mockRejectedValue(removalError);
    spyOn(channel, "subscribe").mockImplementation((callback) => {
      callback?.("SUBSCRIBED");
      return channel;
    });
    let requests = 0, finished: () => void = () => {};
    const closed = new Promise<void>(resolve => { finished = resolve; });
    const errors: unknown[] = [];
    const callbackError = new Error("synthetic state failure");
    globalThis.fetch = Object.assign(async () => {
      requests++;
      return Response.json({});
    }, { preconnect: originalFetch.preconnect });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => "fixture-token",
    });
    const subscription = client.tasks.subscribe("task-1", {
      realtime: { schema: "public", table: "task_updates" },
      onUpdate() {},
      onStateChange(state) {
        if (state === "realtime") throw callbackError;
        if (state === "closed") finished();
      },
      onError(error) { errors.push(error); },
    });
    try {
      await closed;
      expect(subscription.connectionState).toBe("closed");
      expect(errors).toEqual([callbackError, removalError]);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(requests).toBe(0);
    } finally { subscription.unsubscribe(); }
  });

  test("subscribes through management polling by default without an invented Realtime table", async () => {
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const channel = spyOn(supabase, "channel");
    const remove = spyOn(supabase, "removeChannel");
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls++;
      return Response.json({ id: "task-1", project_ref: "fixture", status: calls === 1 ? "running" : "completed" });
    }, { preconnect: originalFetch.preconnect });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => "fixture-token",
    });
    const updates: string[] = [], states: string[] = [], errors: unknown[] = [];
    let finish: () => void = () => {};
    const done = new Promise<void>(resolve => { finish = resolve; });
    const subscription = client.tasks.subscribe("task-1", {
      pollingIntervalMs: 1,
      onUpdate: task => { updates.push(task.status); },
      onStateChange: state => { states.push(state); if (state === "closed") finish(); },
      onError: error => { errors.push(error); finish(); },
    });
    try {
      expect(subscription.connectionState).toBe("polling");
      await done;
      expect(errors).toEqual([]);
      expect(updates).toEqual(["running", "completed"]);
      expect(states).toEqual(["polling", "closed"]);
      expect(subscription.connectionState).toBe("closed");
      expect(calls).toBe(2);
      expect(channel).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally { subscription.unsubscribe(); }
  });

  test("rejects foreign or malformed realtime task events without ending the subscription", async () => {
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const supabase = createClient("http://local", "fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const channel = supabase.channel("test-task");
    const channelSpy = spyOn(supabase, "channel").mockReturnValue(channel);
    let deliver: (value: unknown) => void = () => { throw new Error("Missing realtime callback"); };
    const onSpy = spyOn(channel, "on").mockImplementation((...args: unknown[]) => {
      const callback = args[2];
      if (typeof callback !== "function") throw new Error("Missing realtime callback");
      deliver = value => { callback(value); };
      return channel;
    });
    spyOn(channel, "subscribe").mockReturnValue(channel);
    const remove = spyOn(supabase, "removeChannel").mockResolvedValue("ok");
    const updates: unknown[] = [], errors: unknown[] = [];
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "http://management", projectRef: "fixture",
      getAccessToken: () => "fixture-token",
    });
    const options = {
      realtime: { schema: "public", table: "task_updates" },
      realtimeTimeoutMs: 0, reconcileIntervalMs: 0,
      onUpdate: (value: unknown) => { updates.push(value); },
      onError: (value: unknown) => { errors.push(value); },
    };
    expect(() => client.tasks.subscribe("", options)).toThrow("Invalid task ID");
    for (const realtime of [
      null, {}, { schema: "public" }, { schema: "public", table: "tasks;drop" },
      { schema: "public", table: "tasks", extra: true },
    ]) {
      expect(() => Reflect.apply(client.tasks.subscribe, client.tasks, [taskId, { ...options, realtime }]))
        .toThrow("Invalid task Realtime source");
    }
    expect(channelSpy).not.toHaveBeenCalled();
    const subscription = client.tasks.subscribe(taskId.toUpperCase(), options);
    try {
      expect(onSpy.mock.calls[0]?.[1]).toMatchObject({
        schema: "public", table: "task_updates", filter: `id=eq.${taskId}`,
      });
      const valid = {
        id: taskId, status: "running", progress: 10, project_ref: "fixture",
        metadata: { label: "original" },
      };
      for (const next of [
        { ...valid, id: "another-task", status: "completed" },
        { ...valid, id: 1 }, { ...valid, status: {} }, { ...valid, progress: "10" },
        { ...valid, latest_logs: [{}] }, { ...valid, updatedAt: 1 },
        { id: taskId, status: "completed" },
        ...["other-project", "FIXTURE", "", null, 42, {}, ["fixture"]].map(project_ref => ({
          ...valid, project_ref, status: "completed",
        })),
      ]) {
        deliver({ new: next, old: {} });
      }
      let reads = 0;
      const accessor = Object.defineProperty({ ...valid }, "status", {
        enumerable: true, get() { reads++; return "completed"; },
      });
      deliver({ new: accessor, old: {} });
      expect(reads).toBe(0);
      expect(updates).toHaveLength(0);
      expect(errors).toHaveLength(15);
      for (const error of errors) expect(error).toMatchObject({ code: "TASK_READ_INVALID", mutationMayHaveApplied: false });
      expect(remove).not.toHaveBeenCalled();
      deliver({ new: valid, old: {} });
      valid.metadata.label = "changed";
      expect(updates).toMatchObject([{ id: taskId, status: "running", progress: 10, raw: { metadata: { label: "original" } } }]);
      subscription.unsubscribe();
      deliver({ new: { id: taskId, status: "completed" }, old: {} });
      expect(updates).toHaveLength(1);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      subscription.unsubscribe();
    }
  });

  test("subscribe falls back to polling on channel error", async () => {
    const { supabase, channelInstance, removeChannel } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: string[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10, project_ref: "proj_1" })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed", progress: 100, project_ref: "proj_1" });

    let subscribeHandler:
      | ((status: string, error?: unknown) => void | Promise<void>)
      | undefined;

    channelInstance.subscribe.mockImplementation((...args: unknown[]) => {
      const [handler] = args as [((status: string, error?: unknown) => void | Promise<void>)?];
      subscribeHandler = handler;
      return channelInstance;
    });

    const subscription = client.tasks.subscribe("tsk_123", {
      realtime: { schema: "public", table: "task_updates" },
      onUpdate(snapshot) {
        snapshots.push(String(snapshot.status));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await subscribeHandler?.("CHANNEL_ERROR", new Error("realtime down"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("polling");
    expect(snapshots).toContain("completed");
    expect(removeChannel).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    expect(getSpy).toHaveBeenCalled();
  });

  test("subscribe falls back to polling when realtime does not connect in time", async () => {
    const { supabase, channelInstance, removeChannel } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: string[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10, project_ref: "proj_1" })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed", progress: 100, project_ref: "proj_1" });

    channelInstance.subscribe.mockImplementation(() => channelInstance);

    const subscription = client.tasks.subscribe("tsk_123", {
      realtime: { schema: "public", table: "task_updates" },
      realtimeTimeoutMs: 1,
      onUpdate(snapshot) {
        snapshots.push(String(snapshot.status));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("polling");
    expect(snapshots).toContain("completed");
    expect(removeChannel).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    expect(getSpy).toHaveBeenCalled();
  });

  test("subscribe reconciles while realtime is connected", async () => {
    const { supabase, channelInstance } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: number[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10, project_ref: "proj_1" })
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 20, project_ref: "proj_1" });

    let subscribeHandler:
      | ((status: string, error?: unknown) => void | Promise<void>)
      | undefined;

    channelInstance.subscribe.mockImplementation((...args: unknown[]) => {
      const [handler] = args as [((status: string, error?: unknown) => void | Promise<void>)?];
      subscribeHandler = handler;
      return channelInstance;
    });

    const subscription = client.tasks.subscribe("tsk_123", {
      realtime: { schema: "public", table: "task_updates" },
      reconcileIntervalMs: 1,
      stopOnTerminal: false,
      onUpdate(snapshot) {
        snapshots.push(Number(snapshot.progress));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await subscribeHandler?.("SUBSCRIBED");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("realtime");
    expect(snapshots).toContain(10);
    expect(snapshots).toContain(20);
    expect(getSpy.mock.calls.length >= 2).toBe(true);

    subscription.unsubscribe();
  });
});
