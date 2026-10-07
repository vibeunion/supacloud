import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, FunctionsHttpError, FunctionsFetchError, FunctionsRelayError } from "@supabase/supabase-js";
import { MutationObserver, QueryClient, QueryObserver, hashKey } from "@tanstack/query-core";
import * as ts from "../../compiler/node_modules/@typescript/typescript6";
import { createCommandScope } from "@supacloud/contracts/client";
import { createSupaCloudApiFetch } from "./api-fetch";
import {
  createSupaCloudProcedureClient,
  isSupaCloudProcedureError,
  isSupaCloudProcedureHttpError,
  isSupaCloudProcedureTransportError,
  SupaCloudProcedureError,
  type SupaCloudGeneratedClientConfig,
} from "./index";
import type { SupabaseClient } from "./supabase-types";
import { createSupaCloudQueryAdapter } from "./query";

const graph = {
  externalTokens: [],
  modules: [{
    name: "items", className: "ItemsModule", file: "items.ts", line: 1,
    imports: [], providers: [], queries: [], exports: [],
    commands: [{
      className: "SaveItem", name: "item.save", permission: "item.save",
      transaction: "required", idempotency: "required",
    }],
    controllers: [{
      className: "ItemsController", path: "/items", scope: "request",
      deps: [], file: "items.ts", importPath: "./items",
      schemaImports: { Result: "./schemas", Body: "./schemas", Empty: "./schemas", Rejection: "./schemas" },
      routes: [
        { method: "GET", path: "/:id", handler: "detail", response: "Result" },
        { method: "GET", path: "/", handler: "list", response: "Result" },
        { method: "GET", path: "/empty", handler: "empty", responses: { "204": "Empty" } },
        { method: "POST", path: "/:id", handler: "save", body: "Body", response: "Result", command: "SaveItem" },
        { method: "POST", path: "/ping", handler: "ping", response: "Result" },
        { method: "POST", path: "/empty", handler: "touch", command: "SaveItem" },
        { method: "POST", path: "/declared", handler: "declared", responses: { 200: "Result", 409: "Rejection" } },
        { method: "GET", path: "/stream", handler: "stream", contract: { response: "stream" } },
      ],
    }],
  }],
};

type Execution = { signal?: AbortSignal; idempotencyKey?: string };
type Input = { params: { id: string }; query?: Record<string, unknown>; headers?: Record<string, string> };
type SaveInput = Input & { body: { name: string } };
type Result = { id: string };
type Procedure<I, R, K extends "query" | "mutation", D extends "none" | "required" = "none"> =
  ((input: I, execution?: Execution) => Promise<R>) & {
    __supacloudProcedure: { key: string; method: string; path: string; kind: K; idempotency: D };
    __supacloudInput?: I;
  };
type Route<I, R> = {
  (input: I): Promise<R>;
  <T>(input: I, decode: (value: unknown) => T): Promise<T>;
};
type FixtureClient = {
  request(method: string, path: string): Promise<unknown>;
  buildRouteUrl(path: string, params?: Record<string, string | number>): string;
  items: {
    detail: Route<Input, Result> & { query: Procedure<Input, Result, "query"> };
    list: { query: Procedure<{ query?: Record<string, unknown> }, Result, "query"> };
    empty: { query: Procedure<{}, undefined, "query"> };
    save: Route<SaveInput, Result> & { mutate: Procedure<SaveInput, Result, "mutation", "required"> };
    ping: { mutate: Procedure<{}, Result, "mutation"> };
    touch: { mutate: Procedure<{}, unknown, "mutation", "required"> };
    declared: { mutate: Procedure<{}, Result | { declined: boolean }, "mutation"> };
    stream: { query: Procedure<{}, ReadableStream<Uint8Array>, "query"> };
  };
};

let root: string;
type FixtureRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
};
type FixtureConfig = Pick<SupaCloudGeneratedClientConfig, "errorMapper" | "procedureExecutionValidator"> & {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  normalize?: boolean;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  interceptors?: Array<(request: FixtureRequest, next: (request: FixtureRequest) => Promise<Response>) => Promise<Response>>;
};
let createApiClient: (config: FixtureConfig) => FixtureClient;
const adapter = createSupaCloudQueryAdapter({ keyPrefix: ["project/app-api", "tenant", "actor"] });
const input: SaveInput = { params: { id: "1" }, body: { name: "first" } };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "supacloud-query-adapter-"));
  // Execute the real renderer without pulling compiler sources into the SDK's typecheck root.
  const compiler = await import(pathToFileURL(join(import.meta.dir, "../../compiler/src/generate.ts")).href) as {
    renderClient(applicationGraph: typeof graph): string;
  };
  await Bun.write(join(root, "client.ts"), compiler.renderClient(graph));
  await Bun.write(join(root, "schemas.ts"), [
    'import { Type } from "typebox";',
    'export const Result = Type.Object({ id: Type.String() });',
    'export const Body = Type.Object({ name: Type.String() });',
    'export const Empty = Type.Undefined();',
    'export const Rejection = Type.Object({ declined: Type.Boolean() });',
  ].join("\n"));
  await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"));
  const generated = await import(pathToFileURL(join(root, "client.ts")).href) as {
    createApiClient: typeof createApiClient;
  };
  createApiClient = generated.createApiClient;
});

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function facadeWithFetch(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const supabase = createClient("https://project.example.com", "publishable-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  return createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient });
}

async function procedureFailure(pending: Promise<unknown>): Promise<SupaCloudProcedureError> {
  const error: unknown = await pending.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(SupaCloudProcedureError);
  if (!(error instanceof SupaCloudProcedureError)) throw new Error("Expected procedure failure");
  return error;
}

test("generated procedures preserve old calls, query caching, key invalidation and snapshots", async () => {
  const seen: string[] = [];
  const api = createApiClient({ fetch: async (url) => {
    seen.push(url);
    return Response.json({ id: url.split("/").pop() });
  } });
  const client = new QueryClient();
  try {
    const mutable = { params: { id: "1" } };
    const options = adapter.queryOptions(api.items.detail.query, mutable, { staleTime: Infinity });
    mutable.params.id = "2";
    await expect(client.fetchQuery(options)).resolves.toEqual({ id: "1" });
    await expect(client.fetchQuery(options)).resolves.toEqual({ id: "1" });
    expect(seen).toHaveLength(1);
    expect(client.getQueryData(options.queryKey)).toEqual({ id: "1" });
    expect(Object.isFrozen(options.queryKey.at(-1))).toBe(true);
    await client.invalidateQueries({ queryKey: adapter.queryKey(api.items.detail.query) });
    await client.fetchQuery(options);
    expect(seen).toHaveLength(2);
    await expect(api.items.detail({ params: { id: "old" } })).resolves.toEqual({ id: "old" });
    await expect(api.items.save(input)).resolves.toEqual({ id: "1" });
    const reordered = adapter.queryKey(api.items.detail.query, { query: { b: 2, a: 1 }, params: { id: "1" } });
    expect(hashKey(reordered)).toBe(hashKey(adapter.queryKey(api.items.detail.query, {
      params: { id: "1" }, query: { a: 1, b: 2 },
    })));
    const otherActor = createSupaCloudQueryAdapter({ keyPrefix: ["project/app-api", "tenant", "actor-2"] });
    expect(hashKey(options.queryKey)).not.toBe(hashKey(otherActor.queryKey(api.items.detail.query, input)));
    expect(adapter.queryKey(api.items.list.query, undefined)).toEqual(adapter.queryKey(api.items.list.query, {}));
  } finally { client.clear(); }
});

test("query input rejects cycles and non-JSON values instead of colliding in cache", () => {
  const api = createApiClient({ fetch: async () => Response.json({ id: "1" }) });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const invalid of [cycle, [cycle], new Date(), Infinity, 1n]) {
    expect(() => adapter.queryOptions(api.items.list.query, { query: { value: invalid } })).toThrow();
  }
  const shared = { value: 1 };
  expect(() => adapter.queryOptions(api.items.list.query, { query: { a: shared, b: shared } })).not.toThrow();
});

