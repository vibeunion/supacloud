import type { CommandErrorCode } from "@supacloud/contracts";

export function commandErrorCode(error: unknown): CommandErrorCode | undefined {
  // Installed adapters may load separate copies of the protocol package.
  // Accept only named Error instances with an allowlisted protocol code.
  if (!(error instanceof Error) || error.name !== "CommandError" || !("code" in error)) return undefined;
  switch (error.code) {
    case "COMMAND_INPUT_INVALID":
    case "COMMAND_REJECTED":
    case "COMMAND_IDEMPOTENCY_CONFLICT":
    case "COMMAND_INPUT_EXPIRED":
    case "COMMAND_UNAVAILABLE":
    case "COMMAND_RECEIPT_INVALID":
    case "COMMAND_OUTCOME_UNKNOWN":
      return error.code;
    default: return undefined;
  }
}

export function commandErrorStatus(code: CommandErrorCode): number {
  switch (code) {
    case "COMMAND_INPUT_INVALID": return 400;
    case "COMMAND_REJECTED": return 403;
    case "COMMAND_IDEMPOTENCY_CONFLICT": return 409;
    case "COMMAND_INPUT_EXPIRED": return 410;
    case "COMMAND_UNAVAILABLE":
    case "COMMAND_RECEIPT_INVALID":
    case "COMMAND_OUTCOME_UNKNOWN": return 503;
  }
}
