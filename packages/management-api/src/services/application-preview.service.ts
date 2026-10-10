import { randomBytes, randomUUID } from "node:crypto";
import { branchService } from "./branch.service";
import { pgmqService } from "./pgmq.service";
import { projectService } from "./project.service";
import { runtimeCacheService } from "./runtime-cache.service";
import { tenantRuntimeService } from "./tenant-runtime.service";
import { projectRepository } from "../repositories/project.repository";
import { ApplicationPreviewConflictError } from "../repositories/project-config-writes";
import { normalizeProjectConfig } from "../utils/project-config";
import { logger } from "../utils/logger";
import {
  buildApplicationPreviewReceipt,
  type ApplicationPreviewReceipt,
  type StoredApplicationPreview,
} from "./application-preview-contract";
import type { ApplicationReleaseStorage } from "./application-release-storage";
import type { ApplicationConfigurations } from "./application-configuration";

type PreviewDataMode = "schema_only" | "full_clone";

function previewList(config: unknown): StoredApplicationPreview[] {
  const raw = normalizeProjectConfig(config as Record<string, unknown> | null | undefined)["application_previews"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is StoredApplicationPreview =>
      !!item && typeof item === "object" && (item as StoredApplicationPreview).schema === "supacloud.application-preview.v1"
      && typeof (item as StoredApplicationPreview).preview_id === "string")
    .map(item => ({
      ...item,
      source_configuration_id: item.source_configuration_id ?? null,
      resources: {
        ...item.resources,
        configuration_revision: item.resources.configuration_revision ?? { status: "pending", configuration_id: null },
        application_activation: item.resources.application_activation ?? { status: "pending", activation_id: null },
      },
    }));
}

function previewId(value: string): boolean {
  return /^[a-f0-9-]{8,64}$/.test(value);
}

function branchRefFor(preview: string): string {
  return `pv${preview.replace(/-/g, "").slice(0, 18)}`;
}

function queueNameFor(preview: string): string {
  return `preview_${preview.replace(/-/g, "").slice(0, 40)}`;
}

function secretNameFor(preview: string): string {
  return `PREVIEW_TOKEN_${preview.replace(/-/g, "").slice(0, 40).toUpperCase()}`;
}

function storedReceipt(
  receipt: ApplicationPreviewReceipt,
  input: { branchName: string; queueName: string; testSecretName: string; sourceConfigurationId: string | null },
): StoredApplicationPreview {
  const now = new Date().toISOString();
  return {
    ...receipt,
    branch_name: input.branchName,
    queue_name: input.queueName,
    test_secret_name: input.testSecretName,
    source_configuration_id: input.sourceConfigurationId,
    created_at: now,
    updated_at: now,
  };
}

type PreviewDependencies = Omit<ApplicationPreviewServiceDependencies, "branches" | "queues" | "projects" | "secrets" | "invalidateEnv" | "runtime">
  & {
    branches: NonNullable<ApplicationPreviewServiceDependencies["branches"]>;
    queues: NonNullable<ApplicationPreviewServiceDependencies["queues"]>;
    projects: NonNullable<ApplicationPreviewServiceDependencies["projects"]>;
    secrets: NonNullable<ApplicationPreviewServiceDependencies["secrets"]>;
    invalidateEnv: NonNullable<ApplicationPreviewServiceDependencies["invalidateEnv"]>;
    runtime: NonNullable<ApplicationPreviewServiceDependencies["runtime"]>;
    smokeTest: NonNullable<ApplicationPreviewServiceDependencies["smokeTest"]>;
  };

export interface ApplicationPreviewServiceDependencies {
  releases: Pick<ApplicationReleaseStorage, "readRelease">
    & Partial<Pick<ApplicationReleaseStorage, "materializeRelease">>;
  branches?: Pick<typeof branchService, "createBranch" | "deleteBranch">;
  queues?: Pick<typeof pgmqService, "createQueue" | "dropQueue" | "listQueues">;
  projects?: Pick<typeof projectRepository, "findByRef" | "saveApplicationPreview">;
  secrets?: Pick<typeof projectService, "upsertSecrets" | "deleteSecret">;
  invalidateEnv?: (ref: string) => Promise<boolean>;
  runtime?: Pick<typeof tenantRuntimeService, "checkStatus">;
  configurations?: Pick<ApplicationConfigurations, "clone">;
  activate?: (input: {
    projectRef: string;
    branchRef: string;
    applicationId: string;
    environmentId: string;
    releaseId: string;
    configurationId: string;
  }) => Promise<{ activation_id: string }>;
  smokeTest?: (input: {
    projectRef: string;
    branchRef: string;
    applicationId: string;
    environmentId: string;
    releaseId: string;
  }) => Promise<{ passed: string[]; failed: string[] }>;
}

export class ApplicationPreviewService {
  private readonly dependencies: PreviewDependencies;
  private readonly provisioning = new Map<string, Promise<void>>();

