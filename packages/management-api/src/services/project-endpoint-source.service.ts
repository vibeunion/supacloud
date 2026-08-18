import { projectRepository } from "../repositories/project.repository";
import {
  normalizeProjectRoutingConfig,
  type ProjectRoutingConfig,
} from "../utils/project-routing";

const PROJECT_ENDPOINT_ROUTING_KEYS = [
  "custom_domain",
  "api_domain",
  "additional_api_domains",
  "api_domains",
  "auth_domain",
  "studio_domain",
  "external_url_scheme",
  "public_url_scheme",
  "url_scheme",
  "api_url_scheme",
  "auth_url_scheme",
  "studio_url_scheme",
] as const satisfies readonly (keyof ProjectRoutingConfig)[];

export interface ProjectEndpointRoutingSource {
  ref: string;
  config: ProjectRoutingConfig | undefined;
}

function endpointRoutingConfig(rawConfig: unknown): ProjectRoutingConfig | undefined {
  const normalized = normalizeProjectRoutingConfig(rawConfig);
  if (!normalized) return undefined;

  const projected: Record<string, unknown> = {};
  for (const key of PROJECT_ENDPOINT_ROUTING_KEYS) {
    const value = normalized[key];
    if (value !== undefined) projected[key] = value;
  }
  return Object.keys(projected).length > 0
    ? projected as ProjectRoutingConfig
    : undefined;
}

/**
 * Read only the fields required to calculate authoritative endpoint origins.
 *
 * `projectService.listProjects()` intentionally returns public project summaries
 * and therefore omits the private project config. Fleet endpoint projection must
 * not infer custom domains from those summaries. This source also strips every
 * non-routing config key before the route builds its credential-free projection.
 */
export const projectEndpointSourceService = {
  async listRoutingSources(): Promise<ProjectEndpointRoutingSource[]> {
    const projects = await projectRepository.findAll();
    return projects.map((project) => ({
      ref: project.ref,
      config: endpointRoutingConfig(project.config),
    }));
  },
};
