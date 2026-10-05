export type SupaCloudProcedureErrorCode =
  | "API_HTTP_ERROR"
  | "API_RESPONSE_INVALID"
  | "API_RESPONSE_UNDECLARED"
  | "SUPACLOUD_EXECUTION_ERROR"
  | "SUPACLOUD_FUNCTIONS_ERROR"
  | "SUPACLOUD_TRANSPORT_ERROR"
  | "SUPACLOUD_CLIENT_ERROR";

const procedureErrorCodes: ReadonlySet<string> = new Set<SupaCloudProcedureErrorCode>([
  "API_HTTP_ERROR",
  "API_RESPONSE_INVALID",
  "API_RESPONSE_UNDECLARED",
  "SUPACLOUD_EXECUTION_ERROR",
  "SUPACLOUD_FUNCTIONS_ERROR",
  "SUPACLOUD_TRANSPORT_ERROR",
  "SUPACLOUD_CLIENT_ERROR",
]);

export function isSupaCloudProcedureErrorCode(value: unknown): value is SupaCloudProcedureErrorCode {
  return typeof value === "string" && procedureErrorCodes.has(value);
}

export interface SupaCloudProcedureErrorOptions {
  code: SupaCloudProcedureErrorCode;
  status?: number | null;
  requestId?: string | null;
  upstreamCode?: string | null;
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
  readonly code: SupaCloudProcedureErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly upstreamCode: string | null;
  readonly details: unknown;
  readonly response: Response | undefined;
  readonly cause: unknown;

  constructor(message: string, options: SupaCloudProcedureErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SupaCloudProcedureError";
    this.code = options.code;
    this.status = options.status ?? null;
    this.requestId = procedureErrorIdentifier(options.requestId) ?? null;
    this.upstreamCode = procedureErrorIdentifier(options.upstreamCode) ?? null;
    this.details = options.details;
    this.response = options.response;
    this.cause = options.cause;
    Object.defineProperty(this, "response", { enumerable: false });
    Object.defineProperty(this, "cause", { enumerable: false });
    Object.defineProperty(this, "upstreamCode", { enumerable: false });
    Object.defineProperty(this, "details", { enumerable: false });
  }
}

/** Recognizes errors from separately bundled SDK entrypoints. */
export function isSupaCloudProcedureError(value: unknown): value is SupaCloudProcedureError {
  return value instanceof Error
    && value.name === "SupaCloudProcedureError"
    && "code" in value && isSupaCloudProcedureErrorCode(value.code)
    && "status" in value
    && (value.status === null || (typeof value.status === "number"
      && Number.isInteger(value.status) && value.status >= 0 && value.status <= 599))
    && "requestId" in value
    && (value.requestId === null || procedureErrorIdentifier(value.requestId) !== undefined)
    && "upstreamCode" in value
    && (value.upstreamCode === null || procedureErrorIdentifier(value.upstreamCode) !== undefined)
    && "response" in value
    && (value.response === undefined || value.response instanceof Response)
    && "details" in value
    && "cause" in value;
}

export function isSupaCloudProcedureHttpError(
  value: unknown,
): value is SupaCloudProcedureError & { status: number; response: Response } {
  return isSupaCloudProcedureError(value)
    && typeof value.status === "number"
    && value.response instanceof Response;
}

export function isSupaCloudProcedureTransportError(
  value: unknown,
): value is SupaCloudProcedureError & {
  code: "SUPACLOUD_FUNCTIONS_ERROR" | "SUPACLOUD_TRANSPORT_ERROR";
} {
  return isSupaCloudProcedureError(value)
    && (value.code === "SUPACLOUD_FUNCTIONS_ERROR" || value.code === "SUPACLOUD_TRANSPORT_ERROR");
}
