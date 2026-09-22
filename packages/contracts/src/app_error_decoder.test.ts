import { describe, expect, test } from "bun:test";
import { decodeAppError } from "./app_error.js";

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
});
