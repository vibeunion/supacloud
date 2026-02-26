import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { GatewayService } from "../services/gateway.service";

// 可用区域列表
const AVAILABLE_REGIONS = [
  { code: "local", name: "Local", continent: "local" },
  { code: "us-east-1", name: "US East (N. Virginia)", continent: "americas" },
  { code: "us-west-1", name: "US West (N. California)", continent: "americas" },
  { code: "eu-west-1", name: "EU (Ireland)", continent: "emea" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)", continent: "apac" },
];

export const projectRoutes = new Elysia({ prefix: "/v1/projects" })
  // 获取可用区域
  .get("/available-regions", () => {
    return AVAILABLE_REGIONS;
  })

  // 获取所有项目
  .get("/", async () => {
    const projects = await projectService.listProjects();
    return projects;
  })
  .get("", async () => {
    const projects = await projectService.listProjects();
    return projects;
  })

  // 创建新项目
  .post(
    "/",
    async ({ body, set }) => {
      const project = await projectService.createProject(body);
      set.status = 201;
      return project;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        region: t.Optional(t.String()),
        organization_id: t.Optional(t.String()),
      }),
    }
  )

  // 获取项目详情
  .get(
    "/:ref",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return project;
    },
    {
      params: t.Object({
        ref: t.String({ minLength: 1 }),
      }),
    }
  )

  // 更新项目 (PATCH)
  .patch(
    "/:ref",
    async ({ params, body, set }) => {
      const updated = await projectService.updateProject(params.ref, body);
      if (!updated) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      }),
    }
  )

  // 删除项目
  .delete(
    "/:ref",
    async ({ params, set }) => {
      const deleted = await projectService.deleteProject(params.ref);
      if (!deleted) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 暂停项目
  .post(
    "/:ref/pause",
    async ({ params, set }) => {
      const paused = await projectService.pauseProject(params.ref);
      if (!paused) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref, status: "paused" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 恢复项目
  .post(
    "/:ref/restore",
    async ({ params, set }) => {
      const restored = await projectService.restoreProject(params.ref);
      if (!restored) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref, status: "active" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取项目健康状态
  .get(
    "/:ref/health",
    async ({ params, set }) => {
      const health = await projectService.getProjectHealth(params.ref);
      if (!health) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return health;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取项目状态 (兼容旧接口)
  .get(
    "/:ref/status",
    async ({ params, set }) => {
      const status = await projectService.getProjectStatus(params.ref);
      if (!status) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return status;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取项目健康状态
  .get(
    "/:ref/usage",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
      }
      // 返回模拟的基础指标，使 Studio 仪表盘动起来
      return {
        data: {
          database: { usage: 10, limit: 500, unit: "MB" },
          storage: { usage: 5, limit: 1000, unit: "MB" },
          cpu: { usage: Math.floor(Math.random() * 20), limit: 100, unit: "percent" },
          ram: { usage: 256, limit: 1024, unit: "MB" },
        },
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 重启项目
  .post(
    "/:ref/restart",
    async ({ params, set }) => {
      const restarted = await projectService.restartProject(params.ref);
      if (!restarted) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref, message: "Project restart initiated" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取项目设置
  .get(
    "/:ref/settings",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (settings === null) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return settings;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 更新项目设置
  .put(
    "/:ref/settings",
    async ({ params, body, set }) => {
      const settings = await projectService.updateProjectSettings(params.ref, body);
      if (settings === null) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return settings;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // 获取项目 API 密钥
  .get(
    "/:ref/api-keys",
    async ({ params, set }) => {
      const keys = await projectService.getApiKeys(params.ref);
      if (!keys) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return keys;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 轮换 API 密钥
  .post(
    "/:ref/api-keys/rotate",
    async ({ params, set }) => {
      const keys = await projectService.rotateApiKeys(params.ref);
      if (!keys) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return keys;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取日志
  .get(
    "/:ref/logs",
    async ({ params, query, set }) => {
      const logs = await projectService.queryLogs(params.ref, query.type);
      return logs;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      query: t.Object({
        type: t.Optional(t.String()),
      }),
    }
  )

  // 获取备份列表
  .get(
    "/:ref/database/backups",
    async ({ params, set }) => {
      const backups = await projectService.listBackups(params.ref);
      return backups;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 还原备份
  .post(
    "/:ref/database/backups/restore",
    async ({ params, body, set }) => {
      const success = await projectService.restoreBackup(params.ref, body.backup_id);
      if (!success) {
        set.status = 500;
        return { error: "Failed to restore backup" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        backup_id: t.String(),
      }),
    }
  )

  // 更新网络限制
  .post(
    "/:ref/network-restrictions",
    async ({ params, body, set }) => {
      const success = await projectService.updateNetworkRestrictions(params.ref, body.allowed_address_ranges);
      if (!success) {
        set.status = 500;
        return { error: "Failed to update network restrictions" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        allowed_address_ranges: t.Array(t.String()),
      }),
    }
  )

  // 获取自定义域名
  .get(
    "/:ref/custom-hostname",
    async ({ params, set }) => {
      const domainInfo = await projectService.getCustomDomain(params.ref);
      if (!domainInfo) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return domainInfo;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 添加自定义域名
  .post(
    "/:ref/custom-hostname",
    async ({ params, body, set }) => {
      const success = await projectService.addCustomDomain(params.ref, body.custom_hostname);
      if (!success) {
        set.status = 500;
        return { error: "Failed to add custom hostname" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        custom_hostname: t.String(),
      }),
    }
  )

  // 删除自定义域名
  .delete(
    "/:ref/custom-hostname",
    async ({ params, set }) => {
      const success = await projectService.deleteCustomDomain(params.ref);
      if (!success) {
        set.status = 500;
        return { error: "Failed to delete custom hostname" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取 Auth 配置
  .get(
    "/:ref/config/auth",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return settings.auth || {};
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 修改 Auth 配置（支持第三方 Providers 深拷贝覆盖）
  .patch(
    "/:ref/config/auth",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as any) || {};
      const newAuth = typeof body === "object" ? body : {};

      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          ...newAuth,
        },
      });
      return updated?.auth || {};
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // 获取环境变量 (Secrets)
  .get(
    "/:ref/secrets",
    async ({ params, set }) => {
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return secrets;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 设置环境变量
  .post(
    "/:ref/secrets",
    async ({ params, body, set }) => {
      const success = await projectService.upsertSecrets(params.ref, body as any);
      if (!success) {
        set.status = 500;
        return { error: "Failed to update secrets" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Array(
        t.Object({
          name: t.String(),
          value: t.String(),
        })
      ),
    }
  )

  // 删除环境变量
  .delete(
    "/:ref/secrets/:name",
    async ({ params, set }) => {
      const success = await projectService.deleteSecret(params.ref, params.name);
      if (!success) {
        set.status = 500;
        return { error: "Failed to delete secret" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        name: t.String(),
      }),
    }
  )

  // 获取函数列表
  .get(
    "/:ref/functions",
    async ({ params, set }) => {
      const functions = await projectService.listFunctions(params.ref);
      return functions;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取函数代码
  .get(
    "/:ref/functions/:slug",
    async ({ params, set }) => {
      const code = await projectService.getFunctionCode(params.ref, params.slug);
      if (code === null) {
        set.status = 404;
        return { error: "Function not found" };
      }
      return { code };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
    }
  )

  // 部署函数代码
  .post(
    "/:ref/functions/:slug",
    async ({ params, body, set }) => {
      const success = await projectService.deployFunction(params.ref, params.slug, body.code);
      if (!success) {
        set.status = 500;
        return { error: "Failed to deploy function" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
      body: t.Object({
        code: t.String(),
      }),
    }
  )

  // 删除函数代码
  .delete(
    "/:ref/functions/:slug",
    async ({ params, set }) => {
      const success = await projectService.deleteFunction(params.ref, params.slug);
      if (!success) {
        set.status = 500;
        return { error: "Failed to delete function" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
    }
  )

  // 更新网关配置 (限流, CORS, JWT)
  .post(
    "/:ref/gateway/config",
    async ({ params, body, set }) => {
      const result = await GatewayService.applyConfig(params.ref, {
        rateLimitTier: body.rate_limit_tier as any,
        corsOrigins: body.cors_origins,
        jwtEnabled: body.jwt_enabled,
        jwtSecret: body.jwt_secret
      });
      if (!result.success) {
        set.status = 500;
        return { error: result.message };
      }
      return result;
    },
    {
      params: t.Object({
        ref: t.String()
      }),
      body: t.Object({
        rate_limit_tier: t.Optional(t.Union([t.Literal('free'), t.Literal('pro'), t.Literal('enterprise')])),
        cors_origins: t.Optional(t.String()),
        jwt_enabled: t.Optional(t.Boolean()),
        jwt_secret: t.Optional(t.String())
      })
    }
  );
