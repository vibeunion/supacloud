import { Elysia, t } from "elysia";
import { projectService } from "../services";

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
  );
