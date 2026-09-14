import { isHostingId } from "./hosting-list";
import { requestValidatedJson } from "./validated-json";

export interface HostingToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string;
}

export interface CreatedHostingToken {
  id: string;
  token: string;
  project_ref: string;
  deployment_id: string;
  name: string;
}

export class HostingTokenCreationError extends Error {
  constructor(readonly mutationMayHaveApplied: boolean) {
    super("Hosting token creation could not be confirmed");
    this.name = "HostingTokenCreationError";
  }
}

function invalid(): never { throw new Error("Invalid hosting token list response"); }
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) return invalid();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) return invalid();
    entries.push([key, property.value]);
  }
  return Object.fromEntries(entries);
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid();
  return value;
}

export function parseHostingTokens(value: unknown): HostingToken[] {
  const envelope = record(value, ["tokens"]);
  const tokens = envelope.tokens;
  if (!Array.isArray(tokens) || Object.getPrototypeOf(tokens) !== Array.prototype
    || tokens.length > 5000 || Reflect.ownKeys(tokens).length !== tokens.length + 1) return invalid();
  const result: HostingToken[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const property = Object.getOwnPropertyDescriptor(tokens, String(index));
    if (!property || !("value" in property) || !property.enumerable) return invalid();
    const row = record(property.value, ["id", "name", "created_at", "last_used_at"]);
    if (!isHostingId(row.id) || ids.has(row.id) || typeof row.name !== "string"
      || !row.name.trim() || row.name.length > 1024 || /[\u0000-\u001f\u007f]/.test(row.name)) return invalid();
    ids.add(row.id);
    result.push({
      id: row.id, name: row.name, created_at: timestamp(row.created_at),
      ...(row.last_used_at === undefined ? {} : { last_used_at: timestamp(row.last_used_at) }),
    });
  }
  return result;
}

export async function loadHostingTokens(
  projectRef: string, deploymentId: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<HostingToken[]> {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId)) throw new Error("Missing hosting deployment");
  return requestValidatedJson(
    `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}/tokens`,
    request, value => parseScopedHostingTokens(value, projectRef, deploymentId),
    { signal, cache: "no-store" }, { maxBytes: 1024 * 1024 },
  );
}

export function parseScopedHostingTokens(value: unknown, projectRef: string, deploymentId: string): HostingToken[] {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId)) return invalid();
  const envelope = record(value, ["project_ref", "deployment_id", "tokens"]);
  if (envelope.project_ref !== projectRef || envelope.deployment_id !== deploymentId) return invalid();
  return parseHostingTokens({ tokens: envelope.tokens });
}

export function parseCreatedHostingToken(
  value: unknown, projectRef: string, deploymentId: string, name: string,
): CreatedHostingToken {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId) || typeof name !== "string"
    || !name.trim() || name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Invalid hosting token creation input");
  }
  const data = record(value, ["operation", "project_ref", "deployment_id", "name", "id", "token"]);
  if (data.operation !== "create_token" || data.project_ref !== projectRef || data.deployment_id !== deploymentId
    || data.name !== name || !isHostingId(data.id) || typeof data.token !== "string"
    || !/^supa_deploy_[0-9a-f]{32}$/.test(data.token)) throw new HostingTokenCreationError(true);
  return { id: data.id, token: data.token, project_ref: projectRef, deployment_id: deploymentId, name };
}

export async function createHostingToken(
  projectRef: string, deploymentId: string, name: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<CreatedHostingToken> {
  if (!isHostingId(projectRef) || !isHostingId(deploymentId) || typeof name !== "string"
    || !name.trim() || name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Invalid hosting token creation input");
  }
  signal.throwIfAborted();
  let dispatched = false;
  try {
    return await requestValidatedJson(
      `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}/tokens`,
      (url, options) => { dispatched = true; return request(url, options); },
      value => parseCreatedHostingToken(value, projectRef, deploymentId, name),
      {
        method: "POST", signal, cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
      { maxBytes: 16 * 1024 },
    );
  } catch {
    throw new HostingTokenCreationError(dispatched);
  }
}
