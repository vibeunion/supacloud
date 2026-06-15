/**
 * Auto-Branching configuration routes.
 *
 * Lets project admins configure automatic creation of preview branches when
 * a Git push event matches the project's linked repository.
 *
 * Stored under projects.config.auto_branching.
 */
import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { mergeProjectConfig } from "../utils/project-config";
import {
  readAutoBranchingConfig,
  saveAutoBranchingConfig,
  type AutoBranchingConfig,
} from "../services/auto-branching.service";

export const autoBranchingRoutes = new Elysia({ prefix: "/v1/projects/:ref/auto-branching" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })

  // GET -> Read current auto-branching config
  .get("", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });
    const config = readAutoBranchingConfig(project.config);
    return { project_ref: params.ref, config };
  }, {
    detail: { tags: ["auto-branching"], summary: "Get auto-branching configuration" },
  })

  // PUT -> Update auto-branching config
  .put("", async ({ params, body }) => {
    const input = body as Partial<AutoBranchingConfig>;
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });

    const current = readAutoBranchingConfig(project.config);
    const updated: AutoBranchingConfig = {
      enabled: input.enabled ?? current.enabled,
      git_url: input.git_url ?? current.git_url,
      base_branch: input.base_branch ?? current.base_branch,
      branch_prefix: input.branch_prefix ?? current.branch_prefix,
      exclude_patterns: input.exclude_patterns ?? current.exclude_patterns,
    };

    await saveAutoBranchingConfig(params.ref, updated);
    return { project_ref: params.ref, config: updated };
  }, {
    body: t.Object({
      enabled: t.Optional(t.Boolean()),
      git_url: t.Optional(t.String()),
      base_branch: t.Optional(t.String()),
      branch_prefix: t.Optional(t.String()),
      exclude_patterns: t.Optional(t.Array(t.String())),
    }),
    detail: { tags: ["auto-branching"], summary: "Update auto-branching configuration" },
  })

  // DELETE -> Disable auto-branching
  .delete("", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });
    await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, { auto_branching: { enabled: false } }),
    );
    return { project_ref: params.ref, disabled: true };
  }, {
    detail: { tags: ["auto-branching"], summary: "Disable auto-branching" },
  });
