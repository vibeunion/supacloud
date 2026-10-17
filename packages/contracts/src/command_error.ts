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

// A nominal, versioned marker survives duplicate package copies and ESM/CJS
// entrypoints. Do not infer protocol errors from an arbitrary object's name/code.
const commandErrorBrand = Symbol.for("@supacloud/contracts/CommandError/v1");
const commandErrorCodes: ReadonlySet<string> = new Set([
  "COMMAND_INPUT_INVALID", "COMMAND_REJECTED", "COMMAND_UNAVAILABLE",
  "COMMAND_IDEMPOTENCY_CONFLICT", "COMMAND_RECEIPT_INVALID",
  "COMMAND_OUTCOME_UNKNOWN", "COMMAND_INPUT_EXPIRED",
]);

/** Protocol-level errors carry no input, tokens, SQL or adapter-specific causes. */
export class CommandError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    // Keep ordinary subclass instanceof semantics, rather than making every
    // CommandError an instance of every subclass.
    try {
      if (this !== CommandError) return Function.prototype[Symbol.hasInstance].call(this, value);
      if (!(value instanceof Error)) return false;
      const brand = Object.getOwnPropertyDescriptor(value, commandErrorBrand);
      const code = Object.getOwnPropertyDescriptor(value, "code");
      return brand?.value === true && typeof code?.value === "string" && commandErrorCodes.has(code.value);
    } catch {
      // Revoked/hostile proxies are not trusted protocol instances.
      return false;
    }
  }

  get metadata(): ErrorMetadata { return commandFailureMetadata(this.code); }

  constructor(readonly code: CommandErrorCode) {
    super(code);
    this.name = "CommandError";
    Object.defineProperty(this, commandErrorBrand, { value: true });
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
