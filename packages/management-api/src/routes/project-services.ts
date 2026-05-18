/**
 * Project Service Control Routes
 * Handles: health, status, usage, restart, individual service control
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { getAuthContext, requireProjectOrAdminAuth } from "../middleware/auth";
import { $ } from "bun";
import { tenantRuntimeService } from "../services/tenant-runtime.service";

export const projectServiceRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get project health status
  .get(
    "/:ref/health",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      try {
        const servicesData = await tenantRuntimeService.getProjectServiceStatuses(params.ref, "studio");
        return { status: "healthy", services: servicesData || [] };
      } catch {
        return { status: "healthy", services: [] };
      }
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["projects"], summary: "Get project health status" },
    },
  )

  // Get project status (legacy compatibility)
  .get(
    "/:ref/status",
    async ({ params, set }) => {
      const projectStatus = await projectService.getProjectStatus(params.ref);
      if (!projectStatus) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return projectStatus;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["projects"], summary: "Get project status" },
    },
  )

  // Get project usage metrics — real pg_stat data (P0-6)
  .get(
    "/:ref/usage",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }

      try {
        const { getProjectDb, resolveDbName } = await import("../db");
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);

        // Database size
        const [dbSize] =
          await db`SELECT pg_database_size(current_database()) as size_bytes`;
        const dbSizeMb = Math.round(Number(dbSize.size_bytes) / (1024 * 1024));

        // Table count
        const [tableCount] = await db`
          SELECT count(*) as cnt FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `;

        // Active connections
        const [connCount] = await db`
          SELECT count(*) as cnt FROM pg_stat_activity WHERE datname = current_database()
        `;

        // Storage objects count + total size
        let storageSizeMb = 0;
        let storageObjectCount = 0;
        try {
          const [storageStats] = await db`
            SELECT count(*) as cnt, coalesce(sum((metadata->>'size')::bigint), 0) as total_bytes
            FROM storage.objects
          `;
          storageSizeMb = Math.round(
            Number(storageStats.total_bytes) / (1024 * 1024),
          );
          storageObjectCount = Number(storageStats.cnt);
        } catch {
          /* storage schema may not exist */
        }

        // Auth user count
        let userCount = 0;
        try {
          const [authStats] = await db`SELECT count(*) as cnt FROM auth.users`;
          userCount = Number(authStats.cnt);
        } catch {
          /* auth schema may not exist */
        }

        return {
          data: {
            database: { usage: dbSizeMb, limit: 500, unit: "MB" },
            storage: { usage: storageSizeMb, limit: 1000, unit: "MB" },
            storage_objects: {
              usage: storageObjectCount,
              limit: 0,
              unit: "count",
            },
            auth_users: { usage: userCount, limit: 0, unit: "count" },
            tables: { usage: Number(tableCount.cnt), limit: 0, unit: "count" },
            connections: {
              usage: Number(connCount.cnt),
              limit: 60,
              unit: "count",
            },
          },
        };
      } catch (err) {
        // Fallback if tenant DB is unreachable
        return {
          data: {
            database: { usage: 0, limit: 500, unit: "MB" },
            storage: { usage: 0, limit: 1000, unit: "MB" },
          },
        };
      }
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["projects"], summary: "Get project usage metrics" },
    },
  )

  // Restart project
  .post(
    "/:ref/restart",
    async ({ params, set }) => {
      const restarted = await projectService.restartProject(params.ref);
      if (!restarted) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return { ref: params.ref, message: "Project restart initiated" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["projects"], summary: "Restart project" },
    },
  )

  // Get project services status list (Supabase Studio compatibility)
  .get(
    "/:ref/services",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found" });
      }

      return tenantRuntimeService.getProjectServiceStatuses(params.ref, "studio");
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "List project services status" },
    },
  )

  // PostgREST runtime status (desired/actual state and last error)
  .get(
    "/:ref/services/postgrest/status",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found" });
      }
      return tenantRuntimeService.statusPostgrest(params.ref);
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get PostgREST runtime status" },
    },
  )

  // Individual service control (start/stop/restart)
  .post(
    "/:ref/services/:service/:action",
    async ({ params, request, set }) => {
      const { ref, service, action } = params;
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const auth = await getAuthContext(request);
      if ("status" in auth) return status(auth.status, auth.body);

      const validActions = ["start", "stop", "restart", "pause", "resume", "status"];
      if (!validActions.includes(action)) {
        set.status = 400;
        return {
          message: `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}`,
          code: "400",
        };
      }

      const projectUnitMap: Record<string, string> = {
        postgrest: `supacloud-pgrst@${ref}`,
        rest: `supacloud-pgrst@${ref}`,
        gotrue: `supacloud-gotrue@${ref}`,
        storage: `supacloud-storage@${ref}`,
      };
      const sharedUnitMap: Record<string, string> = {
        postgresql: "patroni",
        realtime: "supacloud-realtime",
        kong: "kong",
      };
      const serviceMap: Record<string, string> = { ...projectUnitMap, ...sharedUnitMap };

      if (auth.role === "project" && !(service in projectUnitMap)) {
        return status(403, { message: "Admin privileges required for shared services", code: "403" });
      }

      if (service === "postgrest" || service === "rest") {
        try {
          const runtime =
            action === "stop" || action === "pause"
              ? await tenantRuntimeService.pausePostgrest(ref)
              : action === "start" || action === "resume"
                ? await tenantRuntimeService.resumePostgrest(ref)
                : action === "restart"
                  ? await tenantRuntimeService.restartPostgrest(ref)
                  : await tenantRuntimeService.statusPostgrest(ref);

          return {
            service: "postgrest",
            action,
            success: action === "status" || runtime.actual !== "error",
            runtime,
            message: `PostgREST ${action} ${runtime.actual === "error" ? "failed" : "succeeded"}`,
          };
        } catch (err: unknown) {
          set.status = 500;
          return {
            message: `Failed to ${action} PostgREST: ${err instanceof Error ? err.message : String(err)}`,
            code: "500",
          };
        }
      }

      if (action === "pause" || action === "resume" || action === "status") {
        set.status = 400;
        return {
          message: `Action ${action} is only supported for PostgREST`,
          code: "400",
        };
      }

      const unitName = serviceMap[service];
      if (!unitName) {
        set.status = 400;
        return {
          message: `Unknown service: ${service}. Available: ${Object.keys(serviceMap).join(", ")}`,
          code: "400",
        };
      }

      try {
        const result = await $`systemctl ${action} ${unitName}`
          .nothrow()
          .quiet();
        return {
          service,
          action,
          success: result.exitCode === 0,
          message:
            result.exitCode === 0
              ? `Service ${service} ${action} succeeded`
              : `Service ${service} ${action} failed (exit code: ${result.exitCode})`,
        };
      } catch (err: unknown) {
        set.status = 500;
        return {
          message: `Failed to ${action} ${service}: ${err instanceof Error ? err.message : String(err)}`,
          code: "500",
        };
      }
    },
    {
      params: t.Object({
        ref: t.String(),
        service: t.String(),
        action: t.String(),
      }),
      detail: { tags: ["projects"], summary: "Control a project service" },
    },
  );
