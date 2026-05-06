import { config } from "../config";

export interface ProjectRoutingConfig {
  custom_domain?: unknown;
  api_domain?: unknown;
  studio_domain?: unknown;
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

function pickPort(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

export function normalizeBaseDomain(baseDomain: string): string {
  return baseDomain.trim().replace(/^(?:api|studio)\./i, "");
}

export function resolveProjectBaseHost(projectRef: string): string {
  return `${projectRef}.${normalizeBaseDomain(config.baseDomain)}`;
}

export function normalizeProjectRoutingConfig(
  projectConfig: ProjectRoutingConfig | string | null | undefined,
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
  return projectConfig;
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

  return `studio-${projectRef}.${normalizeBaseDomain(config.baseDomain)}`;
}

export function resolveProjectApiUrl(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  return `https://${resolveProjectApiHost(projectRef, projectConfig)}`;
}

export function resolveProjectStudioUrl(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): string {
  return `https://${resolveProjectStudioHost(projectRef, projectConfig)}`;
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
  projectConfig: ProjectRoutingConfig | string | null | undefined,
): boolean {
  const normalizedConfig = normalizeProjectRoutingConfig(projectConfig);
  const normalizedHost = host.split(":")[0].trim().toLowerCase();
  if (!normalizedHost) return false;

  const baseDomain = normalizeBaseDomain(config.baseDomain).toLowerCase();
  if (baseDomain && normalizedHost.endsWith(baseDomain)) {
    return normalizedHost === resolveProjectApiHost(projectRef, normalizedConfig).toLowerCase()
      || normalizedHost === resolveProjectStudioHost(projectRef, normalizedConfig).toLowerCase()
      || normalizedHost === `${projectRef}.${baseDomain}`.toLowerCase()
      || normalizedHost === `${projectRef}.api.${baseDomain}`.toLowerCase();
  }

  return normalizedHost === resolveProjectApiHost(projectRef, normalizedConfig).toLowerCase()
    || normalizedHost === resolveProjectStudioHost(projectRef, normalizedConfig).toLowerCase()
    || normalizedHost === pickString(normalizedConfig?.custom_domain)?.toLowerCase();
}
