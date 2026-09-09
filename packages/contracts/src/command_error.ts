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

export type CommandAuthorization = "allow" | "deny";
