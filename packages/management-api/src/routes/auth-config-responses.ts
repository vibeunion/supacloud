import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";
import type { AuthSessionPolicyValidationError } from "../services/auth-session-policy";

export function buildAuthSessionPolicyErrorBody(error: AuthSessionPolicyValidationError) {
  return {
    code: error.code,
    field: error.field,
    message: error.message,
  };
}

export function buildAuthRuntimeApplyFailureBody(projectRef: string, error: unknown) {
  const runtime = getAuthRuntimeDescriptor(projectRef);
  const runtimeCode = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  const dependentRefreshFailed = runtimeCode === "SUPAUTH_DEPENDENT_REFRESH_FAILED";
  const failedDependents = dependentRefreshFailed
    && error
    && typeof error === "object"
    && "failedRefs" in error
    && Array.isArray(error.failedRefs)
    ? error.failedRefs.map(String)
    : [];
  const dependentStatusUnknown = dependentRefreshFailed && failedDependents.length === 0;

  return {
    code: dependentRefreshFailed
      ? "SUPAUTH_DEPENDENT_REFRESH_FAILED"
      : "AUTH_RUNTIME_APPLY_FAILED",
    message: dependentRefreshFailed
      ? dependentStatusUnknown
        ? "Auth configuration was saved and applied to the owner, but dependent refresh status is unknown"
        : "Auth configuration was saved, but one or more SupAuth dependents failed to refresh"
      : "Auth configuration was saved, but the auth runtime failed to apply it",
    persisted: true,
    runtime_applied: dependentRefreshFailed,
    ...(dependentRefreshFailed ? {
      dependents_applied: false,
      dependent_status: dependentStatusUnknown ? "unknown" : "failed",
      failed_dependents: failedDependents,
    } : {}),
    runtime_mode: runtime.mode,
    authority_project_ref: runtime.authority_project_ref,
  };
}
