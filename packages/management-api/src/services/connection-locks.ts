import { sql, getProjectDb } from "../db";

export async function readConnectionLocks(ref: string) {
  const [project] = await sql<{ db_name: string }[]>`
    SELECT db_name FROM projects WHERE ref = ${ref} AND deleted_at IS NULL AND lower(status) = 'active'
  `;
  if (!project?.db_name) throw new Error("Project database unavailable");
  const rows = await getProjectDb(project.db_name)<{
    pid: number; role: string; application: string; state: string | null;
    wait_event_type: string | null; wait_event: string | null;
    query_started_at: string | null; blocking_pids: number[];
  }[]>`
    SELECT pid, usename AS role, application_name AS application, state,
           wait_event_type, wait_event, query_start::text AS query_started_at,
           pg_blocking_pids(pid) AS blocking_pids
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
    ORDER BY (cardinality(pg_blocking_pids(pid)) > 0) DESC, query_start NULLS LAST, pid
    LIMIT 101
  `;
  return { project_ref: ref, rows: rows.slice(0, 100), truncated: rows.length > 100, read_only: true };
}
