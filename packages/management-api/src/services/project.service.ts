import { projectRepository } from "../repositories/project.repository";
import { jwtService } from "./jwt.service";
import { databaseService } from "./database.service";
import { gatewayService } from "./gateway.service";
import { taskRepository } from "../repositories/task.repository";
import type { Project, ProjectStatus } from "../db";
import { resolveBucketName, resolveDbName, resolveRoleName, generateDbName } from "../db";
import {
  EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE,
  activeFunctionVersionNumber,
  edgeFunctionService,
  getVersionedArtifactPath,
  type EdgeFunctionActivationId,
  type EdgeFunctionActivationResult,
  type EdgeFunctionDeploymentRequest,
  type EdgeFunctionCapabilities,
  type EdgeFunctionLimits,
} from "./edge-function.service";
import { logger } from "../utils/logger";
import { config } from "../config";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import { projectLogService } from "./project-logs.service";
import { projectOpsService } from "./project-ops.service";
import {
  normalizeProjectRoutingConfig,
  resolveProjectApiUrl,
  resolveProjectStudioUrl,
  resolveTenantPorts,
} from "../utils/project-routing";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import {
  BACKGROUND_TASK_SETTING_LIMITS,
  DEFAULT_BACKGROUND_TASK_SETTINGS,
} from "../config/background-task-settings";
import { decryptSecretIfNeeded } from "../utils/secret-crypto";
import {
  ProjectMigrationLockError,
  withProjectMigrationLocks,
} from "./migration-lock";
import { ProjectStateTransitionLockedError } from "./project-database-lock";

export interface CreateProjectRequest {
  name: string;
  region?: string;
  organization_id?: string;
  domain?: string; // Base custom domain (e.g., "aorist.cn") — auto generates api.X / studio.X
  api_domain?: string; // Explicit API domain (e.g., "xg-api.aizhuliren.cn")
  auth_domain?: string; // Explicit Auth/OIDC domain (e.g., "auth.example.com")
  studio_domain?: string; // Explicit Studio domain (e.g., "xg-studio.aizhuliren.cn")
}

export interface UpdateProjectRequest {
  name?: string;
}

export interface ProjectResponse {
  id: string;
  ref: string;
  name: string;
  status: ProjectStatus;
  region: string;
  organization_id: string;
  created_at: Date;
  updated_at: Date;
  database: {
    host: string;
    port?: number;
    name: string;
    user: string;
  };
  api: {
    url: string;
  };
  studio: {
    url: string;
  };
}

export interface ProjectCreateResponse extends ProjectResponse {
  inserted_at: Date;
  endpoint: string;
  cloud_provider: string;
  kubernetes_version: string;
  infra_compute_size: string;
  default_branch_name: string;
  preview_branch_refs: string[];
  pause_status: string | null;
  connection_string: string;
  db_port: number;
  db_host: string;
  db_name: string;
  db_user: string;
  anon_key: string;
  service_role_key: string;
  publishable_key: string;
  secret_key: string;
  jwt_secret: string;
  db_password: string;
}

export interface ProjectDetailResponse extends ProjectResponse {
  config: Record<string, unknown>;
  updated_at: Date;
  // API Keys for Studio compatibility
  anon_key?: string;
  publishable_key?: string;
}

export interface BackupResponse {
  id: string;
  project_id: string;
  status: string;
  created_at: string;
  size_bytes?: number;
}

export interface SecretResponse {
  name: string;
  value: string;
  updated_at?: string;
}

export interface FunctionResponse {
  id: string;
  slug: string;
  name: string;
  status: string;
  version: number;
  activation_id: string;
  verify_jwt: boolean;
  framework: "fetch" | "elysia" | "hono" | "sveltekit-function";
  background_routes?: string[];
  capabilities?: EdgeFunctionCapabilities;
  limits?: EdgeFunctionLimits;
  import_map: boolean;
  entrypoint_path: string;
  created_at: string;
  updated_at: string;
}

export interface BackgroundTaskSettings {
  concurrency: number;
  max_attempts: number;
  max_payload_bytes: number;
  timeout_sec_default: number;
  timeout_sec_max: number;
}

