import type { ErrorContext } from "elysia";

export const VALIDATION_ERROR_BODY = {
  message: "Validation failed",
  code: "VALIDATION_ERROR",
} as const;

export function validationErrorResponse(set: ErrorContext["set"]) {
  set.status = 400;
  return VALIDATION_ERROR_BODY;
}

export function parseErrorResponse(set: ErrorContext["set"], pathname: string) {
  set.status = 400;
  if (pathname.startsWith("/storage/v1/")) {
    return { statusCode: "400", error: "Bad Request", message: "Invalid JSON body" };
  }
  return { message: "Invalid JSON body", code: "PARSE_ERROR" };
}
