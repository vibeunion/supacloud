import { lstat, open, realpath, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import { generateDbName, resolveBucketName, sql } from "../db";
import { projectRepository } from "../repositories/project.repository";
import { ApplicationActiveStorage } from "./application-active-storage";
import type { ApplicationPreviewServiceDependencies } from "./application-preview.service";
import { tenantRuntimeService } from "./tenant-runtime.service";
import { branchService } from "./branch.service";
import { normalizeProjectConfig } from "../utils/project-config";
import type { ApplicationDeploymentService } from "./application-deployment";
import { databaseService } from "./database.service";
import { PROJECT_STORAGE_SECRET } from "./project-storage-contract";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Empty legacy filesystem roots only; bound S3 prefixes require their own verifier. */
export async function cleanupEmptyPreviewStorage(branchRef: string, rootPath: string): Promise<void> {
  if (!/^pv[a-f0-9]{18}$/.test(branchRef)) throw new Error("APPLICATION_PREVIEW_CLEANUP_IDENTITY_MISMATCH");
  const root = resolve(rootPath);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("APPLICATION_PREVIEW_CLEANUP_STORAGE_UNSUPPORTED");
  }
  const directory = join(root, resolveBucketName(branchRef));
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("APPLICATION_PREVIEW_CLEANUP_STORAGE_UNSUPPORTED");
    await rmdir(directory);
  } catch (error) {
    if (!missing(error)) {
      if (error instanceof Error && "code" in error && ["ENOTEMPTY", "EEXIST"].includes(String(error.code))) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_STORAGE_OCCUPIED");
      }
      throw error;
    }
  }
  const handle = await open(root, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  try { await lstat(directory); }
  catch (error) { if (missing(error)) return; throw error; }
  throw new Error("APPLICATION_PREVIEW_CLEANUP_STORAGE_UNCONFIRMED");
}

export function createApplicationPreviewCleanupChecks(
  active: Pick<ApplicationActiveStorage, "readForApplication">,
  deployment: Pick<ApplicationDeploymentService, "deactivateConfigured">,
  options: {
    projects?: Pick<typeof projectRepository, "findByRef">;
    runtimeOccupied?: (branchRef: string) => Promise<boolean>;
  } = {},
): NonNullable<ApplicationPreviewServiceDependencies["cleanupChecks"]> {
  const projects = options.projects ?? projectRepository;
  const occupied = options.runtimeOccupied ?? (async (branchRef: string) => {
    const [state] = await sql<{ occupied: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM application_runtime_allocations
        WHERE project_ref = ${branchRef} AND retired_at IS NULL)
        OR EXISTS (SELECT 1 FROM project_mutations
          WHERE project_ref = ${branchRef}
            AND status IN ('pending', 'running', 'failed_retryable', 'outcome_unknown')) AS occupied
    `;
    if (!state) throw new Error("APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED");
    return state.occupied;
  });
  return {
    async assertSafe(receipt, automatic) {
      const branchRef = receipt.resources.database_branch.branch_ref;
      const branch = await projects.findByRef(branchRef);
      if (branch && (branch.ref !== branchRef || branch.db_name !== generateDbName(branchRef)
        || normalizeProjectConfig(branch.config)["parent_ref"] !== receipt.project_ref
        || normalizeProjectConfig(branch.config)["is_branch"] !== true)) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_IDENTITY_MISMATCH");
      }
      const current = await active.readForApplication(branchRef, receipt.application_id, receipt.environment_id);
      if (current && automatic) throw new Error("APPLICATION_PREVIEW_CLEANUP_ACTIVE");
      const activation = receipt.resources.application_activation;
      if (current && (current.runtime.activationId !== activation.activation_id
        || current.runtime.release.release_id !== receipt.release_id
        || current.configurationId !== receipt.resources.configuration_revision.configuration_id)) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_IDENTITY_MISMATCH");
      }
      if (activation.activation_id !== null) {
        if (!["ready", "cleaned"].includes(activation.status) || (automatic && activation.status !== "cleaned")) {
          throw new Error("APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED");
        }
      } else if (current) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_IDENTITY_MISMATCH");
      }
      if ((activation.activation_id === null || automatic) && await occupied(branchRef)) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED");
      }
    },
    async deactivateApplication(receipt) {
      const branchRef = receipt.resources.database_branch.branch_ref;
      const activationId = receipt.resources.application_activation.activation_id;
      if (activationId === null) throw new Error("APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED");
      await deployment.deactivateConfigured({
        projectRef: branchRef, applicationId: receipt.application_id, environmentId: receipt.environment_id,
        activationId, mutationId: receipt.preview_id,
        principal: { type: "master", id: "preview-cleanup" },
      });
      if (await occupied(branchRef)) throw new Error("APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED");
    },
    async cleanupStorage(receipt) {
      const branchRef = receipt.resources.database_branch.branch_ref;
      const [binding] = await sql`
        SELECT 1 FROM project_control_secrets WHERE project_ref = ${branchRef}
          AND scope = ${PROJECT_STORAGE_SECRET.scope} AND name = ${PROJECT_STORAGE_SECRET.name}
      `;
      if (binding || !["juicefs", "local"].includes(config.storageType)) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_STORAGE_UNSUPPORTED");
      }
      await cleanupEmptyPreviewStorage(branchRef, config.storageMountPoint);
    },
    async verifySecretDeleted(receipt) {
      const [secret] = await sql`
        SELECT 1 FROM project_secrets
        WHERE project_ref = ${receipt.resources.database_branch.branch_ref} AND name = ${receipt.test_secret_name}
      `;
      if (secret) throw new Error("APPLICATION_PREVIEW_CLEANUP_SECRET_UNCONFIRMED");
    },
    async verifyBranchDeleted(receipt) {
      const branchRef = receipt.resources.database_branch.branch_ref;
      const [database] = await sql`SELECT 1 FROM pg_database WHERE datname = ${generateDbName(branchRef)}`;
      if (database || await projectRepository.findByRef(branchRef)) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_BRANCH_UNCONFIRMED");
      }
      const runtime = await tenantRuntimeService.checkStatus(branchRef);
      if (runtime.status !== "stopped") throw new Error("APPLICATION_PREVIEW_CLEANUP_RUNTIME_UNCONFIRMED");
    },
    async databaseExists(receipt) {
      const [database] = await sql`SELECT 1 FROM pg_database
        WHERE datname = ${generateDbName(receipt.resources.database_branch.branch_ref)}`;
      return !!database;
    },
  };
}

export const previewBranches: NonNullable<ApplicationPreviewServiceDependencies["branches"]> = {
  createBranch: input => branchService.createBranch(input),
  deleteBranch: branchRef => branchService.deletePreviewBranch(branchRef),
};

export const previewSecrets: NonNullable<ApplicationPreviewServiceDependencies["secrets"]> = {
  upsertSecrets: async (ref, values) => {
    for (const { name, value } of values) if (!await databaseService.upsertSecret(ref, name, value)) return false;
    return true;
  },
  deleteSecret: (ref, name) => databaseService.deleteSecret(ref, name),
};
