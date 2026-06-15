/**
 * Project Branching routes.
 *
 * A branch is a lightweight preview project cloned from a parent project's
 * database. Each branch gets its own ref, its own PostgREST/GoTrue runtime,
 * and shares the parent's JWT/anon key so the same client SDK works against it.
 *
 * Branch metadata is stored under `projects.config.branches` on the parent and
 * the branch itself is a normal project row with `parent_ref` in its config.
 */
import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { branchService } from "../services/branch.service";
import { logger } from "../utils/logger";

export interface BranchRecord {
  ref: string;
  name: string;
  parent_ref: string;
  status: "creating" | "active" | "deleting" | "error";
  created_at: string;
  error?: string;
}

function readBranches(projectConfig: unknown): BranchRecord[] {
  const cfg = normalizeProjectConfig(projectConfig as Record<string, unknown> | null | undefined);
  const raw = cfg.branches;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (b): b is BranchRecord =>
      !!b && typeof b === "object" && typeof (b as BranchRecord).ref === "string",
  );
}

async function saveBranches(parentRef: string, branches: BranchRecord[]): Promise<void> {
  const project = await projectRepository.findByRef(parentRef);
  if (!project) throw new Error("Parent project not found");
  await projectRepository.updateConfig(
    parentRef,
    mergeProjectConfig(project.config, { branches }),
  );
}

export const branchRoutes = new Elysia({ prefix: "/v1/projects/:ref/branches" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });
    const branches = readBranches(project.config);
    return { project_ref: params.ref, branches };
  }, {
    detail: { tags: ["branches"], summary: "List project branches" },
  })
  .post("", async ({ params, body }) => {
    const input = body as { name: string };
    if (!input.name?.trim()) {
      return status(400, { error: "Branch name is required" });
    }
    const name = input.name.trim().slice(0, 80);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return status(400, { error: "Branch name may only contain letters, numbers, dots, dashes, underscores" });
    }

    const parent = await projectRepository.findByRef(params.ref);
    if (!parent) return status(404, { error: "Parent project not found" });

    // Reject creating a branch from a branch.
    const parentCfg = normalizeProjectConfig(parent.config);
    if (typeof parentCfg.parent_ref === "string" && parentCfg.parent_ref) {
      return status(400, { error: "Cannot create a branch from another branch; branch from the parent project instead" });
    }

    const existing = readBranches(parent.config);
    if (existing.some((b) => b.name === name)) {
      return status(409, { error: `A branch named '${name}' already exists` });
    }

    const branchRef = await import("crypto").then((m) => m.randomUUID().replace(/-/g, "").slice(0, 20));
    const now = new Date().toISOString();
    const record: BranchRecord = {
      ref: branchRef,
      name,
      parent_ref: params.ref,
      status: "creating",
      created_at: now,
    };

    await saveBranches(params.ref, [...existing, record]);

    // Provision the branch asynchronously (DB clone + runtime).
    branchService
      .createBranch({ parentRef: params.ref, branchRef, name })
      .then(async () => {
        const current = await projectRepository.findByRef(params.ref);
        if (!current) return;
        const branches = readBranches(current.config).map((b) =>
          b.ref === branchRef ? { ...b, status: "active" as const } : b,
        );
        await saveBranches(params.ref, branches);
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[branches] failed to create branch ${branchRef}`, { error: message });
        const current = await projectRepository.findByRef(params.ref);
        if (!current) return;
        const branches = readBranches(current.config).map((b) =>
          b.ref === branchRef ? { ...b, status: "error" as const, error: message } : b,
        );
        await saveBranches(params.ref, branches);
      });

    return { created: true, project_ref: params.ref, branch: record };
  }, {
    body: t.Object({
      name: t.String(),
    }),
    detail: { tags: ["branches"], summary: "Create a preview branch" },
  })
  .delete("/:branchRef", async ({ params }) => {
    const parent = await projectRepository.findByRef(params.ref);
    if (!parent) return status(404, { error: "Parent project not found" });

    const branches = readBranches(parent.config);
    const target = branches.find((b) => b.ref === params.branchRef);
    if (!target) return status(404, { error: "Branch not found" });

    // Mark as deleting, then clean up asynchronously.
    const marked = branches.map((b) =>
      b.ref === params.branchRef ? { ...b, status: "deleting" as const } : b,
    );
    await saveBranches(params.ref, marked);

    branchService
      .deleteBranch(params.branchRef)
      .then(async () => {
        // Only remove metadata after successful cleanup.
        const current = await projectRepository.findByRef(params.ref);
        if (!current) return;
        const remaining = readBranches(current.config).filter((b) => b.ref !== params.branchRef);
        await saveBranches(params.ref, remaining);
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[branches] failed to clean up branch ${params.branchRef}`, {
          error: message,
        });
        // On failure, mark as error and keep the record so it can be retried.
        const current = await projectRepository.findByRef(params.ref);
        if (!current) return;
        const updated = readBranches(current.config).map((b) =>
          b.ref === params.branchRef ? { ...b, status: "error" as const, error: message } : b,
        );
        await saveBranches(params.ref, updated);
      });

    return { deleted: true, project_ref: params.ref, branch_ref: params.branchRef };
  }, {
    detail: { tags: ["branches"], summary: "Delete a preview branch" },
  })
  .post("/:branchRef/promote", async ({ params }) => {
    // Promote: dump branch DB schema+data and restore into parent.
    const parent = await projectRepository.findByRef(params.ref);
    if (!parent) return status(404, { error: "Parent project not found" });

    const branches = readBranches(parent.config);
    const target = branches.find((b) => b.ref === params.branchRef);
    if (!target) return status(404, { error: "Branch not found" });

    try {
      await branchService.promoteBranch({ parentRef: params.ref, branchRef: params.branchRef });
      return { promoted: true, project_ref: params.ref, branch_ref: params.branchRef };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[branches] failed to promote branch ${params.branchRef}`, { error: message });
      return status(500, { error: message });
    }
  }, {
    detail: { tags: ["branches"], summary: "Promote a branch back to parent (overwrite parent DB)" },
  });
