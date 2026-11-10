import { describe, expect, test } from "bun:test";
import {
  CLUSTER_LOGIN_AUDIT_NOTE,
  buildClusterLoginAuditReport,
  logConnectionsEnabled,
  mapClusterLoginSession,
  renderRoleLogConnectionsSql,
  renderTenantLoginAuditSql,
} from "../../src/services/cluster-login-audit";
import { redactLoggedSecrets } from "../../src/services/secret-log-redaction";

describe("cluster login audit", () => {
  test("enables connection logging only for the two cluster LOGIN roles", () => {
    const sql = renderRoleLogConnectionsSql();
    expect(sql).toContain("ALTER ROLE supabase_auth_admin SET log_connections = on");
    expect(sql).toContain("ALTER ROLE supabase_admin SET log_connections = on");
    expect(sql).not.toContain("PASSWORD");
    expect(sql).not.toContain("supabase_realtime_admin");
  });

  test("login trigger records role, database, and client, and cannot refuse the login", () => {
    const sql = renderTenantLoginAuditSql();
    expect(sql).toContain("supacloud_cluster_login role=% database=% client_addr=%");
    expect(sql).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(sql).toContain("ON login");
    expect(sql).not.toContain("PASSWORD");
  });

  test("report lists sessions without query text or the cluster password", () => {
    const report = buildClusterLoginAuditReport({
      roleLogConnections: { supabase_auth_admin: true, supabase_admin: false },
      sessions: [mapClusterLoginSession({
        usename: "supabase_auth_admin",
        datname: "supa_aaa",
        client_addr: "127.0.0.1",
        client_port: 54321,
        application_name: "gotrue",
        backend_start: "2026-11-10T00:00:00Z",
        state: "idle",
      })],
    });
    expect(report.isolation).toBe("audit-only");
    expect(report.note).toBe(CLUSTER_LOGIN_AUDIT_NOTE);
    expect(report.note).toContain("leaked cluster password");
    expect(report.sessions).toEqual([{
      role: "supabase_auth_admin",
      database: "supa_aaa",
      client_addr: "127.0.0.1",
      client_port: 54321,
      application_name: "gotrue",
      backend_start: "2026-11-10T00:00:00Z",
      state: "idle",
    }]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("query");
    expect(serialized).not.toContain("cluster-secret-value");
    expect(Object.keys(report.sessions[0] ?? {})).not.toContain("password");
  });

  test("reads log_connections from role settings without returning the setting list", () => {
    expect(logConnectionsEnabled(["search_path=auth, public", "log_connections=on"])).toBe(true);
    expect(logConnectionsEnabled(["log_connections=off"])).toBe(false);
    expect(logConnectionsEnabled(null)).toBe(false);
  });
});

describe("logged secret redaction", () => {
  test("removes echoed cluster passwords from realtime error bodies", () => {
    const body = JSON.stringify({
      db_password: "cluster-secret-value",
      url: "postgres://supabase_admin:cluster-secret-value@127.0.0.1:5432/supa_aaa",
    });
    const redacted = redactLoggedSecrets(body, ["cluster-secret-value"]);
    expect(redacted).not.toContain("cluster-secret-value");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("supabase_admin");
  });
});
