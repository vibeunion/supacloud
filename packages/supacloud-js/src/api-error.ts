import { decodeAppError, type AppError } from "@supacloud/contracts";

export class SupaCloudApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly responseBody: unknown;
  readonly appError: AppError;

  constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.name = "SupaCloudApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.appError = decodeAppError(responseBody, status);
    this.code = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
      && Object.hasOwn(responseBody, "code") && "code" in responseBody
      && typeof responseBody.code === "string" ? responseBody.code : null;
  }
}
