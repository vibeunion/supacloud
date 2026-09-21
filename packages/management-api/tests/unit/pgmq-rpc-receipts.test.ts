// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres } from "../helpers/native-postgres";
import { queueRpcId, queueRpcIds, queueRpcMessages } from "../../../supacloud-js/src/queue-rpc";
import { replaceSqlModuleBlock } from "../../src/db/sql-module-sync";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/pgmq-public.sql", import.meta.url), "utf8");

test("fresh RPC installation returns JSON string IDs accepted exactly by SDK decoders", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.unsafe(moduleSql);
    await db`SELECT pgmq.create('jobs')`;
    await db`SELECT setval(pg_get_serial_sequence('pgmq.q_jobs', 'msg_id'), 9007199254740992, true)`;
    const single = await db`
      SELECT jsonb_agg(id)::text AS body FROM pgmq_public.send('jobs', '{"value":1}'::jsonb) AS receipt(id)
    `;
    const parsed: unknown = JSON.parse(single[0].body);
    expect(parsed).toEqual(["9007199254740993"]);
    expect(queueRpcId(parsed)).toBe("9007199254740993");
    const batch = await db`
      SELECT jsonb_agg(id)::text AS body FROM pgmq_public.send_batch('jobs', ARRAY['{}'::jsonb, '{}'::jsonb]) AS receipt(id)
    `;
    const parsedBatch: unknown = JSON.parse(batch[0].body);
    expect(queueRpcIds(parsedBatch, 2)).toEqual(["9007199254740994", "9007199254740995"]);
    const before = await db`SELECT 'pgmq_public.send(text,jsonb,integer)'::regprocedure::oid::text AS id`;
    await db.unsafe(moduleSql);
    const after = await db`SELECT 'pgmq_public.send(text,jsonb,integer)'::regprocedure::oid::text AS id`;
    expect(after[0].id).toBe(before[0].id);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const grants = await db`
        SELECT has_function_privilege(${role}, 'pgmq_public.send(text,jsonb,integer)', 'EXECUTE') AS single,
          has_function_privilege(${role}, 'pgmq_public.send_batch(text,jsonb[],integer)', 'EXECUTE') AS batch
      `;
      expect(grants[0]).toMatchObject({ single: true, batch: true });
    }
    await db`CREATE ROLE stranger`;
    const publicGrant = await db`SELECT has_function_privilege('stranger', 'pgmq_public.send(text,jsonb,integer)', 'EXECUTE') AS allowed`;
    expect(publicGrant[0].allowed).toBe(false);
  }, { image });
}, 40_000);

test("legacy bigint receipt migration is repeatable and refuses dependent-object deletion", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE EXTENSION pgmq; CREATE SCHEMA pgmq_public;");
    await db.unsafe(`
      CREATE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
      RETURNS SETOF bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
      CREATE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
      RETURNS SETOF bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
      CREATE VIEW public.user_receipt_view AS SELECT * FROM pgmq_public.send('jobs', '{}'::jsonb);
    `);
    await expect(db.begin(async tx => { await tx.unsafe(moduleSql); })).rejects.toThrow();
    const preserved = await db`
      SELECT pg_get_function_result('pgmq_public.send(text,jsonb,integer)'::regprocedure) AS result,
        to_regclass('public.user_receipt_view')::text AS dependent
    `;
    expect(preserved[0]).toMatchObject({ result: "SETOF bigint", dependent: "user_receipt_view" });
    await db`DROP VIEW public.user_receipt_view`;
    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    for (const signature of ["pgmq_public.send(text,jsonb,integer)", "pgmq_public.send_batch(text,jsonb[],integer)"]) {
      const updated = await db`SELECT pg_get_function_result(${signature}::regprocedure) AS result`;
      expect(updated[0].result).toBe("SETOF text");
    }
    await db`SELECT pgmq.create('migrated')`;
    const receipt = await db`SELECT * FROM pgmq_public.send('migrated', '{}'::jsonb)`;
    expect(receipt[0].send).toBe("1");
  }, { image });
}, 40_000);

test("embedded module copies match the canonical receipt definitions", async () => {
  for (const path of [
    new URL("../../src/db/schemas/supabase.sql", import.meta.url),
    new URL("../../../supacloud-lite/src/runtime/db/emulated.ts", import.meta.url),
  ]) {
    const source = await readFile(path, "utf8");
    expect(replaceSqlModuleBlock(source, "pgmq-public", moduleSql)).toBe(source);
  }
});

