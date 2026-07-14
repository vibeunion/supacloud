import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Pigsty 4.4 compatibility upgrade", () => {
  test("uses a dedicated Analytics database and schema", () => {
    const installer = readRepoFile("install.sh");

    expect(installer).toContain('LOGFLARE_DB="${LOGFLARE_DB:-_supabase}"');
    expect(installer).toContain('LOGFLARE_SCHEMA="${LOGFLARE_SCHEMA:-_analytics}"');
    expect(installer).toContain('/${LOGFLARE_DB}');
  });

  test("ships an idempotent compatibility upgrade entrypoint", () => {
    const script = readRepoFile("scripts/upgrade_pigsty_4_4_compat.sh");
    const upgrade = readRepoFile("scripts/upgrade_pigsty.sh");

    expect(script).toContain("--check");
    expect(script).toContain("--apply");
    expect(script).toContain("--prepare-analytics");
    expect(script).toContain("CREATE DATABASE");
    expect(script).toContain('ANALYTICS_SCHEMA="${LOGFLARE_SCHEMA:-_analytics}"');
    expect(script).toContain("CREATE SCHEMA IF NOT EXISTS %I");
    expect(script).toContain("extensions.pg_stat_statements_info");
    expect(script).toContain("pg_dump");
    expect(script).toContain("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA");
    expect(script).toContain("supacloud_compat_migrations");
    expect(script).toContain("stop_legacy_analytics");
    expect(script).toContain("Legacy Analytics data exists but no managed compose file was found");
    expect(script).toContain("Run --prepare-analytics before --apply");
    expect(script).toContain("up -d --force-recreate analytics");
    expect(script).toContain("ps -a -q analytics");
    expect(script).toContain("LOGFLARE_DATABASE_URL does not target database");
    expect(script).toContain('migration_required" == "true" || "$env_was_target" != "true"');
    expect(script).toContain("recover_stopped_prepared_analytics");
    expect(script).toContain('run_psql "$ANALYTICS_DB" -1');
    expect(script).toContain("still need opaque API key backfill");
    expect(upgrade).toContain("upgrade_pigsty_4_4_compat.sh");
    expect(upgrade.indexOf("--prepare-analytics")).toBeLessThan(upgrade.indexOf("ansible-playbook"));
    expect(upgrade).toContain('ANALYTICS_PREPARE_COMPLETED" == "true"');
  });
});
