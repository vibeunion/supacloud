// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres, waitForPostgresFixture } from "../helpers/native-postgres";

const moduleSql = await readFile(new URL("../../src/db/sql-modules/artifacts-public.sql", import.meta.url), "utf8");

test("opposing artifact links cannot commit a cycle under read committed or repeatable read", async () => {
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
    for (const isolation of ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]) {
      const parent = crypto.randomUUID(), child = crypto.randomUUID();
      for (const artifactId of [parent, child]) {
        await db`INSERT INTO storage.objects VALUES (${crypto.randomUUID()}::uuid, 'fixture', ${artifactId}, 'v1')`;
        await db`SELECT public.supacloud_artifact_register(${JSON.stringify({
          artifactId, bucketId: "fixture", objectPath: artifactId, artifactType: "fixture",
          sha256: "a".repeat(64), sizeBytes: "1", mimeType: "application/octet-stream",
        })}::text::jsonb)`;
      }
      let releaseFirst = () => {};
      let firstInserted = () => {};
      const release = new Promise<void>(resolve => { releaseFirst = resolve; });
      const inserted = new Promise<void>(resolve => { firstInserted = resolve; });
      const first = db.begin(async tx => {
        await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        await tx.unsafe("SET LOCAL ROLE service_role; SET LOCAL statement_timeout = '10s'");
        await tx`SELECT public.supacloud_artifact_link(${JSON.stringify({
          parentArtifactId: parent, childArtifactId: child, relationType: "derived_from", metadata: {},
        })}::text::jsonb)`;
        firstInserted();
        await release;
      });
      let second: Promise<unknown> | undefined;
      let results: PromiseSettledResult<unknown>[] = [];
      try {
        await Promise.race([inserted, first]);
        const application = `artifact-cycle-${crypto.randomUUID()}`;
        let secondFinished = false;
        second = db.begin(async tx => {
          await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await tx`SELECT set_config('application_name', ${application}, true)`;
          await tx.unsafe("SET LOCAL ROLE service_role; SET LOCAL statement_timeout = '10s'");
          return tx`SELECT public.supacloud_artifact_link(${JSON.stringify({
            parentArtifactId: child, childArtifactId: parent, relationType: "derived_from", metadata: {},
          })}::text::jsonb)`;
        });
        void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
        await waitForPostgresFixture(async () => {
          const rows = await db`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE application_name = ${application} AND wait_event_type = 'Lock') AS blocked
          `;
          return secondFinished || rows[0]?.blocked === true;
        });
      } finally {
        releaseFirst();
        results = await Promise.allSettled(second ? [first, second] : [first]);
      }
      expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
      const rejected = results[1];
      if (rejected?.status !== "rejected") throw new Error("Expected reverse edge rejection");
      expect(rejected.reason).toMatchObject({ errno: isolation === "READ COMMITTED" ? "23514" : "40001" });
      const edges = await db`
        SELECT parent_artifact_id::text AS parent, child_artifact_id::text AS child
        FROM supacloud_artifacts.lineage
        WHERE parent_artifact_id IN (${parent}::uuid, ${child}::uuid)
      `;
      expect(Array.from(edges)).toEqual([{ parent, child }]);
      const retry = async () => {
        await db.begin(async tx => {
          await tx.unsafe("SET LOCAL ROLE service_role");
          await tx`SELECT public.supacloud_artifact_link(${JSON.stringify({
            parentArtifactId: child, childArtifactId: parent, relationType: "derived_from", metadata: {},
          })}::text::jsonb)`;
        });
      };
      await expect(retry()).rejects.toMatchObject({ errno: "23514" });
    }
    const beforeUpgrade = await db`SELECT * FROM supacloud_artifacts.lineage ORDER BY parent_artifact_id`;
    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    expect(Array.from(await db`SELECT * FROM supacloud_artifacts.lineage ORDER BY parent_artifact_id`))
      .toEqual(Array.from(beforeUpgrade));
    expect((await db`SELECT count(*)::integer AS count FROM supacloud_artifacts.lineage_write_guard`)[0]?.count).toBe(1);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const rows = await db`
        SELECT has_table_privilege(${role}, 'supacloud_artifacts.lineage_write_guard', 'UPDATE') AS allowed
      `;
      expect(rows[0]?.allowed).toBe(false);
    }
  });
}, 60_000);
