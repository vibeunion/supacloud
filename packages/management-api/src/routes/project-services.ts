/**
 * Project Service Control Routes
 * Handles: health, status, usage, restart, individual service control
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { getAuthContext, requireProjectOrAdminAuth } from "../middleware/auth";
import { $ } from "bun";

export const projectServiceRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get project health status
  .get(
    "/:ref/health",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return { status: "healthy" };
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

      const ref = params.ref;

      // Check each service via systemctl (fails gracefully in CI/non-systemd environments)
      const checkService = async (unitName: string): Promise<string> => {
        try {
          const result = await $`systemctl is-active ${unitName} 2>/dev/null`
            .nothrow()
            .quiet();
          return result.exitCode === 0 ? "ACTIVE_HEALTHY" : "INACTIVE";
        } catch {
          return "INACTIVE";
        }
      };

      const [db, pgrst, gotrue, realtime, storage] = await Promise.allSettled([
        checkService("patroni"),
        checkService(`supacloud-pgrst@${ref}`),
        checkService(`supacloud-gotrue@${ref}`),
        checkService("supacloud-realtime"),
        checkService(`supacloud-storage@${ref}`),
      ]);

      const getResult = (r: PromiseSettledResult<string>): string =>
        r.status === "fulfilled" ? r.value : "INACTIVE";

      return [
        { id: "db", name: "db", status: getResult(db) === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "UNHEALTHY", healthy: getResult(db) === "ACTIVE_HEALTHY", service_host_ids: [`${ref}-db`] },
        { id: "rest", name: "rest", status: getResult(pgrst) === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "UNHEALTHY", healthy: getResult(pgrst) === "ACTIVE_HEALTHY", service_host_ids: [`${ref}-rest`] },
        { id: "auth", name: "auth", status: getResult(gotrue) === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "UNHEALTHY", healthy: getResult(gotrue) === "ACTIVE_HEALTHY", service_host_ids: [`${ref}-auth`] },
        { id: "realtime", name: "realtime", status: getResult(realtime) === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "UNHEALTHY", healthy: getResult(realtime) === "ACTIVE_HEALTHY", service_host_ids: [`${ref}-realtime`] },
        { id: "storage", name: "storage", status: getResult(storage) === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "UNHEALTHY", healthy: getResult(storage) === "ACTIVE_HEALTHY", service_host_ids: [`${ref}-storage`] },
      ];
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "List project services status" },
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

      const validActions = ["start", "stop", "restart"];
      if (!validActions.includes(action)) {
        set.status = 400;
        return {
          message: `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}`,
          code: "400",
        };
      }

      const projectUnitMap: Record<string, string> = {
        postgrest: `supacloud-pgrst@${ref}`,
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
