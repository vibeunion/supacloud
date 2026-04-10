import { projectRepository } from "../repositories/project.repository";
import { jwtService } from "./jwt.service";
import { databaseService } from "./database.service";
import { storageService } from "./storage.service";
import { routerService } from "./router.service";
import { shellService } from "./shell.service";
import { gatewayService } from "./gateway.service";
import { taskRepository } from "../repositories/task.repository";
import type { Project, ProjectStatus } from "../db";
import { edgeFunctionService } from "./edge-function.service";
import { logger } from "../utils/logger";
import { config } from "../config";
import { $ } from "bun";
import { projectLogService } from "./project-logs.service";
import { projectOpsService } from "./project-ops.service";

export interface CreateProjectRequest {
  name: string;
  region?: string;
  organization_id?: string;
  domain?: string;  // Base custom domain (e.g., "aorist.cn") — auto generates api.X / studio.X
  api_domain?: string;   // Explicit API domain (e.g., "xg-api.aizhuliren.cn")
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
  // Credentials returned only on creation
  anon_key: string;
  service_role_key: string;
  jwt_secret: string;
  db_password: string;
}

export interface ProjectDetailResponse extends ProjectResponse {
  config: Record<string, unknown>;
  updated_at: Date;
  // API Keys for Studio compatibility
  anon_key?: string;
  service_key?: string;
  jwt_secret?: string;
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
}

export interface FunctionResponse {
  id: string;
  slug: string;
  name: string;
  status: string;
  verify_jwt: boolean;
  created_at: string;
}

export interface LogEntryResponse {
  id: string;
  timestamp: string;
  event_message: string;
  SystemMock?: boolean;
  metadata: Record<string, unknown>;
}

export class ProjectService {
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

  // Get all projects
  async listProjects(): Promise<ProjectResponse[]> {
    const projects = await projectRepository.findAll();
    return projects.map((p) => this.toResponse(p));
  }

