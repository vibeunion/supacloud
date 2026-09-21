import { serviceIds } from "./project-services";
import type { AuthRuntimeDescriptor } from "./auth-runtime";

export function serviceControlFixture(projectRef = "a", mode: "local" | "owner" | "shared" | "external" = "local") {
  const authority = mode === "shared" ? "owner-project" : projectRef;
  const base = {
    project_ref: projectRef, authority_project_ref: authority,
    local_membership_source: "project_database", realtime_auth_supported: mode !== "shared",
  } as const;
  const authRuntime: AuthRuntimeDescriptor = mode === "shared" ? {
    ...base, mode: "shared", owner_project_ref: authority, local_gotrue_enabled: false,
    public_auth_route: "owner_proxy", user_management: "owner_only", configuration_management: "owner_only",
    owner_management_path: `/project/${authority}/auth`,
  } : {
    ...base, mode: mode === "owner" ? "owner" : "local", owner_project_ref: mode === "owner" ? authority : null,
    local_gotrue_enabled: true, public_auth_route: "local_gotrue", user_management: "local",
    configuration_management: "local", owner_management_path: null,
  };
  const units = {
    postgresql: "patroni", postgrest: `supacloud-pgrst@${projectRef}`, gotrue: `supacloud-gotrue@${authority}`,
    realtime: "supacloud-realtime", storage: "supacloud-storage", caddy: "supacloud-caddy",
  };
  return {
    project_ref: projectRef, auth_runtime: authRuntime,
    services: serviceIds.map(id => ({
      id, name: id, status: "ACTIVE_HEALTHY", healthy: true,
      service_host_ids: [`${id === "gotrue" ? authority : projectRef}-${id}`], control_unit: units[id],
      ...(id !== "gotrue" ? {} : {
        unit: units.gotrue, runtime_mode: mode, local_runtime_enabled: mode === "local" || mode === "owner",
        ...(mode === "owner" || mode === "shared" ? { managed_by_ref: authority } : {}),
      }),
    })),
  };
}
