import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlPlaneUpgradeSafetyInternals,
  prepareControlPlaneUpgradeSafety,
  withControlPlaneUpgradeSafety,
} from "../../src/control-plane-upgrade-safety";

const databaseUrl = "postgresql://postgres:private-password@127.0.0.1:5432/supacloud_meta";
const target = controlPlaneUpgradeSafetyInternals.databaseTarget(databaseUrl);
const inspection = {
  candidateCounts: {
    deprecated_webhook_secrets: 0,
    legacy_deployment_history_rows: 0,
    legacy_project_config_rows: 0,
    opaque_key_backfill_projects: 0,
    stored_secret_values: 4,
  },
  checkpointPresent: true,
  databaseFingerprint: "b".repeat(64),
  databaseTargetFingerprint: controlPlaneUpgradeSafetyInternals.databaseTargetFingerprint(target),
  snapshotId: "00000003-0000001B-1",
};

function writeTrustedBackup(backupRoot: string, backupId: string): void {
  const backupDirectory = join(backupRoot, backupId);
  const archive = "verified-historical-control-plane-dump";
  mkdirSync(backupDirectory, { mode: 0o700 });
  writeFileSync(join(backupDirectory, "control-plane.dump"), archive, { mode: 0o600 });
  writeFileSync(join(backupDirectory, "receipt.json"), `${JSON.stringify({
    schema: "supacloud.control-plane-upgrade-safety.v1",
    backup_id: backupId,
    backup_directory: backupDirectory,
    bytes: Buffer.byteLength(archive),
    candidate_counts: inspection.candidateCounts,
    completed_at: "2026-08-18T00:00:00.000Z",
    current_key_checkpoint_present: true,
    sha256: createHash("sha256").update(archive).digest("hex"),
  })}\n`, { mode: 0o600 });
}

