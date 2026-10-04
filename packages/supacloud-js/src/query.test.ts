import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { MutationObserver, QueryClient, QueryObserver, hashKey } from "@tanstack/query-core";
import * as ts from "@typescript/typescript6";
import { createCommandScope } from "@supacloud/contracts/client";
import { createSupaCloudApiFetch } from "./api-fetch";
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
      schemaImports: { Result: "./schemas", Body: "./schemas", Empty: "./schemas" },
      routes: [
        { method: "GET", path: "/:id", handler: "detail", response: "Result" },
        { method: "GET", path: "/", handler: "list", response: "Result" },
        { method: "GET", path: "/empty", handler: "empty", responses: { "204": "Empty" } },
        { method: "POST", path: "/:id", handler: "save", body: "Body", response: "Result", command: "SaveItem" },
        { method: "POST", path: "/ping", handler: "ping", response: "Result" },
        { method: "POST", path: "/empty", handler: "touch", command: "SaveItem" },
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
type Route<I, R> = (input: I) => Promise<R>;
type FixtureClient = {
  items: {
    detail: Route<Input, Result> & { query: Procedure<Input, Result, "query"> };
    list: { query: Procedure<{ query?: Record<string, unknown> }, Result, "query"> };
    empty: { query: Procedure<{}, undefined, "query"> };
    save: Route<SaveInput, Result> & { mutate: Procedure<SaveInput, Result, "mutation", "required"> };
    ping: { mutate: Procedure<{}, Result, "mutation"> };
    touch: { mutate: Procedure<{}, unknown, "mutation", "required"> };
  };
};

let root: string;
let createApiClient: (config: { fetch: (input: string, init?: RequestInit) => Promise<Response> }) => FixtureClient;
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
  ].join("\n"));
  await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"));
  const generated = await import(pathToFileURL(join(root, "client.ts")).href) as {
    createApiClient: typeof createApiClient;
  };
  createApiClient = generated.createApiClient;
});

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

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
  const api = createApiClient({ fetch: createSupaCloudApiFetch({ supabase, functionName: "app-api" }) });
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

test("actual generated client infers core and Svelte results and rejects missing input or keys", async () => {
  await Bun.write(join(root, "consumer.ts"), `
import { createApiClient, type ProcedureCall } from "./client";
import { createSupaCloudQueryAdapter } from ${JSON.stringify(join(import.meta.dir, "query"))};
import { QueryClient, MutationObserver } from "@tanstack/query-core";
import { createQuery, createMutation } from "@tanstack/svelte-query";
const api = createApiClient();
const adapter = createSupaCloudQueryAdapter({ keyPrefix: ["project", "tenant", "actor"] });
const input = { params: { id: "1" }, body: { name: "first" } };
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
void data; void pending; void error; void selectedData; void fetched; void cached; void saved; void empty; void legacy;
`);
  const program = ts.createProgram([join(root, "consumer.ts")], {
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true,
  });
  expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
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
  }
});
/// <reference types="bun" />