test("query adapter rejects non-callable procedure values at runtime", () => {
  const fake = {
    __supacloudProcedure: {
      key: "items.list", method: "GET", path: "/items", kind: "query", idempotency: "none",
    },
  } as unknown as Parameters<typeof adapter.queryKey>[0];
  expect(() => adapter.queryKey(fake)).toThrow("Expected a generated query procedure");
  expect(() => adapter.queryOptions(fake, {})).toThrow("Expected a generated query procedure");
  const fakeMutation = { ...fake } as unknown as Procedure<{}, Result, "mutation">;
  expect(() => adapter.mutationKey(fakeMutation)).toThrow("Expected a generated mutation procedure");
  expect(() => adapter.mutationOptions(fakeMutation)).toThrow("Expected a generated mutation procedure");
});

test("real Query observers expose pending, success, error and no-content state", async () => {
  const client = new QueryClient();
  let respond!: (value: Response) => void;
  const api = createApiClient({ fetch: async () => new Promise((resolve) => { respond = resolve; }) });
  const observer = new QueryObserver(client, adapter.queryOptions(api.items.detail.query, input, { retry: false }));
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(observer.getCurrentResult().isPending).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    respond(Response.json({ id: "ready" }));
    await observer.refetch();
    expect(observer.getCurrentResult().data).toEqual({ id: "ready" });
    const failed = createApiClient({ fetch: async () => new Response("denied", { status: 403 }) });
    observer.setOptions(adapter.queryOptions(failed.items.detail.query, { params: { id: "error" } }, { retry: false }));
    await observer.refetch();
    expect(observer.getCurrentResult().isError).toBe(true);
    expect(observer.getCurrentResult().error).toMatchObject({ code: "API_HTTP_ERROR", status: 403 });
    const empty = createApiClient({ fetch: async () => new Response(null, { status: 204 }) });
    await expect(client.fetchQuery(adapter.queryOptions(empty.items.empty.query, {}))).resolves.toBeNull();
  } finally { unsubscribe(); client.clear(); }
});

test("Query cancellation reaches the generated transport and discards late results", async () => {
  const client = new QueryClient();
  let received!: AbortSignal;
  let respond!: (response: Response) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const api = createApiClient({ fetch: async (_url, init) => {
    received = init?.signal as AbortSignal;
    started();
    return new Promise((resolve) => { respond = resolve; });
  } });
  const options = adapter.queryOptions(api.items.detail.query, input);
  const pending = client.fetchQuery(options).catch((error: unknown) => error);
  try {
    await dispatched;
    await client.cancelQueries({ queryKey: options.queryKey });
    expect(received.aborted).toBe(true);
    respond(Response.json({ id: "late" }));
    await pending;
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  } finally { client.clear(); }
});

test("mutations require per-invocation keys and never inherit automatic write retries", async () => {
  const received: Array<string | null> = [];
  let fail = false;
  const api = createApiClient({ fetch: async (_url, init) => {
    received.push(new Headers(init?.headers).get("idempotency-key"));
    if (fail) throw new Error("network failure");
    return Response.json({ id: "saved" });
  } });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 3, retryDelay: 0 } } });
  try {
    const options = adapter.mutationOptions(api.items.save.mutate);
    const observer = new MutationObserver(client, options);
    for (const key of ["operation-1", "operation-2"]) {
      await expect(observer.mutate({ input, execution: { idempotencyKey: key } })).resolves.toEqual({ id: "saved" });
    }
    expect(received).toEqual(["operation-1", "operation-2"]);
    await expect(options.mutationFn({ input } as Parameters<typeof options.mutationFn>[0])).rejects.toThrow("idempotencyKey");
    for (const key of ["", "header-only"]) {
      const headerOnly: unknown = {
        input: { ...input, headers: { "idempotency-key": key } },
      };
      await expect(options.mutationFn(headerOnly as Parameters<typeof options.mutationFn>[0])).rejects.toMatchObject({
        code: "SUPACLOUD_EXECUTION_ERROR",
      });
    }
    await expect(options.mutationFn({ input, execution: { idempotencyKey: "" } })).rejects.toThrow("idempotencyKey");
    expect(received).toHaveLength(2);
    fail = true;
    await expect(observer.mutate({ input, execution: { idempotencyKey: "uncertain" } })).rejects.toThrow("network failure");
    expect(received).toHaveLength(3);
    fail = false;
    await adapter.mutationOptions(api.items.touch.mutate).mutationFn({ execution: { idempotencyKey: "no-input" } });
    await adapter.mutationOptions(api.items.ping.mutate).mutationFn({});
    expect(received.slice(-2)).toEqual(["no-input", null]);
  } finally { client.clear(); }
});

