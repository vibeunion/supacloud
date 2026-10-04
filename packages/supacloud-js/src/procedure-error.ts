export type SupaCloudProcedureErrorCode =
  | "API_HTTP_ERROR"
  | "API_RESPONSE_INVALID"
  | "API_RESPONSE_UNDECLARED"
  | "SUPACLOUD_EXECUTION_ERROR"
  | "SUPACLOUD_FUNCTIONS_ERROR"
  | "SUPACLOUD_TRANSPORT_ERROR"
  | "SUPACLOUD_CLIENT_ERROR";

export interface SupaCloudProcedureErrorOptions {
  code: string;
  status?: number | null;
  requestId?: string | null;
  details?: unknown;
  response?: Response | undefined;
  cause?: unknown;
}

/** Internal validation shared by error construction and response inspection. */
export function procedureErrorIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined;
}

/** Failure metadata is not proof that a server-side mutation rolled back. */
export class SupaCloudProcedureError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly details: unknown;
  readonly response: Response | undefined;
  readonly cause: unknown;

  constructor(message: string, options: SupaCloudProcedureErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SupaCloudProcedureError";
    this.code = options.code;
    this.status = options.status ?? null;
    this.requestId = procedureErrorIdentifier(options.requestId) ?? null;
    this.details = options.details;
    this.response = options.response;
    this.cause = options.cause;
    Object.defineProperty(this, "response", { enumerable: false });
    Object.defineProperty(this, "cause", { enumerable: false });
    Object.defineProperty(this, "details", { enumerable: false });
  }
}
