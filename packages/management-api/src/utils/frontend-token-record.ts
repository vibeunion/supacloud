export interface FrontendTokenMetadata {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string;
}

export class InvalidFrontendTokenRecordError extends Error {
  constructor() {
    super("Invalid stored deployment token record");
    this.name = "InvalidFrontendTokenRecordError";
  }
}

function invalid(): never { throw new InvalidFrontendTokenRecordError(); }
function record(value: unknown): object {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
  return value;
}
function field(value: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property) return undefined;
  if (!("value" in property) || !property.enumerable) return invalid();
  return property.value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid();
  return value;
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function parseFrontendTokenMetadata(
  value: unknown, projectRef: string, deploymentId: string,
): FrontendTokenMetadata[] {
  try {
    if (!isId(projectRef) || !isId(deploymentId)) return invalid();
    const deployment = record(value);
    if (field(deployment, "project_ref") !== projectRef || field(deployment, "id") !== deploymentId) return invalid();
    const tokens = field(deployment, "deploy_tokens");
    if (tokens === undefined) return [];
    if (!Array.isArray(tokens) || Object.getPrototypeOf(tokens) !== Array.prototype
      || tokens.length > 5000 || Reflect.ownKeys(tokens).length !== tokens.length + 1) return invalid();
    const result: FrontendTokenMetadata[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < tokens.length; index++) {
      const token = record(field(tokens, String(index)));
      const id = field(token, "id");
      const name = field(token, "name");
      if (!isId(id) || ids.has(id) || typeof name !== "string" || !name.trim()
        || name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name)) return invalid();
      ids.add(id);
      const lastUsedAt = field(token, "last_used_at");
      result.push({
        id, name, created_at: timestamp(field(token, "created_at")),
        ...(lastUsedAt === undefined ? {} : { last_used_at: timestamp(lastUsedAt) }),
      });
    }
    return result;
  } catch {
    return invalid();
  }
}
