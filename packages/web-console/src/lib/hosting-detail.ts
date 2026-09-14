import { isHostingId, parseHostingList, type HostingDeployment } from "./hosting-list";
import { requestValidatedJson } from "./validated-json";
import { parseHostingEnvironmentRevision } from "./hosting-env";
import { parseHostingConfigurationRevision } from "./hosting-configuration";

export interface HostingDetail extends HostingDeployment {
  build_command: string;
  output_dir: string;
  install_command: string;
  node_version: string;
  health_check_path: string;
  env_vars: Record<string, string>;
  env_revision: string;
  configuration_revision: string;
}

function invalid(): never { throw new Error("Invalid hosting detail response"); }
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
function text(value: unknown, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== "string" || value.length > 16_384 || controls.test(value)) return invalid();
  return value;
}

export function parseHostingDetail(value: unknown, projectRef: string, deploymentId: string): HostingDetail {
  try {
    if (!isHostingId(projectRef) || !isHostingId(deploymentId)) return invalid();
    const row = record(value);
    const deployment = parseHostingList({ deployments: [row] }, projectRef)[0];
    if (!deployment || deployment.id !== deploymentId) return invalid();
    const environment = record(row.env_vars);
    if (Object.keys(environment).length > 256) return invalid();
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value !== "********") return invalid();
      entries.push([key, value]);
    }
    return {
      ...deployment,
      build_command: text(row.build_command, true),
      output_dir: text(row.output_dir),
      install_command: text(row.install_command, true),
      node_version: text(row.node_version),
      health_check_path: row.health_check_path === undefined ? "/" : text(row.health_check_path),
      env_vars: Object.fromEntries(entries),
      env_revision: parseHostingEnvironmentRevision(row.env_revision),
      configuration_revision: parseHostingConfigurationRevision(row.configuration_revision),
    };
  } catch {
    return invalid();
  }
}

export async function loadHostingDetail(
  projectRef: string,
  deploymentId: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<HostingDetail | null> {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId)) throw new Error("Missing hosting deployment");
  return requestValidatedJson(
    `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}`,
    request,
    (value, status) => {
      if (status === 404) {
        const error = record(value);
        if (error.code !== "404" || error.message !== "Deployment not found") return invalid();
        return null;
      }
      return parseHostingDetail(value, projectRef, deploymentId);
    },
    { signal, cache: "no-store" },
    { statuses: [200, 404], maxBytes: 1024 * 1024 },
  );
}
