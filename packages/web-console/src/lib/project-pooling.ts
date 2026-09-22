import { requestValidatedJson } from "./validated-json";

export interface ProjectPoolingState {
  projectRef: string;
  poolMode: "transaction" | "session" | "statement" | null;
  poolSize: number | null;
  poolerPort: number;
  directPort: number;
  connectionString: string;
  directString: string;
}
function invalid(): never { throw new Error("Invalid project pooling response"); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
function endpoint(value: unknown): { host: string; port: number } {
  const data = record(value);
  const host = text(data.host);
  if (/[\\/?#@%\s]/.test(host)) return invalid();
  const parsed = new URL(`http://${host}`);
  if (parsed.port || parsed.username || parsed.password || !parsed.hostname
    || parsed.hostname !== host) return invalid();
  const port = data.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return invalid();
  return { host, port };
}
export function validPoolingProject(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function parseProjectPoolingState(value: unknown, projectRef: string): ProjectPoolingState {
  const data = record(value);
  if (!validPoolingProject(projectRef) || data.project_ref !== projectRef || data.source !== "configuration") return invalid();
  const database = record(data.database);
  const user = encodeURIComponent(text(database.user));
  const name = encodeURIComponent(text(database.name));
  const direct = endpoint(data.direct);
  const pooler = endpoint(data.pooler);
  const settings = record(data.settings);
  const poolMode = settings.pool_mode;
  if (poolMode !== null && poolMode !== "transaction" && poolMode !== "session" && poolMode !== "statement") return invalid();
  const poolSize = settings.default_pool_size;
  if (poolSize !== null && (typeof poolSize !== "number" || !Number.isSafeInteger(poolSize) || poolSize < 0)) return invalid();
  const connection = (target: { host: string; port: number }) =>
    `postgresql://${user}:[YOUR-PASSWORD]@${target.host}:${target.port}/${name}`;
  return {
    projectRef, poolMode, poolSize, poolerPort: pooler.port, directPort: direct.port,
    connectionString: `${connection(pooler)}?pgbouncer=true`, directString: connection(direct),
  };
}

export function loadProjectPoolingState(
  projectRef: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<ProjectPoolingState> {
  if (!validPoolingProject(projectRef)) throw new Error("Missing pooling project");
  return requestValidatedJson(`/v1/projects/${projectRef}/pooling-state`, request,
    value => parseProjectPoolingState(value, projectRef), { signal, cache: "no-store" }, { maxBytes: 64 * 1024 });
}
