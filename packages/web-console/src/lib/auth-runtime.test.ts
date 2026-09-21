import { expect, test } from "bun:test";
import { loadAuthRuntime, parseAuthRuntimeDescriptor, readAuthRuntimeResponse, type AuthRuntimeDescriptor } from "./auth-runtime";
import { localAuthRuntime, sharedAuthRuntime } from "./auth-runtime.test-fixtures";

test("runtime descriptors validate ownership relationships and copy only public fields", () => {
  const inputs: AuthRuntimeDescriptor[] = [localAuthRuntime(), sharedAuthRuntime(),
    { ...localAuthRuntime(), mode: "owner", owner_project_ref: "a" }];
  for (const input of inputs) {
    expect(parseAuthRuntimeDescriptor({ ...input, secret: "do-not-copy" }, "a")).toEqual(input);
  }
  expect(parseAuthRuntimeDescriptor({ ...sharedAuthRuntime(), realtime_auth_supported: true }, "a"))
    .toMatchObject({ realtime_auth_supported: true });
});

test("partial, contradictory and cross-project runtime descriptors cannot authorize a view", () => {
  const local = localAuthRuntime();
  for (const payload of [null, [], false, {}, { data: local }, { mode: "local" },
    { ...local, project_ref: "b" }, { ...local, mode: "other" }, { ...local, owner_project_ref: "a" },
    { ...local, authority_project_ref: "b" }, { ...local, owner_management_path: "/project/b/auth" },
    { ...local, local_gotrue_enabled: "true" }, { ...local, public_auth_route: "owner_proxy" },
    { ...local, user_management: "owner_only" }, { ...local, configuration_management: "owner_only" },
    { ...local, local_membership_source: "external" }, { ...local, realtime_auth_supported: 1 },
    { ...local, mode: "owner" },
    { ...sharedAuthRuntime(), authority_project_ref: "a", owner_project_ref: "a" },
    { ...sharedAuthRuntime(), owner_project_ref: "other" },
    { ...sharedAuthRuntime(), authority_project_ref: "../other" },
    { ...sharedAuthRuntime(), local_gotrue_enabled: true },
    { ...sharedAuthRuntime(), public_auth_route: "local_gotrue" },
    { ...sharedAuthRuntime(), user_management: "local" },
    { ...sharedAuthRuntime(), configuration_management: "local" },
    { ...sharedAuthRuntime(), owner_management_path: "https://other.invalid/" }]) {
    expect(() => parseAuthRuntimeDescriptor(payload, "a")).toThrow("Invalid authentication runtime response");
  }
  for (const key of Object.keys(local)) {
    const withoutKey = Object.fromEntries(Object.entries(local).filter(([name]) => name !== key));
    expect(() => parseAuthRuntimeDescriptor(withoutKey, "a")).toThrow();
  }
});

test("runtime reads reject invalid status, size, encoding and JSON without disclosing bodies", async () => {
  const signal = new AbortController().signal;
  expect(await readAuthRuntimeResponse(Response.json(localAuthRuntime()), "a", signal)).toEqual(localAuthRuntime());
  for (const response of [
    Response.json(localAuthRuntime(), { status: 202 }),
    Response.json(localAuthRuntime(), { status: 206 }),
    new Response(null, { status: 204 }),
    new Response("private-error-detail", { status: 500 }),
    new Response("not-json"),
    new Response(new Uint8Array([0xff, 0xfe])),
    new Response(" ".repeat(32769)),
    Response.json(localAuthRuntime(), { headers: { "content-length": "32769" } }),
    Response.json(localAuthRuntime(), { headers: { "content-length": "unknown" } }),
  ]) {
    await expect(readAuthRuntimeResponse(response, "a", signal)).rejects.toThrow("Invalid authentication runtime response");
  }
});

test("runtime reader cancels oversized and pending streams and releases their locks", async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32769)); },
    cancel() { cancelled = true; },
  });
  await expect(readAuthRuntimeResponse(new Response(oversized), "a", new AbortController().signal)).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(oversized.locked).toBe(false);

  cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const pending = readAuthRuntimeResponse(new Response(stalled), "a", controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(stalled.locked).toBe(false);
});

test("runtime loader validates the requested identity before transport and forwards cancellation", async () => {
  let calls = 0;
  const request = async (url: string, options: RequestInit) => {
    calls++;
    expect(url).toBe("/v1/projects/a/auth/runtime");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe("error");
    return Response.json(localAuthRuntime());
  };
  expect(await loadAuthRuntime("a", request)).toEqual(localAuthRuntime());
  expect(calls).toBe(1);
  for (const ref of ["", "../other", "a/b", "a?b", "a#b", "a%2fb", "x".repeat(129)]) {
    await expect(loadAuthRuntime(ref, request)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  await expect(loadAuthRuntime("a", request, controller.signal)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("runtime loader keeps its deadline active after headers arrive", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await expect(loadAuthRuntime("a", async () => new Response(source))).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(source.locked).toBe(false);
}, 20_000);

test("runtime deadline settles an uncooperative transport and cancels its late body", async () => {
  const late = Promise.withResolvers<Response>();
  const cancelled = Promise.withResolvers<void>();
  await expect(loadAuthRuntime("a", async () => late.promise)).rejects.toThrow("Authentication runtime request aborted");
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); } });
  late.resolve(new Response(source));
  await cancelled.promise;
  expect(source.locked).toBe(false);
}, 20_000);
