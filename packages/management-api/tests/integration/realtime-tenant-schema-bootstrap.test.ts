/**
 * The state a fresh `SUPACLOUD_REALTIME_ENGINE=rust` install is actually in.
 *
 * The tenant migration leaves an empty `realtime` schema. This test starts
 * from that state, applies the pinned artifact project bootstrap ships, and
 * proves the objects the Rust gateway depends on are there. A later pass, and
 * a database whose `realtime.list_changes` body is not the pin, issue no DDL.
 */
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { config } from "../../src/config";
import {
  ensureOfficialRealtimeTenantSchema,
  pinnedRealtimeTenantSchemaArtifact,
} from "../../src/db/realtime-tenant-schema";
import {
  REALTIME_TENANT_SCHEMA_VERSION,
  decideRealtimeTenantSchema,
  realtimeTenantSchemaInspectionSql,
  realtimeTenantSchemaStateFromRow,
} from "../../src/db/realtime-tenant-schema/artifact";

const adminUrl = process.env.REALTIME_TENANT_SCHEMA_TEST_DATABASE_URL;
const describeIfDatabase = adminUrl === undefined ? describe.skip : describe;

/** An empty `realtime` schema, which is what tenant bootstrap leaves behind. */
const TENANT_REALTIME_SHELL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin LOGIN NOINHERIT BYPASSRLS REPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    CREATE ROLE supabase_realtime_admin LOGIN NOINHERIT CREATEROLE REPLICATION;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'realtime') THEN CREATE SCHEMA realtime; END IF;
END $$;
ALTER SCHEMA realtime OWNER TO supabase_admin;
GRANT USAGE, CREATE ON SCHEMA realtime TO supabase_admin, supabase_realtime_admin;
GRANT USAGE ON SCHEMA public TO supabase_admin, supabase_realtime_admin;
GRANT anon, authenticated, service_role TO supabase_admin WITH INHERIT FALSE, SET TRUE;
`;

interface ReservedDatabase {
  sql: SQL;
}

async function withDatabase<T>(run: (database: ReservedDatabase) => Promise<T>): Promise<T> {
  const name = `realtime_schema_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(adminUrl!, { max: 1 });
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  let database: SQL | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    database = new SQL(url.toString(), { max: 1 });
    await database.unsafe(TENANT_REALTIME_SHELL);
    return await run({ sql: database });
  } finally {
    // Close this fixture's sessions, then drop without FORCE. PostgreSQL 18's
    // FORCE path waits on a ProcSignalBarrier from every backend, including the
    // image's documentdb worker, and that wait blows the test timeout.
    try {
      await database?.close();
    } catch {
      /* the targeted terminate below still releases the session */
    }
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.close();
  }
}

async function inspect(database: SQL) {
  const rows = await database.unsafe(realtimeTenantSchemaInspectionSql());
  return realtimeTenantSchemaStateFromRow(rows[0]);
}

async function listChangesOid(database: SQL): Promise<string> {
  const [row] = await database.unsafe(
    "SELECT oid::text AS oid FROM pg_proc WHERE oid = 'realtime.list_changes(name,name,integer,integer)'::regprocedure",
  );
  const oid = (row as { oid?: string } | undefined)?.oid;
  if (!oid) throw new Error("realtime.list_changes is missing");
  return oid;
}

