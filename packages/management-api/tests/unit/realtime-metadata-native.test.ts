import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
const repo = resolve(import.meta.dir, "../../../..");

test.skipIf(!bin)("Realtime metadata bootstrap owns the candidate schema and preserves existing data", async () => {
  const database = await startStarterPostgres(bin!);
  const directory = await mkdtemp(join(tmpdir(), "realtime-metadata-"));
  const candidate = join(directory, "container.env");
  const password = `  '${crypto.randomUUID()}'\\literal  `;
  const adminPassword = crypto.randomUUID();
  const literal = `'${password.replaceAll("'", "''")}'`;
  try {
    await database.exec(`CREATE ROLE postgres LOGIN SUPERUSER PASSWORD '${adminPassword}';
        CREATE ROLE realtime_fixture LOGIN NOINHERIT PASSWORD ${literal};
        CREATE ROLE realtime_no_access LOGIN PASSWORD ${literal};
        CREATE ROLE supabase_realtime_admin NOLOGIN NOINHERIT;
        GRANT supabase_realtime_admin TO realtime_fixture WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
      REVOKE CREATE ON DATABASE postgres FROM PUBLIC;`);
    await database.withConnection(async (connection) => {
      const url = new URL(connection);
      async function bootstrap(user = "realtime_fixture") {
        await writeFile(candidate, [
          `DB_HOST=${url.hostname}`, `DB_PORT=${url.port}`, "DB_NAME=postgres",
          `DB_USER=${user}`, `DB_PASSWORD=${password}`, "",
        ].join("\n"), { mode: 0o600 });
        return spawnSync("bash", ["-c",
          'source "$INSTALLER"; ensure_realtime_metadata_schema "$CANDIDATE"',
        ], {
          cwd: repo, encoding: "utf8", timeout: 20_000,
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: process.env.HOME,
            INSTALLER: join(repo, "install.sh"),
            CANDIDATE: candidate,
            POSTGRES_PASSWORD: adminPassword,
            PGHOSTADDR: "192.0.2.1",
            PGDATABASE: "wrong_database",
            PGUSER: "wrong_user",
            PGSERVICE: "wrong_service",
          },
        });
      }
      const first = await bootstrap();
      expect(first.status, first.stderr.replaceAll(password, "[REDACTED]")).toBe(0);
      await database.exec(`
        DO $$ BEGIN
          IF (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = '_realtime') <> 'realtime_fixture' THEN
            RAISE EXCEPTION 'wrong schema owner';
          END IF;
        END $$;
        SET ROLE realtime_fixture;
        SET search_path TO _realtime;
        CREATE TABLE schema_migrations(version bigint PRIMARY KEY);
        INSERT INTO schema_migrations VALUES (123);
        CREATE FUNCTION migration_parameter_probe() RETURNS integer
          LANGUAGE sql SET log_min_messages TO 'fatal' AS 'SELECT 1';
        GRANT supabase_realtime_admin TO postgres;
        RESET ROLE;
        CREATE SCHEMA realtime AUTHORIZATION supabase_realtime_admin;
        SET ROLE supabase_realtime_admin;
        CREATE TABLE realtime.channels(id bigint PRIMARY KEY);
        INSERT INTO realtime.channels VALUES (123);
        SET ROLE realtime_fixture;
        ALTER TABLE realtime.channels ADD COLUMN migration_probe integer;
        ALTER TABLE realtime.channels DROP COLUMN migration_probe;
        RESET ROLE;
        RESET search_path;
        DO $$ BEGIN
          IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='realtime_fixture') THEN
            RAISE EXCEPTION 'runtime role was given cluster administration privileges';
          END IF;
          IF (SELECT rolinherit FROM pg_roles WHERE rolname='realtime_fixture') THEN
            RAISE EXCEPTION 'runtime role inheritance default was changed';
          END IF;
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='dashboard_user'
              AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
              AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) THEN
            RAISE EXCEPTION 'missing restricted dashboard compatibility role';
          END IF;
        END $$;
      `);
      const repeated = await bootstrap();
      expect(repeated.status, repeated.stderr.replaceAll(password, "[REDACTED]")).toBe(0);
      const rejected = await bootstrap("realtime_no_access");
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("requires USAGE and CREATE on _realtime");
      await database.exec(`
        DO $$ BEGIN
          IF (SELECT count(*) FROM _realtime.schema_migrations WHERE version = 123) <> 1 THEN
            RAISE EXCEPTION 'existing migration data was changed';
          END IF;
          IF has_schema_privilege('realtime_no_access', '_realtime', 'CREATE') THEN
            RAISE EXCEPTION 'existing schema permissions were broadened';
          END IF;
          IF (SELECT relowner::regrole::text FROM pg_class WHERE oid='realtime.channels'::regclass)
              <> 'supabase_realtime_admin'
             OR (SELECT count(*) FROM realtime.channels WHERE id=123) <> 1 THEN
            RAISE EXCEPTION 'upstream object ownership or data was changed';
          END IF;
        END $$;
        SET ROLE realtime_fixture;
        ALTER TABLE realtime.channels ADD COLUMN repeated_probe integer;
        ALTER TABLE realtime.channels DROP COLUMN repeated_probe;
        RESET ROLE;
      `);
    });
  } finally {
    try { await database.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 60_000);
