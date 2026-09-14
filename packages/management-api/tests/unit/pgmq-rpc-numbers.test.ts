// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres } from "../helpers/native-postgres";
import { replaceSqlModuleBlock } from "../../src/db/sql-module-sync";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/pgmq-public.sql", import.meta.url), "utf8");

test("real anonymous RPC calls reject null/negative seconds, invalid counts and nonpositive IDs", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.unsafe(moduleSql);
    await db`SELECT pgmq.create('jobs')`;
    await db`SELECT pgmq_public.send('jobs', '{}'::jsonb)`;
    const before = await db`SELECT msg_id::text, read_ct, vt FROM pgmq.q_jobs`;
    for (const seconds of [null, -1, -2147483648]) {
      for (const operation of [
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT * FROM pgmq_public.send('jobs', '{}'::jsonb, ${seconds}::integer)`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT * FROM pgmq_public.send_batch('jobs', ARRAY['{}'::jsonb], ${seconds}::integer)`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT * FROM pgmq_public.read('jobs', ${seconds}::integer, 1)`; }),
      ]) await expect(operation()).rejects.toMatchObject({ errno: "22023" });
    }
    for (const count of [null, 0, -1, 10001, 2147483647]) {
      await expect(db.begin(async tx => {
        await tx`SET LOCAL ROLE anon`;
        return tx`SELECT * FROM pgmq_public.read('jobs', 0, ${count}::integer)`;
      })).rejects.toMatchObject({ errno: "22023" });
    }
    for (const id of [null, "0", "-1", "-9223372036854775808"]) {
      for (const operation of [
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT pgmq_public.archive('jobs', ${id}::bigint)`; }),
        () => db.begin(async tx => { await tx`SET LOCAL ROLE anon`; return tx`SELECT pgmq_public."delete"('jobs', ${id}::bigint)`; }),
      ]) await expect(operation()).rejects.toMatchObject({ errno: "22023" });
    }
    const after = await db`SELECT msg_id::text, read_ct, vt FROM pgmq.q_jobs`;
    expect(Array.from(after)).toEqual(Array.from(before));
    const next = await db`SELECT * FROM pgmq_public.send('jobs', '{}'::jsonb, 0)`;
    expect(next[0].send).toBe("2");
    const boundary = await db`
      SELECT pgmq_public.require_seconds(2147483647) AS seconds,
        pgmq_public.require_read_count(10000) AS count,
        pgmq_public.require_message_id(9223372036854775807)::text AS id
    `;
    expect(boundary[0]).toEqual({ seconds: 2147483647, count: 10000, id: "9223372036854775807" });
    const visible = await db`SELECT * FROM pgmq_public.read('jobs', 0, 10000)`;
    expect(visible.length).toBe(2);
    expect(visible[0].msg_id).toBe("1");
    await db.unsafe(moduleSql);
    const installed = await db`SELECT pgmq_public.require_seconds(0) AS seconds`;
    expect(installed[0].seconds).toBe(0);
  }, { image });
}, 40_000);

test("embedded numeric guards match the canonical SQL module", async () => {
  for (const path of [
    new URL("../../src/db/schemas/supabase.sql", import.meta.url),
    new URL("../../../supacloud-lite/src/runtime/db/emulated.ts", import.meta.url),
  ]) {
    const source = await readFile(path, "utf8");
    expect(replaceSqlModuleBlock(source, "pgmq-public", moduleSql)).toBe(source);
  }
});
