import { Elysia, t } from "elysia";
import { projectService } from "../services";

export const projectRoutes = new Elysia({ prefix: "/v1/projects" })
  // 获取所有项目
  .get("/", async () => {
    const projects = await projectService.listProjects();
    return projects;
  })

  // 创建新项目
  .post(
    "/",
    async ({ body }) => {
      const project = await projectService.createProject(body);
      return project;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        region: t.Optional(t.String()),
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
        ref: t.String(),
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
      return { success: true, message: "Project deletion initiated" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // 获取项目状态
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
      return { success: true, message: "Project restart initiated" };
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
  );
