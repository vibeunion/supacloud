import { expect, test } from "bun:test";
import {
  FeatureContextError, FeatureOperationError, FeatureTransitionError, FeatureVersionError,
  requireFeatureOperationResult, requireFeatureRequestContext, requireFeatureTransitionResult,
} from "./feature_context";

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
    expect(() => requireFeatureRequestContext(value)).toThrow(FeatureContextError);
    expect(() => requireFeatureRequestContext(value)).toThrow("FEATURE_CONTEXT_REQUIRED");
  }
});

test("rejects operation results that do not match the requested operation", () => {
  const input = { id: "case-1", operationId: "operation-1" };
  expect(requireFeatureOperationResult(input, { id: "case-1", operationId: "operation-1", status: "completed" }))
    .toMatchObject({ id: "case-1", operationId: "operation-1" });
  for (const value of [null, {}, { id: "case-1", operationId: "operation-2" }, { id: "case-2", operationId: "operation-1" }]) {
    expect(() => requireFeatureOperationResult(input, value)).toThrow(FeatureOperationError);
    expect(() => requireFeatureOperationResult(input, value)).toThrow("FEATURE_OPERATION_RESULT_MISMATCH");
  }
});

test("requires a committed transition result to advance state and version", () => {
  expect(requireFeatureTransitionResult("approved", 1, {
    id: "case-1", state: "approved", version: 2,
  })).toMatchObject({ state: "approved", version: 2 });
  expect(() => requireFeatureTransitionResult("approved", 1, {
    state: "draft", version: 2,
  })).toThrow(FeatureTransitionError);
  expect(() => requireFeatureTransitionResult("approved", 1, {
    state: "approved", version: 1,
  })).toThrow(FeatureVersionError);
});
