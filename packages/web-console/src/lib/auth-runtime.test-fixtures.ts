import type { AuthRuntimeDescriptor } from "./auth-runtime";

export function localAuthRuntime(projectRef = "a"): Extract<AuthRuntimeDescriptor, { mode: "local" | "owner" }> {
  return {
    project_ref: projectRef, mode: "local", authority_project_ref: projectRef, owner_project_ref: null,
    local_gotrue_enabled: true, public_auth_route: "local_gotrue", user_management: "local",
    configuration_management: "local", local_membership_source: "project_database",
    realtime_auth_supported: true, owner_management_path: null,
  };
}

export function sharedAuthRuntime(projectRef = "a", owner = "auth-owner"): Extract<AuthRuntimeDescriptor, { mode: "shared" }> {
  return {
    project_ref: projectRef, mode: "shared", authority_project_ref: owner, owner_project_ref: owner,
    local_gotrue_enabled: false, public_auth_route: "owner_proxy", user_management: "owner_only",
    configuration_management: "owner_only", local_membership_source: "project_database",
    realtime_auth_supported: false, owner_management_path: `/project/${owner}/auth`,
  };
}