test("scope invalidation, destruction and superseding cancel mutations without late success", async () => {
  for (const action of ["invalidate", "destroy", "supersede"] as const) {
    const scope = createCommandScope();
    const client = new QueryClient();
    let respond!: (response: Response) => void;
    let received!: AbortSignal;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    const api = createApiClient({ fetch: async (_url, init) => {
      received = init?.signal as AbortSignal;
      started();
      return new Promise((resolve) => { respond = resolve; });
    } });
    let successes = 0;
    const mutation = new MutationObserver(client, adapter.mutationOptions(api.items.save.mutate, {
      onSuccess: () => { successes++; },
    }));
    const attempt = scope.begin("operation");
    const result = mutation.mutate({ input, execution: { idempotencyKey: "operation", signal: attempt.signal } })
      .catch((error: unknown) => error);
    try {
      await dispatched;
      if (action === "supersede") scope.begin("next");
      else scope[action]();
      expect(received.aborted).toBe(true);
      expect(await result).toMatchObject({ name: "AbortError" });
      respond(Response.json({ id: "late" }));
      await Promise.resolve(); await Promise.resolve();
      expect(successes).toBe(0);
      expect(mutation.getCurrentResult().isError).toBe(true);
    } finally { scope.destroy(); client.clear(); }
  }
});

test("already-cancelled mutations do not dispatch and signals remove settled listeners", async () => {
  const scope = createCommandScope();
  const attempt = scope.begin("cancelled");
  scope.invalidate();
  let calls = 0;
  const api = createApiClient({ fetch: async () => { calls++; return Response.json({ id: "1" }); } });
  await expect(adapter.mutationOptions(api.items.save.mutate).mutationFn({
    input, execution: { idempotencyKey: "cancelled", signal: attempt.signal },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(0);
  const current = scope.begin("current");
  const remove = spyOn(current.signal, "removeEventListener");
  try {
    await adapter.mutationOptions(api.items.save.mutate).mutationFn({
      input, execution: { idempotencyKey: "current", signal: current.signal },
    });
    await Promise.resolve();
    expect(remove).toHaveBeenCalled();
  } finally { remove.mockRestore(); scope.destroy(); }
});

test("adapter composes with official Supabase Functions without taking over authentication", async () => {
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const supabase = createClient("https://project.example.com", "publishable-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: async (url, init) => {
      requests.push({
        url: url.toString(), headers: new Headers(init?.headers),
        body: init?.body ? await new Response(init.body).json() : undefined,
      });
      return Response.json({ id: "official" });
    } },
  });
  const api = createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient });
  const client = new QueryClient();
  try {
    await client.fetchQuery(adapter.queryOptions(api.items.detail.query, {
      params: { id: "1" }, headers: { authorization: "Bearer stale", apikey: "stale" },
    }));
    await adapter.mutationOptions(api.items.save.mutate).mutationFn({
      input, execution: { idempotencyKey: "official-operation" },
    });
    expect(requests[0]?.url).toBe("https://project.example.com/functions/v1/app-api/items/1");
    expect(requests[0]?.headers.get("apikey")).toBe("publishable-key");
    expect(requests[0]?.headers.get("authorization")).not.toBe("Bearer stale");
    expect(requests[1]?.headers.get("idempotency-key")).toBe("official-operation");
    expect(requests[1]?.body).toEqual({ name: "first" });
  } finally { client.clear(); }
});

test("procedure facade preserves generated calls and the original Supabase Functions error", async () => {
  const requests: string[] = [];
  const supabase = createClient("https://project.example.com", "publishable-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (url) => {
        requests.push(url.toString());
        return Response.json(
          { code: "FORBIDDEN", details: { policy: "case.read" } },
          { status: 403, headers: { "x-request-id": "req-facade" } },
        );
      },
    },
  });
  const api = createSupaCloudProcedureClient({
    supabase,
    functionName: "app-api",
    generated: createApiClient,
  });

  expect(api.items.detail.query.__supacloudProcedure.kind).toBe("query");
  await expect(api.items.detail({ params: { id: "legacy" } }))
    .rejects.toBeInstanceOf(SupaCloudProcedureError);
  try {
    await api.items.detail.query({ params: { id: "facade" } });
    throw new Error("Expected the procedure to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SupaCloudProcedureError);
    if (!(error instanceof SupaCloudProcedureError)) throw error;
    expect(error).toMatchObject({
      code: "API_HTTP_ERROR",
      status: 403,
      requestId: "req-facade",
      upstreamCode: "FORBIDDEN",
      details: { code: "FORBIDDEN", details: { policy: "case.read" } },
    });
    expect(error.response?.status).toBe(403);
    expect(error.cause).toBeInstanceOf(FunctionsHttpError);
    if (!(error.cause instanceof FunctionsHttpError)) throw new Error("Expected official error");
    expect(error.cause.context).toBe(error.response);
    expect(error.response?.bodyUsed).toBe(false);
    await expect(error.cause.context.json()).resolves.toEqual({
      code: "FORBIDDEN", details: { policy: "case.read" },
    });
    expect(JSON.stringify(error)).not.toContain("case.read");
  }
  expect(requests).toHaveLength(2);
});

test("procedure errors expose strict guards and preserve successful response bodies", async () => {
  const foreign = Object.assign(new Error("foreign bundle"), {
    name: "SupaCloudProcedureError",
    code: "API_HTTP_ERROR",
    status: 403,
    requestId: "request-1",
    upstreamCode: "FORBIDDEN",
    response: undefined,
    details: { code: "FORBIDDEN" },
    cause: new Error("cause"),
  });
  expect(isSupaCloudProcedureError(foreign)).toBe(true);
  for (const invalid of [
    {}, { ...foreign }, Object.assign(new Error(), { ...foreign, code: "invented" }),
    Object.assign(new Error(), { ...foreign, status: NaN }),
    Object.assign(new Error(), { ...foreign, requestId: "unsafe value" }),
    Object.assign(new Error(), { ...foreign, response: {} }),
  ]) {
    expect(isSupaCloudProcedureError(invalid)).toBe(false);
  }
  expect(isSupaCloudProcedureHttpError(foreign)).toBe(false);
  const http = new SupaCloudProcedureError("denied", {
    code: "API_HTTP_ERROR", status: 403, response: new Response(null, { status: 403 }),
  });
  expect(isSupaCloudProcedureHttpError(http)).toBe(true);
  expect(isSupaCloudProcedureTransportError(http)).toBe(false);
  expect(isSupaCloudProcedureTransportError(new SupaCloudProcedureError("offline", {
    code: "SUPACLOUD_TRANSPORT_ERROR",
  }))).toBe(true);

  const response = new Response("{", { headers: { "content-type": "application/json" } });
  const direct = createApiClient({ fetch: async () => response });
  await expect(direct.items.detail.query(input)).rejects.toMatchObject({
    code: "API_RESPONSE_INVALID",
  });
  expect(response.bodyUsed).toBe(false);
  await expect(response.text()).resolves.toBe("{");
});

