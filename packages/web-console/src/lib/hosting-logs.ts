import { isHostingId } from "./hosting-list";
import { requestValidatedJson } from "./validated-json";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
function invalid(): never { throw new Error("Invalid hosting log response"); }

export function parseHostingLogs(value: unknown, projectRef: string, deploymentId: string): string {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId) || !value || typeof value !== "object"
    || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !["project_ref", "deployment_id", "logs"].includes(key)) return invalid();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) return invalid();
    entries.push([key, property.value]);
  }
  const data: Record<string, unknown> = Object.fromEntries(entries);
  if (data.project_ref !== projectRef || data.deployment_id !== deploymentId || typeof data.logs !== "string"
    || data.logs.length > MAX_LOG_BYTES || new TextEncoder().encode(data.logs).byteLength > MAX_LOG_BYTES) return invalid();
  return data.logs;
}

export async function loadHostingLogs(
  projectRef: string, deploymentId: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<string> {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId)) throw new Error("Missing hosting deployment");
  return requestValidatedJson(
    `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}/logs`,
    request, value => parseHostingLogs(value, projectRef, deploymentId),
    { signal, cache: "no-store" }, { maxBytes: MAX_LOG_BYTES },
  );
}
