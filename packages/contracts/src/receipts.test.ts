import { expect, test } from "bun:test";
import { canonicalCommandJson, decodeDurableCommandReceipt } from "./receipts";

test("canonical input keys reject non-JSON values and preserve object/array semantics", () => {
  expect(canonicalCommandJson({ b: 2, a: [1, null] })).toBe('{"a":[1,null],"b":2}');
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), circular, { absent: undefined }]) {
    expect(() => canonicalCommandJson(value)).toThrow();
  }
});

test("receipt decoding rejects impossible states and validates committed results", () => {
  const reference = { tenantId: "t", actorId: "a", command: "update.v1", operationId: "op", dispatchKey: "key" };
  const decode = (value: unknown) => {
    if (typeof value !== "boolean") throw new Error("Invalid result");
    return value;
  };
  expect(decodeDurableCommandReceipt({ ...reference, status: "confirmed", audit: "complete", result: true }, decode))
    .toMatchObject({ status: "confirmed", result: true });
  for (const value of [null, {}, { ...reference, status: "pending", audit: "complete" },
    { ...reference, status: "unknown", audit: "pending", result: true },
    { ...reference, status: "confirmed", audit: "pending", result: "true" }]) {
    expect(() => decodeDurableCommandReceipt(value, decode)).toThrow();
  }
});
