import { describe, expect, test } from "bun:test";
import { evaluateBackupReadiness, parseBackupReadiness } from "./lib/backup-acceptance";

const readiness = (stop: number | null) => parseBackupReadiness({
  schema: "supacloud.backup-readiness.v1",
  provider: "pigsty.pgbackrest",
  stanza: "db-main",
  status: "ready",
  repository_count: 1,
  completed_backup_count: stop === null ? 0 : 1,
  latest_completed_backup: stop === null ? null : { label: "20261107-120000F", timestamp: { start: stop - 30, stop } },
});

describe("Pigsty backup acceptance", () => {
  test("confirms a fresh completed backup and repository", () => {
    const result = evaluateBackupReadiness(readiness(1_000_000), 1_000_000_000, 100);
    expect(result.status).toBe("confirmed");
    expect(result.reasons).toEqual([]);
    expect(result.freshness_seconds).toBe(0);
  });

  test("fails closed for stale or missing completed backups", () => {
    expect(evaluateBackupReadiness(readiness(1_000_000), 1_000_200_000, 100).reasons).toContain("backup_stale");
    expect(evaluateBackupReadiness(readiness(null), 1_000_000_000, 100).reasons).toContain("completed_backup_missing");
  });

  test("rejects a document from another provider", () => {
    expect(() => parseBackupReadiness({ schema: "supacloud.backup-readiness.v1", provider: "filesystem", status: "ready" })).toThrow("Invalid backup readiness");
  });
});
