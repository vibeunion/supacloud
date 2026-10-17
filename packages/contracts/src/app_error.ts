export type ValidationIssue = {
  readonly path: readonly (string | number)[];
  readonly message: string;
};

export type ErrorMetadata = {
  readonly retryability: "never" | "same-key-only" | "read-only";
  readonly idempotency: "not-required" | "required" | "conflict";
  readonly deadlineAt: number | null;
  readonly outcome: "confirmed-failure" | "unknown";
};

export type AppError =
  | { readonly kind: "validation"; readonly issues: readonly ValidationIssue[]; readonly metadata?: ErrorMetadata }
  | { readonly kind: "unauthorized"; readonly reason?: string }
  | { readonly kind: "forbidden"; readonly permission: string; readonly metadata?: ErrorMetadata }
  | { readonly kind: "not_found"; readonly resource: string }
  | { readonly kind: "conflict"; readonly code: string; readonly metadata?: ErrorMetadata }
  | { readonly kind: "dependency"; readonly service: string; readonly metadata?: ErrorMetadata }
  | { readonly kind: "unknown"; readonly operation: string; readonly metadata?: ErrorMetadata };

export function decodeErrorMetadata(value: unknown): ErrorMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const { retryability, idempotency, deadlineAt, outcome } = candidate;
  if ((retryability !== "never" && retryability !== "same-key-only" && retryability !== "read-only")
    || (idempotency !== "not-required" && idempotency !== "required" && idempotency !== "conflict")
    || (deadlineAt !== null && (typeof deadlineAt !== "number" || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0))
    || (outcome !== "confirmed-failure" && outcome !== "unknown")
    || (retryability === "same-key-only" && (outcome === "unknown" || idempotency !== "required"))) return undefined;
  return {
    retryability, idempotency, deadlineAt, outcome,
  };
}

export function decodeAppError(value: unknown, status: number, operation = "http-request"): AppError {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const code = typeof record?.["code"] === "string" ? record["code"] : undefined;
  const message = typeof record?.["message"] === "string" ? record["message"] : undefined;

  const failureMetadata = decodeErrorMetadata(record?.["metadata"]);
  if (code === "COMMAND_REJECTED") {
    return { kind: "forbidden", permission: "command:execute", ...(failureMetadata ? { metadata: failureMetadata } : {}) };
  }
  if (code === "COMMAND_INPUT_INVALID" || code === "COMMAND_INPUT_EXPIRED") {
    return { kind: "validation", issues: [{ path: [], message: code }], ...(failureMetadata ? { metadata: failureMetadata } : {}) };
  }
  if (code === "COMMAND_IDEMPOTENCY_CONFLICT" || code === "COMMAND_RECEIPT_INVALID") {
    return { kind: "conflict", code, ...(failureMetadata ? { metadata: failureMetadata } : {}) };
  }
  if (code === "COMMAND_UNAVAILABLE") {
    return { kind: "dependency", service: "command-store", ...(failureMetadata ? { metadata: failureMetadata } : {}) };
  }
  if (code === "COMMAND_OUTCOME_UNKNOWN") {
    return { kind: "unknown", operation, ...(failureMetadata ? { metadata: failureMetadata } : {}) };
  }
  if (status === 401) return { kind: "unauthorized", ...(message ? { reason: message } : {}) };
  if (status === 403) return { kind: "forbidden", permission: code ?? "request" };
  if (status === 404) return { kind: "not_found", resource: operation };
  if (status === 409) return { kind: "conflict", code: code ?? "HTTP_CONFLICT" };
  if (status >= 500) return { kind: "dependency", service: operation };
  return { kind: "unknown", operation };
}

export function appErrorMessage(error: AppError): string {
  switch (error.kind) {
    case "validation":
      return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    case "unauthorized":
      return error.reason ?? "Authentication required";
    case "forbidden":
      return `Missing permission: ${error.permission}`;
    case "not_found":
      return `${error.resource} not found`;
    case "conflict":
      return `Conflict: ${error.code}`;
    case "dependency":
      return `Dependency unavailable: ${error.service}`;
    case "unknown":
      return `Unknown failure during ${error.operation}`;
  }
}
