import { config } from "../config";

export interface ProjectRoutingConfig {
  custom_domain?: unknown;
  api_domain?: unknown;
  additional_api_domains?: unknown;
  api_domains?: unknown;
  auth_domain?: unknown;
  studio_domain?: unknown;
  external_url_scheme?: unknown;
  public_url_scheme?: unknown;
  url_scheme?: unknown;
  api_url_scheme?: unknown;
  auth_url_scheme?: unknown;
  studio_url_scheme?: unknown;
  postgrest_port?: unknown;
  gotrue_port?: unknown;
}

export interface TenantPorts {
  pgrstPort: number;
  gotruePort: number;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pickStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => pickString(item))
      .filter((item): item is string => Boolean(item));
  }

  const single = pickString(value);
  return single ? [single] : [];
}

function uniqueHosts(hosts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const host of hosts) {
    if (!host) continue;
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(host);
  }
  return result;
}

function pickPort(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function pickUrlScheme(value: unknown): "http" | "https" | undefined {
  if (value !== "http" && value !== "https") return undefined;
  return value;
}

function splitHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").split(":")[0].toLowerCase();
}

function isLocalHttpHost(host: string): boolean {
  const normalizedHost = splitHost(host);
  if (!normalizedHost) return true;
  if (
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".lan") ||
    normalizedHost.endsWith(".sslip.io") ||
    normalizedHost.endsWith(".nip.io")
  ) {
    return true;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalizedHost)) return true;
  if (normalizedHost.includes(":")) return true;

  return false;
}

function hasExplicitPublicHost(
  kind: "api" | "auth" | "studio",
  projectConfig: ProjectRoutingConfig | undefined,
): boolean {
  if (!projectConfig) return false;
  if (kind === "api") {
    return Boolean(pickString(projectConfig.api_domain) || pickString(projectConfig.custom_domain));
  }
  if (kind === "auth") {
    return Boolean(
      pickString(projectConfig.auth_domain) ||
      pickString(projectConfig.api_domain) ||
      pickString(projectConfig.custom_domain),
    );
  }
  return Boolean(
    pickString(projectConfig.studio_domain) ||
    pickString(projectConfig.custom_domain) ||
    deriveStudioHostFromApiHost(projectConfig.api_domain),
  );
}

function resolveProjectUrlScheme(
  kind: "api" | "auth" | "studio",
  host: string,
  projectConfig: ProjectRoutingConfig | undefined,
): "http" | "https" {
  const explicit =
    pickUrlScheme(projectConfig?.[`${kind}_url_scheme` as keyof ProjectRoutingConfig]) ||
    pickUrlScheme(projectConfig?.public_url_scheme) ||
    pickUrlScheme(projectConfig?.external_url_scheme) ||
    pickUrlScheme(projectConfig?.url_scheme);
  if (explicit) return explicit;
  if (config.enableSsl) return "https";
  if (hasExplicitPublicHost(kind, projectConfig) && !isLocalHttpHost(host)) return "https";
  return "http";
}

export function normalizeBaseDomain(baseDomain: string): string {
  return baseDomain.trim().replace(/^(?:api|studio)\./i, "");
}

export function deriveStudioHostFromApiHost(apiHost: unknown): string | undefined {
  const normalizedApiHost = pickString(apiHost);
  if (!normalizedApiHost || !normalizedApiHost.toLowerCase().startsWith("api.")) {
    return undefined;
  }

  const baseHost = normalizedApiHost.slice("api.".length);
  return baseHost.length > 0 ? `studio.${baseHost}` : undefined;
}

export function resolveProjectBaseHost(projectRef: string): string {
  return `${projectRef}.${normalizeBaseDomain(config.baseDomain)}`;
}