describeIfDatabase("pinned Realtime tenant schema bootstrap", () => {
  test("a fresh tenant gets the objects postgres_changes depends on", async () => {
    const previous = config.realtimeEngine;
    config.realtimeEngine = "rust";
    try {
      const artifact = pinnedRealtimeTenantSchemaArtifact();
      await withDatabase(async ({ sql }) => {
        const before = await inspect(sql);
        expect(before.empty).toBe(true);
        expect(decideRealtimeTenantSchema(artifact, before).mode).toBe("install");
        expect(await ensureOfficialRealtimeTenantSchema(sql)).toBe(true);

        const after = await inspect(sql);
        expect(after.subscriptionExists).toBe(true);
        expect(after.subscriptionOwner).toBe("supabase_realtime_admin");
        expect(after.listChangesPresent).toBe(true);
        for (const name of ["list_changes", "apply_rls"]) {
          expect(after.functions.some((entry) => entry.name === name)).toBe(true);
        }
        expect(decideRealtimeTenantSchema(artifact, after)).toEqual({
          mode: "pinned",
          reason: `the realtime schema is the pinned ${REALTIME_TENANT_SCHEMA_VERSION} artifact`,
        });

        await sql.unsafe(`
          CREATE TABLE public.todos (id serial primary key, task text, done boolean);
          CREATE PUBLICATION supabase_realtime;
          ALTER PUBLICATION supabase_realtime ADD TABLE public.todos;
        `);
        const subscription = randomUUID();
        await sql.unsafe(
          "INSERT INTO realtime.subscription (subscription_id, entity, claims) VALUES ($1, 'public.todos'::regclass, '{\"role\":\"authenticated\",\"sub\":\"fixture\"}'::jsonb)",
          [subscription],
        );
        const [row] = await sql.unsafe(
          "SELECT subscription_id::text AS id, claims_role::text AS role FROM realtime.subscription WHERE subscription_id = $1",
          [subscription],
        );
        expect(row).toEqual({ id: subscription, role: "authenticated" });

        const [walLevel] = await sql.unsafe("SELECT current_setting('wal_level') AS level");
        const slot = `bootstrap_probe_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        let slotCreated = false;
        if ((walLevel as { level?: string } | undefined)?.level === "logical") {
          try {
            await sql.unsafe("SELECT pg_create_logical_replication_slot($1, 'wal2json')", [slot]);
            slotCreated = true;
          } catch {
            slotCreated = false;
          }
        }
        if (slotCreated) {
          try {
            const changes = await sql.unsafe(
              "SELECT wal, slot_changes_count::int AS consumed FROM realtime.list_changes('supabase_realtime'::name, $1::name, 1::int, 1024::int)",
              [slot],
            );
            expect(changes).toHaveLength(1);
            expect(changes[0]!.wal).toBeNull();
            expect(changes[0]!.consumed).toBe(0);
          } finally {
            await sql.unsafe("SELECT pg_drop_replication_slot($1)", [slot]);
          }
        } else {
          const [signature] = await sql.unsafe(
            "SELECT to_regprocedure('realtime.list_changes(name,name,integer,integer)')::text AS signature",
          );
          expect(signature).toEqual({ signature: "realtime.list_changes(name,name,integer,integer)" });
        }
      });
    } finally {
      config.realtimeEngine = previous;
    }
  });

  test("a second run is a no-op and keeps the same functions", async () => {
    const previous = config.realtimeEngine;
    config.realtimeEngine = "rust";
    try {
      await withDatabase(async ({ sql }) => {
        expect(await ensureOfficialRealtimeTenantSchema(sql)).toBe(true);
        const first = await listChangesOid(sql);
        expect(decideRealtimeTenantSchema(pinnedRealtimeTenantSchemaArtifact(), await inspect(sql)).mode).toBe("pinned");
        expect(await ensureOfficialRealtimeTenantSchema(sql)).toBe(false);
        expect(await listChangesOid(sql)).toBe(first);
      });
    } finally {
      config.realtimeEngine = previous;
    }
  });

  test("an existing list_changes body is left in place", async () => {
    const previous = config.realtimeEngine;
    config.realtimeEngine = "rust";
    try {
      await withDatabase(async ({ sql }) => {
        expect(await ensureOfficialRealtimeTenantSchema(sql)).toBe(true);
        await sql.unsafe(`
          CREATE OR REPLACE FUNCTION realtime.list_changes (
            publication name, slot_name name, max_changes integer, max_record_bytes integer
          ) RETURNS TABLE (wal jsonb, is_rls_enabled boolean, subscription_ids uuid[], errors text[], slot_changes_count bigint)
          LANGUAGE sql AS $fn$ SELECT null::jsonb, null::boolean, null::uuid[], null::text[], 0::bigint $fn$;
        `);
        const replaced = await listChangesOid(sql);
        const state = await inspect(sql);
        expect(decideRealtimeTenantSchema(pinnedRealtimeTenantSchemaArtifact(), state).mode).toBe("leave");
        expect(await ensureOfficialRealtimeTenantSchema(sql)).toBe(false);
        expect(await listChangesOid(sql)).toBe(replaced);
        expect((await inspect(sql)).subscriptionExists).toBe(true);
      });
    } finally {
      config.realtimeEngine = previous;
    }
  });

  test("the container engine leaves an empty realtime schema to Elixir", async () => {
    const previous = config.realtimeEngine;
    config.realtimeEngine = "container";
    try {
      await withDatabase(async ({ sql }) => {
        expect(await ensureOfficialRealtimeTenantSchema(sql)).toBe(false);
        const [signature] = await sql.unsafe(
          "SELECT to_regprocedure('realtime.list_changes(name,name,integer,integer)')::text AS signature",
        );
        expect(signature).toEqual({ signature: null });
        expect((await inspect(sql)).empty).toBe(true);
      });
    } finally {
      config.realtimeEngine = previous;
    }
  });
});
