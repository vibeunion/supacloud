import { expect, mock, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, createSupaCloudWorkflowFetch, createSupaCloudCommandFetch, createSupaCloudArtifactFetch } from "./index";

const url = "http://local/rest/v1/rpc/supacloud_workflow_get";
const headers = { "content-type": "application/json" };
const maxBytes = 1024 * 1024;
const runId = "11111111-1111-4111-8111-111111111111";

test("artifact, command and workflow guards compose without touching other RPCs or Storage", async () => {
  const transport = mock(async () => new Response("x".repeat(maxBytes + 1), { headers }));
  const guarded = createSupaCloudArtifactFetch({
    fetch: createSupaCloudCommandFetch({ fetch: createSupaCloudWorkflowFetch({ fetch: transport }) }),
  });
  await expect(guarded(url)).rejects.toThrow("Workflow HTTP response could not be validated");
  for (const name of ["get", "submit"]) {
    await expect(guarded(`http://local/rest/v1/rpc/supacloud_command_${name}`))
      .rejects.toThrow("Command HTTP response could not be validated");
  }
  for (const name of ["get", "register", "link"]) {
    await expect(guarded(`http://local/rest/v1/rpc/supacloud_artifact_${name}`))
      .rejects.toThrow("Artifact HTTP response could not be validated");
  }
  const unchanged = await guarded("http://local/rest/v1/rpc/application_owned");
  expect((await unchanged.text()).length).toBe(maxBytes + 1);
  const storage = await guarded("http://local/storage/v1/object/reports/large.pdf");
  expect((await storage.text()).length).toBe(maxBytes + 1);
  expect(transport).toHaveBeenCalledTimes(8);
});

test("official artifact SDK preserves read and mutation semantics for rejected response bodies", async () => {
  for (const mode of ["size", "utf8", "redirect"]) {
    let cancelled = 0;
    const transport = mock(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode !== "redirect") controller.enqueue(mode === "size"
          ? new Uint8Array(maxBytes + 1) : new Uint8Array([0xff]));
      },
      cancel() { cancelled++; },
    }), { headers, status: mode === "redirect" ? 307 : 200 }));
    const supabase = createClient("http://local", "synthetic-key", {
      global: { fetch: createSupaCloudArtifactFetch({ fetch: transport }) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const artifacts = createSupaCloudClient({
      supabase, managementApiUrl: "http://management-not-used", projectRef: "fixture",
    }).artifacts;
    await expect(artifacts.get(runId)).rejects.toMatchObject({
      code: "ARTIFACT_READ_INVALID", mutationMayHaveApplied: false,
    });
    await expect(artifacts.register({
      artifactId: runId, bucketId: "reports", objectPath: "report.pdf", artifactType: "report",
      sha256: "a".repeat(64), sizeBytes: "1", mimeType: "application/pdf",
    })).rejects.toMatchObject({ code: "ARTIFACT_REGISTER_UNCONFIRMED", mutationMayHaveApplied: true });
    await expect(artifacts.link({
      parentArtifactId: "22222222-2222-4222-8222-222222222222", childArtifactId: runId, relationType: "derived_from",
    })).rejects.toMatchObject({ code: "ARTIFACT_LINK_UNCONFIRMED", mutationMayHaveApplied: true });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(cancelled).toBe(3);
  }
});

test("official command SDK retains uncertainty and read error semantics with the byte guard", async () => {
  for (const mode of ["size", "utf8", "redirect"]) {
    let cancelled = 0;
    const transport = mock(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode !== "redirect") controller.enqueue(mode === "size"
          ? new Uint8Array(maxBytes + 1) : new Uint8Array([0xff]));
      },
      cancel() { cancelled++; },
    }), { headers, status: mode === "redirect" ? 307 : 200 }));
    const supabase = createClient("http://local", "synthetic-key", {
      global: { fetch: createSupaCloudCommandFetch({ fetch: transport }) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const commands = createSupaCloudClient({
      supabase, managementApiUrl: "http://management-not-used", projectRef: "fixture",
    }).commands;
    await expect(commands.get(runId)).rejects.toMatchObject({
      code: "COMMAND_READ_INVALID", mutationMayHaveApplied: false,
    });
    await expect(commands.submit({
      commandId: runId, commandType: "report.issue", targetType: "report", targetId: "report-1",
    })).rejects.toMatchObject({ code: "COMMAND_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(cancelled).toBe(2);
  }
});

test("bounds actual UTF-8 bytes, preserves JSON error status, and passes unrelated requests through", async () => {
  const responses = [
    new Response(`"${"a".repeat(maxBytes - 2)}"`, { headers }),
    new Response(`"${"a".repeat(maxBytes - 1)}"`, { headers }),
    new Response(`"${"中".repeat(Math.ceil(maxBytes / 3))}"`, { headers }),
    Response.json({ code: "42501", message: "permission denied" }, { status: 403 }),
  ];
  const transport = mock(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch");
    return response;
  });
  const bounded = createSupaCloudWorkflowFetch({ fetch: transport });
  expect((await (await bounded(url)).text()).length).toBe(maxBytes);
  await expect(bounded(url)).rejects.toThrow("Workflow HTTP response could not be validated");
  await expect(bounded(url)).rejects.toThrow("Workflow HTTP response could not be validated");
  const denied = await bounded(url);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ code: "42501", message: "permission denied" });
  const untouched = new Response("streaming storage data");
  const other = mock(async () => untouched);
  const passthrough = createSupaCloudWorkflowFetch({ fetch: other });
  const input = new Request("http://local/storage/v1/object/example");
  const init = { method: "GET" };
  expect(await passthrough(input, init)).toBe(untouched);
  expect(other.mock.calls[0]).toEqual([input, init]);
});

