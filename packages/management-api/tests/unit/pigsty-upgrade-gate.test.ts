import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Pigsty upgrade acceptance gate", () => {
  test("fails closed when PGDATA holds a path the backup user cannot read", () => {
    const gate = readRepoFile("scripts/verify-pigsty-upgrade-acceptance.sh");

    expect(gate).toContain("show data_directory");
    expect(gate).toContain('find "$pgdata_real" ! -user postgres');
    expect(gate).toContain("PGDATA contains paths not owned by postgres");
  });

  test("keeps the backup manager executable for direct spawning", () => {
    const mode = statSync(resolve(repoRoot, "scripts/lib/backup_manager.sh")).mode;
    expect(mode & 0o111).not.toBe(0);

    // The acceptance checker spawns the manager directly, without a shell.
    expect(readRepoFile("scripts/verify-pigsty-backup-acceptance.ts")).toContain(
      'Bun.spawn([manager, "verify"]',
    );
  });
});