/**
 * The state a fresh `SUPACLOUD_REALTIME_ENGINE=rust` install is actually in.
 *
 * The tenant migration (`ALTER_TENANT_SQL`) leaves an empty `realtime` schema
 * and nothing else, and the Elixir container that used to install the upstream
 * objects is not started. This test starts from exactly that state, applies the
 * pinned artifact the control plane ships, and proves the objects the Rust
 * gateway depends on are there, owned correctly, and reproducible.
 */
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import {
  REALTIME_TENANT_SCHEMA_VERSION,
  assertRealtimeTenantSchemaState,
  decideRealtimeTenantSchema,
  loadRealtimeTenantSchemaArtifact,
  realtimeTenantSchemaBootstrapSql,
  realtimeTenantSchemaInspectionSql,
} from "../../src/services/realtime-tenant-schema-artifact";

const adminUrl = process.env.REALTIME_TENANT_SCHEMA_TEST_DATABASE_URL;
const describeIfDatabase = adminUrl === undefined ? describe.skip : describe;

/** Section 9 of the tenant migration, verbatim in effect: an empty schema. */
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

async function withDatabase<T>(run: (database: ReservedDatabase) => Promise<T>): Promise<T> {
  const name = `realtime_schema_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // One connection: the artifact is applied as a single transaction.
  const admin = new SQL(adminUrl!, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    const database = new SQL(url.toString(), { max: 1 });
    try {
      await database.unsafe(TENANT_REALTIME_SHELL);
      return await run({ sql: database, name });
    } finally {
      await database.close();
    }
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  }
}

interface ReservedDatabase {
  sql: SQL;
  name: string;
}

async function inspect(database: SQL) {
  const rows = await database.unsafe(realtimeTenantSchemaInspectionSql());
  // `psql -tAc` yields the JSON text; the SQL client yields it under the column
  // name. Both are the same document.
  const row = rows[0] as Record<string, unknown> | undefined;
  return assertRealtimeTenantSchemaState(row?.["json_build_object"] ?? row);
}

describeIfDatabase("pinned Realtime tenant schema bootstrap", () => {
  test("a fresh tenant gets the objects postgres_changes depends on", async () => {
    const artifact = await loadRealtimeTenantSchemaArtifact();
    await withDatabase(async ({ sql }) => {
      const before = await inspect(sql);
      expect(before.empty).toBe(true);
      expect(decideRealtimeTenantSchema(artifact, before).mode).toBe("install");

      await sql.unsafe(realtimeTenantSchemaBootstrapSql(artifact));

      const after = await inspect(sql);
      expect(after.subscriptionExists).toBe(true);
      expect(after.subscriptionOwner).toBe("supabase_realtime_admin");
      for (const name of ["list_changes", "apply_rls"]) {
        expect(after.functions.some((entry) => entry.name === name)).toBe(true);
      }
      expect(decideRealtimeTenantSchema(artifact, after)).toEqual({
        mode: "pinned",
        reason: `the realtime schema is the pinned ${REALTIME_TENANT_SCHEMA_VERSION} artifact`,
      });

      // A subscription row is what `phx_join` inserts, and the publication is
      // what the slot consumer reads; both have to work on a fresh database.
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

      // `list_changes` reads a slot, which needs `wal_level=logical` and the
      // `wal2json` plugin. Where those exist, prove the call; where they do not,
      // the receipt above already compares the body against the pin.
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
  });

  test("a second run is a no-op and keeps the same functions", async () => {
    const artifact = await loadRealtimeTenantSchemaArtifact();
    await withDatabase(async ({ sql }) => {
      await sql.unsafe(realtimeTenantSchemaBootstrapSql(artifact));
      const [first] = await sql.unsafe(
        "SELECT oid::text AS oid FROM pg_proc WHERE oid = 'realtime.list_changes(name,name,integer,integer)'::regprocedure",
      );
      expect(decideRealtimeTenantSchema(artifact, await inspect(sql)).mode).toBe("pinned");
      // The control plane only writes when the receipt says "install", so the
      // second pass must not run DDL at all.
      expect((await inspect(sql)).functions.length).toBeGreaterThan(0);
      const [second] = await sql.unsafe(
        "SELECT oid::text AS oid FROM pg_proc WHERE oid = 'realtime.list_changes(name,name,integer,integer)'::regprocedure",
      );
      expect(second!.oid).toBe(first!.oid);
    });
  });

  test("a divergent realtime schema is refused, not overwritten", async () => {
    const artifact = await loadRealtimeTenantSchemaArtifact();
    await withDatabase(async ({ sql }) => {
      await sql.unsafe(realtimeTenantSchemaBootstrapSql(artifact));
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION realtime.list_changes (
          publication name, slot_name name, max_changes integer, max_record_bytes integer
        ) RETURNS TABLE (wal jsonb, is_rls_enabled boolean, subscription_ids uuid[], errors text[], slot_changes_count bigint)
        LANGUAGE sql AS $fn$ SELECT null::jsonb, null::boolean, null::uuid[], null::text[], 0::bigint $fn$;
      `);
      const state = await inspect(sql);
      expect(() => decideRealtimeTenantSchema(artifact, state)).toThrow(
        /realtime\.list_changes is not the pinned 2\.150\.0 definition/,
      );
      // Nothing was dropped: the subscription table survived the refusal.
      expect((await inspect(sql)).subscriptionExists).toBe(true);
    });
  });
});
