// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres } from "../helpers/native-postgres";
import { replaceSqlModuleBlock } from "../../src/db/sql-module-sync";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/pgmq-public.sql", import.meta.url), "utf8");

function nested(depth: number): string {
  return "[".repeat(depth) + "0" + "]".repeat(depth);
}

test("real SQL guards enforce node/depth boundaries and reject entire oversized batches before send", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.unsafe(moduleSql);
    await db`SELECT pgmq.create('jobs')`;
    for (const [json, count] of [
      ["null", 1], ["{}", 1], ["[]", 1], ['{"a":[null,true,{"b":1}]}', 6],
      [nested(64), 65],
    ] as const) {
      const result = await db`SELECT pgmq_public.message_node_count(${json}::text::jsonb) AS count`;
      expect(result[0].count).toBe(count);
    }
    const exact = JSON.stringify(Array.from({ length: 9999 }, () => 0));
    const oversized = JSON.stringify(Array.from({ length: 10000 }, () => 0));
    const count = await db`SELECT pgmq_public.message_node_count(${exact}::text::jsonb) AS count`;
    expect(count[0].count).toBe(10000);
    for (const json of [nested(65), oversized]) {
      await expect(db.begin(async tx => {
        await tx`SET LOCAL ROLE anon`;
        return tx`SELECT * FROM pgmq_public.send('jobs', ${json}::text::jsonb)`;
      })).rejects.toMatchObject({ errno: "22023" });
      await expect(db.begin(async tx => {
        await tx`SET LOCAL ROLE anon`;
        return tx`SELECT * FROM pgmq_public.send_batch('jobs', ARRAY['{}'::jsonb, ${json}::text::jsonb])`;
      })).rejects.toMatchObject({ errno: "22023" });
    }
    const batchBoundary = await db`
      SELECT cardinality(pgmq_public.require_messages(array_fill(${exact}::text::jsonb, ARRAY[10]))) AS count
    `;
    expect(batchBoundary[0].count).toBe(10);
    await expect(db.begin(async tx => {
      await tx`SET LOCAL ROLE anon`;
      return tx`SELECT * FROM pgmq_public.send_batch('jobs', array_fill(${exact}::text::jsonb, ARRAY[11]))`;
    })).rejects.toMatchObject({ errno: "22023" });
    const empty = await db`SELECT count(*)::integer AS count FROM pgmq.q_jobs`;
    expect(empty[0].count).toBe(0);
    const sent = await db`SELECT * FROM pgmq_public.send('jobs', ${nested(64)}::text::jsonb)`;
    expect(sent[0].send).toBe("1");
    const readback = await db`SELECT message::text AS body FROM pgmq.q_jobs`;
    expect(JSON.stringify(JSON.parse(readback[0].body))).toBe(nested(64));
    for (const json of [null, `"${"x".repeat(1048575)}"`]) {
      const query = async () => await db`SELECT pgmq_public.require_message(${json}::text::jsonb)`;
      await expect(query()).rejects.toMatchObject({ errno: "22023" });
    }
    await db.unsafe(moduleSql);
    const reinstalled = await db`SELECT pgmq_public.message_node_count('{"a":1}'::jsonb) AS count`;
    expect(reinstalled[0].count).toBe(2);
  }, { image });
}, 40_000);

test("structure guards are synchronized in embedded SQL copies", async () => {
  for (const path of [
    new URL("../../src/db/schemas/supabase.sql", import.meta.url),
    new URL("../../../supacloud-lite/src/runtime/db/emulated.ts", import.meta.url),
  ]) {
    const source = await readFile(path, "utf8");
    expect(replaceSqlModuleBlock(source, "pgmq-public", moduleSql)).toBe(source);
  }
});
