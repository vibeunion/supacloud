import { afterEach, expect, expectTypeOf, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { createQueryAdapter, createQueryKey, fetchQueryResult } from "../src/index.js";

const caches = new Set<QueryClient>();
function queryCache() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
  caches.add(client);
  return client;
}
afterEach(() => {
  for (const client of caches) client.clear();
  caches.clear();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function readOptions<Raw>(read: (signal?: AbortSignal) => Promise<Raw>, tenant = "tenant") {
  const query = Object.assign(
    async (_input: Record<string, never>, execution?: { signal?: AbortSignal }) => read(execution?.signal),
    {
      __supacloudInput: undefined as Record<string, never> | undefined,
      __supacloudProcedure: {
        key: "Items.detail", kind: "query" as const, method: "GET",
        path: "/items", idempotency: "none" as const, tags: ["items"] as const,
      },
    },
  );
  return createQueryAdapter({ items: { detail: { query } } }, { keyPrefix: [tenant] })
    .items.detail.queryOptions({});
}

function fixture() {
  const calls: unknown[] = [];
  const query = Object.assign(async (input: { params: { id: string } }, execution?: { signal?: AbortSignal }) => {
    calls.push({ input, execution });
    return { id: input.params.id };
  }, {
    __supacloudInput: undefined as { params: { id: string } } | undefined,
    __supacloudProcedure: {
      key: "Items.get", kind: "query" as const, method: "GET", path: "/items/:id",
      idempotency: "none" as const, tags: ["items"] as const,
    },
  });
  const mutate = Object.assign(async (input: { body: { id: string } }, execution: { idempotencyKey: string }) => {
    calls.push({ input, execution });
    return { id: input.body.id };
  }, {
    __supacloudInput: undefined as { body: { id: string } } | undefined,
    __supacloudProcedure: {
      key: "Items.save", kind: "mutation" as const, method: "POST", path: "/items",
      idempotency: "required" as const, invalidateTags: ["items"] as const,
    },
  });
  return { calls, client: { procedureClient: { items: { get: { query }, save: { mutate } } } } };
}

test("query options retain immutable inputs and tenant-scoped keys", async () => {
  const { calls, client } = fixture();
  const adapter = createQueryAdapter(client, { keyPrefix: ["project", "tenant", "actor"] });
  const input = { params: { id: "before" } };
  const options = adapter.items.get.queryOptions(input, { tags: ["items"] });
  input.params.id = "after";
  expect(await options.queryFn({})).toEqual({ id: "before" });
  expect(calls).toHaveLength(1);
  expect(options.meta.tags).toEqual(["items"]);
  expect(createQueryKey("get", { b: 2, a: 1 }, ["tenant"]))
    .toEqual(createQueryKey("get", { a: 1, b: 2 }, ["tenant"]));
  expect(() => createQueryAdapter(client, { keyPrefix: [""] })).toThrow("identity");
});

test("writes require an explicit key and never inherit retries", async () => {
  const { calls, client } = fixture();
  const adapter = createQueryAdapter(client, { keyPrefix: ["tenant"] });
  const options = adapter.items.save.mutationOptions();
  expect(options.retry).toBe(false);
  // @ts-expect-error A required execution key cannot be omitted.
  await expect(options.mutationFn({ input: { body: { id: "1" } } })).rejects.toThrow("idempotencyKey");
  expect(calls).toHaveLength(0);
  expect(await options.mutationFn({ input: { body: { id: "1" } }, execution: { idempotencyKey: "attempt-1" } }))
    .toEqual({ id: "1" });
});

test("tag invalidation is scoped and still runs with a custom onSuccess", async () => {
  const { client } = fixture();
  const cache = new QueryClient();
  const a = createQueryAdapter(client, { keyPrefix: ["a"], queryClient: cache });
  const b = createQueryAdapter(client, { keyPrefix: ["b"], queryClient: cache });
  const input = { params: { id: "1" } };
  await cache.fetchQuery(a.items.get.queryOptions(input, { tags: ["items"] }));
  await cache.fetchQuery(b.items.get.queryOptions(input, { tags: ["items"] }));
  let notified = false;
  const mutation = a.items.save.mutationOptions({
    invalidateTags: ["items"], onSuccess: () => { notified = true; },
  });
  const variables = { input: { body: { id: "1" } }, execution: { idempotencyKey: "attempt-1" } };
  const result = await mutation.mutationFn(variables);
  await mutation.onSuccess(result, variables, undefined);
  expect(notified).toBe(true);
  expect(cache.getQueryState(a.items.get.queryKey(input))?.isInvalidated).toBe(true);
  expect(cache.getQueryState(b.items.get.queryKey(input))?.isInvalidated).toBe(false);
  cache.clear();
});

test("generated metadata supplies query tags and mutation invalidation defaults", async () => {
  const { client } = fixture();
  const cache = new QueryClient();
  const adapter = createQueryAdapter(client, { keyPrefix: ["tenant"], queryClient: cache });
  const query = adapter.items.get.queryOptions({ params: { id: "1" } });
  expect(query.meta.tags).toEqual(["items"]);
  await cache.fetchQuery(query);
  const mutation = adapter.items.save.mutationOptions();
  const variables = { input: { body: { id: "1" } }, execution: { idempotencyKey: "attempt-default" } };
  const result = await mutation.mutationFn(variables);
  await mutation.onSuccess(result, variables, undefined);
  expect(cache.getQueryState(query.queryKey)?.isInvalidated).toBe(true);
  cache.clear();
});

test("abort prevents dispatch", async () => {
  const { calls, client } = fixture();
  const adapter = createQueryAdapter(client, { keyPrefix: ["tenant"] });
  const controller = new AbortController();
  controller.abort();
  await expect(adapter.items.get.queryOptions({ params: { id: "1" } })
    .queryFn({ signal: controller.signal })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("every consumer decodes cached raw data without sharing its decoded type", async () => {
  const cache = queryCache();
  let calls = 0;
  let decoded = 0;
  const options = readOptions(async () => { calls++; return { id: "item-1" }; });
  const first = await fetchQueryResult(cache, options, {
    staleTime: Infinity,
    decode: value => { decoded++; return value.id; },
  });
  const second = await fetchQueryResult(cache, options, {
    staleTime: Infinity,
    decode: value => { decoded++; return value.id.length; },
  });
  expectTypeOf(first).toEqualTypeOf<string>();
  expectTypeOf(second).toEqualTypeOf<number>();
  expect(first).toBe("item-1");
  expect(second).toBe(6);
  expect(calls).toBe(1);
  expect(decoded).toBe(2);
  expect(cache.getQueryData(options.queryKey)).toEqual({ id: "item-1" });
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0);
});

test("a narrower decoder cannot evict or poison another consumer's raw cache", async () => {
  const cache = queryCache();
  let calls = 0;
  const options = readOptions(async () => { calls++; return { id: "item-1" }; });
  const failure = new Error("Missing domain fields");
  await expect(fetchQueryResult(cache, options, {
    decode: () => { throw failure; }, staleTime: Infinity,
  })).rejects.toBe(failure);
  await expect(fetchQueryResult(cache, options, {
    decode: value => value.id, staleTime: Infinity,
  })).resolves.toBe("item-1");
  expect(calls).toBe(1);
  expect(cache.getQueryData(options.queryKey)).toEqual({ id: "item-1" });
});

test("concurrent consumers share transport but independently decode results", async () => {
  const cache = queryCache();
  const pending = deferred<{ id: string }>();
  let calls = 0;
  const options = readOptions(async () => { calls++; return pending.promise; });
  const first = fetchQueryResult(cache, options, { decode: value => value.id });
  const second = fetchQueryResult(cache, options, { decode: value => value.id.length });
  pending.resolve({ id: "item-1" });
  expect(await first).toBe("item-1");
  expect(await second).toBe(6);
  expect(calls).toBe(1);
});

test("pre-aborted consumers neither dispatch nor decode", async () => {
  const cache = queryCache();
  const controller = new AbortController();
  const reason = new DOMException("Target changed", "AbortError");
  controller.abort(reason);
  let calls = 0;
  let decoded = false;
  const options = readOptions(async () => { calls++; return "value"; });
  await expect(fetchQueryResult(cache, options, {
    signal: controller.signal, decode: value => { decoded = true; return value; },
  })).rejects.toBe(reason);
  expect(calls).toBe(0);
  expect(decoded).toBe(false);
  expect(cache.getQueryCache().getAll()).toHaveLength(0);
});

test("cancelling one consumer preserves the other consumer and transport", async () => {
  const cache = queryCache();
  const pending = deferred<{ id: string }>();
  const started = deferred<void>();
  const controller = new AbortController();
  let transportSignal: AbortSignal | undefined;
  let decoded = false;
  let calls = 0;
  const options = readOptions(async signal => {
    calls++;
    transportSignal = signal;
    started.resolve();
    return pending.promise;
  });
  const first = fetchQueryResult(cache, options, {
    signal: controller.signal, decode: value => { decoded = true; return value.id; },
  });
  const second = fetchQueryResult(cache, options, { decode: value => value.id });
  const rejected = first.catch((cause: unknown) => cause);
  await started.promise;
  controller.abort();
  expect(await rejected).toHaveProperty("name", "AbortError");
  expect(transportSignal?.aborted).toBe(false);
  pending.resolve({ id: "item-1" });
  expect(await second).toBe("item-1");
  expect(decoded).toBe(false);
  expect(calls).toBe(1);
});

test("the last cancelled consumer aborts transport and discards its late response", async () => {
  const cache = queryCache();
  const pending = deferred<string>();
  const started = deferred<void>();
  const controller = new AbortController();
  let transportSignal: AbortSignal | undefined;
  let decoded = false;
  const options = readOptions(async signal => {
    transportSignal = signal;
    started.resolve();
    return pending.promise;
  });
  const result = fetchQueryResult(cache, options, {
    signal: controller.signal, decode: value => { decoded = true; return value; },
  });
  const rejected = result.catch((cause: unknown) => cause);
  await started.promise;
  controller.abort();
  expect(await rejected).toHaveProperty("name", "AbortError");
  expect(transportSignal?.aborted).toBe(true);
  pending.resolve("obsolete");
  await Bun.sleep(0);
  expect(decoded).toBe(false);
  expect(cache.getQueryData(options.queryKey)).toBeUndefined();
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0);
});

test("a mounted native query observer retains transport ownership", async () => {
  const cache = queryCache();
  const pending = deferred<string>();
  const started = deferred<void>();
  const controller = new AbortController();
  let transportSignal: AbortSignal | undefined;
  const options = readOptions(async signal => {
    transportSignal = signal;
    started.resolve();
    return pending.promise;
  });
  const observer = new QueryObserver(cache, options);
  const observed = deferred<string>();
  const unsubscribe = observer.subscribe(result => {
    if (result.isSuccess) observed.resolve(result.data);
  });
  try {
    const result = fetchQueryResult(cache, options, { signal: controller.signal, decode: value => value });
    const rejected = result.catch((cause: unknown) => cause);
    await started.promise;
    controller.abort();
    expect(await rejected).toHaveProperty("name", "AbortError");
    expect(transportSignal?.aborted).toBe(false);
    pending.resolve("mounted");
    expect(await observed.promise).toBe("mounted");
    expect(cache.getQueryData(options.queryKey)).toBe("mounted");
  } finally {
    unsubscribe();
  }
});

test("explicit refresh supersedes an old fetch without touching another identity", async () => {
  const cache = queryCache();
  const pending = deferred<string>();
  const started = deferred<void>();
  let calls = 0;
  const options = readOptions(async () => {
    calls++;
    if (calls === 1) { started.resolve(); return pending.promise; }
    return "fresh";
  });
  const other = readOptions(async () => "other", "other-tenant");
  await fetchQueryResult(cache, other, { decode: value => value, staleTime: Infinity });
  const obsolete = fetchQueryResult(cache, options, { decode: value => value });
  const rejected = obsolete.catch((cause: unknown) => cause);
  await started.promise;
  expect(await fetchQueryResult(cache, options, {
    refresh: true, staleTime: Infinity, decode: value => value,
  })).toBe("fresh");
  expect(await rejected).toHaveProperty("name", "AbortError");
  pending.resolve("obsolete");
  await Bun.sleep(0);
  expect(calls).toBe(2);
  expect(cache.getQueryData(options.queryKey)).toBe("fresh");
  expect(cache.getQueryData(other.queryKey)).toBe("other");
  expect(cache.getQueryState(other.queryKey)?.isInvalidated).toBe(false);
});

test("refresh bypasses a fresh cache while retaining prior data on failure", async () => {
  const cache = queryCache();
  let calls = 0;
  const failure = new Error("Transport unavailable");
  const options = readOptions(async () => {
    calls++;
    if (calls === 1) return "previous";
    throw failure;
  });
  await fetchQueryResult(cache, options, { decode: value => value, staleTime: Infinity });
  await expect(fetchQueryResult(cache, options, {
    refresh: true, decode: value => value, staleTime: Infinity,
  })).rejects.toBe(failure);
  expect(calls).toBe(2);
  expect(cache.getQueryData(options.queryKey)).toBe("previous");
  expect(cache.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
});

test("sensitive reads bypass both cache reads and writes and are not deduplicated", async () => {
  const cache = queryCache();
  let calls = 0;
  const options = readOptions(async () => `secret-${++calls}`);
  cache.setQueryData(options.queryKey, "public");
  const results = await Promise.all([
    fetchQueryResult(cache, options, { cache: "none", decode: value => value }),
    fetchQueryResult(cache, options, { cache: "none", decode: value => value }),
  ]);
  expect(results).toEqual(["secret-1", "secret-2"]);
  expect(cache.getQueryData(options.queryKey)).toBe("public");
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0);
});

test("uncached reads cancel promptly even if the transport ignores cancellation", async () => {
  const cache = queryCache();
  const pending = deferred<string>();
  const started = deferred<void>();
  const controller = new AbortController();
  let decoded = false;
  const options = readOptions(async () => { started.resolve(); return pending.promise; });
  const result = fetchQueryResult(cache, options, {
    cache: "none", signal: controller.signal, decode: value => { decoded = true; return value; },
  });
  const rejected = result.catch((cause: unknown) => cause);
  await started.promise;
  controller.abort();
  expect(await rejected).toHaveProperty("name", "AbortError");
  pending.resolve("secret");
  await Bun.sleep(0);
  expect(decoded).toBe(false);
  expect(cache.getQueryCache().getAll()).toHaveLength(0);
});

test("read failures preserve their identity and do not inherit retries", async () => {
  const cache = queryCache();
  const failure = new Error("Forbidden");
  let calls = 0;
  const options = readOptions(async () => { calls++; throw failure; });
  await expect(fetchQueryResult(cache, options, { decode: value => value })).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0);
});

test("cancellation during decoding cannot return a success", async () => {
  const cache = queryCache();
  const controller = new AbortController();
  const options = readOptions(async () => "raw");
  await expect(fetchQueryResult(cache, options, {
    signal: controller.signal,
    decode: value => { controller.abort(); return value; },
  })).rejects.toHaveProperty("name", "AbortError");
});

test("cancellation during an asynchronous decoder cannot return a late success", async () => {
  const cache = queryCache();
  const controller = new AbortController();
  const pending = deferred<string>();
  const started = deferred<void>();
  const options = readOptions(async () => "raw");
  const result = fetchQueryResult(cache, options, {
    signal: controller.signal,
    decode: async () => { started.resolve(); return pending.promise; },
  });
  expectTypeOf(result).toEqualTypeOf<Promise<string>>();
  const rejected = result.catch((cause: unknown) => cause);
  await started.promise;
  controller.abort();
  expect(await rejected).toHaveProperty("name", "AbortError");
  pending.resolve("obsolete");
  await Bun.sleep(0);
  expect(cache.getQueryData(options.queryKey)).toBe("raw");
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0);
});

test("an asynchronous decoder failure remains local and releases its observer", async () => {
  const cache = queryCache();
  const failure = new Error("Domain validation failed");
  const options = readOptions(async () => "raw");
  await expect(fetchQueryResult(cache, options, {
    decode: async () => { throw failure; },
  })).rejects.toBe(failure);
  expect(cache.getQueryData(options.queryKey)).toBe("raw");
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0);
});

