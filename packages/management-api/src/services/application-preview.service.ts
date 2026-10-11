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
  type ApplicationPreviewProbeInput,
  type ApplicationPreviewReceipt,
  type StoredApplicationPreview,
} from "./application-preview-contract";
import type { ApplicationReleaseStorage } from "./application-release-storage";
import type { ApplicationConfigurations } from "./application-configuration";
import { withApplicationPreviewLifecycle, withApplicationProjectLifecycle } from "./application-lifecycle-lock";
import { StorageService } from "./storage.service";

type PreviewDataMode = "schema_only" | "full_clone";
export const APPLICATION_PREVIEW_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const APPLICATION_PREVIEW_MIN_TTL_SECONDS = 5 * 60;
export const APPLICATION_PREVIEW_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

function previewList(config: unknown): StoredApplicationPreview[] {
  const raw = normalizeProjectConfig(config as Record<string, unknown> | null | undefined)["application_previews"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is StoredApplicationPreview =>
      !!item && typeof item === "object" && (item as StoredApplicationPreview).schema === "supacloud.application-preview.v1"
      && typeof (item as StoredApplicationPreview).preview_id === "string")
    .map(item => ({
      ...item,
      expires_at: item.expires_at ?? null,
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
  input: {
    branchName: string; queueName: string; testSecretName: string; sourceConfigurationId: string | null; now: string;
  },
): StoredApplicationPreview {
  return {
    ...receipt,
    branch_name: input.branchName,
    queue_name: input.queueName,
    test_secret_name: input.testSecretName,
    source_configuration_id: input.sourceConfigurationId,
    created_at: input.now,
    updated_at: input.now,
  };
}

type PreviewDependencies = Omit<ApplicationPreviewServiceDependencies,
  "branches" | "queues" | "projects" | "secrets" | "invalidateEnv" | "runtime" | "storage"
  | "lifecycle" | "branchLifecycle" | "now">
  & {
    branches: NonNullable<ApplicationPreviewServiceDependencies["branches"]>;
    queues: NonNullable<ApplicationPreviewServiceDependencies["queues"]>;
    projects: NonNullable<ApplicationPreviewServiceDependencies["projects"]>;
    secrets: NonNullable<ApplicationPreviewServiceDependencies["secrets"]>;
    invalidateEnv: NonNullable<ApplicationPreviewServiceDependencies["invalidateEnv"]>;
    runtime: NonNullable<ApplicationPreviewServiceDependencies["runtime"]>;
    storage: NonNullable<ApplicationPreviewServiceDependencies["storage"]>;
    smokeTest: NonNullable<ApplicationPreviewServiceDependencies["smokeTest"]>;
    lifecycle: NonNullable<ApplicationPreviewServiceDependencies["lifecycle"]>;
    branchLifecycle: NonNullable<ApplicationPreviewServiceDependencies["branchLifecycle"]>;
    now: NonNullable<ApplicationPreviewServiceDependencies["now"]>;
  };

export interface ApplicationPreviewServiceDependencies {
  releases: Pick<ApplicationReleaseStorage, "readRelease" | "materializeRelease">;
  branches?: Pick<typeof branchService, "createBranch" | "deleteBranch">;
  queues?: Pick<typeof pgmqService, "createQueue" | "dropQueue" | "listQueues">;
  projects?: Pick<typeof projectRepository, "findByRef" | "saveApplicationPreview">;
  secrets?: Pick<typeof projectService, "upsertSecrets" | "deleteSecret">;
  invalidateEnv?: (ref: string) => Promise<boolean>;
  runtime?: Pick<typeof tenantRuntimeService, "checkStatus">;
  storage?: Pick<typeof StorageService, "createBucket">;
  configurations?: Pick<ApplicationConfigurations, "read" | "clone">;
  activate?: (input: {
    projectRef: string;
    branchRef: string;
    applicationId: string;
    environmentId: string;
    releaseId: string;
    configurationId: string;
    activationId: string;
  }) => Promise<{ activation_id: string }>;
  smokeTest?: (input: ApplicationPreviewProbeInput) => Promise<{ passed: string[]; failed: string[] }>;
  lifecycle?: typeof withApplicationPreviewLifecycle;
  branchLifecycle?: typeof withApplicationProjectLifecycle;
  now?: () => number;
  cleanupChecks?: {
    assertSafe(receipt: StoredApplicationPreview, automatic: boolean): Promise<void>;
    deactivateApplication?(receipt: StoredApplicationPreview): Promise<void>;
    cleanupStorage(receipt: StoredApplicationPreview): Promise<void>;
    verifySecretDeleted(receipt: StoredApplicationPreview): Promise<void>;
    verifyBranchDeleted(receipt: StoredApplicationPreview): Promise<void>;
    databaseExists?(receipt: StoredApplicationPreview): Promise<boolean>;
  };
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
      storage: { createBucket: ref => StorageService.createBucket(ref) },
      lifecycle: withApplicationPreviewLifecycle,
      branchLifecycle: withApplicationProjectLifecycle,
      now: Date.now,
      ...dependencies,
      smokeTest: dependencies.smokeTest ?? (async () => ({ passed: [], failed: ["application_readiness"] })),
    };
  }

  async list(projectRef: string, applicationId: string, environmentId: string): Promise<StoredApplicationPreview[]> {
    const project = await this.dependencies.projects.findByRef(projectRef);
    if (!project) return [];
    return previewList(project.config).filter((item) =>
      item.application_id === applicationId && item.environment_id === environmentId);
  }

  async get(projectRef: string, id: string): Promise<StoredApplicationPreview | null> {
    return this.read(projectRef, id);
  }

  async read(projectRef: string, id: string): Promise<StoredApplicationPreview | null> {
    if (!previewId(id)) return null;
    const project = await this.dependencies.projects.findByRef(projectRef);
    return previewList(project?.config).find((item) => item.preview_id === id && item.project_ref === projectRef) ?? null;
  }

  async reconcile(projectRef: string, id: string): Promise<StoredApplicationPreview | null> {
    const receipt = await this.read(projectRef, id);
    if (receipt) await this.reconcilePending(projectRef, [receipt]);
    return this.read(projectRef, id);
  }

  async create(input: {
    projectRef: string;
    applicationId: string;
    environmentId: string;
    releaseId: string;
    configurationId?: string;
    branchName?: string;
    dataMode?: PreviewDataMode;
    ttlSeconds?: number;
  }): Promise<StoredApplicationPreview> {
    const now = this.dependencies.now();
    const ttlSeconds = input.ttlSeconds ?? APPLICATION_PREVIEW_DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < APPLICATION_PREVIEW_MIN_TTL_SECONDS
      || ttlSeconds > APPLICATION_PREVIEW_MAX_TTL_SECONDS) {
      throw new Error("APPLICATION_PREVIEW_TTL_INVALID");
    }
    const sourceRelease = await this.dependencies.releases.readRelease(input.projectRef, input.applicationId, input.releaseId);
    const sourceConfigurationId = input.configurationId ?? (await this.dependencies.configurations?.read({
      projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId,
    }))?.configuration_id ?? null;
    const id = randomUUID();
    const branchRef = branchRefFor(id);
    const release = await this.dependencies.releases.materializeRelease(
      input.projectRef, input.applicationId, sourceRelease.release_id, branchRef,
    );
    if (release.project_ref !== branchRef || release.application_id !== input.applicationId
      || release.manifest_sha256 !== sourceRelease.manifest_sha256) {
      throw new Error("APPLICATION_PREVIEW_RELEASE_IDENTITY_MISMATCH");
    }
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
        expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      }),
      {
        branchName: input.branchName?.trim() || `app-${input.applicationId}-${id.slice(0, 8)}`,
        queueName,
        testSecretName,
        sourceConfigurationId,
        now: new Date(now).toISOString(),
      },
    );
    receipt.status = "provisioning";
    await this.save(input.projectRef, receipt, true);
    this.startProvisioning(input.projectRef, receipt);
    return receipt;
  }

  async cleanup(
    projectRef: string, previewId: string, options: { automatic?: boolean } = {},
  ): Promise<StoredApplicationPreview | null> {
    const pending = this.provisioning.get(`${projectRef}:${previewId}`);
    if (pending) await pending;
    return this.dependencies.lifecycle(projectRef, previewId, async () => {
      const current = await this.read(projectRef, previewId);
      if (!current || current.status === "cleaned") return current;
      if (options.automatic && (current.expires_at === null || !Number.isFinite(Date.parse(current.expires_at))
        || Date.parse(current.expires_at) > this.dependencies.now())) return current;
      return this.dependencies.branchLifecycle(current.resources.database_branch.branch_ref,
        () => this.cleanupUnderLock(projectRef, current, options.automatic === true));
    });
  }

  private async cleanupUnderLock(
    projectRef: string, current: StoredApplicationPreview, automatic: boolean,
  ): Promise<StoredApplicationPreview> {
    if (!current || current.status === "cleaned") return current;
    const next = structuredClone(current);
    try {
      const branchRef = next.resources.database_branch.branch_ref;
      if (next.project_ref !== projectRef || branchRef !== branchRefFor(next.preview_id)
        || next.queue_name !== queueNameFor(next.preview_id)
        || next.test_secret_name !== secretNameFor(next.preview_id)
        || next.resources.storage_namespace.namespace !== branchRef) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_IDENTITY_MISMATCH");
      }
      if (!this.dependencies.cleanupChecks) throw new Error("APPLICATION_PREVIEW_CLEANUP_VERIFIER_REQUIRED");
      if (next.resources.application_activation.activation_id !== null
        && !this.dependencies.cleanupChecks.deactivateApplication) {
        throw new Error("APPLICATION_PREVIEW_CLEANUP_VERIFIER_REQUIRED");
      }
      await this.dependencies.cleanupChecks.assertSafe(structuredClone(next), automatic);
      // A durable intent prevents restarted provisioning after cleanup begins.
      next.status = "failed";
      next.cleanup = { required: true, completed: false, error: "APPLICATION_PREVIEW_CLEANUP_PENDING" };
      await this.save(projectRef, next);
      if (next.resources.application_activation.activation_id !== null) {
        await this.dependencies.cleanupChecks.deactivateApplication!(structuredClone(next));
        next.resources.application_activation.status = "cleaned";
        await this.save(projectRef, next);
      }
      if (next.resources.queue_namespace.status !== "cleaned") {
        const databaseExists = !this.dependencies.cleanupChecks.databaseExists
          || await this.dependencies.cleanupChecks.databaseExists(structuredClone(next));
        if (databaseExists) {
          const queues = await this.dependencies.queues.listQueues(branchRef);
          if (queues.some(queue => queue.queue_name === next.queue_name)) {
            if (!await this.dependencies.queues.dropQueue(branchRef, next.queue_name)) {
              throw new Error("APPLICATION_PREVIEW_CLEANUP_FAILED");
            }
          }
          if ((await this.dependencies.queues.listQueues(branchRef)).some(queue => queue.queue_name === next.queue_name)) {
            throw new Error("APPLICATION_PREVIEW_CLEANUP_FAILED");
          }
        }
        next.resources.queue_namespace.status = "cleaned";
        await this.save(projectRef, next);
      }
      if (next.resources.test_secret.status !== "cleaned") {
        if (!await this.dependencies.secrets.deleteSecret(branchRef, next.test_secret_name)) {
          throw new Error("APPLICATION_PREVIEW_CLEANUP_FAILED");
        }
        if (!await this.dependencies.invalidateEnv(branchRef)) throw new Error("APPLICATION_PREVIEW_CLEANUP_FAILED");
        await this.dependencies.cleanupChecks.verifySecretDeleted(structuredClone(next));
        next.resources.test_secret.status = "cleaned";
        await this.save(projectRef, next);
      }
      if (next.resources.storage_namespace.status !== "cleaned") {
        await this.dependencies.cleanupChecks.cleanupStorage(structuredClone(next));
        next.resources.storage_namespace.status = "cleaned";
        await this.save(projectRef, next);
      }
      if (next.resources.database_branch.status !== "cleaned") {
        await this.dependencies.branches.deleteBranch(branchRef);
        await this.dependencies.cleanupChecks.verifyBranchDeleted(structuredClone(next));
        next.resources.database_branch.status = "cleaned";
      }
      next.status = "cleaned";
      next.cleanup = { required: false, completed: true, error: null };
      await this.save(projectRef, next);
      return next;
    } catch (error) {
      if (error instanceof ApplicationPreviewConflictError) throw error;
      const code = error instanceof Error ? error.message : "";
      next.cleanup = {
        required: true, completed: false,
        error: [
          "APPLICATION_PREVIEW_CLEANUP_IDENTITY_MISMATCH", "APPLICATION_PREVIEW_CLEANUP_VERIFIER_REQUIRED",
          "APPLICATION_PREVIEW_CLEANUP_ACTIVE", "APPLICATION_PREVIEW_CLEANUP_STORAGE_OCCUPIED",
          "APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED",
          "APPLICATION_PREVIEW_CLEANUP_STORAGE_UNSUPPORTED",
        ].includes(code) ? code : "APPLICATION_PREVIEW_CLEANUP_FAILED",
      };
      if (code !== "APPLICATION_PREVIEW_CLEANUP_ACTIVE") next.status = "failed";
      await this.save(projectRef, next);
      return next;
    }
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

      if (receipt.resources.configuration_revision.status !== "ready" && receipt.source_configuration_id !== null
        && this.dependencies.configurations) {
        // 先持久化目标身份；恢复时只克隆已固定的源 revision，不重新读取当前 head。
        receipt.resources.configuration_revision.configuration_id ??= randomUUID();
        await this.save(projectRef, receipt);
        const configuration = await this.dependencies.configurations.clone(
          { projectRef, applicationId: receipt.application_id, environmentId: receipt.environment_id },
          { projectRef: branchRef, applicationId: receipt.application_id, environmentId: receipt.environment_id },
          receipt.source_configuration_id,
          receipt.resources.configuration_revision.configuration_id,
        );
        if (configuration && (configuration.configuration_id !== receipt.resources.configuration_revision.configuration_id
          || configuration.project_ref !== branchRef || configuration.application_id !== receipt.application_id
          || configuration.environment_id !== receipt.environment_id)) {
          throw new Error("APPLICATION_PREVIEW_CONFIGURATION_IDENTITY_MISMATCH");
        }
        receipt.resources.configuration_revision.status = configuration ? "ready" : "pending";
        await this.save(projectRef, receipt);
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
      const storage = await this.dependencies.storage.createBucket(branchRef);
      if (!storage.success) throw new Error("PREVIEW_STORAGE_NAMESPACE_PERSIST_FAILED");
      receipt.resources.storage_namespace.status = "ready";
      if (receipt.resources.application_activation.status !== "ready"
        && receipt.resources.configuration_revision.status === "ready"
        && receipt.resources.configuration_revision.configuration_id && this.dependencies.activate) {
        // 在调用激活前持久化身份，重启恢复必须复用同一次操作。
        receipt.resources.application_activation.activation_id ??= randomUUID();
        await this.save(projectRef, receipt);
        const activated = await this.dependencies.activate({
          projectRef,
          branchRef,
          applicationId: receipt.application_id,
          environmentId: receipt.environment_id,
          releaseId: receipt.release_id,
          configurationId: receipt.resources.configuration_revision.configuration_id,
          activationId: receipt.resources.application_activation.activation_id,
        });
        if (activated.activation_id !== receipt.resources.application_activation.activation_id) {
          throw new Error("APPLICATION_PREVIEW_ACTIVATION_IDENTITY_MISMATCH");
        }
        receipt.resources.application_activation = {
          status: "ready",
          activation_id: activated.activation_id,
        };
      }
      await this.save(projectRef, receipt);

      const runtime = await this.dependencies.runtime.checkStatus(branchRef);
      const configurationId = receipt.resources.configuration_revision.configuration_id;
      const activationId = receipt.resources.application_activation.activation_id;
      const activated = receipt.resources.configuration_revision.status === "ready" && configurationId !== null
        && receipt.resources.application_activation.status === "ready" && activationId !== null;
      const smoke = activated ? await this.dependencies.smokeTest({
        projectRef,
        branchRef,
        applicationId: receipt.application_id,
        environmentId: receipt.environment_id,
        releaseId: receipt.release_id,
        configurationId,
        activationId,
      }) : { passed: [], failed: ["application_readiness"] };
      const runtimeReady = runtime.status === "running" && runtime.health === "healthy";
      const passed = [
        "release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret",
        ...(receipt.resources.configuration_revision.status === "ready" && configurationId ? ["configuration_revision"] : []),
        ...(receipt.resources.application_activation.status === "ready" && activationId ? ["application_activation"] : []),
        ...(runtimeReady ? ["tenant_runtime"] : []),
        ...(smoke.passed.includes("application_readiness") && !smoke.failed.includes("application_readiness")
          ? ["application_readiness"] : []),
      ];
      const checks = [...new Set([...receipt.resources.smoke_test.checks,
        "configuration_revision", "application_activation", "application_readiness", "tenant_runtime"])];
      receipt.resources.smoke_test.checks = checks;
      receipt.resources.smoke_test.failed = [...new Set([...checks.filter(check => !passed.includes(check)), ...smoke.failed])];
      receipt.resources.smoke_test.passed = passed.filter(check => !receipt.resources.smoke_test.failed.includes(check));
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
    const operation = this.dependencies.lifecycle(projectRef, receipt.preview_id, async () => {
      const current = await this.read(projectRef, receipt.preview_id);
      if (current?.status === "provisioning") await this.provision(projectRef, current);
    }).finally(() => this.provisioning.delete(key));
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
