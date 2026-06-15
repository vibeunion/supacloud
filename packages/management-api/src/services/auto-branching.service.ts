/**
 * Auto-Branching Service.
 *
 * When a Git push event arrives for a project's linked repository on a
 * non-base branch, this service automatically creates a preview branch.
 *
 * Configuration is stored per-project under projects.config.auto_branching:
 *   {
 *     enabled: boolean,
 *     git_url: string,          // The repository to watch
 *     base_branch: string,      // Branches pushed to base_branch do NOT create previews
 *     branch_prefix: string,    // Optional prefix for generated branch names
 *     exclude_patterns: string[] // Glob patterns for branches to skip (e.g. "dependabot/*")
 *   }
 */
import { projectRepository } from "../repositories/project.repository";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { branchService } from "./branch.service";
import { logger } from "../utils/logger";

export interface AutoBranchingConfig {
  enabled: boolean;
  git_url: string;
  base_branch: string;
  branch_prefix: string;
  exclude_patterns: string[];
}

const DEFAULT_CONFIG: AutoBranchingConfig = {
  enabled: false,
  git_url: "",
  base_branch: "main",
  branch_prefix: "",
  exclude_patterns: [],
};

export function readAutoBranchingConfig(
  projectConfig: unknown,
): AutoBranchingConfig {
  const cfg = normalizeProjectConfig(projectConfig);
  const raw = cfg.auto_branching as Record<string, unknown> | undefined;
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    enabled: raw.enabled === true,
    git_url: typeof raw.git_url === "string" ? raw.git_url : "",
    base_branch: typeof raw.base_branch === "string" ? raw.base_branch : "main",
    branch_prefix: typeof raw.branch_prefix === "string" ? raw.branch_prefix : "",
    exclude_patterns: Array.isArray(raw.exclude_patterns)
      ? raw.exclude_patterns.filter((p): p is string => typeof p === "string")
      : [],
  };
}

async function saveAutoBranchingConfig(
  ref: string,
  config: AutoBranchingConfig,
): Promise<void> {
  const project = await projectRepository.findByRef(ref);
  if (!project) throw new Error("Project not found");
  await projectRepository.updateConfig(
    ref,
    mergeProjectConfig(project.config, { auto_branching: config }),
  );
}

/**
 * Check if a branch name should be excluded from auto-branching.
 */
function isExcluded(branch: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple glob matching: * matches any chars
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    if (regex.test(branch)) return true;
  }
  return false;
}

/**
 * Check if a Git push event should trigger auto-branching for a project.
 * Returns true if the push matches the project's configured git_url and the
 * branch is not the base branch and not excluded.
 */
export function shouldAutoBranch(
  config: AutoBranchingConfig,
  gitUrl: string,
  branch: string,
): boolean {
  if (!config.enabled || !config.git_url) return false;
  if (!gitUrl || gitUrl !== config.git_url) return false;
  if (branch === config.base_branch) return false;
  if (isExcluded(branch, config.exclude_patterns)) return false;
  return true;
}

/**
 * Process a Git push event across all projects that have auto-branching
 * enabled for the given repository. Creates preview branches for matching
 * projects.
 *
 * This is called from the webhook handlers.
 */
export async function processAutoBranchingFromPush(
  gitUrl: string,
  branch: string,
  commitSha: string,
): Promise<{ project_ref: string; branch_ref: string; created: boolean; error?: string }[]> {
  const results: { project_ref: string; branch_ref: string; created: boolean; error?: string }[] = [];

  // Find all projects with auto-branching enabled for this repo.
  let projects: { ref: string; config: Record<string, unknown> }[] = [];
  try {
    const { sql } = await import("../db");
    const rows = await sql`
      SELECT ref, config FROM projects
      WHERE deleted_at IS NULL AND status = 'active'
    `;
    projects = rows.map((r: Record<string, unknown>) => ({
      ref: String(r.ref),
      config: normalizeProjectConfig(r.config),
    }));
  } catch (err: unknown) {
    logger.error("[auto-branching] failed to query projects", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  for (const { ref, config } of projects) {
    const autoConfig = readAutoBranchingConfig(config);
    if (!shouldAutoBranch(autoConfig, gitUrl, branch)) continue;

    // Derive a preview branch name.
    const branchName = autoConfig.branch_prefix
      ? `${autoConfig.branch_prefix}${branch}`
      : branch;

    // Check if a branch with this name already exists.
    const existingBranches = (config.branches as { name: string; ref: string }[] | undefined) || [];
    if (existingBranches.some((b) => b.name === branchName)) {
      // Already exists, skip.
      results.push({
        project_ref: ref,
        branch_ref: existingBranches.find((b) => b.name === branchName)!.ref,
        created: false,
      });
      continue;
    }

    // Create the preview branch asynchronously.
    const branchRef = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    try {
      // Record branch metadata first.
      const branches = [
        ...existingBranches,
        {
          ref: branchRef,
          name: branchName,
          parent_ref: ref,
          status: "creating",
          created_at: new Date().toISOString(),
          git_branch: branch,
          git_commit: commitSha,
        },
      ];
      await saveAutoBranchingConfig(ref, autoConfig); // preserve config
      await projectRepository.updateConfig(
        ref,
        mergeProjectConfig(config, { branches }),
      );

      // Provision the branch.
      branchService
        .createBranch({ parentRef: ref, branchRef, name: branchName })
        .then(async () => {
          const current = await projectRepository.findByRef(ref);
          if (!current) return;
          const cfg = normalizeProjectConfig(current.config);
          const updatedBranches = ((cfg.branches as { ref: string; status: string }[]) || []).map((b) =>
            b.ref === branchRef ? { ...b, status: "active" } : b,
          );
          await projectRepository.updateConfig(
            ref,
            mergeProjectConfig(current.config, { branches: updatedBranches }),
          );
        })
        .catch(async (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[auto-branching] failed for ${ref}/${branchName}`, { error: message });
          const current = await projectRepository.findByRef(ref);
          if (!current) return;
          const cfg = normalizeProjectConfig(current.config);
          const updatedBranches = ((cfg.branches as { ref: string; status: string; error?: string }[]) || []).map((b) =>
            b.ref === branchRef ? { ...b, status: "error", error: message } : b,
          );
          await projectRepository.updateConfig(
            ref,
            mergeProjectConfig(current.config, { branches: updatedBranches }),
          );
        });

      results.push({
        project_ref: ref,
        branch_ref: branchRef,
        created: true,
      });
    } catch (err: unknown) {
      results.push({
        project_ref: ref,
        branch_ref: "",
        created: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export { saveAutoBranchingConfig };
