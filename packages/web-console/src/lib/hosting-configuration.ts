import { isHostingId } from "./hosting-list";
import { requestValidatedJson } from "./validated-json";

export interface HostingConfiguration {
  configuration: {
    build_command: string;
    output_dir: string;
    install_command: string;
    node_version: string;
    health_check_path: string;
  };
  git: { url: string; branch: string };
}

function invalid(): never { throw new Error("Invalid hosting configuration"); }
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
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return invalid();
  return row;
}
function text(value: unknown, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== "string" || value.length > 16_384 || controls.test(value)) return invalid();
  return value;
}
function capture(value: unknown): HostingConfiguration {
  const input = exact(value, ["configuration", "git"]);
  const configuration = exact(input.configuration, [
    "build_command", "output_dir", "install_command", "node_version", "health_check_path",
  ]);
  const git = exact(input.git, ["url", "branch"]);
  const url = text(git.url);
  const branch = text(git.branch);
  if ((url !== "" && !url.trim()) || !branch.trim()) return invalid();
  return {
    configuration: {
      build_command: text(configuration.build_command, true),
      output_dir: text(configuration.output_dir),
      install_command: text(configuration.install_command, true),
      node_version: text(configuration.node_version),
      health_check_path: text(configuration.health_check_path),
    },
    git: { url, branch },
  };
}

export class HostingConfigurationUpdateError extends Error {
  constructor(readonly mutationMayHaveApplied: boolean) {
    super("Hosting configuration update could not be confirmed");
    this.name = "HostingConfigurationUpdateError";
  }
}

export class HostingConfigurationConflictError extends Error {
  constructor() {
    super("Configuration changed; reload before saving");
    this.name = "HostingConfigurationConflictError";
  }
}

export function parseHostingConfigurationRevision(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^enc:v1:[A-Za-z0-9_-]+$/.test(value)) return invalid();
  return value;
}

export async function saveHostingConfiguration(
  projectRef: string, deploymentId: string, input: unknown,
  request: (url: string, options: RequestInit) => Promise<Response>, signal: AbortSignal,
  expectedRevision: string,
): Promise<string> {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId)) return invalid();
  const submitted = capture(input);
  const revision = parseHostingConfigurationRevision(expectedRevision);
  signal.throwIfAborted();
  const endpoint = `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}/configuration`;
  let dispatched = false;
  const send = (url: string, options: RequestInit) => { dispatched = true; return request(url, options); };
  const receipt = (value: unknown, operation: string) => {
    const row = record(value);
    if (row.success !== true || row.operation !== operation || row.project_ref !== projectRef
      || row.id !== deploymentId || row.deployment_id !== deploymentId) return invalid();
    return row;
  };
  try {
    return await requestValidatedJson(endpoint, send, (value, status) => {
      if (status === 409) {
        const row = record(value);
        if (row.code !== "CONFIGURATION_CONFLICT" || row.message !== "Configuration changed; reload before saving"
          || row.project_ref !== projectRef || row.deployment_id !== deploymentId
          || row.expected_revision !== revision) return invalid();
        throw new HostingConfigurationConflictError();
      }
      const row = receipt(value, "update_configuration");
      if (row.previous_configuration_revision !== revision) return invalid();
      if (Object.entries(submitted.configuration).some(([key, expected]) => row[key] !== expected)) return invalid();
      if (row.git_url !== submitted.git.url || row.git_branch !== submitted.git.branch) return invalid();
      return parseHostingConfigurationRevision(row.configuration_revision);
    }, {
      method: "PUT", signal, cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...submitted, expected_revision: revision }),
    }, { statuses: [200, 409], maxBytes: 1024 * 1024 });
  } catch (error: unknown) {
    if (error instanceof HostingConfigurationConflictError) throw error;
    throw new HostingConfigurationUpdateError(dispatched);
  }
}
