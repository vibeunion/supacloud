// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres } from "../helpers/native-postgres";
import { replaceSqlModuleBlock } from "../../src/db/sql-module-sync";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/pgmq-public.sql", import.meta.url), "utf8");

test("real RPC payload guards reject malformed and oversized batches before allocating message IDs", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.unsafe(moduleSql);
    await db`SELECT pgmq.create('jobs')`;
    const invalidStatements = [
      "SELECT * FROM pgmq_public.send('jobs', NULL::jsonb)",
      "SELECT * FROM pgmq_public.send('jobs', to_jsonb(repeat('x', 1048575)))",
      "SELECT * FROM pgmq_public.send('jobs', to_jsonb(repeat(chr(20013), 349526)))",
      "SELECT * FROM pgmq_public.send_batch('jobs', NULL::jsonb[])",
      "SELECT * FROM pgmq_public.send_batch('jobs', ARRAY[]::jsonb[])",
      "SELECT * FROM pgmq_public.send_batch('jobs', ARRAY['{}'::jsonb, NULL::jsonb])",
      "SELECT * FROM pgmq_public.send_batch('jobs', ARRAY[['{}'::jsonb, '{}'::jsonb]])",
      "SELECT * FROM pgmq_public.send_batch('jobs', '[0:0]={\"{}\"}'::jsonb[])",
      "SELECT * FROM pgmq_public.send_batch('jobs', array_fill('{}'::jsonb, ARRAY[10001]))",
      "SELECT * FROM pgmq_public.send_batch('jobs', ARRAY['{}'::jsonb, to_jsonb(repeat('x', 1048575))])",
      "SELECT * FROM pgmq_public.send_batch('jobs', array_fill(to_jsonb(repeat('x', 1048574)), ARRAY[9]))",
    ];
    for (const statement of invalidStatements) {
      await expect(db.begin(async tx => {
        await tx`SET LOCAL ROLE anon`;
        return tx.unsafe(statement);
      })).rejects.toMatchObject({ errno: "22023" });
    }
    const empty = await db`SELECT count(*)::integer AS count FROM pgmq.q_jobs`;
    expect(empty[0].count).toBe(0);
    const sent = await db.begin(async tx => {
      await tx`SET LOCAL ROLE anon`;
      return tx`SELECT * FROM pgmq_public.send('jobs', 'null'::jsonb)`;
    });
    expect(sent[0].send).toBe("1");
    const nullMessage = await db`SELECT message, message IS NULL AS sql_null FROM pgmq.q_jobs`;
    expect(nullMessage[0].message).toBeNull();
    expect(nullMessage[0].sql_null).toBe(false);
    const batch = await db`
      SELECT * FROM pgmq_public.send_batch('jobs', ARRAY['false'::jsonb, '"text"'::jsonb, '[null,1]'::jsonb])
    `;
    expect(batch.map((row: { send_batch: unknown }) => row.send_batch)).toEqual(["2", "3", "4"]);
    const exact = await db`
      SELECT octet_length(convert_to(pgmq_public.require_message(to_jsonb(repeat('x', 1048574)))::text, 'UTF8')) AS bytes
    `;
    expect(exact[0].bytes).toBe(1048576);
    const batchBoundary = await db`
      SELECT cardinality(pgmq_public.require_messages(array_fill(to_jsonb(repeat('x', 1048574)), ARRAY[8]))) AS count
    `;
    expect(batchBoundary[0].count).toBe(8);
    const countBoundary = await db`
      SELECT cardinality(pgmq_public.require_messages(array_fill('{}'::jsonb, ARRAY[10000]))) AS count
    `;
    expect(countBoundary[0].count).toBe(10000);
    await db.unsafe(moduleSql);
    const repeat = await db`SELECT pgmq_public.require_message('null'::jsonb) IS NULL AS sql_null`;
    expect(repeat[0].sql_null).toBe(false);
  }, { image });
}, 40_000);

test("embedded payload guards match the canonical SQL module", async () => {
  for (const path of [
    new URL("../../src/db/schemas/supabase.sql", import.meta.url),
    new URL("../../../supacloud-lite/src/runtime/db/emulated.ts", import.meta.url),
  ]) {
    const source = await readFile(path, "utf8");
    expect(replaceSqlModuleBlock(source, "pgmq-public", moduleSql)).toBe(source);
  }
});
