import { parseAuthRuntimeDescriptor, type AuthRuntimeDescriptor } from "./auth-runtime";
import { requestValidatedJson } from "./validated-json";

export const serviceIds = ["postgresql", "postgrest", "gotrue", "realtime", "storage", "caddy"] as const;
export type ServiceId = typeof serviceIds[number];
export type ServiceAction = "start" | "stop" | "restart";
export type ProjectAction = "restore" | "restart" | "pause";
export type ServiceOperation = { kind: "service"; service: ServiceId; action: ServiceAction }
  | { kind: "project"; action: ProjectAction };
type ServiceStatus = "ACTIVE_HEALTHY" | "INACTIVE" | "UNHEALTHY" | "COMING_UP";
export interface ControlledService {
  id: ServiceId;
  status: ServiceStatus;
  healthy: boolean;
  controlUnit: string;
  runtimeMode: "local" | "owner" | "shared" | "external" | null;
  managedByRef: string | null;
  controllable: boolean;
}
export interface ServiceControlState {
  projectRef: string;
  authRuntime: AuthRuntimeDescriptor;
  services: ControlledService[];
}
function invalid(): never { throw new Error("Invalid service control response"); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
export function validServiceProject(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  for (const candidate of values) if (candidate === value) return candidate;
  return invalid();
}

export function parseServiceControlState(value: unknown, projectRef: string): ServiceControlState {
  const data = record(value);
  if (!validServiceProject(projectRef) || data.project_ref !== projectRef) return invalid();
  const authRuntime = parseAuthRuntimeDescriptor(data.auth_runtime, projectRef);
  if (!Array.isArray(data.services) || data.services.length !== serviceIds.length) return invalid();
  const expectedUnits: Record<ServiceId, string> = {
    postgresql: "patroni", postgrest: `supacloud-pgrst@${projectRef}`,
    gotrue: `supacloud-gotrue@${authRuntime.authority_project_ref}`,
    realtime: "supacloud-realtime", storage: "supacloud-storage", caddy: "supacloud-caddy",
  };
  const seen = new Set<ServiceId>();
  const services = data.services.map((item: unknown): ControlledService => {
    const row = record(item);
    const id = choice(row.id, serviceIds);
    if (seen.has(id)) return invalid();
    seen.add(id);
    const status = choice(row.status, ["ACTIVE_HEALTHY", "INACTIVE", "UNHEALTHY", "COMING_UP"] as const);
    const authority = id === "gotrue" ? authRuntime.authority_project_ref : projectRef;
    if (row.healthy !== (status === "ACTIVE_HEALTHY") || row.control_unit !== expectedUnits[id]
      || !Array.isArray(row.service_host_ids) || row.service_host_ids.length !== 1
      || row.service_host_ids[0] !== `${authority}-${id}`) return invalid();
    if (id !== "gotrue") {
      if (row.runtime_mode !== undefined || row.managed_by_ref !== undefined || row.local_runtime_enabled !== undefined) return invalid();
      return { id, status, healthy: row.healthy, controlUnit: row.control_unit,
        runtimeMode: null, managedByRef: null, controllable: true };
    }
    const runtimeMode = choice(row.runtime_mode, ["local", "owner", "shared", "external"] as const);
    if (runtimeMode === "external" ? authRuntime.mode !== "local" : runtimeMode !== authRuntime.mode) return invalid();
    const locallyEnabled = runtimeMode === "local" || runtimeMode === "owner";
    if (row.local_runtime_enabled !== locallyEnabled || row.unit !== expectedUnits.gotrue) return invalid();
    const owner = runtimeMode === "shared" || runtimeMode === "owner" ? authority : null;
    if (owner === null ? row.managed_by_ref !== undefined : row.managed_by_ref !== owner) return invalid();
    return { id, status, healthy: row.healthy, controlUnit: row.control_unit,
      runtimeMode, managedByRef: owner, controllable: locallyEnabled };
  });
  return { projectRef, authRuntime, services };
}

export function parseServiceOperationReceipt(value: unknown, projectRef: string, operation: ServiceOperation): void {
  const row = record(value);
  if (!validServiceProject(projectRef)) return invalid();
  if (operation.kind === "service") {
    if (row.project_ref !== projectRef || row.service !== operation.service
      || row.action !== operation.action || row.success !== true) return invalid();
    return;
  }
  if (row.ref !== projectRef) return invalid();
  if (operation.action === "restart") {
    if (row.success !== true || row.action !== "restart") return invalid();
  } else {
    const expectedStatus = operation.action === "pause" ? "INACTIVE" : "ACTIVE_HEALTHY";
    if (row.status !== expectedStatus) return invalid();
  }
}

export function loadServiceControlState(
  projectRef: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
) {
  if (!validServiceProject(projectRef)) throw new Error("Missing service project");
  return requestValidatedJson(`/v1/projects/${projectRef}/services/control-state`,
    request, value => parseServiceControlState(value, projectRef), { signal }, { maxBytes: 128 * 1024 });
}

export async function runServiceOperation(
  state: ServiceControlState, operation: ServiceOperation,
  request: (url: string, options: RequestInit) => Promise<Response>, signal: AbortSignal,
): Promise<void> {
  const projectRef = state.projectRef;
  const captured = { ...operation };
  if (!validServiceProject(projectRef)) throw new Error("Missing service project");
  if (captured.kind === "service" && !state.services.some(service => service.id === captured.service && service.controllable)) {
    throw new Error("Service is not locally controllable");
  }
  if (captured.kind === "project" && captured.action === "pause" && state.authRuntime.mode === "owner") {
    throw new Error("Authentication owner cannot be paused");
  }
  const suffix = captured.kind === "project" ? captured.action : `services/${captured.service}/${captured.action}`;
  return requestValidatedJson(`/v1/projects/${projectRef}/${suffix}`, request,
    value => parseServiceOperationReceipt(value, projectRef, captured),
    { method: "POST", signal }, { maxBytes: 128 * 1024 });
}
