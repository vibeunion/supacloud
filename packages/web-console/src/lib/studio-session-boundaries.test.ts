import { afterEach, expect, test } from "bun:test";
import { apiClient, getStudioSession, loginStudio, logoutStudio, refreshStudioSession } from "./api";

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const identity = () => ({ username: "admin", expires_at: new Date(Date.now() + 900_000).toISOString() });
function respond(handler: (input: RequestInfo | URL, options?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(handler, originalFetch);
}
afterEach(async () => {
  try {
    respond(async () => Response.json({ success: true }));
    await logoutStudio();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindowDescriptor) Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("session inspection rejects missing identity, expired timestamps and contradictory flags", async () => {
  for (const patch of [
    { username: undefined }, { username: "" }, { username: 1 }, { expires_at: undefined },
    { expires_at: "not-a-date" }, { expires_at: "2026-02-30T12:00:00.000Z" },
    { expires_at: new Date(Date.now() - 1_000).toISOString() },
    { valid: "true" }, { authenticated: false }, { success: false },
  ]) {
    respond(async () => Response.json({ valid: true, ...identity(), ...patch }));
    await expect(getStudioSession()).rejects.toThrow();
  }
});

test("login cannot accept a success flag without a complete identity receipt", async () => {
  respond(async () => Response.json({ success: true }));
  await expect(loginStudio("admin", "password")).rejects.toThrow();
});

test("logout validates successful HTTP receipts instead of silently accepting failure", async () => {
  for (const value of [null, {}, [], { success: false }, { success: "true" }]) {
    let calls = 0;
    respond(async () => { calls++; return Response.json(value); });
    await expect(logoutStudio()).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test("a session read started before logout cannot authenticate after logout", async () => {
  const pending = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  respond(async input => {
    if (String(input) === "/auth/session") {
      started.resolve();
      return pending.promise;
    }
    return Response.json({ success: true });
  });
  const read = getStudioSession();
  await started.promise;
  await expect(logoutStudio()).resolves.toEqual({ success: true });
  pending.resolve(Response.json({ valid: true, ...identity() }));
  await expect(read).rejects.toThrow();
});

test("Studio authentication requests reject redirects and bypass response caches", async () => {
  respond(async (_input, options) => {
    expect(options?.redirect).toBe("error");
    expect(options?.cache).toBe("no-store");
    expect(options?.credentials).toBe("include");
    return Response.json({ valid: true, ...identity() });
  });
  expect((await getStudioSession()).authenticated).toBe(true);
});

test("oversized declared session responses cannot become authenticated state", async () => {
  respond(async () => Response.json({ valid: true, ...identity() }, {
    headers: { "content-length": String(64 * 1024 + 1) },
  }));
  await expect(getStudioSession()).rejects.toThrow();
});

test("valid authentication receipts retain their identity but never return tokens or unknown fields", async () => {
  const fields = identity();
  respond(async () => Response.json({ success: true, ...fields, token: "must-not-expose", extra: {} }));
  expect(await loginStudio("admin", "password")).toEqual({ success: true, username: "admin" });
  expect(await refreshStudioSession()).toEqual({ authenticated: true, username: "admin", expiresAt: fields.expires_at });
});

test("negative authentication receipts require the correct status and discriminator", async () => {
  for (const [status, message] of [
    [401, "Invalid username or password"],
    [403, "Cross-origin login request denied"],
    [429, "Too many failed login attempts"],
  ] satisfies Array<[number, string]>) {
    respond(async () => Response.json({ success: false, message: "private server details" }, { status }));
    expect(await loginStudio("admin", "password")).toEqual({ success: false, error: message });
  }
  respond(async () => Response.json({ valid: false }, { status: 401 }));
  expect(await getStudioSession()).toEqual({ authenticated: false });
  respond(async () => Response.json({ success: false }, { status: 401 }));
  expect(await refreshStudioSession()).toEqual({ authenticated: false });
  respond(async () => Response.json({ success: false }, { status: 403 }));
  expect(await logoutStudio()).toEqual({ success: false, error: "Cross-origin session request denied" });
  for (const [status, value] of [
    [200, { valid: false }], [401, { valid: true, ...identity() }],
    [201, { valid: true, ...identity() }], [403, { valid: false }], [401, {}],
  ] satisfies Array<[number, unknown]>) {
    respond(async () => Response.json(value, { status }));
    await expect(getStudioSession()).rejects.toThrow("Invalid Studio session response");
  }
});

test("invalid credentials and pre-aborted requests never start authentication transport", async () => {
  let calls = 0;
  respond(async () => { calls++; return Response.json({ success: true }); });
  for (const [username, password] of [["", "password"], [" ", "password"], ["x".repeat(321), "password"], ["admin", ""], ["admin", "x".repeat(4097)]]) {
    if (username === undefined || password === undefined) throw new Error("Invalid fixture");
    await expect(loginStudio(username, password)).rejects.toThrow("Invalid Studio login input");
  }
  const controller = new AbortController();
  controller.abort();
  await expect(getStudioSession({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(0);
});

test("malformed and oversized actual bodies fail without exposing the response or retrying", async () => {
  for (const body of [
    new Uint8Array([0xff]), new Uint8Array(64 * 1024 + 1), '{"private": "secret-marker",',
  ]) {
    let calls = 0;
    respond(async () => { calls++; return new Response(body); });
    await expect(getStudioSession()).rejects.toThrow("Invalid Studio session response");
    expect(calls).toBe(1);
  }
});

test("cancelled session reads settle and dispose responses from transports that ignore cancellation", async () => {
  const response = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  respond(async () => { started.resolve(); return response.promise; });
  const read = getStudioSession({ signal: controller.signal });
  await started.promise;
  controller.abort();
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
  let cancelled = false;
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancelled).toBe(true);
});

test("a refresh started before logout cannot revive the previous session", async () => {
  const response = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  respond(async input => {
    if (String(input) === "/auth/refresh") { started.resolve(); return response.promise; }
    return Response.json({ success: true });
  });
  const refresh = refreshStudioSession();
  await started.promise;
  expect(await logoutStudio()).toEqual({ success: true });
  response.resolve(Response.json({ success: true, ...identity() }));
  await expect(refresh).rejects.toThrow("Studio session changed");
});

test("an uncertain refresh is not automatically replayed by the next managed API call", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/projects", href: "https://console.example.com/projects" } },
  });
  const calls: string[] = [];
  respond(async input => {
    const url = String(input);
    calls.push(url);
    if (url === "/auth/session") return Response.json({
      valid: true, username: "admin", expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
    if (url === "/auth/refresh") return new Response('{"success":');
    return Response.json({ ok: true });
  });
  await getStudioSession();
  await expect(apiClient("/v1/projects")).rejects.toThrow("Invalid Studio session response");
  expect((await apiClient("/v1/projects")).ok).toBe(true);
  expect(calls).toEqual(["/auth/session", "/auth/refresh", "/v1/projects"]);
});

test("the session deadline covers body reads and releases the reader", async () => {
  let cancelled = false;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  respond(async () => { calls++; return new Response(body); });
  await expect(getStudioSession()).rejects.toMatchObject({ name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
  expect(calls).toBe(1);
}, 20_000);

test("managed requests capture their method and headers before the session preflight", async () => {
  const options = { method: "GET", headers: new Headers({ "X-Identity": "original" }) };
  respond(async (_url, request) => {
    expect(request?.method).toBe("GET");
    expect(new Headers(request?.headers).get("X-Identity")).toBe("original");
    return Response.json({});
  });
  const request = apiClient("/v1/projects", options);
  options.method = "DELETE";
  options.headers.set("X-Identity", "changed");
  await request;
});

test("a logout starting during API preflight prevents the old managed mutation", async () => {
  const calls: string[] = [];
  respond(async input => {
    calls.push(String(input));
    return Response.json({ success: true });
  });
  const mutation = apiClient("/v1/projects/a", { method: "DELETE" });
  const outcome = mutation.then(() => null, (error: unknown) => error);
  await logoutStudio();
  expect(await outcome).toMatchObject({ message: "Studio session changed during the request" });
  expect(calls).toEqual(["/auth/logout"]);
});

test("an old unauthorized response cannot redirect after a newer successful login", async () => {
  const location = { pathname: "/projects", href: "https://console.example.com/projects" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
  const pending = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  respond(async input => {
    const url = String(input);
    if (url === "/auth/session") { started.resolve(); return pending.promise; }
    if (url === "/auth/login") return Response.json({ success: true, ...identity() });
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  });
  const request = apiClient("/v1/projects");
  const outcome = request.then(() => null, (error: unknown) => error);
  await started.promise;
  await loginStudio("admin", "password");
  pending.resolve(Response.json({ valid: false }, { status: 401 }));
  expect(await outcome).toMatchObject({ message: "Studio session changed during the request" });
  expect(location.href).toBe("https://console.example.com/projects");
});

test("native HTTP cannot forward a Studio password through a 307 redirect", async () => {
  let destinationCalls = 0;
  let loginCalls = 0;
  let loginBody: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/auth/login") {
        loginCalls++;
        loginBody = await request.json();
        return Response.redirect(new URL("/redirect-target", request.url), 307);
      }
      destinationCalls++;
      return Response.json({ success: true, ...identity() });
    },
  });
  try {
    respond((input, options) => originalFetch(new URL(String(input), server.url), options));
    await expect(loginStudio("admin", "synthetic-password")).rejects.toThrow();
    expect(loginCalls).toBe(1);
    expect(destinationCalls).toBe(0);
    expect(loginBody).toEqual({ username: "admin", password: "synthetic-password" });
  } finally {
    await server.stop(true);
  }
});
