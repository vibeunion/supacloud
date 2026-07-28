const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const ENCODED_CONTROL_CHARACTER_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

type AuthUrlConfigField = "SITE_URL" | "URI_ALLOW_LIST";

export class AuthUrlConfigValidationError extends Error {
  constructor(
    readonly field: AuthUrlConfigField,
    message: string,
  ) {
    super(message);
    this.name = "AuthUrlConfigValidationError";
  }
}

function hasOwnProperty(config: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function resolveConfigAlias(
  config: Record<string, unknown>,
  canonicalKey: string,
  uppercaseAlias: string,
): unknown {
  const hasCanonical = hasOwnProperty(config, canonicalKey);
  const hasAlias = hasOwnProperty(config, uppercaseAlias);
  if (hasCanonical && hasAlias && config[canonicalKey] !== config[uppercaseAlias]) {
    const field = canonicalKey === "site_url" ? "SITE_URL" : "URI_ALLOW_LIST";
    throw new AuthUrlConfigValidationError(field, `${canonicalKey} conflicts with ${uppercaseAlias}`);
  }
  if (hasCanonical) return config[canonicalKey];
  return hasAlias ? config[uppercaseAlias] : undefined;
}

function configFieldName(field: AuthUrlConfigField): "site_url" | "uri_allow_list" {
  return field === "SITE_URL" ? "site_url" : "uri_allow_list";
}

function assertSafeUrlText(rawUrl: string, field: AuthUrlConfigField): void {
  const fieldName = configFieldName(field);
  if (CONTROL_CHARACTER_PATTERN.test(rawUrl) || ENCODED_CONTROL_CHARACTER_PATTERN.test(rawUrl) || rawUrl.includes("\\")) {
    throw new AuthUrlConfigValidationError(field, `${fieldName} must not contain control characters or backslashes`);
  }
}

function parseAbsoluteHttpUrl(
  rawUrl: string,
  field: AuthUrlConfigField,
): { normalizedUrl: string; parsedUrl: URL } {
  assertSafeUrlText(rawUrl, field);
  const fieldName = configFieldName(field);
  const normalizedUrl = rawUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new AuthUrlConfigValidationError(field, `${fieldName} must contain only absolute HTTP(S) URLs`);
  }

  if (!parsedUrl.hostname || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
    throw new AuthUrlConfigValidationError(field, `${fieldName} must contain only absolute HTTP(S) URLs`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new AuthUrlConfigValidationError(field, `${fieldName} must not include userinfo`);
  }
  return { normalizedUrl, parsedUrl };
}

function validateSiteUrl(candidate: unknown): string {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new AuthUrlConfigValidationError("SITE_URL", "site_url must be a non-empty absolute HTTP(S) URL");
  }

  const { normalizedUrl, parsedUrl } = parseAbsoluteHttpUrl(candidate, "SITE_URL");
  if (parsedUrl.search || parsedUrl.hash) {
    throw new AuthUrlConfigValidationError("SITE_URL", "site_url must not include userinfo, query parameters, or fragments");
  }
  return normalizedUrl;
}

function validateUriAllowList(candidate: unknown): string {
  if (typeof candidate !== "string") {
    throw new AuthUrlConfigValidationError("URI_ALLOW_LIST", "uri_allow_list must be a comma-separated string of absolute HTTP(S) URLs");
  }
  assertSafeUrlText(candidate, "URI_ALLOW_LIST");
  if (!candidate.trim()) return "";

  const redirectUrls = candidate.split(",").map((url) => url.trim());
  if (redirectUrls.some((url) => !url)) {
    throw new AuthUrlConfigValidationError("URI_ALLOW_LIST", "uri_allow_list must not contain empty URL entries");
  }
  return redirectUrls
    .map((url) => parseAbsoluteHttpUrl(url, "URI_ALLOW_LIST").normalizedUrl)
    .join(",");
}

export function canonicalizeAuthUrlConfig(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  const siteUrl = resolveConfigAlias(input, "site_url", "SITE_URL");
  const uriAllowList = resolveConfigAlias(input, "uri_allow_list", "URI_ALLOW_LIST");

  delete normalized.SITE_URL;
  delete normalized.URI_ALLOW_LIST;
  if (siteUrl !== undefined) normalized.site_url = validateSiteUrl(siteUrl);
  if (uriAllowList !== undefined) normalized.uri_allow_list = validateUriAllowList(uriAllowList);

  return normalized;
}
