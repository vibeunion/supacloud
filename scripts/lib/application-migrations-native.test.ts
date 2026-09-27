import { expect, test } from "bun:test";
import { SQL } from "bun";
import { startStarterPostgres } from "./starter-postgres";
import { readApplicationMigrationInventory } from "../../packages/management-api/src/services/application-migrations";
import { calculateMigrationChecksum } from "../../packages/management-api/src/services/migration-promotion";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;

(bin ? test : test.skip)("application inventory reads missing, old and divergent ledgers without initializing or repairing them", async () => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let cluster: Awaited<ReturnType<typeof startStarterPostgres>> | undefined;
  let database: SQL | undefined;
  try {
    cluster = await startStarterPostgres(bin!, controller.signal);
    await cluster.withConnection(async url => {
      database = new SQL(url);
      const db = database;
      expect(await readApplicationMigrationInventory(db)).toEqual([]);
      expect((await db`SELECT to_regclass('public.schema_migrations') AS relation`)[0]?.relation).toBeNull();
      expect((await db`SELECT to_regnamespace('supabase_migrations') AS namespace`)[0]?.namespace).toBeNull();
      await db.unsafe("CREATE TABLE public.schema_migrations(version bigint PRIMARY KEY, name text, statements text[])");
      await db.unsafe("INSERT INTO public.schema_migrations VALUES (1,'example',ARRAY['SELECT 1'])");
      const expected = calculateMigrationChecksum({ version: "1", name: "example", statements: ["SELECT 1"] });
      const old = await readApplicationMigrationInventory(db);
      expect(old).toHaveLength(1);
      expect(old[0]).toMatchObject({ version: "1", checksum: expected, applied_at: null });
      expect((await db`SELECT count(*)::integer AS count FROM information_schema.columns
        WHERE table_schema='public' AND table_name='schema_migrations'`)[0]?.count).toBe(3);
      await db.unsafe("ALTER TABLE public.schema_migrations ADD COLUMN checksum text");
      await db`UPDATE public.schema_migrations SET checksum=${"f".repeat(64)}`;
      await expect(readApplicationMigrationInventory(db)).rejects.toThrow("diverged");
      await db`UPDATE public.schema_migrations SET checksum=${expected}`;
      expect((await readApplicationMigrationInventory(db))[0]?.checksum).toBe(expected);
      await db.unsafe(`CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations(
          version text PRIMARY KEY, name text, statements text[], checksum text, inserted_at timestamptz)`);
      await db`INSERT INTO supabase_migrations.schema_migrations VALUES ('1','example',ARRAY['SELECT 1'],${expected},now())`;
      expect((await readApplicationMigrationInventory(db))[0]?.checksum).toBe(expected);
      const writer = await db.reserve();
      let snapshot: Promise<Awaited<ReturnType<typeof readApplicationMigrationInventory>> | Error> | undefined;
      try {
        await writer.unsafe("BEGIN");
        await writer.unsafe("LOCK TABLE public.schema_migrations IN ACCESS EXCLUSIVE MODE");
        snapshot = readApplicationMigrationInventory(db).catch(error =>
          error instanceof Error ? error : new Error("Inventory snapshot failed"));
        const deadline = Date.now() + 5_000;
        let waiting = false;
        while (Date.now() < deadline && !waiting) {
          const rows = await db.unsafe<{ waiting: boolean }[]>(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND state='active'
              AND query LIKE '%FROM public.schema_migrations%'
          ) AS waiting`);
          waiting = rows[0]?.waiting === true;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        const concurrentChecksum = calculateMigrationChecksum({ version: "20", name: "concurrent", statements: ["SELECT 20"] });
        await writer`INSERT INTO public.schema_migrations(version,name,statements,checksum)
          VALUES (20,'concurrent',ARRAY['SELECT 20'],${concurrentChecksum})`;
        await writer`INSERT INTO supabase_migrations.schema_migrations
          VALUES ('20','concurrent',ARRAY['SELECT 20'],${concurrentChecksum},now())`;
        await writer.unsafe("COMMIT");
        const captured = await snapshot;
        if (captured instanceof Error) throw captured;
        expect(captured.map(entry => entry.version)).toEqual(["1"]);
        expect((await readApplicationMigrationInventory(db)).map(entry => entry.version)).toEqual(["1", "20"]);
      } finally {
        try { await writer.unsafe("ROLLBACK"); }
        finally { writer.release(); await snapshot; }
      }
      await db.unsafe(`DELETE FROM public.schema_migrations WHERE version=20;
        DELETE FROM supabase_migrations.schema_migrations WHERE version='20'`);
      await db`UPDATE public.schema_migrations SET checksum=${"f".repeat(64)}`;
      await expect(readApplicationMigrationInventory(db)).rejects.toThrow("diverged");
      expect((await db`SELECT checksum FROM public.schema_migrations`)[0]?.checksum).toBe("f".repeat(64));
      await db`UPDATE public.schema_migrations SET checksum=${expected}`;
      await db`UPDATE supabase_migrations.schema_migrations SET checksum=${"f".repeat(64)}`;
      await expect(readApplicationMigrationInventory(db)).rejects.toThrow("diverged");
      expect((await db`SELECT checksum FROM supabase_migrations.schema_migrations`)[0]?.checksum).toBe("f".repeat(64));
      await db`UPDATE supabase_migrations.schema_migrations SET checksum=${expected}`;
      await db.unsafe("INSERT INTO public.schema_migrations(version,name,statements) VALUES (2,'legacy_only',ARRAY['SELECT 2'])");
      await expect(readApplicationMigrationInventory(db)).rejects.toThrow("missing canonical versions");
      expect((await db`SELECT count(*)::integer AS count FROM supabase_migrations.schema_migrations`)[0]?.count).toBe(1);
      await db.close();
      database = undefined;
    });
  } finally {
    try { await database?.close({ timeout: 1 }); }
    finally {
      try { await cluster?.close(); }
      finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    }
  }
}, 60_000);