describe("control-plane upgrade safety", () => {
  test("creates a private verified dump receipt without putting the password in command arguments", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-backup-"));
    chmodSync(backupRoot, 0o700);
    const commands: string[][] = [];
    try {
      const evidence = await controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000001",
        run: async ({ args, env, stdin, stdout }) => {
          commands.push(args);
          if (args.some((argument) => argument.endsWith("/pg_dump"))) {
            expect(env?.PGPASSWORD).toBe("private-password");
            expect(Object.keys(env || {})).toEqual(["PGPASSWORD"]);
            writeFileSync(stdout!, "verified-control-plane-dump");
          }
          if (args.some((argument) => argument.endsWith("/pg_restore"))) {
            expect(readFileSync(stdin!, "utf8")).toBe("verified-control-plane-dump");
          }
          return 0;
        },
      });

      expect(commands.flat()).not.toContain("private-password");
      expect(commands[0]).toContain("--reuid");
      expect(commands[0]).toContain("--snapshot");
      expect(commands[0]).toContain(inspection.snapshotId);
      expect(commands[1]?.some((argument) => argument.endsWith("/pg_restore"))).toBe(true);
      expect(commands[1]).toContain("--list");
      expect(evidence).toMatchObject({
        schema: "supacloud.control-plane-upgrade-safety.v1",
        backup_id: "control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000001",
        bytes: 27,
        candidate_counts: inspection.candidateCounts,
        current_key_checkpoint_present: true,
      });
      expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(evidence.backup_directory, "control-plane.dump")).mode & 0o777).toBe(0o600);
      expect(statSync(join(evidence.backup_directory, "receipt.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(evidence.backup_directory, "receipt.json"), "utf8"))).toEqual(evidence);
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("removes partial backup state when archive verification fails", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-backup-failure-"));
    chmodSync(backupRoot, 0o700);
    try {
      await expect(controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000002",
        run: async ({ args, stdout }) => {
          if (args.some((argument) => argument.endsWith("/pg_dump"))) {
            writeFileSync(stdout!, "incomplete");
          }
          return args.some((argument) => argument.endsWith("/pg_restore")) ? 1 : 0;
        },
      })).rejects.toThrow("archive verification failed");
      expect(readdirSync(backupRoot)).toEqual([]);
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("lets the postgres identity write only through the inherited root-owned archive descriptor", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-descriptor-"));
    chmodSync(backupRoot, 0o700);
    let dumpArguments: string[] = [];
    try {
      const evidence = await controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: 65_534, gid: 65_534 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000007",
        run: async ({ args, stdout }) => {
          if (args.some((argument) => argument.endsWith("/pg_dump"))) {
            dumpArguments = args;
            writeFileSync(stdout!, "descriptor-only-dump");
          }
          return 0;
        },
      });
      expect(dumpArguments).toContain("65534");
      expect(dumpArguments.some((argument) => argument.startsWith(backupRoot))).toBe(false);
      expect(statSync(backupRoot).mode & 0o777).toBe(0o700);
      expect(statSync(evidence.backup_directory).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("rejects an empty archive before catalog verification", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-empty-"));
    chmodSync(backupRoot, 0o700);
    let catalogChecks = 0;
    try {
      await expect(controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000003",
        run: async ({ args }) => {
          if (!args.some((argument) => argument.endsWith("/pg_dump"))) {
            catalogChecks += 1;
          }
          return 0;
        },
      })).rejects.toThrow("archive is empty");
      expect(catalogChecks).toBe(0);
      expect(readdirSync(backupRoot)).toEqual([]);
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("rejects symlink, directory, and multiply-linked dump outputs", async () => {
    for (const archiveKind of ["symlink", "directory", "hardlink"] as const) {
      const backupRoot = mkdtempSync(join(tmpdir(), `supacloud-control-plane-${archiveKind}-`));
      chmodSync(backupRoot, 0o700);
      try {
        await expect(controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
          backupRoot,
          identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
          now: () => new Date("2026-08-19T00:00:00.000Z"),
          randomId: () => "00000000-0000-4000-8000-000000000004",
          run: async ({ args, stdout }) => {
            if (!args.some((argument) => argument.endsWith("/pg_dump"))) return 0;
            writeFileSync(stdout!, "dump-written-only-to-reserved-descriptor");
            const archivePath = join(
              backupRoot,
              "control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000004",
              "control-plane.dump",
            );
            rmSync(archivePath, { force: true, recursive: true });
            if (archiveKind === "directory") mkdirSync(archivePath);
            if (archiveKind === "symlink") {
              const targetPath = join(backupRoot, "untrusted-target");
              writeFileSync(targetPath, "not-a-dump", { mode: 0o600 });
              symlinkSync(targetPath, archivePath);
            }
            if (archiveKind === "hardlink") {
              const targetPath = join(backupRoot, "multiply-linked-target");
              writeFileSync(targetPath, "not-a-dump", { mode: 0o600 });
              linkSync(targetPath, archivePath);
            }
            return 0;
          },
        })).rejects.toThrow("trusted regular file");
        expect(readdirSync(backupRoot).some((entry) => entry.startsWith("control-plane-"))).toBe(false);
      } finally {
        rmSync(backupRoot, { force: true, recursive: true });
      }
    }
  });

  test("retains the current backup and four newest trusted predecessors", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-retention-"));
    chmodSync(backupRoot, 0o700);
    const historicalIds = Array.from({ length: 6 }, (_, index) => (
      `control-plane-20260818T00000${index}Z-00000000-0000-4000-8000-00000000000${index}`
    ));
    for (const backupId of historicalIds) writeTrustedBackup(backupRoot, backupId);
    mkdirSync(join(backupRoot, "manual-keep"), { mode: 0o700 });
    try {
      const evidence = await controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000005",
        run: async ({ args, stdout }) => {
          if (args.some((argument) => argument.endsWith("/pg_dump"))) {
            writeFileSync(stdout!, "verified-control-plane-dump");
          }
          return 0;
        },
      });
      const retainedIds = readdirSync(backupRoot).filter((entry) => entry.startsWith("control-plane-"));
      expect(retainedIds).toHaveLength(5);
      expect(retainedIds).toContain(evidence.backup_id);
      expect(retainedIds).toEqual(expect.arrayContaining(historicalIds.slice(-4)));
      expect(readdirSync(backupRoot)).toContain("manual-keep");
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("refuses to remove an untrusted matching retention entry", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-retention-trust-"));
    chmodSync(backupRoot, 0o700);
    const targetDirectory = join(backupRoot, "manual-target");
    mkdirSync(targetDirectory, { mode: 0o700 });
    const untrustedId = "control-plane-20260817T000000Z-00000000-0000-4000-8000-000000000000";
    symlinkSync(targetDirectory, join(backupRoot, untrustedId));
    for (let index = 1; index <= 5; index += 1) {
      writeTrustedBackup(
        backupRoot,
        `control-plane-20260818T00000${index}Z-00000000-0000-4000-8000-00000000000${index}`,
      );
    }
    try {
      await expect(controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000006",
        run: async ({ args, stdout }) => {
          if (args.some((argument) => argument.endsWith("/pg_dump"))) {
            writeFileSync(stdout!, "verified-control-plane-dump");
          }
          return 0;
        },
      })).rejects.toThrow("trusted directory");
      expect(statSync(targetDirectory).isDirectory()).toBe(true);
      expect(readdirSync(backupRoot)).toContain(untrustedId);
      expect(readdirSync(backupRoot)).toContain(
        "control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000006",
      );
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("refuses a root-owned matching directory without a complete backup pair", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-retention-pair-"));
    chmodSync(backupRoot, 0o700);
    const misplacedId = "control-plane-20260817T000000Z-00000000-0000-4000-8000-000000000010";
    mkdirSync(join(backupRoot, misplacedId), { mode: 0o700 });
    for (let index = 1; index <= 5; index += 1) {
      writeTrustedBackup(
        backupRoot,
        `control-plane-20260818T00000${index}Z-00000000-0000-4000-8000-00000000001${index}`,
      );
    }
    const currentId = "control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000011";
    try {
      await expect(controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000011",
        run: async ({ args, stdout }) => {
          if (args.some((argument) => argument.endsWith("/pg_dump"))) {
            writeFileSync(stdout!, "verified-control-plane-dump");
          }
          return 0;
        },
      })).rejects.toThrow("contents are not trusted");
      expect(readdirSync(backupRoot)).toContain(misplacedId);
      expect(readdirSync(backupRoot)).toContain(currentId);
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("keeps the durable current backup when retention deletion stops midway", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "supacloud-control-plane-retention-failure-"));
    chmodSync(backupRoot, 0o700);
    const historicalIds = Array.from({ length: 6 }, (_, index) => (
      `control-plane-20260818T00000${index}Z-00000000-0000-4000-8000-00000000000${index}`
    ));
    for (const backupId of historicalIds) writeTrustedBackup(backupRoot, backupId);
    let removals = 0;
    const currentId = "control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000008";
    try {
      await expect(controlPlaneUpgradeSafetyInternals.createControlPlaneBackup(target, inspection, {
        backupRoot,
        identity: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
        now: () => new Date("2026-08-19T00:00:00.000Z"),
        randomId: () => "00000000-0000-4000-8000-000000000008",
        remove: (directory) => {
          removals += 1;
          if (removals === 2) throw new Error("retention delete failed");
          rmSync(directory, { force: true, recursive: true });
        },
        run: async ({ args, stdout }) => {
          if (args.some((argument) => argument.endsWith("/pg_dump"))) {
            writeFileSync(stdout!, "verified-control-plane-dump");
          }
          return 0;
        },
      })).rejects.toThrow("retention delete failed");
      expect(removals).toBe(2);
      expect(readdirSync(backupRoot)).toContain(currentId);
      expect(readdirSync(join(backupRoot, currentId)).sort()).toEqual(["control-plane.dump", "receipt.json"]);
      expect(readdirSync(backupRoot).filter((entry) => entry.startsWith("control-plane-"))).toHaveLength(6);
    } finally {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  });

  test("holds the exported snapshot inspection open through backup", async () => {
    let inspectionOpen = false;
    await withControlPlaneUpgradeSafety(databaseUrl, "k".repeat(32), async (lease) => {
      expect(inspectionOpen).toBe(true);
      expect(lease.snapshotId).toBe(inspection.snapshotId);
      expect(lease.databaseFingerprint).toBe(inspection.databaseFingerprint);
      expect(lease.evidence).not.toHaveProperty("database_fingerprint");
    }, {
      withInspection: async (_databaseUrl, _currentKey, operation) => {
        inspectionOpen = true;
        try {
          return await operation(inspection);
        } finally {
          inspectionOpen = false;
        }
      },
      backup: async (_target, inspected) => {
        expect(inspectionOpen).toBe(true);
        expect(inspected.snapshotId).toBe(inspection.snapshotId);
        return {
          schema: "supacloud.control-plane-upgrade-safety.v1",
          backup_id: "control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000009",
          backup_directory: "/var/lib/supacloud/backups/control-plane-upgrades/control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000009",
          bytes: 1,
          candidate_counts: inspection.candidateCounts,
          completed_at: "2026-08-19T00:00:00.000Z",
          current_key_checkpoint_present: true,
          sha256: "a".repeat(64),
        };
      },
    });
    expect(inspectionOpen).toBe(false);
  });

  test("fails closed when inspection and backup resolve different database identities", async () => {
    await expect(prepareControlPlaneUpgradeSafety(databaseUrl, "k".repeat(32), {
      withInspection: async (_databaseUrl, _currentKey, operation) => operation({
        ...inspection,
        databaseTargetFingerprint: "0".repeat(64),
      }),
      backup: async () => { throw new Error("backup must not run"); },
    })).rejects.toThrow("database identity changed");
  });

  test("rejects incomplete or non-PostgreSQL database targets", () => {
    expect(() => controlPlaneUpgradeSafetyInternals.databaseTarget("https://example.com/db"))
      .toThrow("PostgreSQL");
    expect(() => controlPlaneUpgradeSafetyInternals.databaseTarget("postgresql://localhost"))
      .toThrow("incomplete");
  });
});
