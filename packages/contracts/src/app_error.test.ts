import { describe, expect, test } from "bun:test";
import { CommandError, commandErrorToAppError } from "./index.js";

describe("command error mapping", () => {
  test("maps command failures to stable application errors", () => {
    expect(commandErrorToAppError(new CommandError("COMMAND_REJECTED"))).toEqual({
      kind: "forbidden",
      permission: "command:execute",
    });
    expect(commandErrorToAppError(new CommandError("COMMAND_INPUT_INVALID"))).toEqual({
      kind: "validation",
      issues: [{ path: [], message: "COMMAND_INPUT_INVALID" }],
    });
    expect(commandErrorToAppError(new CommandError("COMMAND_OUTCOME_UNKNOWN"))).toEqual({
      kind: "unknown",
      operation: "command-execution",
    });
  });
});
