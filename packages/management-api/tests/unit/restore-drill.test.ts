import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPONENTS, parseRestoreSnapshot, safeRestorePath, sha256, signDrillDocument, verifyDrillDocument,
  type RestoreSnapshot,
} from "../../src/services/restore-drill-contract";
import { assertDrillIsolation, pgbackrestArgs, postgresRecoveryTimestamp, verifyRestoreInventory } from "../../src/services/project-restore-drill";
import { decryptSecretWithKey, encryptSecretWithKey } from "../../src/utils/secret-crypto-core";

const key = "snapshot-key-".repeat(4);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function fixture(): RestoreSnapshot {
  const snapshot: RestoreSnapshot = {
    schema: "supacloud.project-restore-snapshot.v1", snapshot_id: crypto.randomUUID(), project_ref: "testproject",
    incident_at: "2026-09-08T00:00:00.000Z",
    recovery_points: Object.fromEntries(COMPONENTS.map((component) => [component, "2026-09-07T23:59:00.000Z"])) as RestoreSnapshot["recovery_points"],
    database: { kind: "logical-full", name: "project_db", admin_role: "postgres", major: 18 },
    files: ["database/database.dump", "database/globals.sql", "objects/file", "runtime/check.js", "secrets/runtime-env.enc"]
      .map((path) => ({ path, bytes: 4, sha256: sha256("test") })),
    database_env_keys: ["FA_DATABASE_URL"],
    sql_checks: [
      { category: "permissions", name: "tenant_allowed", role: "authenticated", query: "SELECT 1 AS visible", expected: [{ visible: 1 }] },
      { category: "permissions", name: "tenant_denied", role: "authenticated", query: "SELECT 1 WHERE false", expected: [] },
      { category: "queues", name: "queue", role: "postgres", query: "SELECT 1", expected: [] },
      { category: "business", name: "business", role: "postgres", query: "SELECT 1", expected: [] },
    ],
    marker_query: "SELECT snapshot_id, recovered_through FROM restore_marker",
    http_checks: [
      { slug: "check", path: "/", auth: "anonymous", status: 401, sha256: sha256("denied") },
      { slug: "check", path: "/", auth: "service_role", status: 200, sha256: sha256("ok") },
    ],
    max_rpo_ms: 60000, max_rto_ms: 120000, signature: "",
  };
  return snapshot;
}

function serialized(snapshot = fixture()): string {
  snapshot.signature = signDrillDocument(snapshot as unknown as Record<string, unknown>, key);
  return JSON.stringify(snapshot);
}

test("signed complete manifests preserve method, fixture coverage and budgets", () => {
  const result = parseRestoreSnapshot(serialized(), key);
  expect(result.database.kind).toBe("logical-full");
  expect(result.sql_checks.length).toBe(4);
  expect(result.max_rpo_ms).toBe(60000);
});

test("tampering, missing keys and invalid source signature fail closed", () => {
  const raw = serialized();
  expect(() => parseRestoreSnapshot(raw.replace("60000", "60001"), key)).toThrow("signature");
  expect(() => parseRestoreSnapshot(raw, "other-key-".repeat(4))).toThrow("signature");
  expect(() => parseRestoreSnapshot(raw, "")).toThrow();
});

test("paths cannot escape a component or use traversal separators", () => {
  for (const path of ["/etc/passwd", "runtime/../secret", "runtime//file", "runtime\\file", "secrets/\u0000", "other/file"]) {
    expect(safeRestorePath(path)).toBe(false);
  }
  expect(safeRestorePath("runtime/.versions/check/1/src/.supacloud-entry.js")).toBe(true);
});

test("missing component and incomplete fixture coverage cannot produce a valid plan", () => {
  for (const component of COMPONENTS) {
    const snapshot = fixture();
    snapshot.files = snapshot.files.filter((entry) => !entry.path.startsWith(component + "/"));
    expect(() => parseRestoreSnapshot(serialized(snapshot), key)).toThrow();
  }
  for (const category of ["permissions", "queues", "business"]) {
    const snapshot = fixture();
    snapshot.sql_checks = snapshot.sql_checks.filter((check) => check.category !== category);
    expect(() => parseRestoreSnapshot(serialized(snapshot), key)).toThrow();
  }
  const snapshot = fixture();
  snapshot.http_checks = snapshot.http_checks.filter((check) => check.auth !== "anonymous");
  expect(() => parseRestoreSnapshot(serialized(snapshot), key)).toThrow();
});

