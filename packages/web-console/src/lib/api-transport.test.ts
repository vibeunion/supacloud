import { afterEach, expect, test } from "bun:test";
import { apiClient, getStudioSession, logoutStudio } from "./api";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
function respond(handler: (input: RequestInfo | URL, options?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(handler, originalFetch);
}
function browser() {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "https://console.example.com/projects", pathname: "/projects" },
  } });
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Request did not settle promptly")), 250);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
afterEach(async () => {
  try {
    respond(async () => Response.json({ success: true }));
    await logoutStudio();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("invalid timeout values and foreign or ambiguous URLs fail before transport", async () => {
  browser();
  let calls = 0;
  respond(async () => { calls++; return Response.json({}); });
  for (const timeoutMs of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
    await expect(apiClient("/v1/projects", { timeoutMs })).rejects.toThrow();
  }
  for (const url of ["//outside.invalid/v1", "/\\outside.invalid/v1", "https://outside.invalid/v1",
    "https://user:password@console.example.com/v1", "\n/v1/projects", "/v1/\r\nprojects", "v1/projects"]) {
    await expect(apiClient(url)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("managed fetch settles on timeout even when the transport ignores its signal", async () => {
  const pending = Promise.withResolvers<Response>();
  const disposed = Promise.withResolvers<void>();
  respond(() => pending.promise);
  const read = apiClient("/v1/projects", { timeoutMs: 5 });
  try {
    expect((await promptly(read)).status).toBe(504);
  } finally {
    pending.resolve(new Response(new ReadableStream({ cancel() { disposed.resolve(); } })));
    await read;
  }
  await promptly(disposed.promise);
});

test("cancellation during a shared refresh settles without a late managed write", async () => {
  browser();
  const refresh = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const calls: string[] = [];
  respond(async input => {
    const url = String(input);
    calls.push(url);
    if (url === "/auth/session") return Response.json({
      valid: true, username: "admin", expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
    if (url === "/auth/refresh") { started.resolve(); return refresh.promise; }
    return Response.json({});
  });
  await getStudioSession();
  const controller = new AbortController();
  const request = apiClient("/v1/projects/a", { method: "DELETE", signal: controller.signal });
  const outcome = request.then(() => null, (error: unknown) => error);
  await started.promise;
  controller.abort();
  try {
    expect(await promptly(outcome)).toMatchObject({ name: "AbortError" });
  } finally {
    refresh.resolve(Response.json({
      success: true, username: "admin", expires_at: new Date(Date.now() + 900_000).toISOString(),
    }));
    await outcome;
  }
  expect(calls).toEqual(["/auth/session", "/auth/refresh"]);
});

test("the configured deadline covers JSON error body reading", async () => {
  let finish = () => {};
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      finish = () => { if (!cancelled) controller.close(); };
    },
    cancel() { cancelled = true; },
  });
  respond(async () => new Response(body, { status: 500, headers: { "content-type": "application/json" } }));
  const read = apiClient("/v1/projects", { timeoutMs: 5 });
  try {
    expect((await promptly(read)).status).toBe(504);
    expect(cancelled).toBe(true);
  } finally {
    finish();
    await read;
  }
});

test("non-JSON failures discard their body and retain retry metadata", async () => {
  let cancelled = false;
  respond(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("private-secret-marker")); controller.close(); },
    cancel() { cancelled = true; },
  }), { status: 503, headers: { "content-type": "text/plain", "retry-after": "30", "x-request-id": "request-1" } }));
  const response = await apiClient("/v1/projects");
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("30");
  expect(response.headers.get("x-request-id")).toBe("request-1");
  expect(await response.json()).toEqual({ message: "Service Unavailable", code: "503" });
  expect(cancelled).toBe(true);
});

test("invalid JSON error bodies cannot bypass the response limit or UTF-8 validation", async () => {
  for (const body of [new Uint8Array(64 * 1024 + 1), new Uint8Array([0xff]), "{", "null", "[]"]) {
    respond(async () => new Response(body, { status: 500, headers: { "content-type": "application/json" } }));
    await expect(apiClient("/v1/projects")).rejects.toThrow("Invalid API error response");
  }
});

test("managed requests always reject redirects even when the caller requests following", async () => {
  respond(async (_url, options) => {
    expect(options?.redirect).toBe("error");
    return Response.json({});
  });
  await apiClient("/v1/projects", { redirect: "follow" });
});

test("structured errors retain endpoint-specific fields but discard stale body headers", async () => {
  const payload = { code: "promotion_plan_changed", owner: { project_ref: "owner" }, details: [1, 2] };
  respond(async () => Response.json(payload, { status: 409, headers: {
    "retry-after": "10", "content-length": "1024", "content-encoding": "gzip", etag: "old",
  } }));
  const response = await apiClient("/v1/projects");
  expect(await response.json()).toEqual(payload);
  expect(response.headers.get("retry-after")).toBe("10");
  expect(response.headers.has("content-length")).toBe(false);
  expect(response.headers.has("content-encoding")).toBe(false);
  expect(response.headers.has("etag")).toBe(false);
});

test("the deadline covers the 401 session probe and prevents a late redirect", async () => {
  browser();
  const session = Promise.withResolvers<Response>();
  const disposed = Promise.withResolvers<void>();
  respond(async input => String(input) === "/auth/session"
    ? session.promise : Response.json({ message: "Unauthorized" }, { status: 401 }));
  const response = await promptly(apiClient("/v1/projects", { timeoutMs: 5 }));
  expect(response.status).toBe(504);
  session.resolve(new Response(new ReadableStream({ cancel() { disposed.resolve(); } })));
  await promptly(disposed.promise);
  expect(window.location.href).toBe("https://console.example.com/projects");
});

test("caller cancellation remains connected to the successful response body", async () => {
  const controller = new AbortController();
  respond(async (_input, options) => new Response(new ReadableStream({
    start(stream) {
      options?.signal?.addEventListener("abort", () => stream.error(options.signal?.reason), { once: true });
    },
  })));
  const response = await apiClient("/v1/projects", { signal: controller.signal });
  controller.abort();
  await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
});

test("caller cancellation wins over the later timeout", async () => {
  const pending = Promise.withResolvers<Response>();
  respond(() => pending.promise);
  const controller = new AbortController();
  const request = apiClient("/v1/projects", { signal: controller.signal, timeoutMs: 10 });
  const outcome = request.then(() => null, (error: unknown) => error);
  controller.abort();
  expect(await promptly(outcome)).toMatchObject({ name: "AbortError" });
  pending.resolve(Response.json({}));
});

test("unexpected redirect responses are disposed rather than accepted", async () => {
  let cancelled = false;
  respond(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 307 }));
  await expect(apiClient("/v1/projects")).rejects.toThrow("Invalid API response");
  expect(cancelled).toBe(true);
});