  constructor(dependencies: ApplicationPreviewServiceDependencies) {
    this.dependencies = {
      branches: branchService,
      queues: pgmqService,
      projects: projectRepository,
      secrets: projectService,
      invalidateEnv: runtimeCacheService.invalidateProjectRuntimeEnv,
      runtime: tenantRuntimeService,
      smokeTest: async () => ({ passed: [], failed: ["application_readiness"] }),
      ...dependencies,
    };
  }

  async list(projectRef: string, applicationId: string, environmentId: string): Promise<StoredApplicationPreview[]> {
    const project = await this.dependencies.projects.findByRef(projectRef);
    if (!project) return [];
    const previews = previewList(project.config).filter((item) =>
      item.application_id === applicationId && item.environment_id === environmentId);
    await this.reconcilePending(projectRef, previews);
    const refreshed = await this.dependencies.projects.findByRef(projectRef);
    return previewList(refreshed?.config).filter((item) =>
      item.application_id === applicationId && item.environment_id === environmentId);
  }

  async get(projectRef: string, id: string): Promise<StoredApplicationPreview | null> {
    if (!previewId(id)) return null;
    const project = await this.dependencies.projects.findByRef(projectRef);
    const receipt = previewList(project?.config).find((item) => item.preview_id === id) ?? null;
    if (receipt) await this.reconcilePending(projectRef, [receipt]);
    const refreshed = await this.dependencies.projects.findByRef(projectRef);
    return previewList(refreshed?.config).find((item) => item.preview_id === id) ?? receipt;
  }

  async create(input: {
    projectRef: string;
    applicationId: string;
    environmentId: string;
    releaseId: string;
    configurationId?: string;
    branchName?: string;
    dataMode?: PreviewDataMode;
  }): Promise<StoredApplicationPreview> {
    const sourceRelease = await this.dependencies.releases.readRelease(input.projectRef, input.applicationId, input.releaseId);
    const id = randomUUID();
    const branchRef = branchRefFor(id);
    const release = this.dependencies.releases.materializeRelease
      ? await this.dependencies.releases.materializeRelease(
        input.projectRef, input.applicationId, sourceRelease.release_id, branchRef,
      )
      : sourceRelease;
    const queueName = queueNameFor(id);
    const testSecretName = secretNameFor(id);
    const receipt = storedReceipt(
      buildApplicationPreviewReceipt({
        previewId: id,
        projectRef: input.projectRef,
        applicationId: input.applicationId,
        environmentId: input.environmentId,
        releaseId: release.release_id,
        branchRef,
        dataMode: input.dataMode ?? "schema_only",
      }),
      {
        branchName: input.branchName?.trim() || `app-${input.applicationId}-${id.slice(0, 8)}`,
        queueName,
        testSecretName,
        sourceConfigurationId: input.configurationId ?? null,
      },
    );
    receipt.status = "provisioning";
    await this.save(input.projectRef, receipt, true);
    this.startProvisioning(input.projectRef, receipt);
    return receipt;
  }

  async cleanup(projectRef: string, previewId: string): Promise<StoredApplicationPreview | null> {
    const current = await this.get(projectRef, previewId);
    if (!current || current.status === "cleaned") return current;
    const next = structuredClone(current);
    try {
      await this.dependencies.queues.dropQueue(projectRef === current.project_ref ? current.resources.database_branch.branch_ref : projectRef, current.queue_name);
    } catch {
      // Cleanup remains retryable; branch teardown is still attempted.
    }
    try { await this.dependencies.secrets.deleteSecret(current.resources.database_branch.branch_ref, current.test_secret_name); } catch { /* retryable */ }
    try { await this.dependencies.invalidateEnv(current.resources.database_branch.branch_ref); } catch { /* best effort */ }
    try { await this.dependencies.branches.deleteBranch(current.resources.database_branch.branch_ref); } catch {
      next.cleanup.error = "APPLICATION_PREVIEW_CLEANUP_FAILED";
      next.status = "failed";
      await this.save(projectRef, next);
      return next;
    }
    next.status = "cleaned";
    next.cleanup = { required: false, completed: true, error: null };
    next.resources.database_branch.status = "cleaned";
    next.resources.queue_namespace.status = "cleaned";
    next.resources.storage_namespace.status = "cleaned";
    next.resources.test_secret.status = "cleaned";
    await this.save(projectRef, next);
    return next;
  }

