import { requestValidatedJson } from "./validated-json";

export type JwtExecutionMode = "local" | "shared" | "external";

export interface JwtSigningState {
  algorithm: string;
  keyId: string;
  issuer: string;
  jwksUrl: string;
  oauthEnabled: boolean;
  migrationStatus: string;
}

export interface JwtPolicy {
  accessExpiry: number;
  refreshRotation: boolean;
}

export interface JwtSettings {
  projectRef: string;
  executionMode: JwtExecutionMode;
  authorityProjectRef: string | null;
  policy: JwtPolicy | null;
  signing: JwtSigningState | null;
}

function invalid(): never { throw new Error("Invalid JWT settings response"); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
function nullable<T>(value: unknown, decode: (value: unknown) => T): T | null {
  return value === null ? null : decode(value);
}
function integer(value: unknown, min = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : invalid();
}
function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
export function validJwtProject(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function parseJwtSettings(value: unknown, projectRef: string): JwtSettings {
  const data = record(value);
  if (!validJwtProject(projectRef) || data.project_ref !== projectRef) return invalid();
  const executionMode = data.execution_mode;
  if (executionMode !== "local" && executionMode !== "shared" && executionMode !== "external") return invalid();
  const authority = nullable(data.authority_project_ref, text);
  if (executionMode === "shared") {
    if (!validJwtProject(authority)) return invalid();
  } else if (executionMode === "local") {
    if (authority !== projectRef) return invalid();
  } else if (authority !== null) {
    return invalid();
  }
  const policy = nullable(data.policy, (raw) => {
    const row = record(raw);
    if (typeof row.refresh_rotation !== "boolean") return invalid();
    return { accessExpiry: integer(row.access_expiry), refreshRotation: row.refresh_rotation };
  });
  const signing = nullable(data.signing, (raw) => {
    const row = record(raw);
    const jwksUrl = text(row.jwks_url);
    let parsed: URL;
    try { parsed = new URL(jwksUrl); } catch { return invalid(); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return invalid();
    return {
      algorithm: text(row.algorithm),
      keyId: text(row.key_id),
      issuer: text(row.issuer),
      jwksUrl,
      oauthEnabled: boolean(row.oauth_enabled),
      migrationStatus: text(row.migration_status),
    };
  });
  return { projectRef, executionMode, authorityProjectRef: authority, policy, signing };
}

export function loadJwtSettings(
  projectRef: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<JwtSettings> {
  if (!validJwtProject(projectRef)) throw new Error("Missing JWT project");
  return requestValidatedJson(`/v1/projects/${projectRef}/auth/jwt-settings`, request,
    (value) => parseJwtSettings(value, projectRef), { signal, cache: "no-store" }, { maxBytes: 128 * 1024 });
}