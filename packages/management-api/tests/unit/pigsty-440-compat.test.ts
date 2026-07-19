import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    expect(script).toContain("apply_postgrest_prerequest_compat");
    expect(script).toContain("check_postgrest_prerequest_compat");
    expect(script).toContain("apply_auth_jwt_helpers_compat");
    expect(script).toContain("check_auth_jwt_helpers_compat");
    expect(script).toContain("supacloud:pigsty-4.4-auth-jwt-helpers:v1");
    expect(script).toContain("current_setting('request.jwt.claims', true)");
    expect(script).toContain("apply_auth_delete_fence_compat");
    expect(script).toContain("check_auth_delete_fence_compat");
    expect(script).toContain("supacloud:pigsty-4.4-auth-delete-fence:v2");
    expect(script).toContain("SET search_path = pg_catalog");
    expect(script).toContain(
      "REVOKE ALL ON FUNCTION public.soft_delete_user_if_no_active_tasks() FROM PUBLIC",
    );
    expect(script).toContain("public_execute_revoked");
    expect(script).toContain("service_role_execute");
    expect(script).toContain("-- supacloud:sql-module:background-task-mirror-up:start");
    expect(script).toContain("IF v_task_state = 'inactive' THEN");
    expect(script).toContain("BEGIN;");
    expect(script).toContain("COMMIT;");
    expect(script).toContain("t.tgenabled IN ('O', 'A')");
    expect(script).toContain("t.tgtype = 11");
    expect(script).toContain("WHEN NOT EXISTS (SELECT 1 FROM target)");
    expect(script).toContain("return old; end if; update auth[.]users");
    expect(script).toContain("apply_tenant_authenticator_compat");
    expect(script).toContain("check_tenant_authenticator_compat");
    expect(script).toContain("reconcile_management_pgpassword_alias");
    expect(script).toContain("repair_pgbouncer_auth_file");
    expect(script).toContain("apply_monitor_connect_compat");
    expect(script).toContain("check_monitor_connect_compat");
    expect(script).toContain("broken PgBouncer auth file");
    expect(script).toContain("Time: [0-9]+([.][0-9]+)? ms");
    expect(script).not.toContain("Time: [0-9.]+ ms");
    expect(script).not.toContain("trap 'rm -f \"$temp_file\"' RETURN");
    expect(script).toContain("GRANT CONNECT ON DATABASE %I TO dbuser_monitor");
    expect(script).toContain('supacloud_write_service_env_pairs "$MANAGEMENT_ENV_FILE" PGPASSWORD "$pg_password"');
    expect(script).not.toContain('supacloud_write_raw_env_pairs "$MANAGEMENT_ENV_FILE" PGPASSWORD "$pg_password"');
    expect(script).toContain("ROLE_PASSWORD");
    expect(script).toContain("--preserve-env=ROLE_PASSWORD");
    expect(script).not.toContain('env ROLE_PASSWORD="$ROLE_PASSWORD"');
    expect(script).toContain("GRANT anon, authenticated, service_role TO");
    expect(script).toContain("unsafe-identifier");
    expect(script).toContain("NOT rolsuper");
    expect(script).toContain("NOT rolcreatedb");
    expect(script).toContain("NOT rolcreaterole");
    expect(script).toContain("NOT rolreplication");
    expect(script).toContain("NOT rolbypassrls");
    expect(script).toContain("rolconnlimit = 30");
    expect(script).toContain("PERFORM set_config('request.jwt.claim.role', role_claim, true)");
    expect(script).not.toContain("SET LOCAL ROLE service_role");
    expect(script).toContain("PostgREST pre-request compatibility");
    expect(script).toContain("supacloud:pigsty-4.4-postgrest-prerequest:v1");
    expect(script).toContain("p.prosecdef");
    expect(script).toContain("request.jwt.claim.sub");
    expect(script).toContain("request.jwt.claim.email");
    expect(script).toContain("lower(status) = 'active'");
    expect(script).toContain("Would reconcile active tenant authenticator roles");
    expect(script).toContain("Would reconcile an empty PGPASSWORD alias");
    expect(script).toContain("Would repair known Pigsty timing noise in the PgBouncer auth file");
    expect(script).toContain("Would grant dbuser_monitor CONNECT");
    expect(script).toContain("still need opaque API key backfill");
    expect(upgrade).toContain("upgrade_pigsty_4_4_compat.sh");
    expect(upgrade.indexOf("--prepare-analytics")).toBeLessThan(upgrade.indexOf("ansible-playbook"));
    expect(upgrade).toContain('ANALYTICS_PREPARE_COMPLETED" == "true"');
  });

  test("keeps Docker PostgreSQL compatibility separate and backup-first", () => {
    const core = readRepoFile("scripts/upgrade_pigsty_4_4_compat.sh");
    const dockerUpgrade = readRepoFile("scripts/upgrade_postgres_docker_4_4_compat.sh");
    const devCompose = readRepoFile("docker/dev/docker-compose.yml");
    const workflow = readRepoFile(".github/workflows/management-api.yml");
    const config = readRepoFile("config.env");

    expect(core).toContain('COMPAT_PROFILE="${SUPACLOUD_COMPAT_PROFILE:-pigsty}"');
    expect(core).toContain("Docker profile skips Pigsty environment, PgBouncer, and monitor-role checks");
    expect(core).toContain("decode_base64()");
    expect(core).toContain("base64 -D");
    expect(core).not.toContain('| base64 --decode');
    expect(dockerUpgrade).toContain("pg_dumpall");
    expect(dockerUpgrade).toContain("--expected-pg-major");
    expect(dockerUpgrade).toContain("--assume-analytics-stopped");
    expect(dockerUpgrade).toContain("SUPACLOUD_COMPAT_PROFILE=docker");
    expect(dockerUpgrade).toContain("never runs `docker compose down -v`");
    expect(
      dockerUpgrade.split("\n").some((line) =>
        /^\s*(docker\s+compose|"?\$\{COMPOSE\[@\]\}"?)\s+down\b.*(?:-v|--volumes)/.test(line),
      ),
    ).toBe(false);

    expect(devCompose).toContain("context: ../self-host/postgres");
    expect(devCompose).toContain("pgdata18:/var/lib/postgresql");
    expect(devCompose).not.toContain("pgdata:/var/lib/postgresql");
    expect(devCompose).not.toContain("supabase/postgres:17.6.1.143");
    expect(workflow).toContain("postgres-18-compatibility:");
    expect(workflow).toContain("image: supabase/postgres:17.6.1.107");
    expect(workflow).toContain("Wait for SupaCloud PostgreSQL 18");
    expect(workflow).toContain("docker inspect --format '{{.State.Health.Status}}'");
    expect(workflow).toContain("env -u CI -u GITHUB_ACTIONS bun src/db/init.ts");
    expect(workflow).toContain("upgrade_postgres_docker_4_4_compat.sh --apply");
    expect(config).toContain('PIGSTY_VERSION="v4.4.0"');
  });

  test("Docker wrapper fails before writes on unsafe prerequisites", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "docker-pg-440-safety-"));
    const fakeDocker = resolve(tempDir, "docker");
    const logFile = resolve(tempDir, "docker.log");
    const backupDir = resolve(tempDir, "backups");
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
args="$*"
if [[ "$args" == "compose version" ]]; then
  exit 0
