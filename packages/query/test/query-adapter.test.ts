import { describe, expect, test } from "bun:test";
import { createQueryAdapter, createQueryKey, invalidateByTags } from "../src";

describe("@supacloud/query", () => {
  test("createQueryKey creates deterministic sorted keys", () => {
    const key1 = createQueryKey("items.get", { id: 1, filter: "active" });
    const key2 = createQueryKey("items.get", { filter: "active", id: 1 });
    expect(key1).toEqual(key2);
    expect(key1).toEqual(["items.get", { filter: "active", id: 1 }]);

    const keyWithPrefix = createQueryKey("items.get", { id: 1 }, ["my-app"]);
    expect(keyWithPrefix).toEqual(["my-app", "items.get", { id: 1 }]);
  });

  test("createQueryAdapter produces queryOptions and mutationOptions", async () => {
    let queriedInput: unknown;
    let mutatedInput: unknown;
    let mutatedOptions: unknown;

    const mockClient = {
      procedures: {
        items: {
          get: {
            operationId: "items.get",
            kind: "query" as const,
            tags: ["items"],
            query: async (input: unknown) => {
              queriedInput = input;
              return { id: 1, name: "item1" };
            },
          },
          create: {
            operationId: "items.create",
            kind: "command" as const,
            tags: ["items"],
            mutate: async (input: unknown, options: unknown) => {
              mutatedInput = input;
              mutatedOptions = options;
              return { id: 2, name: "created" };
            },
          },
        },
      },
    };

    const adapter = createQueryAdapter(mockClient);

    // Test queryOptions
    const qOptions = adapter.items.get.queryOptions({ id: 1 });
    expect(qOptions.queryKey).toEqual(["items.get", { id: 1 }]);
    expect(qOptions.meta?.tags).toEqual(["items"]);

    const queryResult = await qOptions.queryFn({});
    expect(queryResult).toEqual({ id: 1, name: "item1" });
    expect(queriedInput).toEqual({ id: 1 });

    // Test mutationOptions
    const mOptions = adapter.items.create.mutationOptions();
    expect(mOptions.mutationKey).toEqual(["items.create"]);
    expect(mOptions.meta?.tags).toEqual(["items"]);

    const mutateResult = await mOptions.mutationFn({ input: { name: "new" }, options: { idempotencyKey: "k1" } });
    expect(mutateResult).toEqual({ id: 2, name: "created" });
    expect(mutatedInput).toEqual({ name: "new" });
    expect(mutatedOptions).toEqual({ idempotencyKey: "k1" });
  });

  test("explicit tag-based invalidation invalidates matching query tags", async () => {
    const invalidatedPredicates: Array<(query: any) => boolean> = [];
    const mockQueryClient = {
      invalidateQueries: async ({ predicate }: any) => {
        invalidatedPredicates.push(predicate);
      },
    };

    await invalidateByTags(mockQueryClient, ["items", "orders"]);
    expect(invalidatedPredicates.length).toBe(1);

    const predicate = invalidatedPredicates[0]!;
    expect(predicate({ queryKey: ["a"], meta: { tags: ["items"] } })).toBe(true);
    expect(predicate({ queryKey: ["b"], meta: { tags: ["users"] } })).toBe(false);
    expect(predicate({ queryKey: ["c"], meta: { tags: ["orders", "reports"] } })).toBe(true);
    expect(predicate({ queryKey: ["d"], meta: {} })).toBe(false);
  });
});