test("invalid SQL, database identities and future recovery times are rejected", () => {
  for (const query of ["DELETE FROM business", "SELECT 1; COMMIT", "SELECT 1 -- skip", "SELECT /* injected */ 1"]) {
    const snapshot = fixture(); snapshot.marker_query = query;
    expect(() => parseRestoreSnapshot(serialized(snapshot), key)).toThrow();
  }
  for (const name of ["postgres", "template1", "bad-name", "db;drop"]) {
    const snapshot = fixture(); snapshot.database.name = name;
    expect(() => parseRestoreSnapshot(serialized(snapshot), key)).toThrow();
  }
  const snapshot = fixture(); snapshot.recovery_points.objects = "2099-01-01T00:00:00.000Z";
  expect(() => parseRestoreSnapshot(serialized(snapshot), key)).toThrow();
});

test("PITR commands only reference the private target and staged repository", () => {
  const snapshot = fixture();
  snapshot.database = { ...snapshot.database, kind: "pgbackrest", stanza: "tenant", backup_set: "20260907-235900F", recovery_target: snapshot.incident_at };
  snapshot.files = snapshot.files.filter((entry) => !entry.path.startsWith("database/"));
  snapshot.files.push({ path: "database/repo/backup/tenant/backup.info", bytes: 4, sha256: sha256("test") });
  const validated = parseRestoreSnapshot(serialized(snapshot), key);
  const args = pgbackrestArgs(validated, "/drill/owned");
  expect(args).toContain("--pg1-path=/drill/owned/pgdata");
  expect(args).toContain("--repo1-path=/drill/owned/input/database/repo");
  expect(args.join(" ")).not.toContain("pig pitr");
  expect(postgresRecoveryTimestamp(snapshot.incident_at)).toBe("2026-09-08 00:00:00.000+00");
});

test("inventory verification reads actual bytes and refuses omissions or symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-restore-inventory-")); roots.push(root);
  const snapshot = fixture();
  for (const component of COMPONENTS) await mkdir(join(root, component));
  for (const entry of snapshot.files) await Bun.write(join(root, entry.path), "test");
  await verifyRestoreInventory(root, snapshot);
  await Bun.write(join(root, "objects/unlisted"), "extra");
  await expect(verifyRestoreInventory(root, snapshot)).rejects.toThrow("incomplete");
  await rm(join(root, "objects/unlisted"));
  await Bun.write(join(root, "objects/file"), "edit");
  await expect(verifyRestoreInventory(root, snapshot)).rejects.toThrow("digest");
  await rm(join(root, "objects/file"));
  await symlink(join(root, "runtime/check.js"), join(root, "objects/file"));
  await expect(verifyRestoreInventory(root, snapshot)).rejects.toThrow("symlink");
});

test("existing AES-GCM snapshot encryption requires the exact recovery key", () => {
  const payload = JSON.stringify({ snapshot_id: "fixture", project_ref: "testproject", values: { credential: "private" } });
  const encrypted = encryptSecretWithKey(payload, "recovery-key-".repeat(4));
  expect(encrypted).not.toContain("private");
  expect(decryptSecretWithKey(encrypted, "recovery-key-".repeat(4))).toBe(payload);
  expect(() => decryptSecretWithKey(encrypted, "wrong-key-".repeat(4))).toThrow();
});

test("receipt signature detects forged success and does not expose key material", () => {
  const receipt = { schema: "supacloud.project-restore-drill.v1", status: "failed", signature: "" };
  receipt.signature = signDrillDocument(receipt, key);
  verifyDrillDocument(receipt, key);
  expect(JSON.stringify(receipt)).not.toContain(key);
  expect(() => verifyDrillDocument({ ...receipt, status: "succeeded" }, key)).toThrow("signature");
});

test.skipIf(process.platform === "linux")("host execution refuses restoration before any command", async () => {
  await expect(assertDrillIsolation()).rejects.toThrow("non-root Linux container");
});