elif [[ "$args" == *"config --services"* ]]; then
  printf 'postgres\\nmanagement-api\\n'
elif [[ "$args" == *"ps -q postgres"* ]]; then
  printf 'fake-postgres-container\\n'
elif [[ "$args" == *"exec -T postgres sh -lc"* ]]; then
  printf 'postgres'
elif [[ "$args" == *"SHOW server_version_num"* ]]; then
  printf '%s\\n' "\${FAKE_PG_VERSION_NUM:-180000}"
elif [[ "$args" == *"exec -T postgres pg_dumpall"* ]]; then
  if [[ "\${FAKE_DOCKER_MODE:-ok}" == "backup-fail" ]]; then
    exit 9
  fi
  printf '%s\\n' '-- fake non-empty logical backup'
fi
`,
    );
    chmodSync(fakeDocker, 0o700);

    const run = (args: string[], extraEnv: Record<string, string>) => Bun.spawnSync({
      cmd: ["bash", resolve(repoRoot, "scripts/upgrade_postgres_docker_4_4_compat.sh"), ...args],
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_DOCKER_LOG: logFile,
        SUPACLOUD_DOCKER_SKIP_MANAGEMENT_INIT: "true",
        SUPACLOUD_DOCKER_BACKUP_DIR: backupDir,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const mismatch = run(["--apply"], { FAKE_PG_VERSION_NUM: "170000" });
      expect(mismatch.exitCode).not.toBe(0);
      expect(readFileSync(logFile, "utf8")).not.toContain("pg_dumpall");

      writeFileSync(logFile, "");
      const backupFailure = run(["--apply"], {
        FAKE_PG_VERSION_NUM: "180000",
        FAKE_DOCKER_MODE: "backup-fail",
      });
      expect(backupFailure.exitCode).not.toBe(0);
      const backupFailureLog = readFileSync(logFile, "utf8");
      expect(backupFailureLog).toContain("pg_dumpall");
      expect(backupFailureLog).not.toContain("--init-db");

      writeFileSync(logFile, "");
      const analyticsWithoutStop = run(["--prepare-analytics"], { FAKE_PG_VERSION_NUM: "180000" });
      expect(analyticsWithoutStop.exitCode).not.toBe(0);
      expect(readFileSync(logFile, "utf8")).not.toContain("pg_dumpall");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("dry-run discovers active tenant databases with the configured psql client", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "pigsty-440-dry-run-"));
    const fakePsql = resolve(tempDir, "psql");
    writeFileSync(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *":'database_name'"* ]]; then
  printf 'unexpanded psql variable\\n' >&2
  exit 2
fi
if [[ "$args" == *"SELECT 1 FROM pg_database"* ]]; then
  if [[ "$args" == *"supacloud_meta"* || "$args" == *"tenant_alpha"* || "$args" == *"tenant_beta"* ]]; then
    printf '1\\n'
  fi
elif [[ "$args" == *"to_regclass('public.projects') IS NOT NULL"* ]]; then
  printf 't\\n'
elif [[ "$args" == *"SELECT DISTINCT db_name FROM projects"* ]]; then
  printf 'tenant_alpha\\ntenant_beta\\n'
fi
`,
    );
    chmodSync(fakePsql, 0o700);

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", resolve(repoRoot, "scripts/upgrade_pigsty_4_4_compat.sh"), "--dry-run"],
        env: {
          ...process.env,
          PSQL_BIN: fakePsql,
          PG_DUMP_BIN: "/usr/bin/true",
          SUPACLOUD_MANAGEMENT_ENV_FILE: resolve(tempDir, "missing-management.env"),
          PIGSTY_SUPABASE_ENV: resolve(tempDir, "missing-pigsty.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).not.toContain("unexpanded psql variable");
      expect(result.stdout.toString()).toContain("  - tenant_alpha");
      expect(result.stdout.toString()).toContain("  - tenant_beta");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("dry-run keeps compatibility PostgreSQL settings separate from the management runtime env", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "pigsty-440-env-separation-"));
    const fakePsql = resolve(tempDir, "psql");
    const argsLog = resolve(tempDir, "psql-args.log");
    const managementEnv = resolve(tempDir, "management.env");
    const compatPgEnv = resolve(tempDir, "compat-pg.env");
    writeFileSync(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_PSQL_ARGS_FILE"
args="$*"
if [[ "$args" == *"SELECT 1 FROM pg_database"* ]]; then
  printf '1\\n'
elif [[ "$args" == *"to_regclass('public.projects') IS NOT NULL"* ]]; then
  printf 't\\n'
elif [[ "$args" == *"SELECT DISTINCT db_name FROM projects"* ]]; then
  printf '\n'
fi
`,
    );
    chmodSync(fakePsql, 0o700);
    writeFileSync(managementEnv, "PG_HOST=untrusted-management-host.example\nDATABASE_URL=postgresql://runtime-only\n");
    writeFileSync(compatPgEnv, "PG_PORT=5432\nPG_USER=postgres\n");

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", resolve(repoRoot, "scripts/upgrade_pigsty_4_4_compat.sh"), "--dry-run"],
        env: {
          ...process.env,
          FAKE_PSQL_ARGS_FILE: argsLog,
          PSQL_BIN: fakePsql,
          PG_DUMP_BIN: "/usr/bin/true",
          SUPACLOUD_MANAGEMENT_ENV_FILE: managementEnv,
          SUPACLOUD_COMPAT_PG_ENV_FILE: compatPgEnv,
          PIGSTY_SUPABASE_ENV: resolve(tempDir, "missing-pigsty.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(argsLog, "utf8")).not.toContain("untrusted-management-host.example");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("dry-run fails closed when active tenant database enumeration fails", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "pigsty-440-enumeration-failure-"));
    const fakePsql = resolve(tempDir, "psql");
    writeFileSync(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"SELECT 1 FROM pg_database"* ]]; then
  printf '1\\n'
elif [[ "$args" == *"to_regclass('public.projects') IS NOT NULL"* ]]; then
  printf 't\\n'
elif [[ "$args" == *"SELECT DISTINCT db_name FROM projects"* ]]; then
  printf 'simulated project enumeration failure\\n' >&2
  exit 42
fi
`,
    );
    chmodSync(fakePsql, 0o700);

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", resolve(repoRoot, "scripts/upgrade_pigsty_4_4_compat.sh"), "--dry-run"],
        env: {
          ...process.env,
          PSQL_BIN: fakePsql,
          PG_DUMP_BIN: "/usr/bin/true",
          SUPACLOUD_MANAGEMENT_ENV_FILE: resolve(tempDir, "missing-management.env"),
          PIGSTY_SUPABASE_ENV: resolve(tempDir, "missing-pigsty.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Failed to enumerate active project databases");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("dry-run fails closed when the metadata table cannot be inspected", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "pigsty-440-metadata-inspection-failure-"));
    const fakePsql = resolve(tempDir, "psql");
    writeFileSync(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"SELECT 1 FROM pg_database"* ]]; then
  printf '1\\n'