test("one cancelled refresh waiter cannot cancel another caller's request", async () => {
  browser();
  const refresh = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const calls: string[] = [];
  respond(async input => {
    const url = String(input);
    calls.push(url);
    if (url === "/auth/session") return Response.json({
      valid: true, username: "admin", expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
    if (url === "/auth/refresh") { started.resolve(); return refresh.promise; }
    return Response.json({});
  });
  await getStudioSession();
  const controller = new AbortController();
  const cancelled = apiClient("/v1/projects/cancelled", { method: "DELETE", signal: controller.signal })
    .then(() => null, (error: unknown) => error);
  const retained = apiClient("/v1/projects/retained");
  await started.promise;
  controller.abort();
  expect(await promptly(cancelled)).toMatchObject({ name: "AbortError" });
  refresh.resolve(Response.json({
    success: true, username: "admin", expires_at: new Date(Date.now() + 900_000).toISOString(),
  }));
  expect((await retained).status).toBe(200);
  expect(calls).toEqual(["/auth/session", "/auth/refresh", "/v1/projects/retained"]);
});

test("native managed HTTP requests never forward a mutation through a 307 redirect", async () => {
  let forwarded = 0;
  let attempted = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/capture") {
        forwarded++;
        return Response.json({});
      }
      attempted++;
      return new Response(null, { status: 307, headers: { location: "/capture" } });
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: server.url.href, pathname: "/" },
  } });
  globalThis.fetch = originalFetch;
  try {
    await expect(apiClient(new URL("/v1/mutation", server.url).href, {
      method: "POST", body: JSON.stringify({ secret: "synthetic-test-value" }),
    })).rejects.toThrow();
    expect(attempted).toBe(1);
    expect(forwarded).toBe(0);
  } finally {
    await server.stop(true);
  }
});
