const PROVIDER_LINKING_NAME = /^[A-Za-z0-9._:-]+$/;

export class ProviderLinkingDomainsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderLinkingDomainsValidationError";
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mappingEntry(rawName: unknown, rawDomain: unknown): [string, string] {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const domain = typeof rawDomain === "string" ? rawDomain.trim() : "";
  if (!name || !domain) {
    throw new ProviderLinkingDomainsValidationError("Provider linking names and domains must be non-empty strings");
  }
  if (!PROVIDER_LINKING_NAME.test(name) || !PROVIDER_LINKING_NAME.test(domain)) {
    throw new ProviderLinkingDomainsValidationError("Provider linking names and domains can contain only letters, numbers, dot, underscore, colon, or dash");
  }
  return [name, domain];
}

function legacyProviders(value: unknown): string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (!entries) {
    throw new ProviderLinkingDomainsValidationError("Legacy provider linking input must be a string or string array");
  }
  return entries.map((provider) => mappingEntry(provider, provider)[0]);
}

export function normalizedProviderLinkingDomains(experimentalValue: unknown): Record<string, string> {
  const experimental = recordValue(experimentalValue);
  if (!experimental) {
    if (experimentalValue === undefined || experimentalValue === null) return {};
    throw new ProviderLinkingDomainsValidationError("experimental must be an object");
  }
  const domains = new Map<string, string>();
  for (const provider of legacyProviders(experimental.providers_with_own_linking_domain)) {
    domains.set(provider, provider);
  }
  const configured = experimental.provider_linking_domains;
  if (configured !== undefined) {
    const configuredRecord = recordValue(configured);
    if (!configuredRecord) {
      throw new ProviderLinkingDomainsValidationError("provider_linking_domains must be an object map");
    }
    const configuredNames = new Set<string>();
    for (const [rawName, rawDomain] of Object.entries(configuredRecord)) {
      const [name, domain] = mappingEntry(rawName, rawDomain);
      if (configuredNames.has(name)) {
        throw new ProviderLinkingDomainsValidationError(`Duplicate provider linking name: ${name}`);
      }
      configuredNames.add(name);
      domains.set(name, domain);
    }
  }
  return Object.fromEntries([...domains.entries()].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
}

export function canonicalAuthProviderLinkingConfig(
  authConfig: Record<string, unknown>,
): Record<string, unknown> {
  const experimental = recordValue(authConfig.experimental);
  if (!experimental) {
    if (authConfig.experimental === undefined || authConfig.experimental === null) return authConfig;
    throw new ProviderLinkingDomainsValidationError("experimental must be an object");
  }
  const hasCanonical = "provider_linking_domains" in experimental;
  const hasLegacy = "providers_with_own_linking_domain" in experimental;
  if (!hasCanonical && !hasLegacy) return authConfig;
  const canonicalExperimental = { ...experimental };
  canonicalExperimental.provider_linking_domains = normalizedProviderLinkingDomains(experimental);
  delete canonicalExperimental.providers_with_own_linking_domain;
  return { ...authConfig, experimental: canonicalExperimental };
}

export function serializedProviderLinkingDomains(authConfig: Record<string, unknown>): string {
  const experimental = recordValue(authConfig.experimental);
  if (!experimental) {
    if (authConfig.experimental === undefined || authConfig.experimental === null) return "";
    throw new ProviderLinkingDomainsValidationError("experimental must be an object");
  }
  if ("providers_with_own_linking_domain" in experimental) {
    throw new ProviderLinkingDomainsValidationError(
      "Legacy provider linking config must be migrated before runtime rendering",
    );
  }
  const domains = normalizedProviderLinkingDomains({
    provider_linking_domains: experimental.provider_linking_domains,
  });
  return Object.entries(domains).map(([provider, domain]) => `${provider}=${domain}`).join(",");
}
