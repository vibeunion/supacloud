/**
 * Main `tsc --noEmit` has no live database. Text imports stay strings, and
 * Reylo callers can still `.run` a row that carries the control-plane columns
 * they read. `tsconfig.reylo.json` excludes this shim and checks the real
 * inferred query types with the content mapper instead.
 */
declare module "*.sql" {
  type SqlScalar = string | number | boolean | Date | null;

  interface SqlRow {
    [key: string]: SqlScalar | undefined;
    id: string;
    ref: string;
    project_ref: string | null;
    organization_id: string | null;
    name: string;
    slug: string;
    plan: string;
    task_type: string;
    status: string | null;
    region: string | null;
    attempt: number | null;
    max_attempts: number | null;
    count: number;
    next_run_at: string | Date | null;
    lease_until: string | Date | null;
    created_at: string | Date | null;
    updated_at: string | Date | null;
    deleted_at: string | Date | null;
    started_at?: string | Date | null;
    completed_at?: string | Date | null;
    running: number;
    retry_scheduled: number;
    dead_lettered: number;
    failed_last_24h: number;
    cancelled_last_24h: number;
  }

  const query: string & {
    run(db: import("bun").SQL, params?: Record<string, unknown>): Promise<SqlRow[] & SqlRow>;
  };
  export default query;
}
