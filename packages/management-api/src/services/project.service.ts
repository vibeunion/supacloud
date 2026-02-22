import { projectRepository } from "../repositories/project.repository";
import { jwtService } from "./jwt.service";
import { databaseService } from "./database.service";
import { storageService } from "./storage.service";
import { routerService } from "./router.service";
import { shellService } from "./shell.service";
import { GatewayService } from "./gateway.service";
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
  // 获取所有项目
  async listProjects(): Promise<ProjectResponse[]> {
    const projects = await projectRepository.findAll();
    return projects.map((p) => this.toResponse(p));
  }

  // 获取项目详情
  async getProject(ref: string): Promise<ProjectDetailResponse | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return this.toDetailResponse(project);
  }

  // 创建项目
  async createProject(request: CreateProjectRequest): Promise<ProjectResponse> {
    const projectRef = jwtService.generateProjectRef();

    // 生成所有必要的凭据
    const dbPassword = databaseService.generatePassword();
    const { jwtSecret, anonKey, serviceRoleKey } = await jwtService.generateKeySet();

    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;
    const s3Bucket = `supa-${projectRef}`;

    // 1. 在数据库中创建项目记录 (status: creating)
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

    // 2. 异步执行资源创建 (后台进行)
    this.provisionResources(projectRef, dbPassword).catch((error) => {
      console.error(`Failed to provision resources for ${projectRef}:`, error);
    });

    return this.toResponse(project);
  }

  // 异步创建资源 (Saga Orcherstrator)
  private async provisionResources(projectRef: string, dbPassword: string): Promise<void> {
    try {
      // 通过入队第一个任务来启动 Saga
      await taskRepository.createTask(projectRef, "provision_db", { dbPassword });
      console.log(`[Saga] Initiated resource provisioning for project ${projectRef}`);
    } catch (error) {
      console.error(`Failed to initiate saga for ${projectRef}:`, error);
      await projectRepository.updateStatus(projectRef, "paused");
    }
  }

  // 删除项目
  async deleteProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    // 软删除数据库记录
    await projectRepository.softDelete(ref);

    // 异步清理资源
    this.cleanupResources(ref).catch((error) => {
      console.error(`Failed to cleanup resources for ${ref}:`, error);
    });

    return true;
  }

  // 更新项目
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

  // 暂停项目
  async pauseProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    await projectRepository.updateStatus(ref, "paused");
    return true;
  }

  // 恢复项目
  async restoreProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    await projectRepository.updateStatus(ref, "active");
    return true;
  }

  // 获取项目健康状态
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

  // 异步清理资源 (Saga)
  private async cleanupResources(projectRef: string): Promise<void> {
    try {
      await taskRepository.createTask(projectRef, "cleanup_router");
      console.log(`[Saga] Initiated resource cleanup for project ${projectRef}`);
    } catch (error) {
      console.error(`Cleanup saga initiation error for ${projectRef}:`, error);
    }
  }

  // 获取项目状态
  async getProjectStatus(ref: string): Promise<{ status: ProjectStatus; database: string; storage: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const dbStatus = await databaseService.checkStatus(ref);

    return {
      status: project.status,
      database: dbStatus.success ? "healthy" : "unhealthy",
      storage: "unknown", // TODO: 实现存储健康检查
    };
  }

  // 重启项目服务
  async restartProject(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    // TODO: 实现服务重启逻辑
    // 当前仅重载路由
    await routerService.reload();
    return true;
  }

  // 获取项目设置
  async getProjectSettings(ref: string): Promise<Record<string, unknown> | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    return project.config;
  }

  // 更新项目设置
  async updateProjectSettings(ref: string, config: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const updated = await projectRepository.updateConfig(ref, {
      ...project.config,
      ...config,
    });

    return updated?.config || null;
  }

  // 获取项目 API 密钥
  async getApiKeys(ref: string): Promise<{ anon_key: string; service_role_key: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    return {
      anon_key: project.anon_key,
      service_role_key: project.service_role_key,
    };
  }

  // --- 环境变量 (Secrets) 管理 ---

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

    // 更新完成后，可触发 Runtime 重启逻辑
    return true;
  }

  async deleteSecret(ref: string, name: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;
    return await databaseService.deleteSecret(ref, name);
  }

  // --- 在线编辑 (Functions) 管理 ---

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

  // 转换为响应格式
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

  // 获取详细响应格式
  private toDetailResponse(project: Project): ProjectDetailResponse {
    return {
      ...this.toResponse(project),
      config: project.config,
      updated_at: project.updated_at,
    };
  }

  // --- 日志管理 ---

  async queryLogs(ref: string, type: string = "all"): Promise<any[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    // 模拟日志数据，激活 Studio Logs Explorer
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

  // --- API 密钥管理 ---

  async rotateApiKeys(ref: string): Promise<{ anon_key: string, service_role_key: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    // 1. 生成新的密钥集
    const { jwtSecret, anonKey, serviceRoleKey } = await jwtService.generateKeySet();

    // 2. 更新数据库
    await projectRepository.updateApiKeys(ref, {
      jwt_secret: jwtSecret,
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
    });

    // 3. 同步到 Kong 网关
    await GatewayService.setupProject(ref, jwtSecret);

    // 4. TODO: 此处后续可以增加通知路由器重载的逻辑

    return {
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
    };
  }

  // --- 备份管理 ---

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

  // --- 网络限制 ---

  async updateNetworkRestrictions(ref: string, allowedIps: string[]): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await shellService.execute("router_manager.sh", ["update-restrictions", ref, allowedIps.join(",")]);
    if (result.success) {
      await routerService.reload();
    }
    return result.success;
  }

  // --- 自定义域名 ---

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

    const result = await shellService.execute("router_manager.sh", ["add-custom-domain", ref, domain]);
    if (result.success) {
      await projectRepository.updateConfig(ref, { ...project.config, custom_domain: domain });
      await routerService.reload();
    }
    return result.success;
  }

  async deleteCustomDomain(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const domain = project.config?.custom_domain as string | undefined;
    if (!domain) return true; // 未配置过视为删除成功

    const result = await shellService.execute("router_manager.sh", ["remove-custom-domain", ref, domain]);
    if (result.success) {
      const newConfig = { ...project.config };
      delete newConfig.custom_domain;
      await projectRepository.updateConfig(ref, newConfig);
      await routerService.reload();
    }
    return result.success;
  }
}

export const projectService = new ProjectService();
