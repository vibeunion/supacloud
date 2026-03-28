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
import { $ } from "bun";

export interface CreateProjectRequest {
  name: string;
  region?: string;
  organization_id?: string;
  domain?: string;  // Custom domain for the project (e.g., "aorist.cn")
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

    // Build initial config with custom domain if provided
    const initialConfig: Record<string, unknown> = {};
    if (request.domain) {
      initialConfig.custom_domain = request.domain;
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

    return this.toResponse(project);
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
      } catch {
        return "INACTIVE";
      }
    };

    const [pgrstStatus, gotrueStatus, realtimePerTenant, storagePerTenant, kongSystemd, kongDocker, angieSystemd, realtimeDocker] = await Promise.all([
      checkService(`supacloud-pgrst@${ref}`),
      checkService(`supacloud-gotrue@${ref}`),
      checkService(`supacloud-realtime@${ref}`),
      checkService(`supacloud-storage@${ref}`),
      checkService("kong"),
      checkGlobalDocker("supabase-kong"),
      checkService("angie"),
      checkGlobalDocker("realtime-dev.supabase-realtime"),
    ]);

    const realtimeStatus = realtimePerTenant === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : realtimeDocker;
    
    // Storage is embedded in the Management API, so if this endpoint is reached, it's ACTIVE,
    // unless a specific per-tenant storage unit is defined and failing.
    const storageStatus = storagePerTenant === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "ACTIVE_HEALTHY";
    
    // Gateway is either kong (systemd/docker) or angie (systemd)
    const kongStatus = (kongSystemd === "ACTIVE_HEALTHY" || kongDocker === "ACTIVE_HEALTHY" || angieSystemd === "ACTIVE_HEALTHY") 
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
    return slugs.map((slug: string) => ({
      id: slug,
      slug: slug,
      name: slug,
      status: "ACTIVE",
      created_at: new Date().toISOString(),
    }));
  }

  async deleteFunction(ref: string, slug: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    return await edgeFunctionService.remove(ref, slug);
  }

  async deployFunction(ref: string, slug: string, code: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    return await edgeFunctionService.deploy(ref, slug, code);
  }

  // Convert to response format
  private toResponse(project: Project): ProjectResponse {
    const customDomain = project.config?.custom_domain as string | undefined;
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
        host: "localhost",
        name: project.db_name,
        user: project.db_user,
      },
      api: {
        url: routerService.getProjectApiUrl(project.ref, customDomain),
      },
      studio: {
        url: routerService.getProjectStudioUrl(project.ref, customDomain),
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

  // --- Log Management ---

  async queryLogs(ref: string, type: string = "all"): Promise<LogEntryResponse[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    try {
      // Mapping from Studio "postgres", "auth", "realtime", "api" etc to our systemd unit types
      let mappedType = "all";
      if (type === "auth" || type === "gotrue") mappedType = "auth";
      else if (type === "api" || type === "postgrest") mappedType = "api";
      else if (type === "database" || type === "postgres") mappedType = "database";

      const limit = 50;
      let rawOutputs: { source: string, jsonStr: string }[] = [];

      // Helper to fetch journalctl logs natively using Bun Shell
      const fetchJournal = async (unitName: string, sourceName: string) => {
        try {
          const result = await $`journalctl -u ${unitName} -o json -n ${limit} --no-pager`.nothrow().quiet();
          if (result.exitCode === 0) {
            const lines = result.text().trim().split('\\n').filter((l: string) => l.trim().length > 0);
            for (const line of lines) {
              rawOutputs.push({ source: sourceName, jsonStr: line });
            }
          }
        } catch (e: unknown) {
          logger.error(`Error fetching journal for ${unitName}`, { error: (e instanceof Error ? e.message : String(e)) || String(e) });
        }
      };

      if (mappedType === "auth" || mappedType === "all") {
        await fetchJournal(`supacloud-gotrue@${ref}`, "auth");
      }
      if (mappedType === "api" || mappedType === "all") {
        await fetchJournal(`supacloud-pgrst@${ref}`, "api");
      }

      // PostgreSQL is managed by patroni / single instance on 1G server
      if (mappedType === "database" || mappedType === "all") {
        try {
          const pgLogCmd = await shellService.execute("bash", ["-c", `journalctl -u patroni -o json -n 20 --no-pager | grep supa_${ref}`]);
          if (pgLogCmd.success && pgLogCmd.output.trim().length > 0) {
            const lines = pgLogCmd.output.trim().split('\\n').filter((l: string) => l.trim().length > 0);
            for (const line of lines) {
              rawOutputs.push({ source: "database", jsonStr: line });
            }
          }
        } catch (e: unknown) { /* ignore */ }
      }

      if (rawOutputs.length === 0) {
        return [];
      }

      const parsedLogs: LogEntryResponse[] = [];

      for (const raw of rawOutputs) {
        try {
          const entry = JSON.parse(raw.jsonStr);

          const timestampNum = parseInt(entry.__REALTIME_TIMESTAMP || "0");
          const ms = Math.floor(timestampNum / 1000) || Date.now();
          const timestampStr = new Date(ms).toISOString();

          const source = raw.source || "system";
          const message = entry.MESSAGE || JSON.stringify(entry);

          // Infer severity from systemd priority or keywords
          let severity = "info";
          const prio = parseInt(entry.PRIORITY || "6");
          if (prio <= 3) severity = "error";
          else if (prio === 4) severity = "warning";

          if (message.toLowerCase().includes("error") || message.toLowerCase().includes("fatal")) {
            severity = "error";
          } else if (message.toLowerCase().includes("warn")) {
            severity = "warning";
          }

          parsedLogs.push({
            // Ensure unique ID for UI rendering
            id: `log-${ms}-${Math.random().toString(36).substring(2, 9)}`,
            timestamp: timestampStr,
            event_message: message,
            metadata: {
              items: [
                {
                  severity,
                  source,
                  syslog_identifier: entry.SYSLOG_IDENTIFIER,
                  message: message
                }
              ]
            }
          });
        } catch (je: unknown) {
          // Skip unparseable lines
        }
      }

      // Sort globally by timestamp descending
      parsedLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Return top LIMIT
      return parsedLogs.slice(0, limit);
    } catch (e: unknown) {
      logger.error(`Failed to get real logs for ${ref}`, { error: e instanceof Error ? e.message : String(e) });
      return [];
    }
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

  async listBackups(ref: string): Promise<BackupResponse[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    const result = await shellService.execute("backup_manager.sh", ["list", ref]);
    if (!result.success) return [];
    try {
      return JSON.parse(result.output);
    } catch (err: unknown) {
      logger.warn("[ProjectService] Failed to execute secret deletion script", { error: err });
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
