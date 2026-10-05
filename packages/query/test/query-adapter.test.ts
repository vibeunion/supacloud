import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { createQueryAdapter, createQueryKey } from "../src/index.js";

function fixture() {
  const calls: unknown[] = [];
  const query = Object.assign(async (input: { params: { id: string } }, execution?: { signal?: AbortSignal }) => {
    calls.push({ input, execution });
    return { id: input.params.id };
  }, {
    __supacloudInput: undefined as { params: { id: string } } | undefined,
    __supacloudProcedure: { key: "Items.get", kind: "query" as const, method: "GET", path: "/items/:id", idempotency: "none" as const },
  });
  const mutate = Object.assign(async (input: { body: { id: string } }, execution: { idempotencyKey: string }) => {
    calls.push({ input, execution });
    return { id: input.body.id };
  }, {
    __supacloudInput: undefined as { body: { id: string } } | undefined,
    __supacloudProcedure: { key: "Items.save", kind: "mutation" as const, method: "POST", path: "/items", idempotency: "required" as const },
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

test("abort prevents dispatch", async () => {
  const { calls, client } = fixture();
  const adapter = createQueryAdapter(client, { keyPrefix: ["tenant"] });
  const controller = new AbortController();
  controller.abort();
  await expect(adapter.items.get.queryOptions({ params: { id: "1" } })
    .queryFn({ signal: controller.signal })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
