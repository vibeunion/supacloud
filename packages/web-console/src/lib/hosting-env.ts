import { isHostingId } from "./hosting-list";
import { requestValidatedJson } from "./validated-json";

function invalid(): never { throw new Error("Invalid hosting environment update"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !property || !("value" in property) || !property.enumerable) return invalid();
    entries.push([key, property.value]);
  }
  return Object.fromEntries(entries);
}
function capture(value: unknown): Record<string, string> {
  const source = record(value);
  if (Object.keys(source).length > 256) return invalid();
  return Object.fromEntries(Object.entries(source).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string"
      || value.length > 24_576 || /[\u0000\r\n]/.test(value)) return invalid();
    return [key, value];
  }));
}

export class HostingEnvironmentUpdateError extends Error {
  constructor(readonly mutationMayHaveApplied: boolean) {
    super("Hosting environment update could not be confirmed");
    this.name = "HostingEnvironmentUpdateError";
  }
}

export class HostingEnvironmentConflictError extends Error {
  constructor() {
    super("Environment changed; reload before saving");
    this.name = "HostingEnvironmentConflictError";
  }
}

export function parseHostingEnvironmentRevision(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^enc:v1:[A-Za-z0-9_-]+$/.test(value)) return invalid();
  return value;
}

export async function saveHostingEnvironment(
  projectRef: string, deploymentId: string, values: unknown,
  request: (url: string, options: RequestInit) => Promise<Response>, signal: AbortSignal,
  expectedRevision: string,
): Promise<string> {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId)) return invalid();
  const submitted = capture(values);
  const revision = parseHostingEnvironmentRevision(expectedRevision);
  signal.throwIfAborted();
  let dispatched = false;
  try {
    return await requestValidatedJson(
      `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}/env`,
      (url, options) => { dispatched = true; return request(url, options); },
      (value, status) => {
        const data = record(value);
        if (status === 409) {
          if (data.code !== "ENVIRONMENT_CONFLICT" || data.message !== "Environment changed; reload before saving"
            || data.project_ref !== projectRef || data.deployment_id !== deploymentId
            || data.expected_revision !== revision) return invalid();
          throw new HostingEnvironmentConflictError();
        }
        if (data.success !== true || data.operation !== "update_env" || data.mode !== "replace" || data.project_ref !== projectRef
          || data.deployment_id !== deploymentId || data.id !== deploymentId
          || data.previous_env_revision !== revision) return invalid();
        const environment = capture(data.env_vars);
        if (Object.values(environment).some(value => value !== "********")
          || Object.keys(environment).length !== Object.keys(submitted).length
          || Object.keys(submitted).some(key => !Object.hasOwn(environment, key))) return invalid();
        return parseHostingEnvironmentRevision(data.env_revision);
      },
      {
        method: "PUT", signal, cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "replace", expected_revision: revision,
          env_entries: Object.entries(submitted).map(([name, value]) => ({ name, value })),
        }),
      },
      { statuses: [200, 409], maxBytes: 1024 * 1024 },
    );
  } catch (error: unknown) {
    if (error instanceof HostingEnvironmentConflictError) throw error;
    throw new HostingEnvironmentUpdateError(dispatched);
  }
}