test("real RPC read/pop preserve high ids, payloads, headers and consumption effects", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.unsafe(moduleSql);
    await db`SELECT pgmq.create('consume')`;
    await db`SELECT setval(pg_get_serial_sequence('pgmq.q_consume', 'msg_id'), 9007199254740992, true)`;
    await db`SELECT pgmq_public.send('consume', '{"nested":[1,false,null]}'::jsonb)`;
    await db`UPDATE pgmq.q_consume SET headers = '{"trace":"kept"}'::jsonb`;
    const read = await db`
      SELECT coalesce(jsonb_agg(receipt), '[]'::jsonb)::text AS body
      FROM pgmq_public.read('consume', 60, 1) AS receipt
    `;
    const wire: unknown = JSON.parse(read[0].body);
    expect(wire).toMatchObject([{
      msg_id: "9007199254740993", read_ct: 1,
      message: { nested: [1, false, null] }, headers: { trace: "kept" },
    }]);
    expect(queueRpcMessages("consume", wire, 1, "leased")[0]?.msg_id).toBe("9007199254740993");
    const stored = await db`
      SELECT jsonb_build_object(
        'enqueued_at', enqueued_at, 'last_read_at', last_read_at, 'vt', vt
      ) AS timestamps FROM pgmq.q_consume
    `;
    expect(wire).toMatchObject([stored[0].timestamps]);
    const hidden = await db`
      SELECT count(*)::integer AS count FROM pgmq_public.read('consume', 60, 1)
    `;
    expect(hidden[0].count).toBe(0);
    await db`SELECT pgmq.set_vt('consume', 9007199254740993, 0)`;
    const popped = await db`
      SELECT coalesce(jsonb_agg(receipt), '[]'::jsonb)::text AS body
      FROM pgmq_public.pop('consume') AS receipt
    `;
    const poppedWire: unknown = JSON.parse(popped[0].body);
    expect(queueRpcMessages("consume", poppedWire, 1, "deleted")[0]).toMatchObject({
      msg_id: "9007199254740993", message: { nested: [1, false, null] },
    });
    expect(poppedWire).toMatchObject([{ headers: { trace: "kept" } }]);
    const remaining = await db`SELECT count(*)::integer AS count FROM pgmq.q_consume`;
    expect(remaining[0].count).toBe(0);
    const empty = await db`
      SELECT coalesce(jsonb_agg(receipt), '[]'::jsonb)::text AS body FROM pgmq_public.pop('consume') AS receipt
    `;
    expect(queueRpcMessages("consume", JSON.parse(empty[0].body), 1, "deleted")).toEqual([]);
  }, { image });
}, 40_000);

test("legacy composite read/pop upgrades without cascading dependencies or dropping refreshed identities", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE EXTENSION pgmq; CREATE SCHEMA pgmq_public;");
    await db.unsafe(`
      CREATE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
      RETURNS SETOF pgmq.message_record LANGUAGE sql AS $$ SELECT * FROM pgmq.read(queue_name, sleep_seconds, n) $$;
      CREATE FUNCTION pgmq_public.pop(queue_name text)
      RETURNS SETOF pgmq.message_record LANGUAGE sql AS $$ SELECT * FROM pgmq.pop(queue_name) $$;
      CREATE VIEW public.read_dependency AS SELECT * FROM pgmq_public.read('jobs', 30, 1);
      CREATE VIEW public.pop_dependency AS SELECT * FROM pgmq_public.pop('jobs');
    `);
    await expect(db.begin(async tx => { await tx.unsafe(moduleSql); })).rejects.toThrow();
    await db`DROP VIEW public.read_dependency`;
    await expect(db.begin(async tx => { await tx.unsafe(moduleSql); })).rejects.toThrow();
    const unchanged = await db`SELECT pg_get_function_result('pgmq_public.read(text,integer,integer)'::regprocedure) AS result`;
    expect(unchanged[0].result).toBe("SETOF pgmq.message_record");
    await db`DROP VIEW public.pop_dependency`;
    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    const identities = await db`
      SELECT 'pgmq_public.read(text,integer,integer)'::regprocedure::oid::text AS read,
        'pgmq_public.pop(text)'::regprocedure::oid::text AS pop
    `;
    await db.unsafe(moduleSql);
    const reinstalled = await db`
      SELECT 'pgmq_public.read(text,integer,integer)'::regprocedure::oid::text AS read,
        'pgmq_public.pop(text)'::regprocedure::oid::text AS pop
    `;
    expect(reinstalled[0]).toEqual(identities[0]);
    for (const signature of ["pgmq_public.read(text,integer,integer)", "pgmq_public.pop(text)"]) {
      const definition = await db`SELECT pg_get_function_result(${signature}::regprocedure) AS result`;
      expect(definition[0].result).toContain("msg_id text");
      for (const role of ["anon", "authenticated", "service_role"]) {
        const granted = await db`SELECT has_function_privilege(${role}, ${signature}, 'EXECUTE') AS allowed`;
        expect(granted[0].allowed).toBe(true);
      }
    }
  }, { image });
}, 40_000);