export interface QueueSettings {
  max_in_flight: number;
  default_visibility_timeout_sec: number;
  max_attempts: number;
  rate_limit_per_minute: number;
}

export interface LogEntryResponse {
  id: string;
  timestamp: string;
  event_message: string;
  SystemMock?: boolean;
  metadata: Record<string, unknown>;
}

export class ProjectService {
  private readonly defaultBackgroundTaskSettings: BackgroundTaskSettings = { ...DEFAULT_BACKGROUND_TASK_SETTINGS };

  private readonly defaultQueueSettings: QueueSettings = {
    max_in_flight: 10,
    default_visibility_timeout_sec: 330,
    max_attempts: 3,
    rate_limit_per_minute: 600,
  };

  private async reconcileGatewayRoutes(
    ref: string,
    rawConfig: Record<string, unknown>,
  ): Promise<void> {
    const routingConfig = normalizeProjectRoutingConfig(rawConfig);
    const tenantPorts = resolveTenantPorts(routingConfig);
    if (!tenantPorts) {
      logger.warn("[ProjectService] Skipping gateway route reconcile: missing tenant ports", {
        ref,
      });
      return;
    }

    const result = await gatewayService.setupUpstream(
      ref,
      tenantPorts.pgrstPort,
      tenantPorts.gotruePort,
      routingConfig,
    );
    if (!result.success) {
      throw new Error(result.error || "gateway route reconcile failed");
    }
  }

