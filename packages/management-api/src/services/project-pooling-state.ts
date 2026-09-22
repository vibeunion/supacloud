import { isRecord } from "../utils/project-config";

type PoolMode = "transaction" | "session" | "statement";
export interface ProjectPoolingState {
  project_ref: string;
  source: "configuration";
  database: { name: string; user: string };
  direct: { host: string; port: number };
  pooler: { host: string; port: number };
  settings: { pool_mode: PoolMode | null; default_pool_size: number | null };
}

function invalid(): never { throw new Error("Invalid project pooling configuration"); }
function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
function endpoint(host: unknown, port: unknown) {
  const name = text(host);
  if (/[\\/?#@%\s]/.test(name)) return invalid();
  const authority = name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
  const url = new URL(`http://${authority}`);
  if (url.port || url.username || url.password || !url.hostname
    || url.hostname.toLowerCase() !== authority.toLowerCase()) return invalid();
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return invalid();
  return { host: url.hostname, port };
}
function mode(value: unknown): PoolMode {
  return value === "transaction" || value === "session" || value === "statement" ? value : invalid();
}
function count(value: unknown): number {
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : invalid();
}
function setting<T>(
  containers: readonly Record<string, unknown>[], keys: readonly string[], decode: (value: unknown) => T,
): T | null {
  let result: T | null = null;
  for (const container of containers) {
    for (const key of keys) {
      if (!Object.hasOwn(container, key)) continue;
      const decoded = decode(container[key]);
      if (result !== null && result !== decoded) return invalid();
      result = decoded;
    }
  }
  return result;
}

export function buildProjectPoolingState(
  project: { ref: string; config: unknown; database: { host: unknown; name: unknown; user: unknown } },
  runtime: { pgPort: unknown; poolerHost: unknown; poolerPort: unknown },
): ProjectPoolingState {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(project.ref) || !isRecord(project.config)) return invalid();
  const containers = [project.config];
  for (const key of ["pgbouncer", "pooler"]) {
    if (!Object.hasOwn(project.config, key)) continue;
    const nested = project.config[key];
    if (!isRecord(nested)) return invalid();
    containers.push(nested);
  }
  return {
    project_ref: project.ref, source: "configuration",
    database: { name: text(project.database.name), user: text(project.database.user) },
    direct: endpoint(project.database.host, runtime.pgPort),
    pooler: endpoint(runtime.poolerHost, runtime.poolerPort),
    settings: {
      pool_mode: setting(containers, ["pool_mode", "pgbouncer_pool_mode"], mode),
      default_pool_size: setting(containers, ["default_pool_size", "pgbouncer_default_pool_size"], count),
    },
  };
}
