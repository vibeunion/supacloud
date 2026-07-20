export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code?: string,
    public readonly details?: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    return {
      message: this.message,
      code: this.code || this.getDefaultCode(),
      ...(this.details ? { details: this.details } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }

  private getDefaultCode(): string {
    switch (this.statusCode) {
      case 400: return "BAD_REQUEST";
      case 401: return "UNAUTHORIZED";
      case 403: return "FORBIDDEN";
      case 404: return "NOT_FOUND";
      case 409: return "CONFLICT";
      case 422: return "VALIDATION_ERROR";
      case 429: return "RATE_LIMITED";
      case 500: return "INTERNAL_ERROR";
      case 501: return "CAPABILITY_UNAVAILABLE";
      case 503: return "SERVICE_UNAVAILABLE";
      default: return "UNKNOWN_ERROR";
    }
  }
}

export class AuthError extends AppError {
  constructor(message: string = "Authentication required", code: string = "UNAUTHORIZED") {
    super(message, 401, code);
    this.name = "AuthError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Insufficient permissions", code: string = "FORBIDDEN") {
    super(message, 403, code);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    super(
      identifier ? `${resource} not found: ${identifier}` : `${resource} not found`,
      404,
      "NOT_FOUND",
    );
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: string) {
    super(message, 400, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
    this.name = "ConflictError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(service: string, reason?: string) {
    super(
      reason ? `${service} unavailable: ${reason}` : `${service} unavailable`,
      503,
      "SERVICE_UNAVAILABLE",
    );
    this.name = "ServiceUnavailableError";
  }
}

export class CapabilityUnavailableError extends AppError {
  public readonly reasonCode: string;

  constructor(capability: string, reasonCode: string = "capability_unavailable") {
    super(
      `Capability unavailable: ${capability}`,
      501,
      "CAPABILITY_UNAVAILABLE",
      undefined,
      reasonCode,
    );
    this.reasonCode = reasonCode;
    this.name = "CapabilityUnavailableError";
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      reason_code: this.reasonCode,
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("econnrefused") || msg.includes("connection terminated") || msg.includes("connect_timeout")) {
      return new ServiceUnavailableError("Database", error.message);
    }
    if (msg.includes("not found") || msg.includes("enoent")) {
      return new NotFoundError("Resource");
    }
    if (msg.includes("already exists") || msg.includes("duplicate key")) {
      return new ConflictError(error.message);
    }
    if (msg.includes("permission denied") || msg.includes("access denied")) {
      return new ForbiddenError(error.message);
    }
    return new AppError(error.message, 500, "INTERNAL_ERROR");
  }

  return new AppError("An unexpected error occurred", 500, "INTERNAL_ERROR");
}
