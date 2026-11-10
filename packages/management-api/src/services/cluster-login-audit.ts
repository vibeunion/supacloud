import { getProjectDb, sql } from "../db";
import { logger } from "../utils/logger";
import { renderTenantHbaPairingSql } from "./tenant-hba-pairing";

export const CLUSTER_LOGIN_ROLES = ["supabase_auth_admin", "supabase_admin"] as const;

export const CLUSTER_LOGIN_AUDIT_NOTE =
  "supabase_auth_admin and supabase_admin remain cluster-wide LOGIN roles. A leaked cluster password can still open every tenant database as these roles. This audit does not isolate them and does not return the cluster password.";

export interface ClusterLoginSession {
  role: string;
  database: string;
  client_addr: string;
  client_port: number | null;
  application_name: string;
  backend_start: string | null;
  state: string | null;
}

export interface ClusterLoginAuditReport {
  roles: readonly string[];
  isolation: "audit-only";
  note: string;
  history: string;
  log_connections: Record<string, boolean | null>;
  sessions: ClusterLoginSession[];
}

interface ProjectPairingRow {
  ref?: unknown;
  db_name?: unknown;
  db_user?: unknown;
}

interface RoleConfigRow {
  rolname?: unknown;
  rolconfig?: unknown;
}

interface ActivityRow {
  usename?: unknown;
  datname?: unknown;
  client_addr?: unknown;
  client_port?: unknown;
  application_name?: unknown;
  backend_start?: unknown;
  state?: unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderRoleLogConnectionsSql(): string {
  return `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        EXECUTE 'ALTER ROLE supabase_auth_admin SET log_connections = on';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        EXECUTE 'ALTER ROLE supabase_admin SET log_connections = on';
      END IF;
    END
    $$;
  `;
}

export function renderTenantLoginAuditSql(): string {
  return `
    CREATE SCHEMA IF NOT EXISTS supacloud_platform;
    CREATE OR REPLACE FUNCTION supacloud_platform.audit_cluster_login()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $audit$
    BEGIN
      IF session_user IN ('supabase_auth_admin', 'supabase_admin') THEN
        RAISE LOG 'supacloud_cluster_login role=% database=% client_addr=% client_port=% application_name=% backend_pid=%',
          session_user,
          current_database(),
          coalesce(inet_client_addr()::text, 'local'),
          coalesce(inet_client_port()::text, ''),
          coalesce(current_setting('application_name', true), ''),
          pg_backend_pid();
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    $audit$;
    DO $install$
    BEGIN
      IF current_setting('server_version_num')::int < 170000 THEN
        RETURN;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION supacloud_platform.audit_cluster_login() TO supabase_auth_admin;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        GRANT EXECUTE ON FUNCTION supacloud_platform.audit_cluster_login() TO supabase_admin;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'supacloud_audit_cluster_login') THEN
        RETURN;
      END IF;
      CREATE EVENT TRIGGER supacloud_audit_cluster_login
        ON login
        EXECUTE FUNCTION supacloud_platform.audit_cluster_login();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'supacloud_cluster_login trigger was not installed: %', SQLERRM;
    END;
    $install$;
  `;
}

export function logConnectionsEnabled(rolconfig: unknown): boolean {
  const text = Array.isArray(rolconfig) ? rolconfig.map((setting) => String(setting)).join(",") : String(rolconfig ?? "");
  return text.replaceAll(" ", "").includes("log_connections=on");
}

export function mapClusterLoginSession(row: ActivityRow): ClusterLoginSession {
  const port = row.client_port == null || row.client_port === "" ? null : Number(row.client_port);
  return {
    role: String(row.usename ?? ""),
    database: String(row.datname ?? ""),
    client_addr: String(row.client_addr ?? "local"),
    client_port: port != null && Number.isFinite(port) ? port : null,
    application_name: String(row.application_name ?? ""),
    backend_start: row.backend_start == null ? null : String(row.backend_start),
    state: row.state == null ? null : String(row.state),
  };
}

export function buildClusterLoginAuditReport(input: {
  roleLogConnections: Record<string, boolean | null>;
  sessions: ClusterLoginSession[];
}): ClusterLoginAuditReport {
  return {
    roles: CLUSTER_LOGIN_ROLES,
    isolation: "audit-only",
    note: CLUSTER_LOGIN_AUDIT_NOTE,
    history: "When log_connections is on for these roles, PostgreSQL logs connection authorized lines with the role, database, and client. Tenant databases also emit supacloud_cluster_login. Neither record includes the cluster password.",
    log_connections: input.roleLogConnections,
    sessions: input.sessions,
  };
}

export async function readClusterLoginAudit(): Promise<ClusterLoginAuditReport> {
  const roleRows = await sql<RoleConfigRow[]>`
    SELECT rolname, rolconfig
    FROM pg_roles
    WHERE rolname IN ('supabase_auth_admin', 'supabase_admin')
  `;
  const roleLogConnections: Record<string, boolean | null> = {
    supabase_auth_admin: null,
    supabase_admin: null,
  };
  for (const row of roleRows) {
    const name = String(row.rolname ?? "");
    if (name in roleLogConnections) roleLogConnections[name] = logConnectionsEnabled(row.rolconfig);
  }
  const activity = await sql<ActivityRow[]>`
    SELECT usename,
           datname,
           COALESCE(client_addr::text, 'local') AS client_addr,
           client_port,
           application_name,
           backend_start,
           state
    FROM pg_stat_activity
    WHERE usename IN ('supabase_auth_admin', 'supabase_admin')
      AND backend_type = 'client backend'
    ORDER BY backend_start
  `;
  return buildClusterLoginAuditReport({
    roleLogConnections,
    sessions: activity.map((row) => mapClusterLoginSession(row)),
  });
}

export async function reconcileTenantHbaPairingAndLoginAudit(): Promise<void> {
  try {
    await sql.unsafe(renderRoleLogConnectionsSql());
  } catch (error: unknown) {
    logger.warn("[cluster-login-audit] could not enable role log_connections", {
      error: errorText(error),
    });
  }

  let rows: ProjectPairingRow[] = [];
  try {
    rows = await sql<ProjectPairingRow[]>`
      SELECT ref, db_name, db_user
      FROM projects
      WHERE deleted_at IS NULL
    `;
  } catch (error: unknown) {
    logger.warn("[cluster-login-audit] could not list projects for HBA pairing", {
      error: errorText(error),
    });
    return;
  }

  for (const row of rows) {
    const ref = String(row.ref ?? "");
    const dbName = String(row.db_name ?? "");
    const dbUser = String(row.db_user ?? "");
    try {
      await sql.unsafe(renderTenantHbaPairingSql(dbName, dbUser, `authenticator_${ref}`));
    } catch (error: unknown) {
      logger.warn("[tenant-hba] pairing grant failed", { ref, error: errorText(error) });
      continue;
    }
    try {
      await getProjectDb(dbName).unsafe(renderTenantLoginAuditSql());
    } catch (error: unknown) {
      logger.warn("[cluster-login-audit] login trigger was not installed", {
        ref,
        error: errorText(error),
      });
    }
  }
}
