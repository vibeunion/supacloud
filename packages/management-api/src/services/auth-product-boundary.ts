import { renderGoTruePasskeyEnv } from "./tenant-runtime-config";

export class PasskeyConfigValidationError extends Error {
  readonly code = "INVALID_PASSKEY_CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "PasskeyConfigValidationError";
  }
}

export function canonicalizeStockPasskeyConfig(
  authConfig: Record<string, unknown>,
): Record<string, unknown> {
  const canonical = structuredClone(authConfig);
  if (Array.isArray(canonical.webauthn_rp_origins)) {
    canonical.webauthn_rp_origins = [...new Set(canonical.webauthn_rp_origins.map((origin) => {
      if (typeof origin !== "string") {
        throw new PasskeyConfigValidationError("webauthn_rp_origins must contain only strings");
      }
      return origin.trim();
    }).filter(Boolean))].join(",");
  }
  return canonical;
}

export function readStockPasskeyConfig(authConfig: Record<string, unknown>) {
  const passkey = authConfig.passkey && typeof authConfig.passkey === "object" && !Array.isArray(authConfig.passkey)
    ? authConfig.passkey as Record<string, unknown>
    : {};
  const webauthn = authConfig.webauthn && typeof authConfig.webauthn === "object" && !Array.isArray(authConfig.webauthn)
    ? authConfig.webauthn as Record<string, unknown>
    : {};
  const origins = authConfig.webauthn_rp_origins ?? webauthn.rp_origins ?? null;
  return {
    passkey_enabled: authConfig.passkey_enabled ?? passkey.enabled ?? false,
    webauthn_rp_display_name: authConfig.webauthn_rp_display_name ?? webauthn.rp_display_name ?? null,
    webauthn_rp_id: authConfig.webauthn_rp_id ?? webauthn.rp_id ?? null,
    webauthn_rp_origins: Array.isArray(origins) ? origins.join(",") : origins,
  };
}

export function validateStockPasskeyConfig(authConfig: Record<string, unknown>): void {
  try {
    renderGoTruePasskeyEnv(authConfig);
  } catch (error: unknown) {
    throw new PasskeyConfigValidationError(
      error instanceof Error ? error.message : "Invalid Passkey configuration",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedConfigKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * The local runtime supports stock GoTrue Passkeys, but not MFA WebAuthn
 * enrollment/verification. Reject those write shapes instead of persisting
 * settings that GoTrue will silently ignore.
 */
export function requestsUnavailableWebAuthnMfaConfig(authConfig: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(authConfig)) {
    const normalizedKey = normalizedConfigKey(key);
    if (normalizedKey.startsWith("mfawebauthn")) return true;
    if (normalizedKey === "mfa" && isRecord(value)) {
      if (Object.keys(value).some((nestedKey) => normalizedConfigKey(nestedKey) === "webauthn")) return true;
    }
  }
  return false;
}

export function unavailableWebAuthnMfaConfigBody() {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    feature: "auth_webauthn_mfa",
    message: "MFA WebAuthn enrollment and verification are not available in this runtime",
    experimental: true,
  };
}

export function passkeyConfigValidationBody(error: PasskeyConfigValidationError) {
  return {
    code: error.code,
    message: error.message,
    experimental: true,
  };
}
