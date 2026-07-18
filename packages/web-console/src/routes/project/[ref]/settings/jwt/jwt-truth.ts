import {
  unwrapAuthApiObject,
  type JsonObject,
} from "../../auth-api-response";

export type AuthRuntimeMode = "local" | "owner" | "shared";
export type SigningSource = "oauth_status" | "unavailable";

export type AuthRuntimeDescriptor = {
  mode: AuthRuntimeMode;
  authorityProjectRef: string;
  ownerManagementPath: string | null;
  configurationManagement: string | null;
};

export type JwtTruth = {
  accessExpiry: number | null;
  signingAlgorithm: string | null;
  signingSource: SigningSource;
  signingKeyId: string | null;
  jwksUrl: string | null;
  issuer: string | null;
  migrationStatus: string | null;
  oauthEnabled: boolean | null;
  refreshRotation: boolean | null;
};

export function emptyJwtTruth(): JwtTruth {
  return {
    accessExpiry: null,
    signingAlgorithm: null,
    signingSource: "unavailable",
    signingKeyId: null,
    jwksUrl: null,
    issuer: null,
    migrationStatus: null,
    oauthEnabled: null,
    refreshRotation: null,
  };
}

function stringSetting(rawSetting: unknown): string | null {
  return typeof rawSetting === "string" && rawSetting.trim() ? rawSetting.trim() : null;
}

function numberSetting(rawSetting: unknown): number | null {
  if (rawSetting === null || rawSetting === undefined || rawSetting === "") return null;
  if (typeof rawSetting !== "number" && typeof rawSetting !== "string") return null;
  const parsedNumber = Number(rawSetting);
  return Number.isFinite(parsedNumber) && parsedNumber >= 0 ? parsedNumber : null;
}

function booleanSetting(rawSetting: unknown): boolean | null {
  if (rawSetting === true || rawSetting === "true" || rawSetting === 1) return true;
  if (rawSetting === false || rawSetting === "false" || rawSetting === 0) return false;
  return null;
}

function firstNumberSetting(source: JsonObject, keys: string[]): number | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const parsedNumber = numberSetting(source[key]);
    if (parsedNumber !== null) return parsedNumber;
  }
  return null;
}

function firstBooleanSetting(source: JsonObject, keys: string[]): boolean | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const parsedBoolean = booleanSetting(source[key]);
    if (parsedBoolean !== null) return parsedBoolean;
  }
  return null;
}

function signingAlgorithm(rawAlgorithm: unknown): string | null {
  const algorithm = stringSetting(rawAlgorithm);
  if (!algorithm || algorithm === "unknown" || algorithm === "not_migrated") return null;
  return algorithm;
}

export function normalizeAuthRuntime(payload: unknown): AuthRuntimeDescriptor | null {
  const runtime = unwrapAuthApiObject(payload);
  const mode = runtime.mode;
  const authorityProjectRef = stringSetting(runtime.authority_project_ref);
  if ((mode !== "local" && mode !== "owner" && mode !== "shared") || !authorityProjectRef) return null;
  return {
    mode,
    authorityProjectRef,
    ownerManagementPath: stringSetting(runtime.owner_management_path),
    configurationManagement: stringSetting(runtime.configuration_management),
  };
}

export function buildJwtTruth(authPayload: unknown, oauthPayload: unknown): JwtTruth {
  const authConfig = unwrapAuthApiObject(authPayload);
  const oauthStatus = unwrapAuthApiObject(oauthPayload);
  const algorithm = signingAlgorithm(oauthStatus.signing_alg);
  return {
    accessExpiry: firstNumberSetting(authConfig, ["jwt_expiry", "jwt_exp"]),
    signingAlgorithm: algorithm,
    signingSource: algorithm ? "oauth_status" : "unavailable",
    signingKeyId: stringSetting(oauthStatus.key_id),
    jwksUrl: stringSetting(oauthStatus.jwks_url),
    issuer: stringSetting(oauthStatus.issuer),
    migrationStatus: stringSetting(oauthStatus.migration_status),
    oauthEnabled: booleanSetting(oauthStatus.enabled),
    refreshRotation: firstBooleanSetting(authConfig, [
      "refresh_token_rotation_enabled",
      "security_refresh_token_rotation_enabled",
    ]),
  };
}
