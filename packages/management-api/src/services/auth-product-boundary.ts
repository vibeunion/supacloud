const PASSKEY_CAPABILITY_REASON = "gotrue_passkey_ceremony_unavailable";

function normalizedAuthFieldName(fieldName: string): string {
  return fieldName.replaceAll(/[_-]/g, "").toLowerCase();
}

function isUnavailableWebAuthnField(fieldName: string): boolean {
  const normalized = normalizedAuthFieldName(fieldName);
  return normalized.startsWith("passkey")
    || normalized.startsWith("webauthn")
    || normalized.startsWith("mfawebauthn");
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function hasNestedMfaWebAuthn(candidate: unknown): boolean {
  return isRecord(candidate)
    && Object.keys(candidate).some((fieldName) => normalizedAuthFieldName(fieldName).startsWith("webauthn"));
}

export function requestsUnavailablePasskeyConfig(authConfig: Record<string, unknown>): boolean {
  return Object.entries(authConfig).some(([fieldName, fieldSetting]) =>
    isUnavailableWebAuthnField(fieldName)
      || (normalizedAuthFieldName(fieldName) === "mfa" && hasNestedMfaWebAuthn(fieldSetting)),
  );
}

export function withoutUnavailablePasskeyConfig(
  authConfig: Record<string, unknown>,
): Record<string, unknown> {
  const publicConfig = structuredClone(authConfig);
  for (const [fieldName, fieldSetting] of Object.entries(publicConfig)) {
    if (isUnavailableWebAuthnField(fieldName)) {
      delete publicConfig[fieldName];
      continue;
    }
    if (normalizedAuthFieldName(fieldName) === "mfa" && isRecord(fieldSetting)) {
      for (const mfaFieldName of Object.keys(fieldSetting)) {
        if (normalizedAuthFieldName(mfaFieldName).startsWith("webauthn")) delete fieldSetting[mfaFieldName];
      }
    }
  }
  return publicConfig;
}

export function passkeyCapabilityUnavailableBody() {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    message: "Passkey and WebAuthn configuration is unavailable until a stock GoTrue ceremony is verified",
    reason_code: PASSKEY_CAPABILITY_REASON,
  };
}
