import { describe, expect, test } from "bun:test";
import {
  assertPostgresUpgradeScopeUnchanged,
  buildPostgresMajorUpgradePlan,
  buildPostgresUpgradeScopeSnapshot,
  canTransitionPostgresUpgrade,
  normalizePostgresMajor,
  parsePostgresUpgradeScopeDatabases,
  publicPostgresUpgradeStatus,
  summarizePostgresUpgradePreflight,
  isTrustedExecutorMetadata,
  shouldRecoverPostgresUpgrade,
} from "../../src/services/postgres-major-upgrade.service";

describe("PostgreSQL major upgrade workflow", () => {
  test("allows only a supported forward major upgrade", () => {
    expect(normalizePostgresMajor("15.7", "17")).toEqual({ current: 15, target: 17 });
    expect(() => normalizePostgresMajor("17.4", "16")).toThrow("newer");
    expect(() => normalizePostgresMajor("18.1", "19")).toThrow("supported");
  });

  test("uses a cluster-scoped backup-first plan with exact approval", () => {
    const plan = buildPostgresMajorUpgradePlan({
      id: "11111111-1111-4111-8111-111111111111",
      requestedProjectRef: "proj_1",
      currentMajor: 15,
      targetMajor: 17,
    });
    expect(plan.scope).toBe("cluster");
    expect(plan.affects_all_projects).toBe(true);
    expect(plan.steps.map((step) => step.id)).toEqual([
      "preflight", "full_backup", "upgrade", "validate", "cutover", "rollback_window",
    ]);
    expect(plan.required_confirmation).toBe("UPGRADE POSTGRES CLUSTER 15 TO 17:11111111-1111-4111-8111-111111111111");
  });

  test("fails preflight closed when backup, capacity, or compatibility evidence is missing", () => {
    expect(summarizePostgresUpgradePreflight([
      { id: "database", status: "pass", message: "PostgreSQL 15" },
      { id: "backup", status: "fail", message: "No readable full backup" },
      { id: "disk", status: "unknown", message: "Cannot inspect target volume" },
    ])).toEqual({ ready: false, blockers: ["backup", "disk"], warnings: [] });
  });

  test("permits only explicit durable state transitions", () => {
    expect(canTransitionPostgresUpgrade("preflight_running", "awaiting_approval")).toBe(true);
    expect(canTransitionPostgresUpgrade("awaiting_approval", "backup_running")).toBe(true);
    expect(canTransitionPostgresUpgrade("upgrade_running", "rollback_running")).toBe(true);
    expect(canTransitionPostgresUpgrade("manual_recovery_required", "rollback_requested")).toBe(true);
    expect(canTransitionPostgresUpgrade("rollback_requested", "rollback_running")).toBe(true);
    expect(canTransitionPostgresUpgrade("succeeded", "upgrade_running")).toBe(false);
    expect(canTransitionPostgresUpgrade("draft", "succeeded")).toBe(false);
  });

  test("requires a root-owned non-writable regular executor", () => {
    expect(isTrustedExecutorMetadata({ isFile: true, uid: 0, mode: 0o755 })).toBe(true);
    expect(isTrustedExecutorMetadata({ isFile: true, uid: 1000, mode: 0o755 })).toBe(false);
    expect(isTrustedExecutorMetadata({ isFile: true, uid: 0, mode: 0o775 })).toBe(false);
    expect(isTrustedExecutorMetadata({ isFile: false, uid: 0, mode: 0o755 })).toBe(false);
  });

  test("never blindly resumes an interrupted provider execution", () => {
    expect(shouldRecoverPostgresUpgrade("backup_running")).toBe(true);
    expect(shouldRecoverPostgresUpgrade("rollback_requested")).toBe(true);
    expect(shouldRecoverPostgresUpgrade("upgrade_running")).toBe(false);
    expect(shouldRecoverPostgresUpgrade("validating")).toBe(true);
    expect(shouldRecoverPostgresUpgrade("rollback_running")).toBe(false);
  });

  test("redacts cluster-wide upgrade evidence from project-scoped status", () => {
    const status = publicPostgresUpgradeStatus({
      id: "upgrade-1",
      requested_project_ref: "project-a",
      current_major: 15,
      target_major: 17,
      status: "manual_recovery_required",
      scope_snapshot: { projects: [{ ref: "project-b", database_name: "secret-db" }] },
      backup_evidence: { backup_id: "secret-backup" },
      executor_evidence: { stdout: "secret" },
      error_message: "secret failure details",
      lease_token: "secret-token",
    }, "project-a");

    expect(status).toEqual({
      id: "upgrade-1",
      status: "manual_recovery_required",
      capability: true,
      available: true,
      scope: "cluster",
      current_version: "15",
      target_version: "17",
      upgrade_status: "manual_recovery_required",
      requested_by_current_project: true,
    });
  });

  test("captures every active project in the cluster backup scope", () => {
    expect(buildPostgresUpgradeScopeSnapshot([
      { ref: "project-a", status: "active", db_name: "supa_project_a" },
      { ref: "project-b", status: "active", db_name: "supa_project_b" },
    ], "2026-07-28T00:00:00.000Z")).toEqual({
      scope: "cluster",
      project_count: 2,
      projects: [
        { ref: "project-a", status: "active", database_name: "supa_project_a" },
        { ref: "project-b", status: "active", database_name: "supa_project_b" },
      ],
      captured_at: "2026-07-28T00:00:00.000Z",
    });
  });

  test("requires a complete unique per-project validation scope", () => {
    expect(parsePostgresUpgradeScopeDatabases({
      project_count: 2,
      projects: [
        { ref: "project-a", database_name: "supa_project_a" },
        { ref: "project-b", database_name: "supa_project_b" },
      ],
    })).toEqual([
      { ref: "project-a", databaseName: "supa_project_a" },
      { ref: "project-b", databaseName: "supa_project_b" },
    ]);
    expect(() => parsePostgresUpgradeScopeDatabases({
      project_count: 2,
      projects: [
        { ref: "project-a", database_name: "supa_project_a" },
        { ref: "project-b", database_name: "supa_project_a" },
      ],
    })).toThrow("duplicate");
    expect(() => assertPostgresUpgradeScopeUnchanged({
      project_count: 1,
      projects: [{ ref: "project-a", database_name: "supa_project_a" }],
    }, [
      { ref: "project-a", db_name: "supa_project_a" },
      { ref: "project-new", db_name: "supa_project_new" },
    ])).toThrow("scope changed");
  });
});
