import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Pigsty version defaults", () => {
  test("pins every installation entrypoint to v4.5.0", () => {
    expect(readRepoFile("config.env")).toContain('PIGSTY_VERSION="v4.5.0"');
    expect(readRepoFile("install.sh")).toContain('${PIGSTY_VERSION:-v4.5.0}');
    expect(readRepoFile("scripts/lib/install_config.sh")).toContain(
      '${PIGSTY_VERSION:-v4.5.0}',
    );
    expect(readRepoFile("scripts/upgrade_pigsty.sh")).toContain(
      'PIGSTY_VERSION="${PIGSTY_VERSION:-v4.5.0}"',
    );
    expect(readRepoFile("packages/management-api/src/install.ts")).toContain(
      'configured.PIGSTY_VERSION || "v4.5.0"',
    );

    for (const path of ["README.md", "README.zh-CN.md", "README.es-ES.md"]) {
      expect(readRepoFile(path)).toContain("`v4.5.0`");
    }
  });

  test("keeps historical Pigsty 4.4 migration identifiers stable", () => {
    const compatibility = readRepoFile("scripts/upgrade_pigsty_4_4_compat.sh");
    expect(compatibility).toContain(
      'ANALYTICS_MIGRATION_ID="pigsty-4.4-postgres-analytics-to-${ANALYTICS_DB}"',
    );
    expect(compatibility).toContain("supacloud:pigsty-4.4-auth-jwt-helpers:v1");
    expect(compatibility).toContain("supacloud:pigsty-4.4-background-task-mirror:v3");
  });

  test("documents the current pin separately from the historical migration", () => {
    const index = readRepoFile("docs/README.md");
    const current = readRepoFile("docs/upgrade-to-pigsty-4.5.md");
    const historical = readRepoFile("docs/upgrade-to-pigsty-4.4.md");

    expect(index).toContain("./upgrade-to-pigsty-4.5.md");
    expect(current).toContain("PIGSTY_VERSION=v4.5.0");
    expect(current).toContain("upgrade_pigsty_4_4_compat.sh --check");
    expect(historical).toContain("Historical migration guide");
  });
});
