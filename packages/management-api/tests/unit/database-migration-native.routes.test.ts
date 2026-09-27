// @supacloud-test-isolate - owns process configuration and a local project lookup adapter.
import { expect, mock, test } from "bun:test";
import { SQL } from "bun";
import { Elysia } from "elysia";
import { strict as assert } from "node:assert";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "../../../compiler/src/fixtures/runtime-source";
import { writeFixtureProject } from "../../../compiler/src/fixtures/helpers";
import { calculateMigrationChecksum } from "../../src/services/migration-promotion";
import { projectDatabaseLockKey } from "../../src/services/project-database-lock";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
const repository = resolve(import.meta.dir, "../../../..");
const initialSql = "CREATE TABLE public.delivery_items(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL);\n";
const additiveSql = "ALTER TABLE public.delivery_items ADD COLUMN note text;\r\n";

async function releaseTestLock(lock: Awaited<ReturnType<SQL["reserve"]>>, key: string) {
  try { await lock`SELECT pg_advisory_unlock(hashtextextended(${key},0))`; }
  finally { lock.release(); }
}

async function interruptionCheckpoint(signal: AbortSignal, phase: "http" | "lock", httpPids: number[]) {
  if (process.env.SUPACLOUD_TEST_INTERRUPT_PHASE !== phase) return;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Native interruption checkpoint timed out"));
    }, 20_000);
    signal.addEventListener("abort", abort, { once: true });
    console.log(JSON.stringify({ event: "native-delivery-interrupt-ready", phase, httpPids }));
  });
  signal.throwIfAborted();
}

async function buildFixture(root: string, archive: string, revision: "old" | "new") {
  const { buildDeliveryProject, readDeliveryMigrationArchive } = await import("../../../compiler/dist/index.js");
  if (revision === "old") {
    await mkdir(join(root, "node_modules/@supacloud"), { recursive: true });
    for (const [name, path] of [
      ["@supacloud/elysia", "packages/elysia"],
      ["elysia", "packages/elysia/node_modules/elysia"],
      ["@types", "packages/compiler/node_modules/@types"],
      ["bun-types", "packages/compiler/node_modules/bun-types"],
    ]) await symlink(join(repository, path!), join(root, "node_modules", name!));
  }
  await writeFixtureProject(root, {
    "package.json": JSON.stringify({ name: "migration-compatibility-fixture", private: true, type: "module" }),
    "tsconfig.json": FIXTURE_TSCONFIG.replace('"strict": true', '"strict": true, "skipLibCheck": true, "types": ["bun"]'),
    "src/runtime.ts": RUNTIME_SOURCE.replaceAll("() => {}", "(..._args: unknown[]) => {}"),
    "src/database.ts": `import { SQL } from "bun";
      let database: SQL | undefined;
      export async function openDatabase() {
        if (!process.env.RUNTIME_DATABASE_URL) throw new Error("Missing database");
        database = new SQL(process.env.RUNTIME_DATABASE_URL);
        await database.unsafe("SELECT id,value${revision === "new" ? ",note" : ""} FROM public.delivery_items LIMIT 0");
      }
      export async function query<T>(statement: string): Promise<T[]> {
        if (!database) throw new Error("Database is closed");
        return await database.unsafe<T[]>(statement);
      }
      export async function closeDatabase() { await database?.close(); }`,
    "src/items.ts": `import { Module, Controller, Get, Post } from "./runtime";
      import { query } from "./database";
      type Item = { id: number; value: string${revision === "new" ? "; note: string | null" : ""} };
      @Controller("/items") export class ItemsController {
        @Get("/") list(): Promise<Item[]> {
          return query<Item>("SELECT id,value${revision === "new" ? ",note" : ""} FROM public.delivery_items ORDER BY id");
        }
        @Post("/") create(): Promise<Item[]> {
          return query<Item>(${JSON.stringify(revision === "new"
            ? "INSERT INTO public.delivery_items(value,note) VALUES('new','preserve-after-rollback') RETURNING id,value,note"
            : "INSERT INTO public.delivery_items(value) VALUES('old') RETURNING id,value")});
        }
      }
      @Module({name: "items", controllers: [ItemsController]}) export class ItemsModule {}`,
    "src/host.ts": `import { createApplication, type CompiledModule } from "@supacloud/elysia";
      import { openDatabase, closeDatabase } from "./database";
      export async function createDeliveryApplication(modules: CompiledModule[]) {
        try { await openDatabase(); }
        catch (error) { await closeDatabase(); throw error; }
        const app = createApplication({ modules });
        return { fetch: (request: Request) => app.handle(request), close: closeDatabase };
      }`,
    "migrations/initial.sql": initialSql,
    "migrations/additive.sql": additiveSql,
  });
  const migrations = [
    { source: "migrations/initial.sql", version: "1", name: "delivery_items", executor: "project-migration" },
    ...(revision === "new" ? [
      { source: "migrations/additive.sql", version: "2", name: "delivery_note", executor: "project-migration" },
    ] : []),
  ];
  const built = await buildDeliveryProject({
    rootDir: join(root, "src"), outDir: join(root, "generated"), strict: false,
    generateClient: false, generatePermissions: false,
  }, { version: 1, build: { migrations, httpApplications: [{ target: "api", source: "host.ts" }] } });
  assert.ok(built.ok, JSON.stringify(built.diagnostics));
  await cp(join(root, "generated/delivery"), archive, { recursive: true });
  const manifest = join(archive, "delivery.manifest.json");
  const verified = await readDeliveryMigrationArchive(manifest, "api");
  return { verified, bundle: join(archive, "objects", verified.objectId, "bundle") };
}