test("facade forwards generated configuration while owning transport and policy hooks", async () => {
  let normalize: boolean | undefined;
  let fetchCalls = 0;
  let returned: FixtureClient | undefined;
  const requests: Headers[] = [];
  const generated = (config: FixtureConfig): FixtureClient => {
    normalize = config.normalize;
    returned = createApiClient({
      ...config,
      fetch: async (url, init) => {
        fetchCalls++;
        return config.fetch(url, init);
      },
    });
    return returned;
  };
  const api = createSupaCloudProcedureClient({
    supabase: createClient("https://project.example.com", "publishable-key", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: async (_url, init) => {
        requests.push(new Headers(init?.headers));
        return Response.json({ id: "configured", extra: true });
      } },
    }),
    functionName: "app-api",
    generated,
    generatedConfig: {
      normalize: false,
      headers: async () => ({
        "x-tenant": "tenant-1", authorization: "Bearer stale", "Idempotency-Key": "default-key",
      }),
      interceptors: [async (request, next) => next({
        ...request, headers: {
          ...request.headers, "x-interceptor": "present", "IDEMPOTENCY-KEY": "interceptor-key",
        },
      })],
    },
  });
  if (returned === undefined) throw new Error("Generated factory did not return a client");
  expect(api).toBe(returned);
  await expect(api.items.detail.query(input)).rejects.toMatchObject({ code: "API_RESPONSE_INVALID" });
  expect(normalize).toBe(false);
  expect(fetchCalls).toBe(1);
  expect(requests[0]?.get("x-tenant")).toBe("tenant-1");
  expect(requests[0]?.get("x-interceptor")).toBe("present");
  expect(requests[0]?.get("authorization")).not.toBe("Bearer stale");
  await expect(api.items.save.mutate(input)).rejects.toMatchObject({ code: "SUPACLOUD_EXECUTION_ERROR" });
  expect(fetchCalls).toBe(1);
  await expect(api.items.save.mutate(input, { idempotencyKey: "invocation-key" }))
    .rejects.toMatchObject({ code: "API_RESPONSE_INVALID" });
  expect(fetchCalls).toBe(2);
  expect(requests[1]?.get("idempotency-key")).toBe("invocation-key");
});

test("facade rejects old generated clients without replacing legacy initialization", async () => {
  const supabase = createClient("https://project.example.com", "publishable-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: async () => Response.json({ id: "legacy" }) },
  });
  const generated = (config: SupaCloudGeneratedClientConfig) => ({
    request: () => config.fetch("/items").then(response => response.json()),
  });
  expect(() => createSupaCloudProcedureClient({ supabase, generated, functionName: "app-api" }))
    .toThrow("Regenerate");
  await expect(generated({ fetch: createSupaCloudApiFetch({ supabase, functionName: "app-api" }) }).request())
    .resolves.toEqual({ id: "legacy" });
});

test("facade preserves application errors including misleading names and messages", async () => {
  const api = facadeWithFetch(async () => Response.json({ id: "ok" }));
  for (const error of [new Error("decoder"), new SyntaxError("business syntax"),
    new TypeError("invalid idempotencyKey in business data"), { code: "DOMAIN_ERROR" },
    ...["FunctionsFetchError", "FunctionsRelayError", "FunctionsHttpError", "ApiClientError"]
      .map(name => Object.assign(new Error("business failure"), { name, code: "DOMAIN_ERROR", status: 409 })),
  ]) {
    await expect(api.items.detail(input, () => { throw error; })).rejects.toBe(error);
    await expect(api.items.detail(input, async () => { throw error; })).rejects.toBe(error);
  }
  const suppliedFailure = new SyntaxError("headers callback");
  const supabase = createClient("https://project.example.com", "publishable-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (const config of [
    { headers: async () => { throw suppliedFailure; } },
    { interceptors: [async () => { throw suppliedFailure; }] },
  ]) {
    const custom = createSupaCloudProcedureClient({
      supabase, functionName: "app-api", generated: createApiClient, generatedConfig: config,
    });
    await expect(custom.items.detail.query(input)).rejects.toBe(suppliedFailure);
  }
});

test("generated hooks map failures once and preserve mapper failures", async () => {
  let calls = 0;
  const mapped = new Error("mapped");
  const api = createApiClient({
    fetch: async () => new Response(null, { status: 500 }),
    errorMapper: async () => { calls++; return mapped; },
  });
  for (const call of [
    () => api.items.detail(input), () => api.items.detail.query(input),
    () => api.request("GET", "/items"), () => api.items.save.mutate(input),
  ]) {
    const before = calls;
    await expect(call()).rejects.toBe(mapped);
    expect(calls).toBe(before + 1);
  }
  let dispatched = 0;
  const broken = createApiClient({
    fetch: async () => { dispatched++; return Response.json({ id: "ok" }); },
    procedureExecutionValidator: () => { throw new Error("validation"); },
    errorMapper: async () => { throw mapped; },
  });
  await expect(broken.items.save.mutate(input, { idempotencyKey: "valid" })).rejects.toBe(mapped);
  expect(dispatched).toBe(0);
});

test("adapter validates custom procedures without dispatching invalid execution", async () => {
  let calls = 0;
  const mutate: Procedure<SaveInput, Result, "mutation", "required"> = Object.assign(
    async (_input: SaveInput) => { calls++; return { id: "saved" }; },
    { __supacloudProcedure: {
      key: "custom", method: "POST", path: "/custom", kind: "mutation", idempotency: "required",
    } as const },
  );
  const options = adapter.mutationOptions(mutate);
  for (const key of [undefined, "", "bad key", "x".repeat(513), 123]) {
    const variables: unknown = {
      input: { ...input, headers: { "Idempotency-Key": "not-execution" } },
      execution: { idempotencyKey: key },
    };
    const error = await procedureFailure(options.mutationFn(variables as Parameters<typeof options.mutationFn>[0]));
    expect(error.code).toBe("SUPACLOUD_EXECUTION_ERROR");
  }
  await expect(options.mutationFn({
    input, execution: { idempotencyKey: "valid", signal: {} as AbortSignal },
  })).rejects.toMatchObject({ code: "SUPACLOUD_EXECUTION_ERROR" });
  expect(calls).toBe(0);
  await options.mutationFn({ input, execution: { idempotencyKey: "x".repeat(512) } });
  expect(calls).toBe(1);
});

