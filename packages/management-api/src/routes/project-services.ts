/**
 * Project Service Control Routes
 * Handles: health, status, usage, restart, individual service control
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { $ } from "bun";

export const projectServiceRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get project health status
  .get(
    "/:ref/health",
    async ({ params, set }) => {
      const health = await projectService.getProjectHealth(params.ref);
      if (!health) {
                return status(404, { error: "Project not found" });
      }
      return health;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get project status (legacy compatibility)
  .get(
    "/:ref/status",
    async ({ params, set }) => {
      const projectStatus = await projectService.getProjectStatus(params.ref);
      if (!projectStatus) {
                return status(404, { error: "Project not found" });
      }
      return projectStatus;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get project usage metrics
  .get(
    "/:ref/usage",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
                return status(404, { error: "Project not found" });
      }
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

  // Restart project
  .post(
    "/:ref/restart",
    async ({ params, set }) => {
      const restarted = await projectService.restartProject(params.ref);
      if (!restarted) {
                return status(404, { error: "Project not found" });
      }
      return { ref: params.ref, message: "Project restart initiated" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Individual service control (start/stop/restart)
  .post(
    "/:ref/services/:service/:action",
    async ({ params, set }) => {
      const { ref, service, action } = params;
      const validActions = ["start", "stop", "restart"];
      if (!validActions.includes(action)) {
        set.status = 400;
        return { error: `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}` };
      }

      const serviceMap: Record<string, string> = {
        postgresql: "patroni",
        postgrest: `supacloud-pgrst@${ref}`,
        gotrue: `supacloud-gotrue@${ref}`,
        realtime: `supacloud-realtime@${ref}`,
        storage: `supacloud-storage@${ref}`,
        kong: "kong",
      };

      const unitName = serviceMap[service];
      if (!unitName) {
        set.status = 400;
        return { error: `Unknown service: ${service}. Available: ${Object.keys(serviceMap).join(", ")}` };
      }

      try {
        const result = await $`systemctl ${action} ${unitName}`.nothrow().quiet();
        return {
          service,
          action,
          success: result.exitCode === 0,
          message: result.exitCode === 0 
            ? `Service ${service} ${action} succeeded`
            : `Service ${service} ${action} failed (exit code: ${result.exitCode})`,
        };
      } catch (err: unknown) {
        set.status = 500;
        return { error: `Failed to ${action} ${service}: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    {
      params: t.Object({
        ref: t.String(),
        service: t.String(),
        action: t.String(),
      }),
    }
  );
