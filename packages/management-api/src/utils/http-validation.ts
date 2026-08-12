import type { ErrorContext } from "elysia";

export const VALIDATION_ERROR_BODY = {
  message: "Validation failed",
  code: "VALIDATION_ERROR",
} as const;

export function validationErrorResponse(set: ErrorContext["set"]) {
  set.status = 400;
  return VALIDATION_ERROR_BODY;
}