test("cancellation during refresh does not start a replacement request", async () => {
  const cache = queryCache();
  let calls = 0;
  const options = readOptions(async () => { calls++; return "value"; });
  await fetchQueryResult(cache, options, { decode: value => value });
  const controller = new AbortController();
  const result = fetchQueryResult(cache, options, {
    refresh: true, signal: controller.signal, decode: value => value,
  });
  const rejected = result.catch((cause: unknown) => cause);
  controller.abort();
  expect(await rejected).toHaveProperty("name", "AbortError");
  await Bun.sleep(0);
  expect(calls).toBe(1);
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(0);
});

test("a cancelled cached consumer does not decode or discard shared data", async () => {
  const cache = queryCache();
  const options = readOptions(async () => "raw");
  await fetchQueryResult(cache, options, { decode: value => value, staleTime: Infinity });
  const controller = new AbortController();
  let decoded = false;
  const result = fetchQueryResult(cache, options, {
    staleTime: Infinity, signal: controller.signal,
    decode: value => { decoded = true; return value; },
  });
  const rejected = result.catch((cause: unknown) => cause);
  controller.abort();
  expect(await rejected).toHaveProperty("name", "AbortError");
  expect(decoded).toBe(false);
  expect(cache.getQueryData(options.queryKey)).toBe("raw");
});

