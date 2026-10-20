import { expect, test } from "bun:test";
import { createFeatureSliceCommandClient } from "./feature_slice_client";

function storageFixture() {
  const values = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    values,
  };
}

const decode = (value: unknown): { id: string } => {
  if (value === null || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
    throw new TypeError("invalid");
  }
  return { id: value.id };
};

const contract = {
  input: decode,
  acknowledgement: decode,
  authority: decode,
  matches: (input: { id: string }, authority: { id: string }) => input.id === authority.id,
};

test("Feature Slice client composes one write and read-only recovery with explicit tags", async () => {
  const fixture = storageFixture();
  let sends = 0;
  let lookups = 0;
  const client = createFeatureSliceCommandClient(contract, {
    send: async (input) => { sends++; return input; },
    lookup: async (input) => { lookups++; return input; },
  }, {
    storage: fixture.storage,
    key: "tenant:actor:feature:entity",
    unknownError: () => new Error("unknown"),
    confirmation: "response",
    invalidateTags: ["approval.list", "approval.detail"],
  });

  expect(await client.execute({ id: "approval-1" })).toEqual({ id: "approval-1" });
  expect(await client.recover()).toBeNull();
  expect(client.invalidateTags).toEqual(["approval.list", "approval.detail"]);
  expect([sends, lookups, fixture.values.size]).toEqual([1, 0, 0]);
});

test("Feature Slice recovery keeps the original pending input and never sends", async () => {
  const fixture = storageFixture();
  fixture.storage.setItem("tenant:actor:feature:entity", JSON.stringify({ id: "approval-1" }));
  let sends = 0;
  let lookups = 0;
  const client = createFeatureSliceCommandClient(contract, {
    send: async (input) => { sends++; return input; },
    lookup: async (input) => { lookups++; return input; },
  }, {
    storage: fixture.storage,
    key: "tenant:actor:feature:entity",
    unknownError: () => new Error("unknown"),
  });
  expect(await client.recover()).toEqual({
    input: { id: "approval-1" },
    authority: { id: "approval-1" },
  });
  expect([sends, lookups, fixture.values.size]).toEqual([0, 1, 0]);
});