  /** Check if the storage backend (S3/MinIO) is reachable */
  private async checkStorageHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${config.s3Endpoint}/minio/health/live`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async checkProjectStorageHealth(ref: string, projectConfig: unknown): Promise<boolean> {
    try {
      const { tenantRuntimeService } = await import("./tenant-runtime.service");
      const services = await tenantRuntimeService.getProjectServiceStatuses(ref, projectConfig, "studio");
      const storage = services.find((service) => service.id === "storage" || service.name.toLowerCase() === "storage");
      if (storage?.healthy || storage?.status === "ACTIVE_HEALTHY") return true;
    } catch {
      // 忽略租户服务状态探测异常，继续使用本地探测兜底。
    }

    try {
      const result = await $`systemctl is-active ${`supacloud-storage@${ref}`}`
        .nothrow()
        .quiet();
      if (result.exitCode === 0) return true;
    } catch {
      // 忽略 systemd 探测异常，继续使用共享存储探测兜底。
    }

    return await this.checkStorageHealth();
  }

  // Get all projects
  async listProjects(): Promise<ProjectResponse[]> {
    const projects = await projectRepository.findAll();
    return Promise.all(projects.map((p) => this.toResponse(p)));
  }

  // Get project details
  async getProject(ref: string): Promise<ProjectDetailResponse | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return await this.toDetailResponse(project);
  }

  // Create project
  async createProject(
    request: CreateProjectRequest,
  ): Promise<ProjectCreateResponse> {
    const projectRef = jwtService.generateProjectRef();

    // Generate all necessary credentials
    const dbPassword = databaseService.generatePassword();
    const { jwtSecret, anonKey, serviceRoleKey, publishableKey, secretKey } =
      await jwtService.generateKeySet();

    const dbName = generateDbName(projectRef);
    const dbUser = resolveRoleName(projectRef);
    const s3Bucket = resolveBucketName(projectRef);

    // Build initial config with custom domain if provided
    const initialConfig: Record<string, unknown> = {};
    if (request.domain) {
      initialConfig.custom_domain = request.domain;
    }
    // Support explicit api_domain / studio_domain (takes precedence over base domain)
    if (request.api_domain) {
      initialConfig.api_domain = request.api_domain;
    }
    if (request.auth_domain) {
      initialConfig.auth_domain = request.auth_domain;
    }
    if (request.studio_domain) {
      initialConfig.studio_domain = request.studio_domain;
    }

    // 1. Create project record in database (status: creating)
    const project = await projectRepository.create({
      ref: projectRef,
      name: request.name,
      db_name: dbName,
      db_user: dbUser,
      db_password: dbPassword,
      jwt_secret: jwtSecret,
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
      publishable_key: publishableKey,
      secret_key: secretKey,
      s3_bucket: s3Bucket,
      region: request.region || "local",
      config: initialConfig,
    });

    if (!project) {
      throw new Error(
        `[ProjectService] Failed to create project ${projectRef}. Database returned undefined.`,
      );
    }

    // 2. Asynchronously provision resources (background)
    this.provisionResources(projectRef, dbPassword, request.domain).catch(
      (error) => {
        logger.error(`Failed to provision resources for ${projectRef}:`, {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );

    // Return full response including credentials (only on creation)
    const response = await this.toResponse(project);
    return {
      ...response,
      inserted_at: project.created_at,
      endpoint: response.api?.url || `https://${projectRef}.${config.baseDomain}`,
      cloud_provider: "localhost",
      kubernetes_version: "1.28.0",
      infra_compute_size: "micro",
      default_branch_name: "main",
      preview_branch_refs: [],
      pause_status: null,
      connection_string: `postgresql://${dbUser}:[YOUR-PASSWORD]@${response.database?.host || 'localhost'}:5432/${dbName}`,
      db_port: 5432,
      db_host: response.database?.host || "localhost",
      db_name: dbName,
      db_user: dbUser,
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
      publishable_key: publishableKey,
      secret_key: secretKey,
      jwt_secret: jwtSecret,
      db_password: dbPassword,
      database: {
        ...response.database,
        port: 5432,
      },
    };
  }

  // Asynchronously provision resources (Saga Orchestrator)
  private async provisionResources(
    projectRef: string,
    dbPassword: string,
    domain?: string,
  ): Promise<void> {
    try {
      // Start Saga by enqueuing the first task
      await taskRepository.createTask(projectRef, "provision_db", {
        dbPassword,
        domain,
      });
      logger.info(
        `[Saga] Initiated resource provisioning for project ${projectRef}`,
      );
    } catch (error: unknown) {
      logger.error(
        `Failed to initiate saga for ${projectRef}:`,
        error as Error,
      );
      await projectRepository.updateStatus(projectRef, "paused");
    }
  }

  // Delete project
  async deleteProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    // Soft delete database record
    await projectRepository.softDelete(ref);

    // Asynchronously cleanup resources
    this.cleanupResources(ref).catch((error) => {
      logger.error(`Failed to cleanup resources for ${ref}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return true;
  }

  // Update project
  async updateProject(
    ref: string,
    request: UpdateProjectRequest,
  ): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    if (request.name) {
      await projectRepository.updateConfig(ref, mergeProjectConfig(project.config, {
        display_name: request.name,
      }));
    }

    return true;
  }

  private async pauseProjectWhileDatabaseLocked(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const runtimePause = await databaseService.pauseRuntime(ref);
    if (!runtimePause.success) {
      throw new Error("Project runtime could not be paused");
    }
    return Boolean(await projectRepository.updateStatus(ref, "paused"));
  }

  // Pause project
  async pauseProject(ref: string): Promise<boolean> {
    try {
      return await withProjectMigrationLocks(
        { projectRefs: [ref] },
        () => this.pauseProjectWhileDatabaseLocked(ref),
      );
    } catch (error: unknown) {
      if (error instanceof ProjectMigrationLockError) {
        throw new ProjectStateTransitionLockedError(ref);
      }
      throw error;
    }
  }

  private async restoreProjectWhileDatabaseLocked(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    // Check if tenant database exists; if not, re-trigger the provisioning saga
    // to ensure all resources (DB, S3, runtime, etc.) are available.
    const dbExists = await databaseService.checkDatabaseExists(ref);
    if (!dbExists) {
      logger.info(`[ProjectService] Tenant DB missing for ${ref}, re-provisioning resources`);
      await projectRepository.updateStatus(ref, "creating");
      this.provisionResources(ref, project.db_password).catch((error) => {
        logger.error(`Failed to re-provision resources for ${ref}:`, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      await projectRepository.updateStatus(ref, "active");
      try {
        await databaseService.resumeRuntime(ref);
      } catch (err: unknown) {
        logger.warn(`[ProjectService] Failed to resume runtime for ${ref}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return true;
  }

  // Restore project
  async restoreProject(ref: string): Promise<boolean> {
    try {
      return await withProjectMigrationLocks(
        { projectRefs: [ref] },
        () => this.restoreProjectWhileDatabaseLocked(ref),
      );
    } catch (error: unknown) {
      if (error instanceof ProjectMigrationLockError) {
        throw new ProjectStateTransitionLockedError(ref);
      }
      throw error;
    }
  }

  // Get project health status
  async getProjectHealth(ref: string): Promise<{
    status: string;
    services: { name: string; status: string }[];
  } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const dbStatus = await databaseService.checkStatus(ref);

    const checkService = async (unitName: string) => {
      try {
        const { $ } = await import("bun");
        const result = await $`systemctl is-active ${unitName}`
          .nothrow()
          .quiet();
        return result.exitCode === 0 ? "ACTIVE_HEALTHY" : "INACTIVE";
      } catch (err: unknown) {
        return "INACTIVE";
      }
    };

    const checkContainer = async (containerName: string) => {
      try {
        const { $ } = await import("bun");
        const res =
          await $`docker inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null || podman inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null`
            .nothrow()
            .quiet();
        return res.text().trim() === "running" ? "ACTIVE_HEALTHY" : "INACTIVE";
      } catch (err: unknown) {
        logger.debug(
          `[ProjectService] container check failed for ${containerName}`,
          { error: err },
        );
        return "INACTIVE";
      }
    };

    const [
      pgrstStatus,
      gotrueStatus,
      realtimeSystemd,
      storagePerTenant,
      gatewaySystemd,
      realtimeDocker,
    ] = await Promise.all([
      checkService(`supacloud-pgrst@${ref}`),
      checkService(`supacloud-gotrue@${ref}`),
      checkService("supacloud-realtime"),
      checkService(`supacloud-storage@${ref}`),
      checkService("supacloud-caddy"),
      checkContainer("supacloud-realtime"),
    ]);

    let realtimeStatus = "INACTIVE";

    if (realtimeSystemd === "ACTIVE_HEALTHY") {
      realtimeStatus = "ACTIVE_HEALTHY";
    } else {
      // Fall back to the global Realtime container, but only when the public gateway is healthy.
      if (gatewaySystemd === "ACTIVE_HEALTHY") {
        if (realtimeDocker === "ACTIVE_HEALTHY") {
          const { realtimeService } = await import("./realtime.service");
          const hasTenant = await realtimeService.getTenant(ref);
          if (hasTenant) {
            try {
              const { getProjectDb, resolveDbName } = await import("../db");
              const dbName = await resolveDbName(ref);
              const projectDb = getProjectDb(dbName);
              // Ensure CDC replication is actively running
              const repl =
                await projectDb`SELECT count(*) as count FROM pg_stat_replication WHERE application_name ILIKE '%realtime%'`;
              if (repl[0] && Number(repl[0].count) > 0) {
                realtimeStatus = "ACTIVE_HEALTHY";
              }
            } catch (e) {
              // Keep realtimeStatus as INACTIVE locally if CDC replication fetch fails
            }
          }
        }
      }
    }

    // Evaluate storage status based on checking MinIO/S3 reachability
    const isStorageReachable = await this.checkStorageHealth();
    const storageStatus =
      storagePerTenant === "ACTIVE_HEALTHY" || isStorageReachable
        ? "ACTIVE_HEALTHY"
        : "INACTIVE";

    return {
      status: project.status === "active" ? "ACTIVE_HEALTHY" : "INACTIVE",
      services: [
        {
          name: "PostgreSQL",
          status: dbStatus.success ? "ACTIVE_HEALTHY" : "INACTIVE",
        },
        { name: "PostgREST", status: pgrstStatus },
        { name: "GoTrue", status: gotrueStatus },
        { name: "Realtime", status: realtimeStatus },
        { name: "Storage", status: storageStatus },
        { name: "Caddy", status: gatewaySystemd },
      ],
    };
  }

  // Asynchronously cleanup resources (Saga)
  // Cleanup pipeline: cleanup_runtime → cleanup_db → cleanup_router
  private async cleanupResources(projectRef: string): Promise<void> {
    try {
      await taskRepository.createTask(projectRef, "cleanup_runtime");
      logger.info(
        `[Saga] Initiated resource cleanup for project ${projectRef}`,
      );
    } catch (error: unknown) {
      logger.error(
        `Cleanup saga initiation error for ${projectRef}:`,
        error as Error,
      );
    }
  }

  // Get project status
  async getProjectStatus(ref: string): Promise<{
    status: ProjectStatus;
    database: string;
    storage: string;
  } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const dbStatus = await databaseService.checkStatus(ref);

    return {
      status: project.status,
      database: dbStatus.success ? "healthy" : "unhealthy",
      storage: (await this.checkProjectStorageHealth(ref, project.config)) ? "healthy" : "unhealthy",
    };
  }

  // Restart project services
  async restartProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    // Delegate to tenantRuntimeService to ensure config is regenerated properly
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      await tenantRuntimeService.restartRuntime(ref);
      await this.reconcileGatewayRoutes(ref, normalizeProjectConfig(project.config));
      logger.info(`[ProjectService] Restarted services for project ${ref}`);
    } catch (err: unknown) {
      logger.warn(
        `[ProjectService] Service restart partial failure for ${ref}`,
        { error: err },
      );
      throw err;
    }

    return true;
  }

  // Get project settings
  async getProjectSettings(
    ref: string,
  ): Promise<Record<string, unknown> | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return normalizeProjectConfig(project.config);
  }

  // Update project settings
  async updateProjectSettings(
    ref: string,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const updated = await projectRepository.updateConfig(
      ref,
      mergeProjectConfig(project.config, config),
    );

    const currentConfig = normalizeProjectConfig(project.config);
    const updatedConfig = updated ? normalizeProjectConfig(updated.config) : mergeProjectConfig(project.config, config);
    const routingKeys = [
      "custom_domain",
      "api_domain",
      "additional_api_domains",
      "api_domains",
      "auth_domain",
      "studio_domain",
      "site_url",
      "siteUrl",
      "additional_redirect_urls",
      "additionalRedirectUrls",
    ];
    const shouldRestartRuntime = routingKeys.some((key) =>
      JSON.stringify(currentConfig[key]) !== JSON.stringify(updatedConfig[key])
    );

    if (shouldRestartRuntime) {
      try {
        const { tenantRuntimeService } = await import("./tenant-runtime.service");
        await tenantRuntimeService.restartRuntime(ref);
        if (updated) {
          await this.reconcileGatewayRoutes(ref, updatedConfig);
        }
      } catch (err) {
        logger.warn("[ProjectService] Failed to propagate routing settings to runtime", {
          ref,
          error: err,
        });
      }
    }

    return updated ? normalizeProjectConfig(updated.config) : null;
  }

  async getBackgroundTaskSettings(ref: string): Promise<BackgroundTaskSettings | null> {
    const settings = await this.getProjectSettings(ref);
    if (!settings) return null;

    const raw = (settings.background_tasks || {}) as Record<string, unknown>;
    const pickNumber = (value: unknown, fallback: number, min: number, max: number) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.floor(parsed)));
    };

    return {
      concurrency: pickNumber(raw.concurrency, this.defaultBackgroundTaskSettings.concurrency, BACKGROUND_TASK_SETTING_LIMITS.concurrency.min, BACKGROUND_TASK_SETTING_LIMITS.concurrency.max),
      max_attempts: pickNumber(raw.max_attempts, this.defaultBackgroundTaskSettings.max_attempts, BACKGROUND_TASK_SETTING_LIMITS.max_attempts.min, BACKGROUND_TASK_SETTING_LIMITS.max_attempts.max),
      max_payload_bytes: pickNumber(raw.max_payload_bytes, this.defaultBackgroundTaskSettings.max_payload_bytes, BACKGROUND_TASK_SETTING_LIMITS.max_payload_bytes.min, BACKGROUND_TASK_SETTING_LIMITS.max_payload_bytes.max),
      timeout_sec_default: pickNumber(raw.timeout_sec_default, this.defaultBackgroundTaskSettings.timeout_sec_default, BACKGROUND_TASK_SETTING_LIMITS.timeout_sec_default.min, BACKGROUND_TASK_SETTING_LIMITS.timeout_sec_default.max),
      timeout_sec_max: pickNumber(raw.timeout_sec_max, this.defaultBackgroundTaskSettings.timeout_sec_max, BACKGROUND_TASK_SETTING_LIMITS.timeout_sec_max.min, BACKGROUND_TASK_SETTING_LIMITS.timeout_sec_max.max),
    };
  }

  async updateBackgroundTaskSettings(
    ref: string,
    settings: Partial<BackgroundTaskSettings>,
  ): Promise<BackgroundTaskSettings | null> {
    const current = await this.getBackgroundTaskSettings(ref);
    if (!current) return null;

    const merged: BackgroundTaskSettings = {
      ...current,
      ...settings,
    };

    await this.updateProjectSettings(ref, {
      background_tasks: merged,
    });

    return this.getBackgroundTaskSettings(ref);
  }

  async getQueueSettings(ref: string, queueName: string): Promise<QueueSettings | null> {
    const settings = await this.getProjectSettings(ref);
    if (!settings) return null;

    const queueSettings = settings.queue_settings as Record<string, unknown> | undefined;
    const raw = (queueSettings?.[queueName] || {}) as Record<string, unknown>;
    const pickNumber = (value: unknown, fallback: number, min: number, max: number) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.floor(parsed)));
    };

    return {
      max_in_flight: pickNumber(raw.max_in_flight, this.defaultQueueSettings.max_in_flight, 1, 100),
      default_visibility_timeout_sec: pickNumber(
        raw.default_visibility_timeout_sec,
        this.defaultQueueSettings.default_visibility_timeout_sec,
        1,
        1800,
      ),
      max_attempts: pickNumber(raw.max_attempts, this.defaultQueueSettings.max_attempts, 1, 10),
      rate_limit_per_minute: pickNumber(
        raw.rate_limit_per_minute,
        this.defaultQueueSettings.rate_limit_per_minute,
        1,
        60_000,
      ),
    };
  }

  async updateQueueSettings(
    ref: string,
    queueName: string,
    settings: Partial<QueueSettings>,
  ): Promise<QueueSettings | null> {
    const currentProjectSettings = await this.getProjectSettings(ref);
    if (!currentProjectSettings) return null;

    const current = await this.getQueueSettings(ref, queueName);
    if (!current) return null;

    const queueSettings = {
      ...((currentProjectSettings.queue_settings || {}) as Record<string, unknown>),
      [queueName]: {
        ...current,
        ...settings,
      },
    };

    await this.updateProjectSettings(ref, { queue_settings: queueSettings });
    return this.getQueueSettings(ref, queueName);
  }

  // Get project API keys
  async getApiKeys(
    ref: string,
  ): Promise<{
    anon_key: string;
    service_role_key: string;
    publishable_key: string | null;
    secret_key: string | null;
  } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    return {
      anon_key: project.anon_key,
      service_role_key: project.service_role_key,
      publishable_key: project.publishable_key || null,
      secret_key: project.secret_key_encrypted
        ? decryptSecretIfNeeded(project.secret_key_encrypted)
        : null,
    };
  }

  // --- Environment Variables (Secrets) Management ---

  async getSecrets(ref: string): Promise<SecretResponse[] | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return await databaseService.getSecrets(ref);
  }

  async upsertSecrets(
    ref: string,
    secrets: { name: string; value: string }[],
  ): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    for (const secret of secrets) {
      const success = await databaseService.upsertSecret(
        ref,
        secret.name,
        secret.value,
      );
      if (!success) return false;
    }

    const persistedSecrets = await databaseService.getSecrets(ref);
    const persistedNames = new Set(persistedSecrets.map((secret) => secret.name));
    return secrets.every((secret) => persistedNames.has(secret.name));
  }

  async deleteSecret(ref: string, name: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;
    return await databaseService.deleteSecret(ref, name);
  }

  // --- Online Editing (Functions) Management ---

  async getFunctionCode(ref: string, slug: string): Promise<string | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const code = await edgeFunctionService.read(ref, slug);
    return code;
  }

  async listFunctions(ref: string): Promise<FunctionResponse[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    const slugs = await edgeFunctionService.list(ref);
    const results: FunctionResponse[] = [];
    for (const slug of slugs) {
      const snapshot = await edgeFunctionService.getState(ref, slug);
      const cfg = snapshot.config;
      const version = activeFunctionVersionNumber(
        snapshot.active_version,
      );
      if (version === null) throw new Error("Function became inactive while listing");
      const activePath = cfg.version === undefined
        ? `${config.edgeFunctionsDir}/${ref}/${slug}.js`
        : await getVersionedArtifactPath(ref, slug, cfg.version);
      if (activePath === null) throw new Error(EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE);
      const fileStat = await fs.stat(activePath);
      const updated_at = fileStat.mtime.toISOString();
      const created_at = fileStat.birthtime.toISOString();
      results.push({
        id: slug,
        slug,
        name: slug,
        status: "ACTIVE",
        version,
        activation_id: cfg.activation_id,
        verify_jwt: cfg.verify_jwt,
        framework: cfg.framework ?? "fetch",
        background_routes: cfg.background_routes || [],
        capabilities: cfg.capabilities ?? {},
        limits: cfg.limits ?? {},
        import_map: !!cfg.import_map,
        entrypoint_path: `file:///home/deno/functions/${slug}/index.ts`,
        created_at,
        updated_at,
      });
    }
    return results;
  }

  async deleteFunction(
    ref: string,
    slug: string,
    expectedActivationId: EdgeFunctionActivationId,
  ): Promise<EdgeFunctionActivationResult | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    return await edgeFunctionService.remove(ref, slug, expectedActivationId);
  }

  async deployFunction(
    ref: string,
    slug: string,
    code: string,
    minify: boolean = false,
  ): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    return await edgeFunctionService.deploy(ref, slug, code, minify);
  }

  async deployFunctionRelease(request: EdgeFunctionDeploymentRequest) {
    const project = await projectRepository.findByRef(request.ref);
    if (!project) return { success: false, error: "Project not found" };
    return edgeFunctionService.deployRelease(request);
  }

  async deployFunctionDetailed(
    ref: string,
    slug: string,
    code: string,
    minify: boolean = false,
  ) {
    const project = await projectRepository.findByRef(ref);
    if (!project) return { success: false, error: "Project not found" };

    return await edgeFunctionService.deployDetailed(ref, slug, code, minify);
  }

  async deployFunctionBundle(
    ref: string,
    slug: string,
    files: Record<string, string>,
    entrypoint: string = "index.ts",
    minify: boolean = false,
  ): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    return await edgeFunctionService.deployBundle(
      ref,
      slug,
      files,
      entrypoint,
      minify,
    );
  }

  async deployFunctionBundleDetailed(
    ref: string,
    slug: string,
    files: Record<string, string>,
    entrypoint: string = "index.ts",
    minify: boolean = false,
  ) {
    const project = await projectRepository.findByRef(ref);
    if (!project) return { success: false, error: "Project not found" };

    return await edgeFunctionService.deployBundleDetailed(
      ref,
      slug,
      files,
      entrypoint,
      minify,
    );
  }

  async checkFunctionRuntime(ref: string, slug: string) {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    return await edgeFunctionService.runtimeCheck(ref, slug);
  }

  // Convert to response format
  private async toResponse(project: Project): Promise<ProjectResponse> {
    const routingConfig = normalizeProjectRoutingConfig(
      normalizeProjectConfig(project.config),
    );
    const apiUrl = resolveProjectApiUrl(project.ref, routingConfig);
    const studioUrl = resolveProjectStudioUrl(project.ref, routingConfig);

    const dbName = await resolveDbName(project.ref);

    return {
      id: project.id,
      ref: project.ref,
      name: project.name,
      status: project.status,
      region: project.region,
      organization_id: project.organization_id || "default",
      created_at: project.created_at,
      updated_at: project.updated_at,
      database: {
        host: config.baseDomain,
        name: dbName,
        user: project.db_user,
      },
      api: {
        url: apiUrl,
      },
      studio: {
        url: studioUrl,
      },
    };
  }

  // Get detailed response format
  private async toDetailResponse(project: Project): Promise<ProjectDetailResponse> {
    return {
      ...(await this.toResponse(project)),
      config: normalizeProjectConfig(project.config),
      updated_at: project.updated_at,
      // API Keys for Studio compatibility
      anon_key: project.anon_key,
      publishable_key: project.publishable_key || undefined,
    };
  }

  // --- Log Management (delegated) ---

  async queryLogs(
    ref: string,
    type: string = "all",
  ): Promise<LogEntryResponse[]> {
    return projectLogService.queryLogs(ref, type);
  }

  // --- API Key Management ---

  async rotateApiKeys(
    ref: string,
  ): Promise<{
    anon_key: string;
    service_role_key: string;
  } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const jwtSecret = jwtService.generateSecret();
    const [anonKey, serviceRoleKey] = await Promise.all([
      jwtService.generateAnonKey(jwtSecret),
      jwtService.generateServiceRoleKey(jwtSecret),
    ]);

    // 1. Update keys in master database
    await projectRepository.updateApiKeys(ref, {
      jwt_secret: jwtSecret,
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
    });

    // 2. Update keys in Edge Runtime secrets
    await databaseService.upsertSecret(ref, "JWT_SECRET", jwtSecret);
    await databaseService.upsertSecret(ref, "SUPABASE_ANON_KEY", anonKey);
    await databaseService.upsertSecret(
      ref,
      "SUPABASE_SERVICE_ROLE_KEY",
      serviceRoleKey,
    );

    // 3. Update Gateway JWT
    await gatewayService.setupJwt(ref, jwtSecret);

    // 4. Update Realtime JWT
    const { realtimeService } = await import("./realtime.service");
    const dbName = await resolveDbName(ref);
    await realtimeService.updateTenant({
      projectRef: ref,
      dbName,
      dbPassword: project.db_password,
      jwtSecret,
      projectConfig: project.config,
    });

    // 5. Restart PostgREST and GoTrue to pickup new keys
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    await tenantRuntimeService.restartRuntime(ref);

    logger.info(
      `[ProjectService] Rotated API keys, synchronized secrets, and reloaded runtimes for ${ref}`,
    );

    return {
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
    };
  }

  async rotateOpaqueApiKeys(
    ref: string,
  ): Promise<{
    publishable_key: string;
    secret_key: string;
  } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const { publishableKey, secretKey } = jwtService.generateOpaqueKeySet();
    const updated = await projectRepository.updateOpaqueApiKeys(ref, {
      publishable_key: publishableKey,
      secret_key: secretKey,
    });
    if (!updated) {
      return null;
    }

    logger.info(`[ProjectService] Rotated opaque API keys for ${ref}`);
    return {
      publishable_key: publishableKey,
      secret_key: secretKey,
    };
  }

  // --- Operations (delegated) ---

  async listBackups(ref: string): Promise<BackupResponse[]> {
    return projectOpsService.listBackups(ref);
  }

  async restoreBackup(ref: string, backupId: string): Promise<boolean> {
    return projectOpsService.restoreBackup(ref, backupId);
  }

  async updateNetworkRestrictions(
    ref: string,
    allowedIps: string[],
  ): Promise<boolean> {
    return projectOpsService.updateNetworkRestrictions(ref, allowedIps);
  }

  async getCustomDomain(ref: string) {
    return projectOpsService.getCustomDomain(ref);
  }

  async addCustomDomain(ref: string, domain: string): Promise<boolean> {
    return projectOpsService.bindCustomDomain(ref, domain);
  }

  async deleteCustomDomain(ref: string): Promise<boolean> {
    return projectOpsService.deleteCustomDomain(ref);
  }
}

export const projectService = new ProjectService();
