import { Elysia, status, t } from "elysia";
import { projectService } from "../services";
import { getProjectDb } from "../db";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { victoriaLogsService, type VictoriaProjectLog } from "../services/victorialogs.service";
import { edgeFunctionService } from "../services/edge-function.service";
import { readConnectionLocks } from "../services/connection-locks";

type MeasurementStatus = "ok" | "warning" | "unknown";
type ErrorRate = {
  service: "data_api" | "auth" | "storage" | "edge_functions";
  window: "1h";
  observations: number;
  errors: number;
  error_rate: number | null;
  status: MeasurementStatus;
  source: "victorialogs";
  coverage: "request_log_sample";
  reason?: string;
};
type TableRow = { schema: string; table: string; rls_enabled: boolean; rls_forced: boolean };

function serviceMatches(service: ErrorRate["service"], logService: string): boolean {
  if (service === "data_api") return ["data_api", "api", "postgrest"].includes(logService);
  if (service === "edge_functions") return ["edge-function", "edge_functions", "functions", "functions-runtime"].includes(logService);
  return logService === service;
}

export function advisorErrorRate(service: ErrorRate["service"], logs: VictoriaProjectLog[] | null): ErrorRate {
  if (!logs) {
    return {
      service, window: "1h", observations: 0, errors: 0, error_rate: null,
      status: "unknown", source: "victorialogs", coverage: "request_log_sample",
      reason: "log_store_unavailable",
    };
  }
  const scoped = logs.filter((log) => serviceMatches(service, log.service)).flatMap(log => {
    let metadata = log.metadata;
    try {
      const parsed: unknown = JSON.parse(log.event_message);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = { ...parsed, ...metadata };
    } catch { /* Unstructured service output is not a request denominator. */ }
    const raw = metadata.http_status ?? metadata.status_code ?? metadata.status;
    const code = typeof raw === "number" || (typeof raw === "string" && /^\d{3}$/.test(raw)) ? Number(raw) : null;
    return code !== null && code >= 100 && code <= 599 ? [code] : [];
  });
  const errors = scoped.filter(code => code >= 500).length;
  const rate = scoped.length ? errors / scoped.length : null;
  return {
    service, window: "1h", observations: scoped.length, errors, error_rate: rate,
    status: rate === null || logs.length >= 1000 ? "unknown" : rate >= 0.05 ? "warning" : "ok",
    source: "victorialogs", coverage: "request_log_sample",
    ...(rate === null ? { reason: "no_request_status_coverage" } : logs.length >= 1000 ? { reason: "source_sample_truncated" } : {}),
  };
}

export const projectAdvisorsRoutes = new Elysia({ prefix: "/v1/projects" }).get(
  "/:ref/advisors",
  {
    params: t.Object({ ref: t.String() }),
    detail: { tags: ["projects"], summary: "Read project health advisors" },
  },
  async ({ params, request, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    const project = await projectService.getProject(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });

    const logResult = await Promise.allSettled([
      victoriaLogsService.queryProjectLogs(params.ref, {
        limit: 1000,
        start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const logs = logResult[0]?.status === "fulfilled" ? logResult[0].value : null;

    const database = {
      available: false,
      reason: "database_unavailable",
      connections: { active: null as number | null, max: null as number | null },
      blocked_sessions: null as number | null,
      unused_indexes: null as number | null,
      tables_without_rls: [] as { schema: string; table: string }[],
      forced_rls_tables: [] as { schema: string; table: string }[],
    };
    let functions: string[] | null = null;

    try {
      // Use the verified project's stored database name; do not derive a
      // fallback name for an operational health read.
      const db = getProjectDb(project.database.name);
      const [connections, locks, indexes, tables] = await Promise.all([
        db<{ active: number; max: number }[]>`
          SELECT count(*)::int AS active,
                 (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
          FROM pg_stat_activity
          WHERE datname = current_database() AND backend_type = 'client backend'
        `,
        db<{ blocked: number }[]>`
          SELECT count(*)::int AS blocked
          FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
        `,
        db<{ unused: number }[]>`
          SELECT count(*)::int AS unused
          FROM pg_stat_user_indexes
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
            AND idx_scan = 0 AND indexrelname NOT LIKE '%_pkey'
        `,
        db<TableRow[]>`
          SELECT n.nspname AS schema, c.relname AS table,
                 c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')
            AND n.nspname = 'public'
          ORDER BY n.nspname, c.relname
        `,
      ]);
      const active = Number(connections[0]?.active);
      const max = Number(connections[0]?.max);
      const blocked = Number(locks[0]?.blocked);
      const unused = Number(indexes[0]?.unused);
      if (![active, max, blocked, unused].every(value => Number.isSafeInteger(value) && value >= 0) || max < 1) {
        throw new Error("Incomplete database observations");
      }
      database.available = true;
      database.reason = "";
      database.connections = { active, max };
      database.blocked_sessions = blocked;
      database.unused_indexes = unused;
      database.tables_without_rls = tables
        .filter((row) => row.rls_enabled !== true)
        .map((row) => ({ schema: row.schema, table: row.table }));
      database.forced_rls_tables = tables
        .filter((row) => row.rls_forced === true)
        .map((row) => ({ schema: row.schema, table: row.table }));
    } catch {
      database.reason = "database_query_failed";
    }

    try {
      functions = await edgeFunctionService.list(params.ref);
    } catch {
      functions = null;
    }

    return {
      schema: "supacloud.project-advisors.v1",
      project_ref: params.ref,
      generated_at: new Date().toISOString(),
      measurement_policy: {
        error_rates: "HTTP 5xx / request-status observations; sampled logs, not total traffic",
        window: "1h",
      },
      error_rates: (["data_api", "auth", "storage", "edge_functions"] as const)
        .map((service) => advisorErrorRate(service, logs)),
      database,
      edge_functions: {
        count: functions?.length ?? null,
        available: functions !== null,
        ...(functions === null ? { reason: "function_inventory_unavailable" } : {}),
      },
    };
  },
).get("/:ref/advisors/connections", { params: t.Object({ ref: t.String() }) }, async ({ request, params, set }) => {
  set.headers["Cache-Control"] = "no-store";
  const denied = await requireProjectOrAdminAuth(request, params.ref);
  if (denied) return status(denied.status, denied.body);
  try { return await readConnectionLocks(params.ref); }
  catch { return status(503, { message: "Connection observations unavailable" }); }
});
