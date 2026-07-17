import { config } from "../config";

export type AuthRuntimeMode = "local" | "owner" | "shared";
export type AuthRuntimeManagement = "local" | "owner_only";

export interface AuthRuntimeDescriptor {
  project_ref: string;
  mode: AuthRuntimeMode;
  authority_project_ref: string;
  owner_project_ref: string | null;
  local_gotrue_enabled: boolean;
  public_auth_route: "local_gotrue" | "owner_proxy";
  user_management: AuthRuntimeManagement;
  configuration_management: AuthRuntimeManagement;
  local_membership_source: "project_database";
  realtime_auth_supported: boolean;
  owner_management_path: string | null;
}

export type AuthRuntimeManagedResource =
  | "users"
  | "providers"
  | "configuration"
  | "sso"
  | "mfa"
  | "oauth"
  | "email_templates"
  | "service_control";

export function isSharedAuthRuntime(ref: string): boolean {
  const ownerRef = config.authRuntimeOwnerRef.trim();
  return ownerRef.length > 0 && ownerRef !== ref;
}

export function getAuthRuntimeDescriptor(ref: string): AuthRuntimeDescriptor {
  const configuredOwnerRef = config.authRuntimeOwnerRef.trim() || null;
  const mode: AuthRuntimeMode = configuredOwnerRef === null
    ? "local"
    : configuredOwnerRef === ref
      ? "owner"
      : "shared";
  const shared = mode === "shared";

  return {
    project_ref: ref,
    mode,
    authority_project_ref: configuredOwnerRef ?? ref,
    owner_project_ref: configuredOwnerRef,
    local_gotrue_enabled: !shared,
    public_auth_route: shared ? "owner_proxy" : "local_gotrue",
    user_management: shared ? "owner_only" : "local",
    configuration_management: shared ? "owner_only" : "local",
    local_membership_source: "project_database",
    realtime_auth_supported: !shared,
    owner_management_path: shared && configuredOwnerRef
      ? `/project/${configuredOwnerRef}/auth`
      : null,
  };
}

export function getAuthRuntimeManagedError(
  ref: string,
  resource: AuthRuntimeManagedResource,
): Record<string, unknown> | null {
  const runtime = getAuthRuntimeDescriptor(ref);
  if (runtime.mode !== "shared") return null;

  return {
    code: "AUTH_RUNTIME_MANAGED_BY_OWNER",
    message: `This project's ${resource} are managed by the SupAuth owner project. Local GoTrue is disabled for ${ref}.`,
    project_ref: ref,
    authority_project_ref: runtime.authority_project_ref,
    owner_project_ref: runtime.owner_project_ref,
    owner_management_path: runtime.owner_management_path,
    public_auth_route: runtime.public_auth_route,
    local_membership_source: runtime.local_membership_source,
    realtime_auth_supported: runtime.realtime_auth_supported,
  };
}

export function getAuthRuntimeOwnerProtectionError(
  ref: string,
  action: "pause" | "delete",
): Record<string, unknown> | null {
  const runtime = getAuthRuntimeDescriptor(ref);
  if (runtime.mode !== "owner") return null;

  return {
    code: "AUTH_RUNTIME_OWNER_REQUIRED",
    message: `Cannot ${action} the SupAuth owner project while SUPACLOUD_AUTH_RUNTIME_OWNER_REF points to ${ref}. Disable SupAuth or migrate dependents first.`,
    project_ref: ref,
    authority_project_ref: runtime.authority_project_ref,
    required_operator_action: "disable_supauth_or_migrate_dependents",
  };
}
