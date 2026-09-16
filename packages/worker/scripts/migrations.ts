import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { sharedProfile } from "./shared-profile.js";

export interface Migration {
  version: string;
  sql: string;
}

export async function loadMigrations(profile: "dedicated" | "shared" = "dedicated"): Promise<Migration[]> {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@pgflow/core/package.json"));
  const manifest: unknown = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    manifest.version !== "0.16.0"
  ) {
    throw new Error("PGFLOW_PACKAGE_VERSION_MISMATCH");
  }
  const folder = join(root, "dist/supabase/migrations");
  const files = (await readdir(folder))
    .filter((name) => /^\d{14}_pgflow_.*\.sql$/.test(name))
    .sort();
  if (
    files.length !== 23 ||
    files.at(-1) !== "20260907082520_pgflow_remove_legacy_flow_compilation.sql"
  ) {
    throw new Error("PGFLOW_MIGRATION_SET_MISMATCH");
  }
  const migrations = await Promise.all(
    files.map(async (name) => ({
      version: name.slice(0, 14),
      sql: profile === "shared"
        ? await sharedProfile(await readFile(join(folder, name), "utf8"))
        : await readFile(join(folder, name), "utf8"),
    })),
  );
  migrations.push({
    version: "supacloud_001",
    sql: await readFile(
      new URL("../sql/001-task-projection.sql", import.meta.url),
      "utf8",
    ),
  });
  return migrations;
}

/** psql owns one connection and one transaction, including its advisory lock. */
export function renderInstall(
  migrations: readonly Migration[],
  projectRef: string,
  database: string,
  profile: "dedicated" | "shared" = "dedicated",
): string {
  if (
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(projectRef) ||
    !/^[a-zA-Z0-9_-]{1,63}$/.test(database)
  ) {
    throw new Error("PGFLOW_INSTALL_TARGET_INVALID");
  }
  if (
    !migrations.length ||
    new Set(migrations.map((m) => m.version)).size !== migrations.length ||
    migrations.some((m) => !/^(?:\d{14}|supacloud_\d{3})$/.test(m.version))
  ) {
    throw new Error("PGFLOW_MIGRATION_SET_INVALID");
  }
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('supacloud-pgflow-install',0));
DO $preflight$
BEGIN
  IF current_database() <> '${database}' THEN RAISE EXCEPTION 'PGFLOW_DATABASE_MISMATCH'; END IF;
  IF ${profile === "dedicated"} AND (current_setting('cron.database_name',true) IS DISTINCT FROM current_database()
    OR current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION 'PGFLOW_REQUIRES_ACTIVE_CRON_IN_PROJECT_DATABASE';
  END IF;
  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL
    OR (${profile === "dedicated"} AND to_regclass('vault.decrypted_secrets') IS NULL) THEN
    RAISE EXCEPTION 'PGFLOW_REQUIRES_REALTIME_AND_VAULT';
  END IF;
  IF EXISTS (SELECT unnest(ARRAY[${profile === "dedicated" ? "'pgmq','pg_cron','pg_net'" : "'pgmq'"}]) EXCEPT SELECT name FROM pg_available_extensions) THEN
    RAISE EXCEPTION 'PGFLOW_EXTENSIONS_UNAVAILABLE';
  END IF;
  IF to_regnamespace('pgflow') IS NOT NULL AND to_regclass('supacloud_worker.migrations') IS NULL THEN
    RAISE EXCEPTION 'PGFLOW_UNTRACKED_BASELINE';
  END IF;
END $preflight$;
CREATE SCHEMA IF NOT EXISTS supacloud_worker;
REVOKE ALL ON SCHEMA supacloud_worker FROM PUBLIC;
CREATE TABLE IF NOT EXISTS supacloud_worker.installation(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  project_ref text NOT NULL, engine_version text NOT NULL
);
ALTER TABLE supacloud_worker.installation ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'dedicated';
INSERT INTO supacloud_worker.installation VALUES(true,'${projectRef}','0.16.0','${profile}') ON CONFLICT DO NOTHING;
DO $binding$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM supacloud_worker.installation
    WHERE singleton AND project_ref='${projectRef}' AND engine_version='0.16.0' AND profile='${profile}') THEN
    RAISE EXCEPTION 'PGFLOW_INSTALLATION_BINDING_MISMATCH';
  END IF;
END $binding$;
CREATE TABLE IF NOT EXISTS supacloud_worker.migrations(
  version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $supported$
BEGIN
  IF EXISTS(SELECT 1 FROM supacloud_worker.migrations WHERE version NOT IN (
    ${migrations.map((m) => `'${m.version}'`).join(",")}
  )) THEN RAISE EXCEPTION 'PGFLOW_NEWER_DATABASE_SCHEMA'; END IF;
END $supported$;
${migrations
  .map((m) => {
    const checksum = createHash("sha256").update(m.sql).digest("hex");
    return `
DO $checksum$
BEGIN
  IF EXISTS(SELECT 1 FROM supacloud_worker.migrations WHERE version='${m.version}' AND sha256<>'${checksum}') THEN
    RAISE EXCEPTION 'PGFLOW_MIGRATION_CHECKSUM_MISMATCH ${m.version}';
  END IF;
END $checksum$;
SELECT NOT EXISTS(SELECT 1 FROM supacloud_worker.migrations WHERE version='${m.version}') AS apply_migration
\\gset
\\if :apply_migration
${m.sql}
INSERT INTO supacloud_worker.migrations(version,sha256) VALUES('${m.version}','${checksum}');
\\endif`;
  })
  .join("\n")}
-- This profile runs dedicated processes, never automatic HTTP function wakeups.
${profile === "dedicated" ? "SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='pgflow_ensure_workers';" : ""}
REVOKE ALL ON SCHEMA pgflow, supacloud_worker FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pgflow, supacloud_worker FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgflow, supacloud_worker FROM PUBLIC;
DO $roles$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA pgflow, supacloud_worker FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA pgflow, supacloud_worker FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgflow, supacloud_worker FROM %I',role_name);
    END IF;
  END LOOP;
END $roles$;
COMMIT;
`;
}
