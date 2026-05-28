export function normalizeProjectConfig(
  value: unknown,
): Record<string, unknown> {
  if (!value) return {};

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};

    try {
      const parsed = JSON.parse(trimmed);
      return isRecord(parsed) ? { ...parsed } : {};
    } catch {
      return {};
    }
  }

  return isRecord(value) ? { ...value } : {};
}

export function mergeProjectConfig(
  current: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...normalizeProjectConfig(current),
    ...patch,
  };
}

export function normalizeOAuthServerConfig(value: unknown): Record<string, unknown> {
  const config = isRecord(value) ? { ...value } : {};
  if (typeof config.authorizationPath === "string" && typeof config.authorization_path !== "string") {
    config.authorization_path = config.authorizationPath;
  }
  delete config.authorizationPath;
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
