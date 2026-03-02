import { projectRepository } from "../repositories/project.repository";
import { jwtService } from "./jwt.service";
import { databaseService } from "./database.service";
import { storageService } from "./storage.service";
import { routerService } from "./router.service";
import { shellService } from "./shell.service";
import { gatewayService } from "./gateway.service";
import { taskRepository } from "../repositories/task.repository";
import type { Project, ProjectStatus } from "../db";

export interface CreateProjectRequest {
  name: string;
  region?: string;
  organization_id?: string;
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
  created_at: Date;
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

export interface ProjectDetailResponse extends ProjectResponse {
  config: Record<string, unknown>;
  updated_at: Date;
}

export class ProjectService {
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
  async createProject(request: CreateProjectRequest): Promise<ProjectResponse> {
    const projectRef = jwtService.generateProjectRef();

    // Generate all necessary credentials
    const dbPassword = databaseService.generatePassword();
    const { jwtSecret, anonKey, serviceRoleKey } = await jwtService.generateKeySet();

    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;
    const s3Bucket = `supa-${projectRef}`;

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
    });

    // 2. Asynchronously provision resources (background)
    this.provisionResources(projectRef, dbPassword).catch((error) => {
      console.error(`Failed to provision resources for ${projectRef}:`, error);
    });

    return this.toResponse(project);
  }

  // Asynchronously provision resources (Saga Orchestrator)
  private async provisionResources(projectRef: string, dbPassword: string): Promise<void> {
    try {
      // Start Saga by enqueuing the first task
      await taskRepository.createTask(projectRef, "provision_db", { dbPassword });
      console.log(`[Saga] Initiated resource provisioning for project ${projectRef}`);
    } catch (error) {
      console.error(`Failed to initiate saga for ${projectRef}:`, error);
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
      console.error(`Failed to cleanup resources for ${ref}:`, error);
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
  async getProjectHealth(ref: string): Promise<{ status: string; services: Record<string, string> } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const dbStatus = await databaseService.checkStatus(ref);

    return {
      status: project.status === "active" ? "ACTIVE_HEALTHY" : "INACTIVE",
      services: {
        database: dbStatus.success ? "ACTIVE_HEALTHY" : "UNHEALTHY",
        storage: "ACTIVE_HEALTHY",
        auth: "ACTIVE_HEALTHY",
        realtime: "ACTIVE_HEALTHY",
      },
    };
  }

  // Asynchronously cleanup resources (Saga)
  private async cleanupResources(projectRef: string): Promise<void> {
    try {
      await taskRepository.createTask(projectRef, "cleanup_router");
      console.log(`[Saga] Initiated resource cleanup for project ${projectRef}`);
    } catch (error) {
      console.error(`Cleanup saga initiation error for ${projectRef}:`, error);
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
      storage: "unknown", // TODO: Implement storage health check
    };
  }

  // Restart project services
  async restartProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    // TODO: Implement service restart logic
    // Currently only reloads router
    await routerService.reload();
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

  async getSecrets(ref: string): Promise<any[] | null> {
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

    const result = await shellService.execute("function_manager.sh", ["read", ref, slug]);
    if (!result.success) return null;
    return result.output;
  }

  async listFunctions(ref: string): Promise<any[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    const result = await shellService.execute("function_manager.sh", ["list", ref]);
    if (!result.success) return [];
    try {
      const slugs = JSON.parse(result.output);
      return slugs.map((slug: string) => ({
        id: slug,
        slug: slug,
        name: slug,
        status: "ACTIVE",
        created_at: new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async deleteFunction(ref: string, slug: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await shellService.execute("function_manager.sh", ["delete", ref, slug]);
    return result.success;
  }

  async deployFunction(ref: string, slug: string, code: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await shellService.execute("function_manager.sh", ["deploy", ref, slug, code]);
    return result.success;
  }

  // Convert to response format
  private toResponse(project: Project): ProjectResponse {
    return {
      id: project.id,
      ref: project.ref,
      name: project.name,
      status: project.status,
      region: project.region,
      created_at: project.created_at,
      database: {
        host: "localhost",
        name: project.db_name,
        user: project.db_user,
      },
      api: {
        url: routerService.getProjectApiUrl(project.ref),
      },
      studio: {
        url: routerService.getProjectStudioUrl(project.ref),
      },
    };
  }

  // Get detailed response format
  private toDetailResponse(project: Project): ProjectDetailResponse {
    return {
      ...this.toResponse(project),
      config: project.config,
      updated_at: project.updated_at,
    };
  }

  // --- Log Management ---

  async queryLogs(ref: string, type: string = "all"): Promise<any[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    // Simulated log data, activates Studio Logs Explorer
    const now = new Date();
    return [
      {
        id: "log-1",
        timestamp: new Date(now.getTime() - 1000).toISOString(),
        event_message: `Project ${ref} received a request to ${type} logs.`,
        metadata: { severity: "info", source: "management-api" },
      },
      {
        id: "log-2",
        timestamp: now.toISOString(),
        event_message: `Successfully retrieved ${type} logs for ${project.name}.`,
        metadata: { severity: "success", source: "management-api" },
      }
    ];
  }

  // --- API Key Management ---

  async rotateApiKeys(ref: string): Promise<{ anon_key: string, service_role_key: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    // 1. Generate new key set
    const { jwtSecret, anonKey, serviceRoleKey } = await jwtService.generateKeySet();

    // 2. Update database
    await projectRepository.updateApiKeys(ref, {
      jwt_secret: jwtSecret,
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
    });

    // 3. Sync to Kong gateway
    await gatewayService.setupJwt(ref, jwtSecret);

    // 4. TODO: Logic to notify router reload can be added here later

    return {
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
    };
  }

  // --- Backup Management ---

  async listBackups(ref: string): Promise<any[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    const result = await shellService.execute("backup_manager.sh", ["list", ref]);
    if (!result.success) return [];
    try {
      return JSON.parse(result.output);
    } catch {
      return [];
    }
  }

  async restoreBackup(ref: string, backupId: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await shellService.execute("backup_manager.sh", ["restore", ref, backupId]);
    return result.success;
  }

  // --- Network Restrictions ---

  async updateNetworkRestrictions(ref: string, allowedIps: string[]): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await routerService.updateNetworkRestrictions(ref, allowedIps);
    return result.success;
  }

  // --- Custom Domain ---

  async getCustomDomain(ref: string): Promise<{ custom_hostname: string, status: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const domain = project.config?.custom_domain as string | undefined;
    if (domain) {
      return { custom_hostname: domain, status: "active" };
    }
    return { custom_hostname: "", status: "not_configured" };
  }

  async addCustomDomain(ref: string, domain: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await routerService.addCustomDomain(ref, domain);
    if (result.success) {
      await projectRepository.updateConfig(ref, { ...project.config, custom_domain: domain });
    }
    return result.success;
  }

  async deleteCustomDomain(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const domain = project.config?.custom_domain as string | undefined;
    if (!domain) return true;

    const result = await routerService.removeCustomDomain(ref, domain);
    if (result.success) {
      const newConfig = { ...project.config };
      delete newConfig.custom_domain;
      await projectRepository.updateConfig(ref, newConfig);
    }
    return result.success;
  }
}

export const projectService = new ProjectService();