test("generated response cloning falls back cleanly and does not tee live streams", async () => {
  const response = Response.json({ id: "fallback" });
  const clone = spyOn(response, "clone").mockImplementation(() => { throw new TypeError("uncloneable"); });
  try {
    const api = createApiClient({ fetch: async () => response });
    await expect(api.items.detail.query(input)).resolves.toEqual({ id: "fallback" });
    expect(clone).toHaveBeenCalledTimes(1);
  } finally { clone.mockRestore(); }
  for (const contentType of ["text/event-stream", "application/octet-stream"]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("event")); controller.close(); },
    });
    const streaming = new Response(stream, { headers: { "content-type": contentType } });
    const streamClone = spyOn(streaming, "clone");
    try {
      const api = createApiClient({ fetch: async () => streaming });
      const result = await api.items.stream.query({});
      if (streaming.body === null) throw new Error("Fixture must contain a response stream");
      expect(result).toBe(streaming.body);
      await expect(new Response(result).text()).resolves.toBe("event");
      expect(streamClone).not.toHaveBeenCalled();
    } finally { streamClone.mockRestore(); }
  }
});

test("procedure facade keeps concurrent response metadata associated with each failure", async () => {
  let index = 0;
  const supabase = {
    functions: {
      invoke: async () => {
        const current = index++;
        const response = Response.json(
          { operation: current === 0 ? "first" : "second" },
          { status: current === 0 ? 409 : 429, headers: { "x-request-id": `req-${current}` } },
        );
        return { data: null, error: new FunctionsHttpError(response), response };
      },
    },
  } as unknown as SupabaseClient;
  const api = createSupaCloudProcedureClient({
    supabase,
    functionName: "app-api",
    generated: createApiClient,
  });
  const failures = await Promise.all([
    api.items.detail.query({ params: { id: "first" } }).catch((error: unknown) => error),
    api.items.detail.query({ params: { id: "second" } }).catch((error: unknown) => error),
  ]);
  expect(failures).toHaveLength(2);
  expect(failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 409, requestId: "req-0" }),
    expect.objectContaining({ status: 429, requestId: "req-1" }),
  ]));
  for (const failure of failures) {
    if (!(failure instanceof SupaCloudProcedureError)) throw new Error("Expected procedure error");
    if (!(failure.cause instanceof FunctionsHttpError)) throw new Error("Expected official error");
    expect(failure.cause.context).toBe(failure.response);
    expect(failure.details).toEqual({ operation: failure.status === 409 ? "first" : "second" });
  }
});

test("facade requires explicit mutation keys, preserves legacy calls and never retries writes", async () => {
  const keys: Array<string | null> = [];
  let offline = false;
  const networkError = new TypeError("offline");
  const api = facadeWithFetch(async (_url, init) => {
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    if (offline) throw networkError;
    return Response.json({ id: "saved" });
  });
  for (const execution of [undefined, {}, { idempotencyKey: "" }, { idempotencyKey: "bad key" },
    { idempotencyKey: 123 as unknown as string }]) {
    const failure = await procedureFailure(api.items.save.mutate(
      { ...input, headers: { "Idempotency-Key": "header-cannot-bypass" } }, execution,
    ));
    expect(failure.code).toBe("SUPACLOUD_EXECUTION_ERROR");
    expect(failure.status).toBeNull();
  }
  expect(keys).toHaveLength(0);
  const mutation = adapter.mutationOptions(api.items.save.mutate);
  expect((await procedureFailure(mutation.mutationFn({
    input,
  } as Parameters<typeof mutation.mutationFn>[0]))).code).toBe("SUPACLOUD_EXECUTION_ERROR");
  await api.items.save.mutate({ ...input, headers: { "Idempotency-Key": "old" } }, { idempotencyKey: "one" });
  await api.items.save(input);
  expect(keys).toEqual(["one", null]);
  expect(api.items.detail.query).toBe(api.items.detail.query);
  expect(Object.isFrozen(api.items.detail.query.__supacloudProcedure)).toBe(true);
  expect(api.buildRouteUrl("/items/:id", { id: "a/b" })).toBe("/items/a%2Fb");
  offline = true;
  const failure = await procedureFailure(api.items.save.mutate(input, { idempotencyKey: "two" }));
  expect(failure.code).toBe("SUPACLOUD_TRANSPORT_ERROR");
  expect(failure.status).toBeNull();
  expect(failure.response).toBeUndefined();
  expect(failure.cause).toBeInstanceOf(FunctionsFetchError);
  if (!(failure.cause instanceof FunctionsFetchError)) throw new Error("Expected network error");
  expect(failure.cause.context).toBe(networkError);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 3, retryDelay: 0 } } });
  try {
    const observer = new MutationObserver(client, adapter.mutationOptions(api.items.save.mutate));
    await procedureFailure(observer.mutate({ input, execution: { idempotencyKey: "three" } }));
    expect(keys).toEqual(["one", null, "two", "three"]);
  } finally { client.clear(); }
});

test("facade preserves declared non-2xx values and distinguishes contract errors from HTTP failures", async () => {
  let response = Response.json({ declined: true }, { status: 409 });
  const api = facadeWithFetch(async () => response);
  await expect(api.items.declared.mutate({})).resolves.toEqual({ declined: true });
  response = Response.json({ declined: "invalid" }, {
    status: 409, headers: { "x-request-id": "req-declared" },
  });
  const invalid = await procedureFailure(api.items.declared.mutate({}));
  expect(invalid).toMatchObject({ code: "API_RESPONSE_INVALID", status: 409, requestId: "req-declared" });
  expect(invalid.cause).toBeInstanceOf(FunctionsHttpError);
  expect(invalid.response).toBe(response);
  await expect(invalid.response?.json()).resolves.toEqual({ declined: "invalid" });
  for (const status of [200, 201]) {
    response = Response.json({ id: 42 }, { status, headers: { "x-request-id": "req-schema" } });
    const failure = await procedureFailure(api.items.detail.query(input));
    expect(failure).toMatchObject({
      code: status === 200 ? "API_RESPONSE_INVALID" : "API_RESPONSE_UNDECLARED",
      status, requestId: "req-schema",
    });
    expect(failure.response?.status).toBe(status);
    expect(failure.response?.bodyUsed).toBe(false);
    await expect(failure.response?.json()).resolves.toEqual({ id: 42 });
    expect(failure.cause).toMatchObject({ name: "ApiClientError" });
  }
  response = new Response("{", { headers: { "content-type": "application/json" } });
  expect(await procedureFailure(api.items.detail.query(input))).toMatchObject({
    code: "API_RESPONSE_INVALID", status: null,
  });
  response = new Response("denied", { status: 403 });
  expect(await procedureFailure(api.request("GET", "/items/1"))).toMatchObject({
    code: "API_HTTP_ERROR", status: 403,
  });
});

