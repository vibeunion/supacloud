import {
  deriveStudioHostFromApiHost,
  normalizeProjectRoutingConfig,
  resolveProjectApiHost,
  resolveProjectApiHosts,
  resolveProjectApiUrl,
  resolveProjectAuthHost,
  resolveProjectAuthUrl,
  resolveProjectStudioHost,
  resolveProjectStudioUrl,
  type ProjectRoutingConfig,
} from "./project-routing";

export const PROJECT_ENDPOINTS_SCHEMA = "supacloud.project-endpoints.v1" as const;

export const PROJECT_ENDPOINT_SOURCES = [
  "explicit_api_domain",
  "explicit_auth_domain",
  "explicit_studio_domain",
  "custom_domain",
  "derived_api_domain",
  "generated",
] as const;

export type ProjectEndpointSource = typeof PROJECT_ENDPOINT_SOURCES[number];
export type ProjectEndpointScheme = "http" | "https";

export interface ProjectEndpointProjection {
  origin: string;
  host: string;
  scheme: ProjectEndpointScheme;
  source: ProjectEndpointSource;
  aliases: string[];
}

export interface ProjectEndpointsProjection {
  schema: typeof PROJECT_ENDPOINTS_SCHEMA;
  project_ref: string;
  endpoints: {
    api: ProjectEndpointProjection;
    auth: ProjectEndpointProjection;
    studio: ProjectEndpointProjection;
  };
}

function configuredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function apiSource(projectConfig: ProjectRoutingConfig | undefined): ProjectEndpointSource {
  if (configuredString(projectConfig?.api_domain)) return "explicit_api_domain";
  if (configuredString(projectConfig?.custom_domain)) return "custom_domain";
  return "generated";
}

function authSource(projectConfig: ProjectRoutingConfig | undefined): ProjectEndpointSource {
  if (configuredString(projectConfig?.auth_domain)) return "explicit_auth_domain";
  if (configuredString(projectConfig?.api_domain)) return "explicit_api_domain";
  if (configuredString(projectConfig?.custom_domain)) return "custom_domain";
  return "generated";
}

function studioSource(projectConfig: ProjectRoutingConfig | undefined): ProjectEndpointSource {
  if (configuredString(projectConfig?.studio_domain)) return "explicit_studio_domain";
  if (configuredString(projectConfig?.custom_domain)) return "custom_domain";
  if (deriveStudioHostFromApiHost(projectConfig?.api_domain)) return "derived_api_domain";
  return "generated";
}

function canonicalHost(candidate: string, scheme: ProjectEndpointScheme): string | null {
  try {
    const parsed = new URL(`${scheme}://${candidate}`);
    return parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
      ? null
      : parsed.host;
  } catch {
    return null;
  }
}

function endpointProjection(
  origin: string,
  expectedHost: string,
  source: ProjectEndpointSource,
  aliases: readonly string[] = [],
): ProjectEndpointProjection {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported project endpoint protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Project endpoint origin must not include credentials, path, query, or fragment");
  }

  const scheme = parsed.protocol.slice(0, -1) as ProjectEndpointScheme;
  const host = parsed.host;
  const normalizedExpectedHost = canonicalHost(expectedHost, scheme);
  if (!normalizedExpectedHost || normalizedExpectedHost !== host) {
    throw new Error("Project endpoint host does not match its resolved origin");
  }

  const normalizedAliases = aliases
    .map((alias) => canonicalHost(alias, scheme))
    .filter((alias): alias is string => Boolean(alias) && alias !== host);

  return {
    origin: parsed.origin,
    host,
    scheme,
    source,
    aliases: [...new Set(normalizedAliases)],
  };
}

export function buildProjectEndpointsProjection(
  projectRef: string,
  rawProjectConfig: unknown,
): ProjectEndpointsProjection {
  const projectConfig = normalizeProjectRoutingConfig(rawProjectConfig);
  const apiHost = resolveProjectApiHost(projectRef, projectConfig);
  const authHost = resolveProjectAuthHost(projectRef, projectConfig);
  const studioHost = resolveProjectStudioHost(projectRef, projectConfig);

  return {
    schema: PROJECT_ENDPOINTS_SCHEMA,
    project_ref: projectRef,
    endpoints: {
      api: endpointProjection(
        resolveProjectApiUrl(projectRef, projectConfig),
        apiHost,
        apiSource(projectConfig),
        resolveProjectApiHosts(projectRef, projectConfig),
      ),
      auth: endpointProjection(
        resolveProjectAuthUrl(projectRef, projectConfig),
        authHost,
        authSource(projectConfig),
      ),
      studio: endpointProjection(
        resolveProjectStudioUrl(projectRef, projectConfig),
        studioHost,
        studioSource(projectConfig),
      ),
    },
  };
}
