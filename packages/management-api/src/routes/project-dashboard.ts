import { Elysia, status, t } from "elysia";
import { getProjectRoleDb, sql as metaSql } from "../db";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { edgeFunctionService } from "../services/edge-function.service";
import { taskRepository } from "../repositories/task.repository";
import { logger } from "../utils/logger";
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";

type DashboardRow = Record<string, unknown>;

const DASHBOARD_SUMMARY_CACHE_TTL_MS = Number(
  process.env.DASHBOARD_SUMMARY_CACHE_TTL_MS || 10_000,
);

const dashboardSummaryCache = new Map<
  string,
  { expiresAt: number; payload: Record<string, unknown> }
>();

async function safeRead<T>(
  label: string,
  fallback: T,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    logger.debug(`[DashboardSummary] ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function firstRow(rows: DashboardRow[] | undefined): DashboardRow {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : {};
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const projectDashboardRoutes = new Elysia({ prefix: "/v1/projects" })
  .get(
    "/:ref/dashboard/summary",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);

      const cached = dashboardSummaryCache.get(params.ref);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.payload;
      }

      const [project] = await metaSql`
        SELECT db_name, db_user, db_password
        FROM projects
        WHERE ref = ${params.ref} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!project) return status(404, { message: "Project not found", code: "404" });

      const projectDb = getProjectRoleDb(
        String(project.db_name),
        String(project.db_user),
        String(project.db_password),
      );
      const authRuntime = getAuthRuntimeDescriptor(params.ref);
      const sharedAuth = authRuntime.mode === "shared";

      const [
        dbInfoRows,
        connectionRows,
        userRows,
        tableRows,
        indexRows,
        storageRows,
        recentUsers,
        activeQueries,
        functionSlugs,
        taskStats,
      ] = await Promise.all([
        safeRead<DashboardRow[]>("database info", [], () => projectDb`
          SELECT
            pg_size_pretty(pg_database_size(current_database())) AS size,
            (
              SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 1)
              FROM pg_stat_database
              WHERE datname = current_database()
            ) AS cache_ratio
        `),
        safeRead<DashboardRow[]>("connection info", [], () => projectDb`
          SELECT
            (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend') AS active,
            (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
        `),
        sharedAuth
          ? Promise.resolve<DashboardRow[]>([])
          : safeRead<DashboardRow[]>("auth user count", [], () => projectDb`
              SELECT count(*)::int AS total FROM auth.users
            `),
        safeRead<DashboardRow[]>("table count", [], () => projectDb`
          SELECT count(*)::int AS cnt FROM pg_stat_user_tables WHERE schemaname = 'public'
        `),
        safeRead<DashboardRow[]>("index count", [], () => projectDb`
          SELECT count(*)::int AS cnt FROM pg_stat_user_indexes WHERE schemaname = 'public'
        `),
        safeRead<DashboardRow[]>("storage size", [], () => projectDb`
          SELECT pg_size_pretty(coalesce(sum(
            CASE
              WHEN metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint
              ELSE 0
            END
          ), 0)) AS size
          FROM storage.objects
        `),
        sharedAuth
          ? Promise.resolve<DashboardRow[]>([])
          : safeRead<DashboardRow[]>("recent users", [], () => projectDb`
              SELECT email, created_at::text
              FROM auth.users
              ORDER BY created_at DESC
              LIMIT 5
            `),
        safeRead<DashboardRow[]>("active queries", [], () => projectDb`
          SELECT pid, usename, state, left(query, 80) AS query
          FROM pg_stat_activity
          WHERE backend_type = 'client backend' AND state = 'active'
          LIMIT 5
        `),
        safeRead<string[]>("function count", [], () => edgeFunctionService.list(params.ref)),
        safeRead("task stats", null, () => taskRepository.getTaskStats(params.ref)),
      ]);

      const dbInfo = firstRow(dbInfoRows);
      const connectionInfo = firstRow(connectionRows);
      const userInfo = firstRow(userRows);
      const tableInfo = firstRow(tableRows);
      const indexInfo = firstRow(indexRows);
      const storageInfo = firstRow(storageRows);

      const payload = {
        database: {
          size: String(dbInfo.size || "-"),
          cache_hit_ratio: numberValue(dbInfo.cache_ratio),
          connections: numberValue(connectionInfo.active),
          max_connections: numberValue(connectionInfo.max, 100),
          table_count: numberValue(tableInfo.cnt),
          index_count: numberValue(indexInfo.cnt),
        },
        auth: {
          total_users: sharedAuth ? null : numberValue(userInfo.total),
          recent_users: recentUsers,
          source: sharedAuth ? "supauth" : "local",
          managed_by_ref: sharedAuth ? authRuntime.authority_project_ref : null,
        },
        storage: {
          size: String(storageInfo.size || "0 bytes"),
        },
        functions: {
          count: functionSlugs.length,
        },
        tasks: taskStats,
        active_queries: activeQueries,
      };

      dashboardSummaryCache.set(params.ref, {
        payload,
        expiresAt: Date.now() + DASHBOARD_SUMMARY_CACHE_TTL_MS,
      });

      return payload;
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get project dashboard summary" },
    },
  );

export function resetDashboardSummaryCacheForTests(): void {
  dashboardSummaryCache.clear();
}