test("relay errors cannot become typed application successes and cancellation is preserved", async () => {
  for (const status of [200, 409]) {
    const api = facadeWithFetch(async () => Response.json(
      status === 200 ? { id: "not-a-success" } : { declined: true },
      { status, headers: { "x-relay-error": "true" } },
    ));
    const failure = await procedureFailure(api.items.declared.mutate({}));
    expect(failure).toMatchObject({ code: "SUPACLOUD_FUNCTIONS_ERROR", status });
    expect(failure.cause).toBeInstanceOf(FunctionsRelayError);
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const api = facadeWithFetch(async () => { calls++; return Response.json({ id: "ok" }); });
  await expect(api.items.save.mutate(input, {
    idempotencyKey: "cancelled", signal: controller.signal,
  })).rejects.toBe(controller.signal.reason);
  expect(calls).toBe(0);
  const abort = new DOMException("Cancelled", "AbortError");
  const cancelled = facadeWithFetch(async () => { throw abort; });
  await expect(cancelled.items.detail.query(input)).rejects.toBe(abort);
});

test("error inspection is bounded, sanitizes trace IDs and never consumes the original response", async () => {
  for (const response of [
    Response.json({ details: "x".repeat(70_000) }, { status: 500 }),
    Response.json({ details: "skip" }, { status: 500, headers: { "content-length": "70000" } }),
    new Response("private text", { status: 500 }),
    new Response("{", { status: 500, headers: { "content-type": "application/json", "x-request-id": "unsafe trace" } }),
  ]) {
    const api = facadeWithFetch(async () => response);
    const failure = await procedureFailure(api.items.detail.query(input));
    expect(failure.details).toBeUndefined();
    expect(failure.requestId).toBeNull();
    expect(failure.response).toBe(response);
    expect(response.bodyUsed).toBe(false);
    await response.text();
  }
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; value.enqueue(new TextEncoder().encode('{"details":')); },
  }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    const failure = await procedureFailure(facadeWithFetch(async () => response).items.detail.query(input));
    expect(failure.details).toBeUndefined();
    expect(failure.response).toBe(response);
  } finally {
    controller.close();
    await response.body?.cancel();
  }
}, 3000);

test("legacy transport and generated client retain their original error ownership", async () => {
  const response = Response.json({ code: "DENIED" }, { status: 403 });
  const official = new FunctionsHttpError(response);
  let error: Error = official;
  const supabase = {
    functions: { invoke: async () => ({ data: null, error, ...(error === official ? { response } : {}) }) },
  } as unknown as SupabaseClient;
  const fetch = createSupaCloudApiFetch({ supabase, functionName: "app-api" });
  expect(await fetch("/items")).toBe(response);
  const legacy = createApiClient({ fetch });
  await expect(legacy.items.detail(input)).rejects.toMatchObject({ name: "ApiClientError" });
  error = new Error("network failure");
  await expect(fetch("/items")).rejects.toBe(error);
  await expect(legacy.items.detail(input)).rejects.toBe(error);
  const direct = createApiClient({ fetch: async () => Response.json({ id: "legacy" }) });
  await expect(direct.items.save({
    ...input, headers: { "idempotency-key": "legacy-key" },
  })).resolves.toEqual({ id: "legacy" });
});

test("all procedure entrypoints reject header-only keys and invalid execution before dispatch", async () => {
  let dispatched = 0;
  const fetch = async () => { dispatched++; return Response.json({ id: "ok" }); };
  const direct = createApiClient({ fetch });
  const facade = facadeWithFetch(fetch);
  const mutations = [adapter.mutationOptions(direct.items.save.mutate), adapter.mutationOptions(facade.items.save.mutate)];
  const headerInput = { ...input, headers: { "Idempotency-Key": "not-execution" } };
  for (const value of [undefined, null, [], "bad", {}, { idempotencyKey: "" },
    { idempotencyKey: "bad key" }, { idempotencyKey: 123 }, { idempotencyKey: "x".repeat(513) },
    { idempotencyKey: "valid", signal: {} }]) {
    const execution = value as Execution & { idempotencyKey: string };
    await expect(direct.items.save.mutate(headerInput, execution)).rejects.toBeInstanceOf(TypeError);
    await expect(facade.items.save.mutate(headerInput, execution))
      .rejects.toMatchObject({ code: "SUPACLOUD_EXECUTION_ERROR" });
    for (const mutation of mutations) {
      await expect(mutation.mutationFn({ input: headerInput, execution }))
        .rejects.toMatchObject({ code: "SUPACLOUD_EXECUTION_ERROR" });
    }
  }
  expect(dispatched).toBe(0);
  for (const key of ["operation_1.v2:attempt-3", "x".repeat(512)]) {
    await direct.items.save.mutate(headerInput, { idempotencyKey: key });
    await facade.items.save.mutate(headerInput, { idempotencyKey: key });
    for (const mutation of mutations) await mutation.mutationFn({ input: headerInput, execution: { idempotencyKey: key } });
  }
  expect(dispatched).toBe(8);
});

test("procedure execution keys are captured before async headers or adapter dispatch", async () => {
  const keys: Array<string | null> = [];
  const pendingHeaders = { idempotencyKey: "original" };
  const direct = createApiClient({
    headers: async () => { pendingHeaders.idempotencyKey = "changed"; return {}; },
    fetch: async (_url, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return Response.json({ id: "ok" });
    },
  });
  await direct.items.save.mutate(input, pendingHeaders);
  const adapted = { idempotencyKey: "adapted" };
  const mutation = adapter.mutationOptions(direct.items.save.mutate);
  const result = mutation.mutationFn({ input, execution: adapted });
  adapted.idempotencyKey = "changed-again";
  await result;
  expect(keys).toEqual(["original", "adapted"]);
});

