import type { CommandErrorCode } from "@supacloud/contracts";

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
