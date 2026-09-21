// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres, waitForPostgresFixture } from "../helpers/native-postgres";

const moduleSql = await readFile(new URL("../../src/db/sql-modules/artifacts-public.sql", import.meta.url), "utf8");

test("registration fences concurrent storage mutations across transaction isolation levels", async () => {
  await withNativePostgres(async db => {
    await db.unsafe(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA storage;
      CREATE TABLE storage.objects (
        id uuid PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL, version text NOT NULL,
        UNIQUE (bucket_id, name)
      );
    `);
    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    const cases = ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"].flatMap(isolation =>
      [false, true].flatMap(preexistingGuard =>
        ["update", "delete"].map(mutation => ({ isolation, preexistingGuard, mutation }))));
    for (const { isolation, preexistingGuard, mutation } of cases) {
      const objectId = crypto.randomUUID(), artifactId = crypto.randomUUID();
      await db`INSERT INTO storage.objects VALUES (${objectId}::uuid, 'fixture', ${artifactId}, 'v1')`;
      if (preexistingGuard) {
        await db`UPDATE storage.objects SET version = 'v1' WHERE id = ${objectId}::uuid`;
      }
      const before = await db`SELECT xmin::text AS revision FROM storage.objects WHERE id = ${objectId}::uuid`;
      let releaseRegistration = () => {}, notifyInserted = () => {};
      const release = new Promise<void>(resolve => { releaseRegistration = resolve; });
      const inserted = new Promise<void>(resolve => { notifyInserted = resolve; });
      const registration = db.begin(async tx => {
        await tx.unsafe("SET LOCAL ROLE service_role; SET LOCAL statement_timeout = '10s'");
        await tx`SELECT public.supacloud_artifact_register(${JSON.stringify({
          artifactId, bucketId: "fixture", objectPath: artifactId, artifactType: "fixture",
          sha256: "a".repeat(64), sizeBytes: "1", mimeType: "application/octet-stream",
        })}::text::jsonb)`;
        notifyInserted();
        await release;
      });
      let update: Promise<unknown> | undefined;
      let results: PromiseSettledResult<unknown>[] = [];
      try {
        await Promise.race([registration, inserted]);
        const application = `artifact-storage-${crypto.randomUUID()}`;
        let finished = false;
        update = db.begin(async tx => {
          await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await tx`SELECT set_config('application_name', ${application}, true)`;
          await tx.unsafe("SET LOCAL statement_timeout = '10s'");
          return mutation === "update"
            ? tx`UPDATE storage.objects SET version = 'v2' WHERE id = ${objectId}::uuid`
            : tx`DELETE FROM storage.objects WHERE id = ${objectId}::uuid`;
        });
        void update.then(() => { finished = true; }, () => { finished = true; });
        await waitForPostgresFixture(async () => {
          const rows = await db`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE application_name = ${application} AND wait_event_type = 'Lock') AS blocked
          `;
          return finished || rows[0]?.blocked === true;
        });
      } finally {
        releaseRegistration();
        results = await Promise.allSettled(update ? [registration, update] : [registration]);
      }
      expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
      const rejected = results[1];
      if (rejected?.status !== "rejected") throw new Error("Expected fenced update");
      expect(rejected.reason).toMatchObject({ errno: isolation === "READ COMMITTED" ? "55000" : "40001" });
      const rows = await db`
        SELECT o.version AS stored, a.object_version AS registered FROM storage.objects o
        JOIN supacloud_artifacts.artifacts a ON a.storage_object_id = o.id
        WHERE o.id = ${objectId}::uuid
      `;
      expect(Array.from(rows)).toEqual([{ stored: "v1", registered: "v1" }]);
      const after = await db`SELECT xmin::text AS revision FROM storage.objects WHERE id = ${objectId}::uuid`;
      expect(after[0]?.revision).toBe(before[0]?.revision);
    }

    const ordinaryId = crypto.randomUUID(), renamedId = crypto.randomUUID();
    await db`INSERT INTO storage.objects VALUES (${ordinaryId}::uuid, 'fixture', 'ordinary', 'v1')`;
    await db`UPDATE storage.objects SET version = 'v2' WHERE id = ${ordinaryId}::uuid`;
    await db`UPDATE storage.objects SET id = ${renamedId}::uuid WHERE id = ${ordinaryId}::uuid`;
    const ordinary = await db`
      SELECT o.version FROM storage.objects o
      JOIN supacloud_artifacts.storage_write_guard g ON g.storage_object_id = o.id
      WHERE o.id = ${renamedId}::uuid
    `;
    expect(Array.from(ordinary)).toEqual([{ version: "v2" }]);
    await db`DELETE FROM storage.objects WHERE id = ${renamedId}::uuid`;
    const removed = await db`
      SELECT count(*)::integer AS count FROM supacloud_artifacts.storage_write_guard
      WHERE storage_object_id IN (${ordinaryId}::uuid, ${renamedId}::uuid)
    `;
    expect(removed[0]?.count).toBe(0);

    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    const guards = await db`SELECT count(*)::integer AS count FROM supacloud_artifacts.storage_write_guard`;
    expect(guards[0]?.count).toBe(12);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const attempt = db.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx.unsafe("DELETE FROM supacloud_artifacts.storage_write_guard");
      });
      await expect(attempt).rejects.toMatchObject({ errno: "42501" });
    }
  });
}, 60_000);
