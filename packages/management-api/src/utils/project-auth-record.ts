import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "./errors";
import { isRecord, normalizeOAuthServerConfig } from "./project-config";

export class ProjectAuthContextError extends AppError {
  constructor() {
    super("Project authentication context unavailable", 503, "PROJECT_AUTH_CONTEXT_UNAVAILABLE");
    this.name = "ProjectAuthContextError";
  }
}

const text = Type.String({ minLength: 1 });
const oauthSettingsSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  allow_dynamic_registration: Type.Optional(Type.Boolean()),
  issuer: Type.Optional(text),
  migrated_at: Type.Optional(text),
  signing_alg: Type.Optional(text),
  key_id: Type.Optional(text),
  authorization_path: Type.Optional(text),
  jwt_keys: Type.Optional(Type.Unknown()),
  jwt_jwks: Type.Optional(Type.Unknown()),
});
export type OAuthServerSettings = Static<typeof oauthSettingsSchema>;

export function parseOAuthServerSettings(value: unknown): OAuthServerSettings {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ProjectAuthContextError();
  if (value.authorizationPath !== undefined && typeof value.authorizationPath !== "string") {
    throw new ProjectAuthContextError();
  }
  const normalized = normalizeOAuthServerConfig(value);
  if (!Value.Check(oauthSettingsSchema, normalized)) throw new ProjectAuthContextError();
  return normalized;
}

export function parseProjectAuthConfig(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ProjectAuthContextError();
  parseOAuthServerSettings(value.oauth_server);
  return { ...value };
}

const projectAuthSchema = Type.Object({
  ref: text,
  organization_id: Type.Union([text, Type.Null()]),
  jwt_secret: text,
  config: Type.Record(Type.String(), Type.Unknown()),
});
export type ProjectAuthRecord = Static<typeof projectAuthSchema>;

export function parseProjectAuthRows(value: unknown, ref: string): ProjectAuthRecord | null {
  if (!Array.isArray(value)) throw new ProjectAuthContextError();
  if (value.length === 0) return null;
  if (value.length !== 1 || !isRecord(value[0])) throw new ProjectAuthContextError();
  const row = value[0];
  let config: unknown = row.config;
  if (typeof config === "string") {
    if (Buffer.byteLength(config, "utf8") > 1024 * 1024) throw new ProjectAuthContextError();
    try { config = JSON.parse(config); } catch { throw new ProjectAuthContextError(); }
    if (!isRecord(config)) throw new ProjectAuthContextError();
  }
  // The persisted config column is nullable. Other malformed values are not defaults.
  if (config === null) config = {};
  const candidate = { ref: row.ref, organization_id: row.organization_id, jwt_secret: row.jwt_secret, config };
  if (!Value.Check(projectAuthSchema, candidate) || candidate.ref !== ref) throw new ProjectAuthContextError();
  parseProjectAuthConfig(candidate.config.auth);
  return candidate;
}
