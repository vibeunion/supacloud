import { describe, expect, test } from "bun:test";
import { decodeAppError, decodeErrorMetadata } from "./app_error.js";

describe("app error decoder", () => {
  test("maps command and HTTP boundaries without trusting payload shape", () => {
    expect(decodeAppError({ code: "COMMAND_REJECTED" }, 400)).toEqual({
      kind: "forbidden",
      permission: "command:execute",
    });
    expect(decodeAppError({ message: "expired" }, 401)).toEqual({
      kind: "unauthorized",
      reason: "expired",
    });
    expect(decodeAppError("not-json", 503, "project-api")).toEqual({
      kind: "dependency",
      service: "project-api",
    });
  });

  test("accepts legacy envelopes and validates additive recovery metadata", () => {
    const metadata = { retryability: "read-only", idempotency: "required", deadlineAt: null, outcome: "unknown" } as const;
    expect(decodeAppError({ code: "COMMAND_OUTCOME_UNKNOWN", metadata }, 503)).toMatchObject({ metadata });
    expect(decodeErrorMetadata({ ...metadata, retryability: "same-key-only" })).toBeUndefined();
    expect(decodeErrorMetadata({ ...metadata, deadlineAt: NaN })).toBeUndefined();
    expect(decodeErrorMetadata({ ...metadata, deadlineAt: -1 })).toBeUndefined();
    expect(decodeErrorMetadata({ ...metadata, outcome: "success" })).toBeUndefined();
    expect(decodeErrorMetadata({ ...metadata, privateToken: "not-returned" })).toEqual(metadata);
  });
});
