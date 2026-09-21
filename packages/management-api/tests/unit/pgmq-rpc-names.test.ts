// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres } from "../helpers/native-postgres";
import { replaceSqlModuleBlock } from "../../src/db/sql-module-sync";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/pgmq-public.sql", import.meta.url), "utf8");

test("all real public RPCs reject noncanonical and reserved names before mutating queues", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.unsafe(moduleSql);
    await db`SELECT pgmq.create('jobs')`;
    await db`SELECT pgmq.create('supacloud_internal_jobs')`;
    await db`SELECT pgmq.send('jobs', '{"protected":"public"}'::jsonb)`;
    await db`SELECT pgmq.send('supacloud_internal_jobs', '{"protected":"internal"}'::jsonb)`;
    const before = await db`
      SELECT msg_id::text AS id, read_ct, vt, message FROM pgmq.q_jobs
      UNION ALL
      SELECT msg_id::text AS id, read_ct, vt, message FROM pgmq.q_supacloud_internal_jobs
    `;
    for (const name of [
      null, "", " jobs", "jobs ", "JOBS", "Jobs", "jobs\n", "jobs/other",
      "jobs.other", "_jobs", "-jobs", "x".repeat(129), "\u212aobs", "jobs' OR true --",
      "supacloud_internal_jobs",
    ]) {
      const code = name === "supacloud_internal_jobs" ? "42501" : "22023";
      const operations = [
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT * FROM pgmq_public.send(${name}, '{}'::jsonb)`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT * FROM pgmq_public.send_batch(${name}, ARRAY['{}'::jsonb])`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT * FROM pgmq_public.read(${name}, 30, 1)`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT * FROM pgmq_public.pop(${name})`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT pgmq_public.archive(${name}, 1)`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT pgmq_public."delete"(${name}, 1)`; }),
      ];
      for (const operation of operations) await expect(operation()).rejects.toMatchObject({ errno: code });
    }
    const after = await db`
      SELECT msg_id::text AS id, read_ct, vt, message FROM pgmq.q_jobs
      UNION ALL
      SELECT msg_id::text AS id, read_ct, vt, message FROM pgmq.q_supacloud_internal_jobs
    `;
    expect(Array.from(after)).toEqual(Array.from(before));
    const archiveRows = await db`
      SELECT count(*)::integer AS count FROM pgmq.a_jobs
      UNION ALL SELECT count(*)::integer AS count FROM pgmq.a_supacloud_internal_jobs
    `;
    expect(Array.from(archiveRows)).toEqual([{ count: 0 }, { count: 0 }]);
    for (const name of ["jobs", "jobs_2", "jobs-2", "0", "x".repeat(128)]) {
      const value = await db`SELECT pgmq_public.require_public_queue(${name}) AS name`;
      expect(value[0].name).toBe(name);
    }
    const valid = await db.begin(async tx => {
      await tx`SET LOCAL ROLE anon`;
      return tx`SELECT * FROM pgmq_public.send('jobs', '{"valid":true}'::jsonb)`;
    });
    expect(valid[0].send).toBe("2");
  }, { image });
}, 40_000);

test("canonical public-name rules are synchronized in both embedded copies", async () => {
  for (const path of [
    new URL("../../src/db/schemas/supabase.sql", import.meta.url),
    new URL("../../../supacloud-lite/src/runtime/db/emulated.ts", import.meta.url),
  ]) {
    const source = await readFile(path, "utf8");
    expect(replaceSqlModuleBlock(source, "pgmq-public", moduleSql)).toBe(source);
  }
});
