import { Elysia, status, t } from "elysia";
import { getProjectRoleDb, sql as metaSql } from "../db";
import * as auth from "../middleware/auth";
import { edgeFunctionService } from "../services/edge-function.service";
import { taskRepository } from "../repositories/task.repository";
import { logger } from "../utils/logger";
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";
import {
  resolveAuthExecutionPolicy,
  type AuthExecutionPolicy,
} from "../services/auth-execution-policy";
import { readTaskStatistics, statisticsCount } from "../utils/task-statistics";
import {
  dashboardFunctionCount,
  dashboardProject,
  dashboardQueries,
  dashboardRatio,
  dashboardRow,
  dashboardSize,
  dashboardUsers,
} from "../services/project-dashboard-data";

const UNAVAILABLE = { message: "Project dashboard unavailable", code: "DASHBOARD_UNAVAILABLE" };

/**
 * Project-owned readers, kept injectable so the route can be exercised against a
 * fixture database without reaching into the process-wide meta connection.
 */
export const projectDashboardReads = {
  async project(ref: string) {
    const [row] = await metaSql`
      SELECT ref, db_name, db_user, db_password, config
      FROM projects
      WHERE ref = ${ref} AND deleted_at IS NULL
      LIMIT 1
    `;
    return row;
  },
  database(project: { db_name?: unknown; db_user?: unknown; db_password?: unknown }) {
    return getProjectRoleDb(String(project.db_name), String(project.db_user), String(project.db_password));
  },
};

async function attempt<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    logger.debug(`[DashboardSummary] ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function nonLocalAuth(policy: AuthExecutionPolicy) {
  if (policy.mode === "shared") {
    return { source: "supauth" as const, managed_by_ref: policy.authorityRef, total_users: null, recent_users: null };
  }
  if (policy.mode === "external") {
    return { source: "external" as const, managed_by_ref: null, total_users: null, recent_users: null };
  }
  return null;
}

export const projectDashboardRoutes = new Elysia({ prefix: "/v1/projects" })
  .get(
    "/:ref/dashboard/summary",
    async ({ params, request, set }) => {
      const context = await auth.getAuthContext(request);
      if ("status" in context) return status(context.status as 401 | 403, context.body);
      if (context.role === "project" && context.ref !== params.ref) {
        return status(403, { error: "Project scope mismatch" });
      }
      set.headers["cache-control"] = "no-store";

      const rawProject = await attempt("project", () => projectDashboardReads.project(params.ref));
      if (!rawProject) return status(404, { message: "Project not found", code: "404" });
      let project: ReturnType<typeof dashboardProject>;
      let policy: AuthExecutionPolicy;
      try {
        project = dashboardProject(rawProject, params.ref);
        policy = resolveAuthExecutionPolicy(getAuthRuntimeDescriptor(params.ref), project.config ?? null);
      } catch {
        return status(503, UNAVAILABLE);
      }
      const projectDb = projectDashboardReads.database(project);
      const fixedAuth = nonLocalAuth(policy);

      const database = await attempt("database", async () => {
        const info = dashboardRow(await projectDb`
          SELECT
            pg_size_pretty(pg_database_size(current_database())) AS size,
            (
              SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 1)
              FROM pg_stat_database
              WHERE datname = current_database()
            ) AS cache_ratio
        `);
        const connectionInfo = dashboardRow(await projectDb`
          SELECT
            (SELECT count(*)::int FROM pg_stat_activity
              WHERE backend_type = 'client backend' AND datname = current_database()) AS active,
            (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
        `);
        const tableInfo = dashboardRow(await projectDb`
          SELECT count(*)::int AS cnt FROM pg_stat_user_tables WHERE schemaname = 'public'
        `);
        const indexInfo = dashboardRow(await projectDb`
          SELECT count(*)::int AS cnt FROM pg_stat_user_indexes WHERE schemaname = 'public'
        `);
        return {
          size: dashboardSize(info.size),
          cache_hit_ratio: dashboardRatio(info.cache_ratio ?? null),
          connections: statisticsCount(connectionInfo.active),
          max_connections: statisticsCount(connectionInfo.max),
          table_count: statisticsCount(tableInfo.cnt),
          index_count: statisticsCount(indexInfo.cnt),
        };
      });

      const authSection = fixedAuth ?? (await attempt("auth", async () => {
        const userInfo = dashboardRow(await projectDb`SELECT count(*)::int AS total FROM auth.users`);
        const recentUsers = dashboardUsers(await projectDb`
          SELECT id, email, created_at FROM auth.users ORDER BY created_at DESC LIMIT 5
        `);
        return {
          source: "local" as const,
          managed_by_ref: null,
          total_users: statisticsCount(userInfo.total),
          recent_users: recentUsers,
        };
      })) ?? { source: "local" as const, managed_by_ref: null, total_users: null, recent_users: null };

      const storage = await attempt("storage", async () => {
        const row = dashboardRow(await projectDb`
          SELECT pg_size_pretty(sum((metadata->>'size')::bigint)
            FILTER (WHERE metadata->>'size' ~ '^[0-9]+$')) AS size
          FROM storage.objects
        `);
        return { size: dashboardSize(row.size) };
      });

      const functions = await attempt("functions", async () => ({
        count: dashboardFunctionCount(await edgeFunctionService.list(params.ref)),
      }));

      const tasks = await attempt("tasks", async () =>
        readTaskStatistics(await taskRepository.getTaskStats(params.ref)));

      const activeQueries = await attempt("active queries", async () => dashboardQueries(await projectDb`
        SELECT pid, usename, state, left(query, 80) AS query
        FROM pg_stat_activity
        WHERE backend_type = 'client backend'
          AND datname = current_database()
          AND state = 'active'
        LIMIT 5
      `));

      // Fence ownership changes and project transitions that happened while reading.
      const currentProject = await attempt("project", () => projectDashboardReads.project(params.ref));
      if (!currentProject) return status(404, { message: "Project not found", code: "404" });
      try {
        const current = dashboardProject(currentProject, params.ref);
        const currentPolicy = resolveAuthExecutionPolicy(getAuthRuntimeDescriptor(params.ref), current.config ?? null);
        if (current.ref !== project.ref || current.db_name !== project.db_name
          || JSON.stringify(currentPolicy) !== JSON.stringify(policy)) return status(503, UNAVAILABLE);
      } catch {
        return status(503, UNAVAILABLE);
      }

      return {
        project_ref: params.ref,
        database,
        auth: authSection,
        storage,
        functions,
        tasks,
        active_queries: activeQueries,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get project dashboard summary" },
    },
  );

export function resetDashboardSummaryCacheForTests(): void {
  // Summary responses are always served with no-store; nothing to reset.
}