test("cancels oversized, non-JSON, redirected and invalid UTF-8 bodies", async () => {
  for (const mode of ["length", "lying-length", "type", "redirect", "utf8", "truncated-utf8"]) {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "lying-length") controller.enqueue(new Uint8Array(maxBytes + 1));
        if (mode === "utf8") controller.enqueue(new Uint8Array([0xff]));
        if (mode === "truncated-utf8") { controller.enqueue(new Uint8Array([0xe4])); controller.close(); }
      },
      cancel() { cancelled++; },
    });
    const response = new Response(body, {
      status: mode === "redirect" ? 307 : 200,
      headers: {
        "content-type": mode === "type" ? "text/html" : "application/json",
        ...(mode === "length" ? { "content-length": String(maxBytes + 1) }
          : mode === "lying-length" ? { "content-length": "1" } : {}),
      },
    });
    const bounded = createSupaCloudWorkflowFetch({ fetch: async () => response });
    await expect(bounded(url)).rejects.toThrow("Workflow HTTP response could not be validated");
    if (mode !== "truncated-utf8") expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  }
});

test("handles split UTF-8 without changing request credentials or payload", async () => {
  const encoded = new TextEncoder().encode('{"text":"中文"}');
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  }), { headers: { ...headers, "content-encoding": "gzip", "content-length": "1" } });
  const transport = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe("Bearer synthetic");
    expect(await request.json()).toEqual({ request: { runId } });
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    return response;
  });
  const bounded = createSupaCloudWorkflowFetch({ fetch: transport });
  const result = await bounded(url, {
    method: "POST", headers: { authorization: "Bearer synthetic" },
    body: JSON.stringify({ request: { runId } }),
  });
  expect(await result.json()).toEqual({ text: "中文" });
  expect(result.headers.has("content-encoding")).toBe(false);
  expect(result.headers.has("content-length")).toBe(false);
  expect(transport).toHaveBeenCalledTimes(1);
});

test("official SDK reports oversized reads and mutations with their own uncertainty semantics", async () => {
  const transport = mock(async () => new Response("x".repeat(maxBytes + 1), { headers }));
  const supabase = createClient("http://local", "synthetic-key", {
    global: { fetch: createSupaCloudWorkflowFetch({ fetch: transport }) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const workflows = createSupaCloudClient({
    supabase, managementApiUrl: "http://management-not-used", projectRef: "fixture",
  }).workflows;
  await expect(workflows.get(runId)).rejects.toMatchObject({
    code: "WORKFLOW_READ_INVALID", mutationMayHaveApplied: false,
  });
  await expect(workflows.start({
    runId, workflowName: "bounded", workflowVersion: "1", firstStepKey: "first",
  })).rejects.toMatchObject({ code: "WORKFLOW_START_UNCONFIRMED", mutationMayHaveApplied: true });
  expect(transport).toHaveBeenCalledTimes(2);
});

test("bounds ignored cancellation and cancels bodies arriving after the deadline", async () => {
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      original(callback, delay === 15000 ? 20 : delay, ...args),
    { __promisify__: original.__promisify__ },
  ));
  try {
    for (const factory of [createSupaCloudWorkflowFetch, createSupaCloudCommandFetch, createSupaCloudArtifactFetch]) {
      for (const mode of ["fetch", "body"]) {
        let cancelled = 0;
        let deliver: ((response: Response) => void) | undefined;
        let signal: AbortSignal | undefined;
        const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
        const bounded = factory({
          fetch: async (input, init) => {
            signal = new Request(input, init).signal;
            if (mode === "body") return new Response(body, { headers });
            return new Promise<Response>(resolve => { deliver = resolve; });
          },
        });
        const endpoint = factory === createSupaCloudCommandFetch
          ? "http://local/rest/v1/rpc/supacloud_command_get"
          : factory === createSupaCloudArtifactFetch ? "http://local/rest/v1/rpc/supacloud_artifact_get" : url;
        await expect(bounded(endpoint)).rejects.toThrow("HTTP response could not be validated");
        expect(signal?.aborted).toBe(true);
        deliver?.(new Response(body, { headers }));
        await new Promise(resolve => original(resolve, 0));
        expect(cancelled).toBe(1);
        expect(body.locked).toBe(false);
      }
    }
  } finally { timer.mockRestore(); }
});

test("caller cancellation prevents dispatch or interrupts an active body read", async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = mock(async () => Response.json(null));
  const bounded = createSupaCloudWorkflowFetch({ fetch: transport });
  await expect(bounded(url, { signal: controller.signal })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  const active = new AbortController();
  let cancelled = 0;
  const streaming = createSupaCloudWorkflowFetch({ fetch: async () => {
    queueMicrotask(() => active.abort());
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers });
  } });
  await expect(streaming(url, { signal: active.signal })).rejects.toThrow();
  expect(cancelled).toBe(1);
});