export function normalizeProjectRoutingConfig(
  projectConfig: unknown,
): ProjectRoutingConfig | undefined {
  if (!projectConfig) return undefined;
  if (typeof projectConfig === "string") {
    const trimmed = projectConfig.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as ProjectRoutingConfig;
        }
      } catch {
        // Fall through to legacy string-as-domain behavior.
      }
    }
    return { custom_domain: projectConfig };
  }
  if (typeof projectConfig === "object" && !Array.isArray(projectConfig)) {
    return projectConfig as ProjectRoutingConfig;
  }
  return undefined;
}

export function resolveProjectApiHost(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const explicitApiDomain = pickString(normalizedConfig?.api_domain);
  if (explicitApiDomain) return explicitApiDomain;

  const customDomain = pickString(normalizedConfig?.custom_domain);
  if (customDomain) {
    return customDomain.startsWith("api.") ? customDomain : `api.${customDomain}`;
  }

  return `${projectRef}.api.${normalizeBaseDomain(config.baseDomain)}`;
}

export function resolveProjectApiHosts(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string[] {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const canonicalHost = `${projectRef}.api.${normalizeBaseDomain(config.baseDomain)}`;
  return uniqueHosts([
    canonicalHost,
    resolveProjectApiHost(projectRef, normalizedConfig),
    ...pickStrings(normalizedConfig?.additional_api_domains),
    ...pickStrings(normalizedConfig?.api_domains),
  ]);
}

export function resolveProjectAuthHost(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const explicitAuthDomain = pickString(normalizedConfig?.auth_domain);
  if (explicitAuthDomain) return explicitAuthDomain;

  return resolveProjectApiHost(projectRef, normalizedConfig);
}

export function resolveProjectStudioHost(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const explicitStudioDomain = pickString(normalizedConfig?.studio_domain);
  if (explicitStudioDomain) return explicitStudioDomain;

  const customDomain = pickString(normalizedConfig?.custom_domain);
  if (customDomain) {
    return customDomain.startsWith("studio.") ? customDomain : `studio.${customDomain}`;
  }

  const derivedStudioDomain = deriveStudioHostFromApiHost(normalizedConfig?.api_domain);
  if (derivedStudioDomain) return derivedStudioDomain;

  return `studio-${projectRef}.${normalizeBaseDomain(config.baseDomain)}`;
}

export function resolveProjectApiUrl(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const host = resolveProjectApiHost(projectRef, normalizedConfig);
  return `${resolveProjectUrlScheme("api", host, normalizedConfig)}://${host}`;
}

export function resolveProjectAuthUrl(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const host = resolveProjectAuthHost(projectRef, normalizedConfig);
  return `${resolveProjectUrlScheme("auth", host, normalizedConfig)}://${host}`;
}

export function resolveProjectStudioUrl(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const host = resolveProjectStudioHost(projectRef, normalizedConfig);
  return `${resolveProjectUrlScheme("studio", host, normalizedConfig)}://${host}`;
}

export function resolveTenantPorts(
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): TenantPorts | null {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const pgrstPort = pickPort(normalizedConfig?.postgrest_port);
  const gotruePort = pickPort(normalizedConfig?.gotrue_port);
  if (!pgrstPort || !gotruePort) return null;
  return { pgrstPort, gotruePort };
}

export function matchProjectRefFromHost(
  host: string,
  projectRef: string,
  projectConfig: unknown,
): boolean {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const normalizedHost = host.split(":")[0].trim().toLowerCase();
  if (!normalizedHost) return false;

  const baseDomain = normalizeBaseDomain(config.baseDomain).toLowerCase();
  const knownHosts = uniqueHosts([
    ...resolveProjectApiHosts(projectRef, normalizedConfig),
    resolveProjectAuthHost(projectRef, normalizedConfig),
    resolveProjectStudioHost(projectRef, normalizedConfig),
    `${projectRef}.${baseDomain}`,
    `${projectRef}.api.${baseDomain}`,
    pickString(normalizedConfig?.custom_domain),
  ]).map((item) => item.toLowerCase());

  if (baseDomain && normalizedHost.endsWith(baseDomain)) {
    return knownHosts.includes(normalizedHost);
  }

  return knownHosts.includes(normalizedHost);
}