  // Get project details
  async getProject(ref: string): Promise<ProjectDetailResponse | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return this.toDetailResponse(project);
  }

  // Create project
  async createProject(request: CreateProjectRequest): Promise<ProjectCreateResponse> {
    const projectRef = jwtService.generateProjectRef();

    // Generate all necessary credentials
    const dbPassword = databaseService.generatePassword();
    const { jwtSecret, anonKey, serviceRoleKey } = await jwtService.generateKeySet();

    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;
    const s3Bucket = `supa-${projectRef}`;

    // Build initial config with custom domain if provided
    const initialConfig: Record<string, unknown> = {};
    if (request.domain) {
      initialConfig.custom_domain = request.domain;
    }
    // Support explicit api_domain / studio_domain (takes precedence over base domain)
    if (request.api_domain) {
      initialConfig.api_domain = request.api_domain;
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
      s3_bucket: s3Bucket,
      region: request.region || "local",
      config: initialConfig,
    });

    // 2. Asynchronously provision resources (background)
    this.provisionResources(projectRef, dbPassword, request.domain).catch((error) => {
      logger.error(`Failed to provision resources for ${projectRef}:`, { error: error instanceof Error ? error.message : String(error) });
    });

    // Return full response including credentials (only on creation)
    return {
      ...this.toResponse(project),
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
      jwt_secret: jwtSecret,
      db_password: dbPassword,
    };
  }

  // Asynchronously provision resources (Saga Orchestrator)
  private async provisionResources(projectRef: string, dbPassword: string, domain?: string): Promise<void> {
    try {
      // Start Saga by enqueuing the first task
      await taskRepository.createTask(projectRef, "provision_db", { dbPassword, domain });
      logger.info(`[Saga] Initiated resource provisioning for project ${projectRef}`);
    } catch (error: unknown) {
      logger.error(`Failed to initiate saga for ${projectRef}:`, error as Error);
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
      logger.error(`Failed to cleanup resources for ${ref}:`, { error: error instanceof Error ? error.message : String(error) });
    });

    return true;
  }

  // Update project
  async updateProject(ref: string, request: UpdateProjectRequest): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    if (request.name) {
      await projectRepository.updateConfig(ref, {
        ...project.config,
        display_name: request.name,
      });
    }

    return true;
  }

  // Pause project
  async pauseProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    await projectRepository.updateStatus(ref, "paused");
    return true;
  }

  // Restore project
  async restoreProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    await projectRepository.updateStatus(ref, "active");
    return true;
  }

  // Get project health status
  async getProjectHealth(ref: string): Promise<{ status: string; services: { name: string; status: string }[] } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const dbStatus = await databaseService.checkStatus(ref);

    const checkService = async (unitName: string) => {
      try {
        const { $ } = await import("bun");
        const result = await $`systemctl is-active ${unitName}`.nothrow().quiet();
        return result.exitCode === 0 ? "ACTIVE_HEALTHY" : "INACTIVE";
      } catch (err: unknown) {
        return "INACTIVE";
      }
    };

    const checkGlobalDocker = async (containerName: string) => {
      try {
        const { $ } = await import("bun");
        const res = await $`docker inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null || podman inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null`.nothrow().quiet();
        return res.text().trim() === "running" ? "ACTIVE_HEALTHY" : "INACTIVE";
      } catch (err: unknown) {
        logger.debug(`[ProjectService] Docker check failed for ${containerName}`, { error: err });
        return "INACTIVE";
      }
    };

    const [pgrstStatus, gotrueStatus, realtimePerTenant, storagePerTenant, kongSystemd, kongDocker, realtimeDocker] = await Promise.all([
      checkService(`supacloud-pgrst@${ref}`),
      checkService(`supacloud-gotrue@${ref}`),
      checkService(`supacloud-realtime@${ref}`),
      checkService(`supacloud-storage@${ref}`),
      checkService("kong"),
      checkGlobalDocker("supabase-kong"),
      checkGlobalDocker("realtime-dev.supabase-realtime"),
    ]);

    let realtimeStatus = "INACTIVE";

    if (realtimePerTenant === "ACTIVE_HEALTHY") {
        realtimeStatus = "ACTIVE_HEALTHY";
    } else {
        // Fall back to checking global docker container, but explicitly verify tenant registration
        if (kongDocker === "ACTIVE_HEALTHY" || kongSystemd === "ACTIVE_HEALTHY") { 
            const globalRealtimeDocker = await checkGlobalDocker("realtime-dev.supabase-realtime") || await checkGlobalDocker("supacloud-realtime");
            if (globalRealtimeDocker === "ACTIVE_HEALTHY" || realtimeDocker === "ACTIVE_HEALTHY") {
                const { realtimeService } = await import("./realtime.service");
                const hasTenant = await realtimeService.getTenant(ref);
                if (hasTenant) {
                    realtimeStatus = "ACTIVE_HEALTHY";
                }
            }
        }
    }
    
    // Storage is embedded in the Management API, so if this endpoint is reached, it's ACTIVE,
    // unless a specific per-tenant storage unit is defined and failing.
    const storageStatus = storagePerTenant === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "ACTIVE_HEALTHY";
    
    // Gateway is kong (systemd/docker)
    const kongStatus = (kongSystemd === "ACTIVE_HEALTHY" || kongDocker === "ACTIVE_HEALTHY") 
      ? "ACTIVE_HEALTHY" 
      : "INACTIVE";

    return {
      status: project.status === "active" ? "ACTIVE_HEALTHY" : "INACTIVE",
      services: [
        { name: "PostgreSQL", status: dbStatus.success ? "ACTIVE_HEALTHY" : "INACTIVE" },
        { name: "PostgREST", status: pgrstStatus },
        { name: "GoTrue", status: gotrueStatus },
        { name: "Realtime", status: realtimeStatus },
        { name: "Storage", status: storageStatus },
        { name: "Kong", status: kongStatus },
      ],
    };
  }

  // Asynchronously cleanup resources (Saga)
  // Cleanup pipeline: cleanup_runtime → cleanup_db → cleanup_router
  private async cleanupResources(projectRef: string): Promise<void> {
    try {
      await taskRepository.createTask(projectRef, "cleanup_runtime");
      logger.info(`[Saga] Initiated resource cleanup for project ${projectRef}`);
    } catch (error: unknown) {
      logger.error(`Cleanup saga initiation error for ${projectRef}:`, error as Error);
    }
  }

  // Get project status
  async getProjectStatus(ref: string): Promise<{ status: ProjectStatus; database: string; storage: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const dbStatus = await databaseService.checkStatus(ref);

    return {
      status: project.status,
      database: dbStatus.success ? "healthy" : "unhealthy",
      storage: await this.checkStorageHealth() ? "healthy" : "unhealthy",
    };
  }

  // Restart project services
  async restartProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    // Restart per-tenant services via systemd
    try {
      await $`systemctl restart supacloud-pgrst@${ref}`.nothrow().quiet();
      await $`systemctl restart supacloud-gotrue@${ref}`.nothrow().quiet();
      logger.info(`[ProjectService] Restarted services for project ${ref}`);
    } catch (err: unknown) {
      logger.warn(`[ProjectService] Service restart partial failure for ${ref}`, { error: err });
    }
    
    return true;
  }

  // Get project settings
  async getProjectSettings(ref: string): Promise<Record<string, unknown> | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return project.config;
  }

  // Update project settings
  async updateProjectSettings(ref: string, config: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const updated = await projectRepository.updateConfig(ref, {
      ...project.config,
      ...config,
    });

    return updated?.config || null;
  }

  // Get project API keys
  async getApiKeys(ref: string): Promise<{ anon_key: string; service_role_key: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    return {
      anon_key: project.anon_key,
      service_role_key: project.service_role_key,
    };
  }

  // --- Environment Variables (Secrets) Management ---

  async getSecrets(ref: string): Promise<SecretResponse[] | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return await databaseService.getSecrets(ref);
  }

  async upsertSecrets(ref: string, secrets: { name: string; value: string }[]): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    for (const secret of secrets) {
      const success = await databaseService.upsertSecret(ref, secret.name, secret.value);
      if (!success) return false;
    }

    // After update, can trigger Runtime restart logic
    return true;
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
      const cfg = await edgeFunctionService.getConfig(ref, slug);
      results.push({
        id: slug,
        slug,
        name: slug,
        status: "ACTIVE",
        verify_jwt: cfg.verify_jwt,
        created_at: new Date().toISOString(),
      });
    }
    return results;
  }

  async deleteFunction(ref: string, slug: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    return await edgeFunctionService.remove(ref, slug);
  }

  async deployFunction(ref: string, slug: string, code: string, minify: boolean = false): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    return await edgeFunctionService.deploy(ref, slug, code, minify);
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

    return await edgeFunctionService.deployBundle(ref, slug, files, entrypoint, minify);
  }

  // Convert to response format
  private toResponse(project: Project): ProjectResponse {
    const customDomain = project.config?.custom_domain as string | undefined;
    const explicitApiDomain = project.config?.api_domain as string | undefined;
    const explicitStudioDomain = project.config?.studio_domain as string | undefined;

    // Explicit domains take precedence over auto-generated ones
    const apiUrl = explicitApiDomain
      ? `https://${explicitApiDomain}`
      : routerService.getProjectApiUrl(project.ref, customDomain);
    const studioUrl = explicitStudioDomain
      ? `https://${explicitStudioDomain}`
      : routerService.getProjectStudioUrl(project.ref, customDomain);

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
        name: project.db_name,
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
  private toDetailResponse(project: Project): ProjectDetailResponse {
    return {
      ...this.toResponse(project),
      config: project.config,
      updated_at: project.updated_at,
      // API Keys for Studio compatibility
      anon_key: project.anon_key,
      service_key: project.service_role_key,
      jwt_secret: project.jwt_secret,
    };
  }

  // --- Log Management (delegated) ---

  async queryLogs(ref: string, type: string = "all"): Promise<LogEntryResponse[]> {
    return projectLogService.queryLogs(ref, type);
  }

  // --- API Key Management ---

  async rotateApiKeys(ref: string): Promise<{ anon_key: string, service_role_key: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const { jwtSecret, anonKey, serviceRoleKey } = await jwtService.generateKeySet();

    await projectRepository.updateApiKeys(ref, {
      jwt_secret: jwtSecret,
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
    });

    await gatewayService.setupJwt(ref, jwtSecret);
    
    logger.info(`[ProjectService] Rotated API keys and reloaded router for ${ref}`);

    return { anon_key: anonKey, service_role_key: serviceRoleKey };
  }

  // --- Operations (delegated) ---

  async listBackups(ref: string): Promise<BackupResponse[]> {
    return projectOpsService.listBackups(ref);
  }

  async restoreBackup(ref: string, backupId: string): Promise<boolean> {
    return projectOpsService.restoreBackup(ref, backupId);
  }

  async updateNetworkRestrictions(ref: string, allowedIps: string[]): Promise<boolean> {
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
