import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { PGMQ_SQL } from "./emulated.js";

test("Lite preserves idempotent enqueue identity and rejects changed payloads", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(PGMQ_SQL);
    await db.exec("SELECT pgmq.create('jobs'); SET ROLE anon;");
    const first = await db.query<{ msg_id: string; created: boolean }>(
      "SELECT * FROM pgmq_public.send_idempotent('jobs', '{\"value\":1}'::jsonb, 'same', 0)");
    expect(first.rows[0]!.created).toBe(true);
    const replay = await db.query<{ msg_id: string; created: boolean }>(
      "SELECT * FROM pgmq_public.send_idempotent('jobs', '{\"value\":1}'::jsonb, 'same', 0)");
    expect(replay.rows).toEqual([{ msg_id: first.rows[0]!.msg_id, created: false }]);
    await expect(db.exec("SELECT * FROM pgmq_public.send_idempotent('jobs', '{\"value\":2}'::jsonb, 'same', 0)"))
      .rejects.toThrow("SUPACLOUD_QUEUE_JOB_KEY_CONFLICT");
    await db.exec("RESET ROLE;");
    const count = await db.query<{ n: number }>("SELECT count(*)::integer AS n FROM pgmq.q_jobs");
    expect(count.rows[0]!.n).toBe(1);
    await db.exec(PGMQ_SQL);
  } finally { await db.close(); }
}, 20_000);
