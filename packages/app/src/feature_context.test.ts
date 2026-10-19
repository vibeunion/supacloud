import { expect, test } from "bun:test";
import { requireFeatureOperationResult, requireFeatureRequestContext } from "./feature_context";

test("normalizes the trusted identity and tenant context", () => {
  const context = requireFeatureRequestContext({
    requestId: "request-1",
    identity: { authenticated: true, subject: "actor-1" },
    access: { tenantId: "tenant-1", permissions: ["case:approve", "case:approve"] },
    idempotencyKey: "operation-1",
  });
  expect(context).toEqual({
    requestId: "request-1",
    tenantId: "tenant-1",
    actorId: "actor-1",
    permissions: ["case:approve"],
    idempotencyKey: "operation-1",
  });
});

test("rejects missing or untrusted tenant context", () => {
  for (const value of [
    undefined,
    { requestId: "request-1", identity: { authenticated: false, subject: "actor-1" } },
    {
      requestId: "request-1",
      identity: { authenticated: true, subject: "actor-1" },
      access: { tenantId: "tenant-1", permissions: [""] },
    },
    {
      requestId: "request-1",
      identity: { authenticated: true, subject: "actor-1" },
      access: { tenantId: "tenant-1", permissions: ["case:approve"] },
      idempotencyKey: 42,
    },
  ]) {
    expect(() => requireFeatureRequestContext(value)).toThrow("FEATURE_CONTEXT_REQUIRED");
  }
});

test("rejects operation results that do not match the requested operation", () => {
  const input = { id: "case-1", operationId: "operation-1" };
  expect(requireFeatureOperationResult(input, { operationId: "operation-1", status: "completed" }))
    .toMatchObject({ operationId: "operation-1" });
  for (const value of [null, {}, { operationId: "operation-2" }]) {
    expect(() => requireFeatureOperationResult(input, value)).toThrow("FEATURE_OPERATION_RESULT_MISMATCH");
  }
});