  private async provision(projectRef: string, initial: StoredApplicationPreview): Promise<void> {
    const receipt = structuredClone(initial);
    const branchRef = receipt.resources.database_branch.branch_ref;
    try {
      const existingBranch = await this.dependencies.projects.findByRef(branchRef);
      if (!existingBranch || existingBranch.ref !== branchRef) {
        await this.dependencies.branches.createBranch({
          parentRef: projectRef,
          branchRef,
          name: receipt.branch_name,
          dataMode: receipt.resources.database_branch.data_mode,
        });
      } else if (existingBranch.config?.["parent_ref"] !== projectRef) {
        throw new Error("APPLICATION_PREVIEW_BRANCH_IDENTITY_CONFLICT");
      }
      receipt.resources.database_branch.status = "ready";
      await this.save(projectRef, receipt);

      if (this.dependencies.configurations) {
        const configuration = await this.dependencies.configurations.clone(
          { projectRef, applicationId: receipt.application_id, environmentId: receipt.environment_id },
          { projectRef: branchRef, applicationId: receipt.application_id, environmentId: receipt.environment_id },
          receipt.source_configuration_id ?? undefined,
        );
        receipt.resources.configuration_revision = {
          status: configuration ? "ready" : "pending",
          configuration_id: configuration?.configuration_id ?? null,
        };
      }

      await this.dependencies.queues.createQueue(branchRef, receipt.queue_name);
      receipt.resources.queue_namespace.status = "ready";
      await this.save(projectRef, receipt);

      const token = randomBytes(32).toString("base64url");
      const secretSaved = await this.dependencies.secrets.upsertSecrets(branchRef, [{
        name: receipt.test_secret_name,
        value: token,
      }]);
      if (!secretSaved) throw new Error("PREVIEW_TEST_SECRET_PERSIST_FAILED");
      await this.dependencies.invalidateEnv(branchRef);
      receipt.resources.test_secret.status = "ready";
      receipt.resources.storage_namespace.status = "ready";
      if (receipt.resources.configuration_revision.configuration_id && this.dependencies.activate) {
        const activated = await this.dependencies.activate({
          projectRef,
          branchRef,
          applicationId: receipt.application_id,
          environmentId: receipt.environment_id,
          releaseId: receipt.release_id,
          configurationId: receipt.resources.configuration_revision.configuration_id,
        });
        receipt.resources.application_activation = {
          status: "ready",
          activation_id: activated.activation_id,
        };
      } else {
        receipt.resources.application_activation.status = "pending";
      }
      await this.save(projectRef, receipt);

      const runtime = await this.dependencies.runtime.checkStatus(branchRef);
      const smoke = await this.dependencies.smokeTest({
        projectRef,
        branchRef,
        applicationId: receipt.application_id,
        environmentId: receipt.environment_id,
        releaseId: receipt.release_id,
      });
      receipt.resources.smoke_test.passed = [
        "release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret",
        ...(receipt.resources.configuration_revision.status === "ready" ? ["configuration_revision"] : []),
        ...(receipt.resources.application_activation.status === "ready" ? ["application_activation"] : []),
        ...(runtime.status === "running" && runtime.health === "healthy" ? ["tenant_runtime"] : []),
        ...smoke.passed,
      ];
      receipt.resources.smoke_test.failed = smoke.failed.length > 0
        ? [...smoke.failed]
        : (runtime.status === "running" && runtime.health === "healthy" ? [] : ["tenant_runtime"]);
      receipt.resources.smoke_test.status = receipt.resources.smoke_test.failed.length > 0 ? "failed" : "ready";
      receipt.status = receipt.resources.smoke_test.failed.length > 0 ? "failed" : "ready";
      receipt.cleanup.required = true;
      await this.save(projectRef, receipt);
    } catch (error) {
      // Never overwrite the winning receipt with a stale failure projection.
      if (error instanceof ApplicationPreviewConflictError) throw error;
      receipt.status = "failed";
      receipt.resources.smoke_test.status = "failed";
      receipt.resources.smoke_test.failed = [...new Set([...receipt.resources.smoke_test.failed, "provisioning"])];
      receipt.cleanup = { required: true, completed: false, error: "APPLICATION_PREVIEW_PROVISIONING_FAILED" };
      await this.save(projectRef, receipt);
    }
  }

  private startProvisioning(projectRef: string, receipt: StoredApplicationPreview): void {
    const key = `${projectRef}:${receipt.preview_id}`;
    if (this.provisioning.has(key)) return;
    const operation = this.provision(projectRef, receipt).finally(() => this.provisioning.delete(key));
    this.provisioning.set(key, operation);
    // Observe detached failures without hiding them from callers awaiting the
    // same operation. Do not include credential-bearing provider exceptions.
    void operation.catch(() => logger.error("[ApplicationPreview] provisioning receipt was not committed", {
      projectRef, previewId: receipt.preview_id,
    }));
  }

  private async reconcilePending(projectRef: string, receipts: StoredApplicationPreview[]): Promise<void> {
    const operations: Promise<void>[] = [];
    for (const receipt of receipts) {
      if (receipt.status !== "provisioning") continue;
      this.startProvisioning(projectRef, receipt);
      const operation = this.provisioning.get(`${projectRef}:${receipt.preview_id}`);
      if (operation) operations.push(operation);
    }
    await Promise.all(operations);
  }

  private async save(projectRef: string, receipt: StoredApplicationPreview, insert = false): Promise<void> {
    const saved = await this.dependencies.projects.saveApplicationPreview(
      projectRef, receipt, insert ? null : receipt.updated_at,
    );
    receipt.updated_at = saved.updated_at;
  }
}