elif [[ "$args" == *"to_regclass('public.projects') IS NOT NULL"* ]]; then
  printf 'simulated metadata inspection failure\\n' >&2
  exit 57
fi
`,
    );
    chmodSync(fakePsql, 0o700);

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", resolve(repoRoot, "scripts/upgrade_pigsty_4_4_compat.sh"), "--dry-run"],
        env: {
          ...process.env,
          PSQL_BIN: fakePsql,
          PG_DUMP_BIN: "/usr/bin/true",
          SUPACLOUD_MANAGEMENT_ENV_FILE: resolve(tempDir, "missing-management.env"),
          PIGSTY_SUPABASE_ENV: resolve(tempDir, "missing-pigsty.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Failed to inspect metadata table public.projects");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("dry-run excludes non-active tenant databases", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "pigsty-440-active-only-"));
    const fakePsql = resolve(tempDir, "psql");
    writeFileSync(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"SELECT 1 FROM pg_database"* ]]; then
  printf '1\n'
elif [[ "$args" == *"to_regclass('public.projects') IS NOT NULL"* ]]; then
  printf 't\n'
elif [[ "$args" == *"SELECT DISTINCT db_name FROM projects"* ]]; then
  if [[ "$args" == *"lower(status) = 'active'"* ]]; then
    printf 'tenant_active\n'
  else
    printf 'tenant_active\ntenant_paused\n'
  fi
fi
`,
    );
    chmodSync(fakePsql, 0o700);

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", resolve(repoRoot, "scripts/upgrade_pigsty_4_4_compat.sh"), "--dry-run"],
        env: {
          ...process.env,
          PSQL_BIN: fakePsql,
          PG_DUMP_BIN: "/usr/bin/true",
          SUPACLOUD_MANAGEMENT_ENV_FILE: resolve(tempDir, "missing-management.env"),
          PIGSTY_SUPABASE_ENV: resolve(tempDir, "missing-pigsty.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("  - tenant_active");
      expect(result.stdout.toString()).not.toContain("tenant_paused");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("dry-run fails closed when the PostgreSQL catalog cannot be inspected", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "pigsty-440-catalog-failure-"));
    const fakePsql = resolve(tempDir, "psql");
    writeFileSync(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'simulated catalog connection failure\\n' >&2
exit 55
`,
    );
    chmodSync(fakePsql, 0o700);

    try {
      const result = Bun.spawnSync({
        cmd: ["bash", resolve(repoRoot, "scripts/upgrade_pigsty_4_4_compat.sh"), "--dry-run"],
        env: {
          ...process.env,
          PSQL_BIN: fakePsql,
          PG_DUMP_BIN: "/usr/bin/true",
          SUPACLOUD_MANAGEMENT_ENV_FILE: resolve(tempDir, "missing-management.env"),
          PIGSTY_SUPABASE_ENV: resolve(tempDir, "missing-pigsty.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Failed to inspect PostgreSQL database catalog");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
