import { describe, expect, test } from "bun:test";
import { CommandError, commandErrorToAppError, commandFailureMetadata } from "./index.js";

describe("command error mapping", () => {
  test("maps command failures to stable application errors", () => {
    expect(commandErrorToAppError(new CommandError("COMMAND_REJECTED"))).toEqual({
      kind: "forbidden",
      permission: "command:execute",
      metadata: {
        retryability: "never",
        idempotency: "required",
        deadlineAt: null,
        outcome: "confirmed-failure",
      },
    });
    expect(commandErrorToAppError(new CommandError("COMMAND_INPUT_INVALID"))).toEqual({
      kind: "validation",
      issues: [{ path: [], message: "COMMAND_INPUT_INVALID" }],
      metadata: {
        retryability: "never",
        idempotency: "not-required",
        deadlineAt: null,
        outcome: "confirmed-failure",
      },
    });
    expect(commandErrorToAppError(new CommandError("COMMAND_OUTCOME_UNKNOWN"))).toEqual({
      kind: "unknown",
      operation: "command-execution",
      metadata: {
        retryability: "read-only",
        idempotency: "required",
        deadlineAt: null,
        outcome: "unknown",
      },
    });
  });

  test("classifies unknown write failures as read-only confirmation", () => {
    expect(commandFailureMetadata("COMMAND_UNAVAILABLE")).toMatchObject({
      retryability: "read-only",
      outcome: "unknown",
    });
  });

  test("input retention expiry cannot disprove a previously dispatched command", () => {
    expect(commandFailureMetadata("COMMAND_INPUT_EXPIRED")).toEqual({
      retryability: "read-only", idempotency: "required", deadlineAt: null, outcome: "unknown",
    });
    expect(commandFailureMetadata("COMMAND_UNAVAILABLE")).not.toHaveProperty("deadline");
  });
});