test("actual generated client infers core and Svelte results and rejects missing input or keys", async () => {
  await Bun.write(join(root, "consumer.ts"), `
import { createApiClient, type ApiClientConfig, type ProcedureCall } from "./client";
import { createSupaCloudQueryAdapter } from ${JSON.stringify(join(import.meta.dir, "query"))};
import { createSupaCloudProcedureClient } from ${JSON.stringify(join(import.meta.dir, "procedure-client"))};
import {
  SupaCloudProcedureError, isSupaCloudProcedureError, isSupaCloudProcedureHttpError,
  isSupaCloudProcedureTransportError, type SupaCloudProcedureErrorCode,
} from ${JSON.stringify(join(import.meta.dir, "procedure-error"))};
import type { SupabaseClient } from ${JSON.stringify(join(import.meta.dir, "supabase-types"))};
import type { SupabaseClient as CjsClient } from "@supabase/supabase-js" with { "resolution-mode": "require" };
import type { SupabaseClient as EsmClient } from "@supabase/supabase-js" with { "resolution-mode": "import" };
import { QueryClient, MutationObserver } from "@tanstack/query-core";
import { createQuery, createMutation } from "@tanstack/svelte-query";
const api = createApiClient();
const adapter = createSupaCloudQueryAdapter({ keyPrefix: ["project", "tenant", "actor"] });
declare const supabase: SupabaseClient;
type Database = { public: {
  Tables: { items: { Row: { id: string }; Insert: { id?: string }; Update: { id?: string }; Relationships: [] } };
  Views: {}; Functions: {}; Enums: {}; CompositeTypes: {};
} };
declare const cjs: CjsClient<Database>;
declare const esm: EsmClient<Database>;
createSupaCloudProcedureClient({ supabase: cjs, functionName: "app-api", generated: createApiClient });
createSupaCloudProcedureClient({ supabase: esm, functionName: "app-api", generated: createApiClient });
const facade = createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient });
const configured = createSupaCloudProcedureClient({
  supabase, functionName: "app-api", generated: createApiClient,
  generatedConfig: {
    normalize: false, baseUrl: "/v1",
    headers: async () => ({ "x-tenant": "tenant" }),
    interceptors: [async (request, next) => {
      const url: string = request.url;
      return next({ ...request, url });
    }],
  },
});
const extendedFactory = (config: ApiClientConfig & { mode?: "strict" | "compat" }) => createApiClient(config);
const extended = createSupaCloudProcedureClient({
  supabase, functionName: "app-api", generated: extendedFactory, generatedConfig: { mode: "strict" },
});
// @ts-expect-error Optional factory-specific settings retain their exact type.
createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: extendedFactory, generatedConfig: { mode: "invented" } });
// @ts-expect-error Boolean settings cannot be strings.
createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient, generatedConfig: { normalize: "false" } });
// @ts-expect-error Unknown configuration cannot be inferred into the factory contract.
createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient, generatedConfig: { unknownOption: true } });
const bypass = { normalize: false, fetch: globalThis.fetch };
// @ts-expect-error Existing variables cannot override facade transport either.
createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient, generatedConfig: bypass });
// @ts-expect-error Error mapping is facade-owned.
createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient, generatedConfig: { errorMapper: (error: unknown) => error } });
// @ts-expect-error Execution validation is facade-owned.
createSupaCloudProcedureClient({ supabase, functionName: "app-api", generated: createApiClient, generatedConfig: { procedureExecutionValidator: () => {} } });
const input = { params: { id: "1" }, body: { name: "first" } };
const configuredResult: Promise<{ id: string }> = configured.items.detail.query(input);
const extendedResult: Promise<{ id: string }> = extended.items.detail.query(input);
const facadeData: Promise<{ id: string }> = facade.items.detail.query(input);
const facadeLegacy: Promise<{ id: string }> = facade.items.detail(input);
const procedureKind: "query" = facade.items.detail.query.__supacloudProcedure.kind;
const facadeDecoded: Promise<string> = facade.items.detail(input, String);
const facadeQuery = createQuery(() => adapter.queryOptions(facade.items.detail.query, input));
const facadeQueryData: { id: string } | undefined = facadeQuery.data;
// @ts-expect-error Facade does not erase body types.
facade.items.save.mutate({ params: { id: "1" }, body: { name: 42 } }, { idempotencyKey: "one" });
// @ts-expect-error Facade still requires a mutation key.
facade.items.save.mutate(input);
// @ts-expect-error Facade still requires path params.
facade.items.detail.query({});
// @ts-expect-error Generated responses cannot be fabricated.
const wrongFacade: Promise<string> = facade.items.detail.query(input);
const query = createQuery(() => adapter.queryOptions(api.items.detail.query, input));
const data: { id: string } | undefined = query.data;
const pending: boolean = query.isPending;
const error: Error | null = query.error;
const selected = createQuery(() => adapter.queryOptions(api.items.detail.query, input, { select: value => value.id }));
const selectedData: string | undefined = selected.data;
const client = new QueryClient();
const fetched: Promise<{ id: string }> = client.fetchQuery(adapter.queryOptions(api.items.detail.query, input));
const cached: { id: string } | undefined = client.getQueryData(adapter.queryKey(api.items.detail.query, input));
const mutation = createMutation(() => adapter.mutationOptions(api.items.save.mutate));
const saved: Promise<{ id: string }> = mutation.mutateAsync({ input, execution: { idempotencyKey: "one" } });
const observer = new MutationObserver(client, adapter.mutationOptions(api.items.save.mutate));
observer.mutate({ input, execution: { idempotencyKey: "one" } });
adapter.mutationOptions(api.items.touch.mutate).mutationFn({ execution: { idempotencyKey: "touch" } });
adapter.mutationOptions(api.items.ping.mutate).mutationFn({});
adapter.queryOptions(api.items.list.query, undefined);
const empty: Promise<null> = client.fetchQuery(adapter.queryOptions(api.items.empty.query, undefined));
const legacy: ProcedureCall = async () => "legacy";
api.items.save(input);
api.items.save.mutate(input, { idempotencyKey: "one" });
// @ts-expect-error Required query input cannot be omitted.
adapter.queryOptions(api.items.detail.query, undefined);
// @ts-expect-error Required parameters remain required.
adapter.queryOptions(api.items.detail.query, {});
// @ts-expect-error Output cannot be invented through select.
adapter.queryOptions(api.items.detail.query, input, { select: (data: { wrong: string }) => data.wrong });
// @ts-expect-error A mutation is not a cacheable query.
adapter.queryOptions(api.items.save.mutate, input);
// @ts-expect-error A query is not a mutation.
adapter.mutationOptions(api.items.detail.query);
// @ts-expect-error Each write must supply the required key.
mutation.mutateAsync({ input });
// @ts-expect-error An empty execution does not satisfy required idempotency.
mutation.mutateAsync({ input, execution: {} });
// @ts-expect-error Body schema is enforced at mutateAsync.
mutation.mutateAsync({ input: { params: { id: "1" }, body: { name: 42 } }, execution: { idempotencyKey: "one" } });
// @ts-expect-error Request data cannot be omitted on this route.
mutation.mutateAsync({ execution: { idempotencyKey: "one" } });
// @ts-expect-error The adapter cannot opt in to automatic write retry.
adapter.mutationOptions(api.items.save.mutate, { retry: 3 });
// @ts-expect-error Cache identity is adapter-owned.
adapter.queryOptions(api.items.detail.query, input, { queryKey: ["unscoped"] });
// @ts-expect-error Namespace is mandatory.
createSupaCloudQueryAdapter();
const descriptor = { __supacloudProcedure: api.items.detail.query.__supacloudProcedure };
const mutationDescriptor = { __supacloudProcedure: api.items.save.mutate.__supacloudProcedure };
// @ts-expect-error Metadata is not a callable procedure.
adapter.queryOptions(descriptor, {});
// @ts-expect-error Prefix keys also require a callable procedure.
adapter.queryKey(descriptor);
// @ts-expect-error Mutation descriptors cannot be invoked.
adapter.mutationOptions(mutationDescriptor);
// @ts-expect-error Mutation keys also require a callable procedure.
adapter.mutationKey(mutationDescriptor);
const synchronous = Object.assign(() => ({ id: "fake" }), descriptor);
// @ts-expect-error A procedure must return a Promise.
adapter.queryOptions(synchronous, {});
const typedError = new SupaCloudProcedureError("network", { code: "SUPACLOUD_TRANSPORT_ERROR" });
const knownCode: SupaCloudProcedureErrorCode = typedError.code;
// @ts-expect-error Arbitrary server codes belong in upstreamCode, not code.
new SupaCloudProcedureError("failure", { code: "FORBIDDEN" });
new SupaCloudProcedureError("failure", { code: "API_HTTP_ERROR", upstreamCode: "FORBIDDEN" });
declare const caught: unknown;
if (isSupaCloudProcedureError(caught)) {
  const code: SupaCloudProcedureErrorCode = caught.code;
  const details: unknown = caught.details;
  // @ts-expect-error Error-body data must be validated before reading properties.
  caught.details.message;
  void code; void details;
}
if (isSupaCloudProcedureHttpError(caught)) {
  const response: Response = caught.response;
  const status: number = caught.status;
  void response; void status;
}
if (isSupaCloudProcedureTransportError(caught)) {
  const transportCode: "SUPACLOUD_TRANSPORT_ERROR" | "SUPACLOUD_FUNCTIONS_ERROR" = caught.code;
  void transportCode;
}
void data; void pending; void error; void selectedData; void fetched; void cached; void saved; void empty; void legacy;
void facadeData; void facadeLegacy; void procedureKind; void facadeDecoded; void facadeQueryData; void wrongFacade;
void configuredResult; void extendedResult; void knownCode;
`);
  const program = ts.createProgram([join(root, "consumer.ts")], {
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true,
  });
  expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
}, 15_000);

