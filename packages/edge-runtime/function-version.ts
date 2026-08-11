const CANONICAL_ACTIVE_VERSION_PATTERN = /^[1-9]\d{0,15}$/;
const CANONICAL_CONFIGURED_VERSION_PATTERN = /^(?:0|[1-9]\d{0,15})$/;

export function assertCanonicalConfiguredFunctionVersion(
  version: unknown,
): asserts version is string {
  if (
    typeof version !== "string" ||
    !CANONICAL_CONFIGURED_VERSION_PATTERN.test(version) ||
    !Number.isSafeInteger(Number(version))
  ) {
    throw new Error("Configured function version must be a canonical non-negative safe integer");
  }
}

export function assertCanonicalPositiveFunctionVersion(
  version: string | null | undefined,
): void {
  if (version === null || version === undefined) return;
  if (
    !CANONICAL_ACTIVE_VERSION_PATTERN.test(version) ||
    !Number.isSafeInteger(Number(version))
  ) {
    throw new Error("Function version must be a canonical positive safe integer");
  }
}

export function resolveFunctionVersionBinding(
  requestedVersion: string | null | undefined,
  configuredVersion: string | null,
): { activeVersion: string | null; responseVersion: string | null } {
  assertCanonicalPositiveFunctionVersion(requestedVersion);
  if (configuredVersion !== null) {
    assertCanonicalConfiguredFunctionVersion(configuredVersion);
  }
  const activeVersion = requestedVersion ?? configuredVersion;
  if (activeVersion === "0") return { activeVersion, responseVersion: null };
  assertCanonicalPositiveFunctionVersion(activeVersion);
  return {
    activeVersion,
    responseVersion: activeVersion,
  };
}

export function resolveTrustedBackgroundFunctionVersionBinding(
  requestedVersion: string | null | undefined,
  configuredVersion: string | null,
): { activeVersion: string | null; responseVersion: string | null } {
  if (requestedVersion === "0") {
    return { activeVersion: "0", responseVersion: null };
  }
  return resolveFunctionVersionBinding(requestedVersion, configuredVersion);
}