// Checked by the package-local compiler test below, never executed.
function queryResultTypeContracts() {
  const cache = new QueryClient();
  const { client } = fixture();
  const adapter = createQueryAdapter(client, { keyPrefix: ["tenant"] });
  const query = adapter.items.get.queryOptions({ params: { id: "1" } });
  const result = fetchQueryResult(cache, query, { decode: value => value.id.length });
  expectTypeOf(result).toEqualTypeOf<Promise<number>>();
  // @ts-expect-error The result is inferred from the decoder, not a caller's wish.
  const invented: Promise<string> = result;
  // @ts-expect-error A runtime decoder is mandatory even for a typed query.
  fetchQueryResult(cache, query, {});
  // @ts-expect-error A decoder cannot assume fields absent from the query result.
  fetchQueryResult(cache, query, { decode: (value: { missing: string }) => value.missing });
  // @ts-expect-error A decoder must accept every possible id, not just one literal.
  fetchQueryResult(cache, query, { decode: (value: { id: "only-this-id" }) => value.id });
  // @ts-expect-error Mutation options are not reads.
  fetchQueryResult(cache, adapter.items.save.mutationOptions(), { decode: value => value });
  void invented;
}
void queryResultTypeContracts;

test("query consumer public types reject unsafe call sites", async () => {
  const process = Bun.spawn([
    "./node_modules/.bin/tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
    "--target", "ESNext", "--module", "ESNext", "--moduleResolution", "Bundler",
    "--types", "bun", "test/query-adapter.test.ts",
  ], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect({ exitCode, diagnostics: stdout + stderr }).toEqual({ exitCode: 0, diagnostics: "" });
}, 30_000);
