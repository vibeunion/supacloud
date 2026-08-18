import { projectRepository } from "../repositories/project.repository";

export interface ProjectEndpointRoutingSource {
  ref: string;
  config: unknown;
}

/**
 * Read only the fields required to calculate authoritative endpoint origins.
 *
 * `projectService.listProjects()` intentionally returns public project summaries
 * and therefore omits the private project config. Fleet endpoint projection must
 * not infer custom domains from those summaries, and it must not expose the full
 * project record either.
 */
export const projectEndpointSourceService = {
  async listRoutingSources(): Promise<ProjectEndpointRoutingSource[]> {
    const projects = await projectRepository.findAll();
    return projects.map((project) => ({
      ref: project.ref,
      config: project.config,
    }));
  },
};
