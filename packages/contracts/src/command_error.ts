import type { AppError } from "./app_error.js";

export type CommandErrorCode =
  | "COMMAND_INPUT_INVALID" | "COMMAND_REJECTED" | "COMMAND_UNAVAILABLE"
  | "COMMAND_IDEMPOTENCY_CONFLICT" | "COMMAND_RECEIPT_INVALID"
  | "COMMAND_OUTCOME_UNKNOWN" | "COMMAND_INPUT_EXPIRED";

/** Protocol-level errors carry no input, tokens, SQL or adapter-specific causes. */
export class CommandError extends Error {
  constructor(readonly code: CommandErrorCode) {
    super(code);
    this.name = "CommandError";
  }
}

export function commandErrorToAppError(error: CommandError): AppError {
  switch (error.code) {
    case "COMMAND_INPUT_INVALID":
    case "COMMAND_INPUT_EXPIRED":
      return {
        kind: "validation",
        issues: [{ path: [], message: error.code }],
      };
    case "COMMAND_REJECTED":
      return { kind: "forbidden", permission: "command:execute" };
    case "COMMAND_IDEMPOTENCY_CONFLICT":
      return { kind: "conflict", code: error.code };
    case "COMMAND_UNAVAILABLE":
      return { kind: "dependency", service: "command-store" };
    case "COMMAND_RECEIPT_INVALID":
      return { kind: "conflict", code: error.code };
    case "COMMAND_OUTCOME_UNKNOWN":
      return { kind: "unknown", operation: "command-execution" };
  }
}

export type CommandAuthorization = "allow" | "deny";
