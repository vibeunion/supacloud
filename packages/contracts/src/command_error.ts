import type { AppError, ErrorMetadata } from "./app_error.js";

export type CommandErrorCode =
  | "COMMAND_INPUT_INVALID" | "COMMAND_REJECTED" | "COMMAND_UNAVAILABLE"
  | "COMMAND_IDEMPOTENCY_CONFLICT" | "COMMAND_RECEIPT_INVALID"
  | "COMMAND_OUTCOME_UNKNOWN" | "COMMAND_INPUT_EXPIRED";

export function commandFailureMetadata(code: CommandErrorCode): ErrorMetadata {
  switch (code) {
    case "COMMAND_INPUT_INVALID":
      return { retryability: "never", idempotency: "not-required", deadlineAt: null, outcome: "confirmed-failure" };
    case "COMMAND_REJECTED":
      return { retryability: "never", idempotency: "required", deadlineAt: null, outcome: "confirmed-failure" };
    case "COMMAND_IDEMPOTENCY_CONFLICT":
      return { retryability: "never", idempotency: "conflict", deadlineAt: null, outcome: "confirmed-failure" };
    case "COMMAND_INPUT_EXPIRED":
    case "COMMAND_RECEIPT_INVALID":
    case "COMMAND_UNAVAILABLE":
    case "COMMAND_OUTCOME_UNKNOWN":
      // Input retention can expire after dispatch. None of these errors proves rollback.
      return { retryability: "read-only", idempotency: "required", deadlineAt: null, outcome: "unknown" };
  }
}

/** Protocol-level errors carry no input, tokens, SQL or adapter-specific causes. */
export class CommandError extends Error {
  get metadata(): ErrorMetadata { return commandFailureMetadata(this.code); }

  constructor(readonly code: CommandErrorCode) {
    super(code);
    this.name = "CommandError";
  }
}

export function commandErrorToAppError(error: CommandError): AppError {
  const metadata = commandFailureMetadata(error.code);
  switch (error.code) {
    case "COMMAND_INPUT_INVALID":
    case "COMMAND_INPUT_EXPIRED":
      return {
        kind: "validation",
        issues: [{ path: [], message: error.code }],
        metadata,
      };
    case "COMMAND_REJECTED":
      return { kind: "forbidden", permission: "command:execute", metadata };
    case "COMMAND_IDEMPOTENCY_CONFLICT":
      return { kind: "conflict", code: error.code, metadata };
    case "COMMAND_UNAVAILABLE":
      return { kind: "dependency", service: "command-store", metadata };
    case "COMMAND_RECEIPT_INVALID":
      return { kind: "conflict", code: error.code, metadata };
    case "COMMAND_OUTCOME_UNKNOWN":
      return { kind: "unknown", operation: "command-execution", metadata };
  }
}

export type CommandAuthorization = "allow" | "deny";
