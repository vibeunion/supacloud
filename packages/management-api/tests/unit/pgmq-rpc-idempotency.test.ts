// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { withNativePostgres } from "../helpers/native-postgres";
import { replaceSqlModuleBlock } from "../../src/db/sql-module-sync";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:2dd8ac92a1c0eb121d6ea5b12b3f7c015813ae58945a940451d4683afd5a19c2";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/pgmq-public.sql", import.meta.url), "utf8");

test("native PGMQ atomically binds concurrent job keys, input and exact durable receipts", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    // An early deployment may contain key records without input identity. Never invent that identity.
    await db.unsafe(`CREATE SCHEMA supacloud_queue; CREATE TABLE supacloud_queue.job_keys (
      queue_name text NOT NULL, job_key text NOT NULL, msg_id bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(queue_name, job_key));
      INSERT INTO supacloud_queue.job_keys VALUES ('jobs', 'legacy', 42, clock_timestamp());`);
    await db.unsafe(moduleSql);
    await db`SELECT pgmq.create('jobs')`;
    await db.unsafe(`CREATE FUNCTION pgmq.pause_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END; $$;
      CREATE TRIGGER pause_enqueue BEFORE INSERT ON pgmq.q_jobs FOR EACH ROW EXECUTE FUNCTION pgmq.pause_enqueue();`);
    const receipts = await Promise.all(Array.from({ length: 12 }, () => db.begin(async tx => {
      await tx`SET LOCAL ROLE anon`;
      return tx`SELECT * FROM pgmq_public.send_idempotent('jobs', '{"revision":1}'::jsonb, 'concurrent', 0)`;
    })));
    expect(receipts.filter(rows => rows[0].created === true)).toHaveLength(1);
    expect(new Set(receipts.map(rows => rows[0].msg_id)).size).toBe(1);
    expect((await db`SELECT count(*)::integer AS n FROM pgmq.q_jobs`)[0].n).toBe(1);
    const id = receipts[0]![0].msg_id;
    expect(typeof id).toBe("string");
    for (const query of [
      () => db`SELECT * FROM pgmq_public.send_idempotent('jobs', '{"revision":2}'::jsonb, 'concurrent', 0)`,
      () => db`SELECT * FROM pgmq_public.send_idempotent('jobs', '{"revision":1}'::jsonb, 'concurrent', 1)`,
      () => db`SELECT * FROM pgmq_public.send_idempotent('jobs', '{}'::jsonb, 'legacy', 0)`,
    ]) await expect(query()).rejects.toMatchObject({ errno: "22023" });
    expect((await db`SELECT count(*)::integer AS n FROM pgmq.q_jobs`)[0].n).toBe(1);
    await expect(db`SELECT * FROM pgmq_public.send_idempotent('missing', '{}'::jsonb, 'rollback', 0)`).rejects.toBeInstanceOf(Error);
    expect((await db`SELECT count(*)::integer AS n FROM supacloud_queue.job_keys WHERE job_key = 'rollback'`)[0].n).toBe(0);
    await expect(db.begin(async tx => {
      await tx`SELECT * FROM pgmq_public.send_idempotent('jobs', '{}'::jsonb, 'aborted', 0)`;
      throw new Error("abort fixture");
    })).rejects.toThrow("abort fixture");
    expect((await db`SELECT count(*)::integer AS n FROM supacloud_queue.job_keys WHERE job_key = 'aborted'`)[0].n).toBe(0);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await expect(db.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        return tx`SELECT * FROM supacloud_queue.job_keys`;
      })).rejects.toMatchObject({ errno: "42501" });
    }
    await expect(db`SELECT * FROM pgmq_public.send_idempotent('supacloud_internal_jobs', '{}'::jsonb, 'reserved', 0)`)
      .rejects.toMatchObject({ errno: "42501" });
    await expect(db`SELECT * FROM pgmq_public.send_idempotent('jobs', '{}'::jsonb, '', 0)`)
      .rejects.toMatchObject({ errno: "22023" });
    await db`SELECT pgmq_public.archive('jobs', ${id}::bigint)`;
    await db.unsafe(moduleSql);
    expect((await db`SELECT * FROM pgmq_public.send_idempotent('jobs', '{"revision":1}'::jsonb, 'concurrent', 0)`)[0])
      .toEqual({ msg_id: id, created: false });
    expect((await db`SELECT count(*)::integer AS n FROM pgmq.q_jobs`)[0].n).toBe(0);
    await db`SELECT setval(pg_get_serial_sequence('pgmq.q_jobs', 'msg_id')::regclass, 9007199254740992, true)`;
    expect((await db`SELECT * FROM pgmq_public.send_idempotent('jobs', 'null'::jsonb, 'large-id', 0)`)[0])
      .toEqual({ msg_id: "9007199254740993", created: true });
  }, { image });
}, 120_000);

test("canonical idempotency SQL is identical in the platform and Lite mirrors", async () => {
  for (const path of [new URL("../../src/db/schemas/supabase.sql", import.meta.url),
    new URL("../../../supacloud-lite/src/runtime/db/emulated.ts", import.meta.url)]) {
    const source = await readFile(path, "utf8");
    expect(replaceSqlModuleBlock(source, "pgmq-public", moduleSql)).toBe(source);
  }
});