async function launch(bundle: string, databaseUrl: string, signal: AbortSignal, shouldStart = true) {
  signal.throwIfAborted();
  const child = Bun.spawn([process.execPath, "--no-env-file", "index.js"], {
    cwd: bundle,
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: "0", RUNTIME_DATABASE_URL: databaseUrl },
    stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  let running = false;
  const abort = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let output = "";
  try {
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
      assert.ok(output.length < 16_384);
    }
    if (!shouldStart) {
      expect(await child.exited).toBe(1);
      expect(output).toBe("");
      expect((await stderr).trim()).toBe("Delivery HTTP startup failed.");
      return undefined;
    }
    const event = JSON.parse(output.split("\n")[0]!);
    expect(event.event).toBe("delivery-http-listening");
    const origin = new URL(event.url);
    expect(origin.hostname).toBe("127.0.0.1");
    signal.throwIfAborted();
    running = true;
    return {
      pid: child.pid,
      async request(method: "GET" | "POST") {
        const response = await fetch(new URL("/items", origin), { method, signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(200);
        return await response.json() as Array<{ id: number; value: string; note?: string | null }>;
      },
      async stop() {
        if (child.exitCode === null) child.kill("SIGTERM");
        const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          const code = await child.exited;
          if (!signal.aborted) expect(code).toBe(0);
          await stderr;
        } finally {
          clearTimeout(deadline);
          signal.removeEventListener("abort", abort);
        }
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    await stderr;
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    if (!running) signal.removeEventListener("abort", abort);
  }
}

(bin ? test : test.skip)("archived SQL uses real migration-role transactions and detached old/new builds remain compatible", async () => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let cluster: Awaited<ReturnType<typeof startStarterPostgres>> | undefined;
  let ownedRoot: string | undefined;
  const master = crypto.randomUUID() + crypto.randomUUID();
  const migrationPassword = crypto.randomUUID();
  const runtimePassword = crypto.randomUUID();
  const secrets = [master, migrationPassword, runtimePassword];
  const environment = { DATABASE_URL: process.env.DATABASE_URL, MASTER_TOKEN: process.env.MASTER_TOKEN };
  let oldHost: Awaited<ReturnType<typeof launch>> = undefined, newHost: Awaited<ReturnType<typeof launch>> = undefined;
  let admin: SQL | undefined;
  let closePools: (() => Promise<void>) | undefined;
  try {
    const root = await mkdtemp(join(tmpdir(), "migration-native-route-"));
    ownedRoot = root;
    const ownedCluster = await startStarterPostgres(bin!, controller.signal);
    cluster = ownedCluster;
    await ownedCluster.withConnection(async url => {
      secrets.push(new URL(url).password);
      process.env.DATABASE_URL = url;
      process.env.MASTER_TOKEN = master;
      admin = new SQL(url);
      await admin.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      await admin.unsafe(`CREATE ROLE delivery_migrator LOGIN PASSWORD '${migrationPassword}';
        CREATE ROLE delivery_runtime LOGIN PASSWORD '${runtimePassword}';`);
      await admin.unsafe("CREATE DATABASE delivery_project");
      await admin.unsafe(`CREATE TABLE projects(ref text PRIMARY KEY, db_name text, db_user text, db_password text, deleted_at timestamptz)`);
      await admin`INSERT INTO projects(ref,db_name,db_user,db_password)
        VALUES('delivery_test','delivery_project','delivery_migrator',${migrationPassword})`;

      // Only tenant existence is synthetic. SQL, auth, locks, role preparation and leases are real.
      mock.module("../../src/services", () => ({
        projectService: { getProject: async (ref: string) => ref === "delivery_test" ? { ref } : null },
      }));
      const db = await import("../../src/db");
      closePools = async () => { await db.removeProjectDbCache("delivery_project"); await db.sql.close(); };
      const { databaseRoutes } = await import(
        new URL("../../src/routes/database.ts?native-delivery-migrations", import.meta.url).href,
      );
      const app = new Elysia().use(databaseRoutes);
      const route = (method: "GET" | "POST", body?: unknown, token = master) => app.handle(new Request(
        "http://localhost/v1/projects/delivery_test/database/migrations" + (method === "GET" ? "/inventory" : ""),
        { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      ));
      controller.signal.throwIfAborted();
      expect((await route("GET", undefined, "")).status).toBe(401);
      const oldBuild = await buildFixture(join(root, "source"), join(root, "old"), "old");
      const newBuild = await buildFixture(join(root, "source"), join(root, "new"), "new");
      expect(oldBuild.verified.objectId).not.toBe(newBuild.verified.objectId);
      await rm(join(root, "source"), { recursive: true });
      const apply = async (migration: { version: string; name: string; sql: string }, status = 200) => {
        const response = await route("POST", migration);
        const receipt = await response.json() as Record<string, unknown>;
        assert.equal(response.status, status, JSON.stringify(receipt));
        if (status === 200) expect(receipt.checksum).toBe(calculateMigrationChecksum({
          version: migration.version, name: migration.name, statements: [migration.sql],
        }));
        return receipt;
      };
      const initial = oldBuild.verified.migrations[0]!;
      await apply(initial);
      const project = db.getProjectDb("delivery_project");
      expect((await project.unsafe<{ owner: string }[]>(
        "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.delivery_items'::regclass",
      ))[0]?.owner).toBe("delivery_migrator");
      await project.unsafe(`GRANT USAGE ON SCHEMA public TO delivery_runtime;
        GRANT SELECT,INSERT ON public.delivery_items TO delivery_runtime;
        GRANT USAGE ON SEQUENCE public.delivery_items_id_seq TO delivery_runtime;`);
      const runtime = new URL(url);
      runtime.pathname = "/delivery_project";
      runtime.username = "delivery_runtime";
      runtime.password = runtimePassword;
      oldHost = await launch(oldBuild.bundle, runtime.href, controller.signal);
      assert.ok(oldHost);
      expect((await oldHost.request("POST"))[0]?.value).toBe("old");
      await launch(newBuild.bundle, runtime.href, controller.signal, false);
      expect(await oldHost.request("GET")).toHaveLength(1);

      const additive = newBuild.verified.migrations[1]!;
      await apply(additive);
      newHost = await launch(newBuild.bundle, runtime.href, controller.signal);
      assert.ok(newHost);
      await interruptionCheckpoint(controller.signal, "http", [oldHost.pid, newHost.pid]);
      expect((await newHost.request("POST"))[0]?.note).toBe("preserve-after-rollback");
      expect(await oldHost.request("GET")).toHaveLength(2);
      expect((await oldHost.request("POST"))[0]?.value).toBe("old");
      expect((await newHost.request("GET")).map(item => item.note)).toEqual([null, "preserve-after-rollback", null]);

      await apply(additive, 409);
      const conflict = await apply({ ...additive, sql: "ALTER TABLE public.delivery_items ADD COLUMN forbidden text;" }, 409);
      expect(conflict.code).toBe("migration_checksum_conflict");
      const failed = await apply({ version: "3", name: "failed_ddl",
        sql: "ALTER TABLE public.delivery_items ADD COLUMN failed_ddl text; SELECT 1/0;" }, 500);
      expect(failed).not.toHaveProperty("checksum");
      expect(failed.detail).toContain("division by zero");
      await project.unsafe(`CREATE FUNCTION supabase_migrations.reject_test_receipt() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic ledger insertion failure'; END $$;
        CREATE TRIGGER reject_test_receipt BEFORE INSERT ON supabase_migrations.schema_migrations
        FOR EACH ROW EXECUTE FUNCTION supabase_migrations.reject_test_receipt();`);
      try {
        const receiptFailure = await apply({ version: "4", name: "failed_receipt",
          sql: "ALTER TABLE public.delivery_items ADD COLUMN failed_receipt text;" }, 500);
        expect(receiptFailure).not.toHaveProperty("checksum");
        expect(receiptFailure.detail).toContain("Synthetic ledger insertion failure");
      } finally {
        await project.unsafe(`DROP TRIGGER reject_test_receipt ON supabase_migrations.schema_migrations;
          DROP FUNCTION supabase_migrations.reject_test_receipt();`);
      }
      const lock = await db.sql.reserve();
      const lockKey = projectDatabaseLockKey("delivery_test");
      try {
        await lock`SELECT pg_advisory_lock(hashtextextended(${lockKey},0))`;
        await interruptionCheckpoint(controller.signal, "lock", [oldHost.pid, newHost.pid]);
        const locked = await apply({ version: "5", name: "locked",
          sql: "ALTER TABLE public.delivery_items ADD COLUMN locked text;" }, 423);
        expect(locked.code).toBe("migration_locked");
      } finally {
        await releaseTestLock(lock, lockKey);
      }
      const columns = await project.unsafe<{ column_name: string }[]>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_items'",
      );
      expect(columns.map(row => row.column_name).sort()).toEqual(["id", "note", "value"]);
      const inventoryResponse = await route("GET");
      expect(inventoryResponse.status).toBe(200);
      const inventory = await inventoryResponse.json() as { migrations: Array<{ version: string }> };
      expect(inventory.migrations.map(item => item.version)).toEqual(["1", "2"]);
      expect((await project.unsafe<{ count: number }[]>(
        "SELECT count(*)::integer AS count FROM supabase_migrations.migration_ledger_leases",
      ))[0]?.count).toBe(0);
      const legacy = await project.unsafe<{ version: string }[]>(
        "SELECT version::text AS version FROM public.schema_migrations ORDER BY version",
      );
      expect(legacy.map(item => item.version)).toEqual(["1", "2"]);
      expect(await newHost.request("GET")).toHaveLength(3);
      const roles = await project.unsafe<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolbypassrls: boolean }[]>(
        "SELECT rolname,rolsuper,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname IN ('delivery_migrator','delivery_runtime')",
      );
      expect(roles.every(role => !role.rolsuper && !role.rolcreaterole)).toBe(true);
      expect(roles.find(role => role.rolname === "delivery_runtime")?.rolbypassrls).toBe(false);
      expect(roles.find(role => role.rolname === "delivery_migrator")?.rolbypassrls).toBe(true);
      const owners = await project.unsafe<{ owner: string }[]>(
        "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.delivery_items'::regclass",
      );
      expect(owners[0]?.owner).toBe("delivery_migrator");

      await newHost.stop(); newHost = undefined;
      await oldHost.stop(); oldHost = undefined;
      oldHost = await launch(oldBuild.bundle, runtime.href, controller.signal);
      assert.ok(oldHost);
      expect(await oldHost.request("GET")).toHaveLength(3);
      expect((await project.unsafe<{ note: string }[]>(
        "SELECT note FROM public.delivery_items WHERE value='new'",
      ))[0]?.note).toBe("preserve-after-rollback");
      expect((await oldHost.request("POST"))[0]?.value).toBe("old");
      await oldHost.stop(); oldHost = undefined;
      await ownedCluster.restart();
      oldHost = await launch(oldBuild.bundle, runtime.href, controller.signal);
      newHost = await launch(newBuild.bundle, runtime.href, controller.signal);
      assert.ok(oldHost && newHost);
      expect(await oldHost.request("GET")).toHaveLength(4);
      expect((await newHost.request("GET")).filter(item => item.note === "preserve-after-rollback")).toHaveLength(1);
      await oldHost.stop(); oldHost = undefined;
      await newHost.stop(); newHost = undefined;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Native migration fixture failed";
    throw new Error(secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[REDACTED]"), message,
    ));
  } finally {
    const hosts = await Promise.allSettled([newHost?.stop(), oldHost?.stop()]);
    const pools = await Promise.allSettled([closePools?.(), admin?.close()]);
    try {
      await cluster?.close();
      if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true });
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    const failed = [...hosts, ...pools].find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw new Error("Native migration fixture cleanup failed.");
  }
}, 180_000);

(bin ? test : test.skip)("native cancellation releases a reserved lock even when PostgreSQL has stopped", async () => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let cluster: Awaited<ReturnType<typeof startStarterPostgres>> | undefined;
  let database: SQL | undefined;
  try {
    cluster = await startStarterPostgres(bin!, controller.signal);
    await cluster.withConnection(async url => { database = new SQL(url); });
    assert.ok(database);
    let lock: Awaited<ReturnType<SQL["reserve"]>> | undefined = await database.reserve();
    const key = projectDatabaseLockKey("cancelled_delivery_test");
    try {
      await lock`SELECT pg_advisory_lock(hashtextextended(${key},0))`;
      controller.abort();
      await cluster.close();
      const released = releaseTestLock(lock, key);
      lock = undefined;
      await expect(released).rejects.toBeDefined();
      await database.close({ timeout: 1 });
    } finally { lock?.release(); }
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
}, 30_000);