test("facade emits portable declarations and root browser/CommonJS exports without Query dependencies", async () => {
  const source = join(import.meta.dir, "procedure-client.ts");
  const declarations: string[] = [];
  const program = ts.createProgram([source], {
    strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [], outDir: join(root, "facade-declarations"),
  });
  const emitted = program.emit(undefined, (_path, text) => { declarations.push(text); });
  expect([...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  expect(declarations.join("\n")).toContain("ReturnType<TFactory>");
  expect(declarations.join("\n")).not.toContain("node_modules/");
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
  expect(manifest.files).toContain("PROCEDURES.md");
  for (const format of ["esm", "cjs"] as const) {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "index.ts")], target: "browser", format,
      external: ["@supabase/supabase-js", "@supacloud/contracts"],
    });
    expect(built.success).toBe(true);
    const text = await built.outputs[0]!.text();
    expect(text).toContain("createSupaCloudProcedureClient");
    expect(text).toContain("SupaCloudProcedureError");
    expect(text).not.toContain("@tanstack/");
    expect(text).not.toContain("svelte");
  }
});

test("optional query entrypoint produces portable declarations and dependency-free browser/CommonJS bundles", async () => {
  const source = join(import.meta.dir, "query.ts");
  const declarations: string[] = [];
  const program = ts.createProgram([source], {
    strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [], outDir: join(root, "declarations"),
  });
  const emitted = program.emit(undefined, (_path, text) => { declarations.push(text); });
  expect([...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  expect(declarations.join("\n")).toContain('from "@tanstack/query-core"');
  expect(declarations.join("\n")).not.toContain("node_modules/");
  expect(declarations.join("\n")).not.toContain("hydration-");
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
  expect(manifest.exports["./query"].import.default).toBe("./dist/query.mjs");
  expect(manifest.exports["./query"].require.default).toBe("./dist/query.cjs");
  expect(manifest.peerDependenciesMeta["@tanstack/query-core"].optional).toBe(true);
  for (const format of ["esm", "cjs"] as const) {
    const built = await Bun.build({ entrypoints: [source], target: "browser", format });
    expect(built.success).toBe(true);
    const text = await built.outputs[0]!.text();
    expect(text).not.toContain("@tanstack/");
    expect(text).not.toContain("@supabase/");
    expect(text).not.toContain("svelte");
    // Each bundle gets a separate class identity in the same JS realm.
    const isolated = format === "esm" ? text : [
      "const isolatedExports = (() => {",
      "const module = { exports: {} };",
      "const exports = module.exports;",
      text,
      "return module.exports;",
      "})();",
      "export const createSupaCloudQueryAdapter = isolatedExports.createSupaCloudQueryAdapter;",
    ].join("\n");
    const bundled = await import(
      `data:text/javascript;base64,${Buffer.from(isolated).toString("base64")}`
    ) as typeof import("./query");
    const bundledAdapter = bundled.createSupaCloudQueryAdapter({ keyPrefix: ["bundle"] });
    const api = createApiClient({ fetch: async () => Response.json({ id: "ok" }) });
    const options = bundledAdapter.mutationOptions(api.items.save.mutate);
    const failure: unknown = await options.mutationFn({
      input,
    } as Parameters<typeof options.mutationFn>[0]).catch((error: unknown) => error);
    expect(failure instanceof SupaCloudProcedureError).toBe(false);
    expect(isSupaCloudProcedureError(failure)).toBe(true);
    expect(failure).toMatchObject({ code: "SUPACLOUD_EXECUTION_ERROR" });
  }
});
/// <reference types="bun" />
