/** Runs only against an empty, loopback, explicitly named disposable database. */
import { SQL } from "bun";
import assert from "node:assert/strict";
import { splitSqlStatements } from "../../src/db/sql-statements";
import schema from "../../src/db/task-output-journal.sql" with { type: "text" };

const connection = process.env.SUPACLOUD_TEST_TASK_OUTPUT_DATABASE_URL;
if (!connection) throw new Error("Set SUPACLOUD_TEST_TASK_OUTPUT_DATABASE_URL to a disposable task_output_test database");
const url = new URL(connection);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/task_output_test") {
  throw new Error("Refusing a non-loopback or non-test database");
}
const sql = new SQL(connection, { max: 8 });
const id = crypto.randomUUID(), owner = crypto.randomUUID(), other = crypto.randomUUID();
const append = async (eventId = crypto.randomUUID(), attempt = 1, payload = { text: "hello" }, ref = "demo") => {
  const [row] = await sql`SELECT public.supacloud_append_task_output(${ref}::text, ${id}::uuid, ${attempt}::integer, ${eventId}::uuid, 'output.delta', ${JSON.stringify(payload)}::text::jsonb) AS value`;
  return row.value;
};
const read = async (after = "0", ref = "demo", user: string | null = owner, limit = 100) => {
  const [row] = await sql`SELECT public.supacloud_read_task_output(${ref}, ${id}::uuid, ${after}::bigint, ${limit}, ${user}::uuid) AS value`;
  return row.value;
};
try {
  const [guard] = await sql`SELECT current_database() AS name, to_regclass('public.project_tasks') AS tasks`;
  assert.equal(guard.name, "task_output_test"); assert.equal(guard.tasks, null, "The test database must be empty");
  await sql`CREATE TABLE public.project_tasks (
    id uuid PRIMARY KEY, project_ref text NOT NULL, status text NOT NULL,
    attempt integer NOT NULL DEFAULT 0, lease_until timestamptz, cancel_requested_at timestamptz,
    invoker_user_id uuid, completed_at timestamptz, result jsonb
  )`;
  for (let run = 0; run < 2; run++) {
    await sql.begin(async (tx) => {
      for (const statement of splitSqlStatements(schema)) await tx.unsafe(statement);
    });
  }
  await sql`INSERT INTO public.project_tasks(id, project_ref, status, attempt, lease_until, invoker_user_id)
    VALUES (${id}::uuid, 'demo', 'running', 1, clock_timestamp() + interval '10 minutes', ${owner}::uuid)`;
  assert.equal((await read()).enabled, false);
  const ordinary = crypto.randomUUID();
  await sql`INSERT INTO public.project_tasks(id, project_ref, status) VALUES (${ordinary}::uuid, 'demo', 'pending')`;
  await sql`UPDATE public.project_tasks SET status = 'succeeded' WHERE id = ${ordinary}::uuid`;
  const [untouched] = await sql`SELECT count(*)::int AS count FROM public.project_task_output_streams WHERE task_id = ${ordinary}::uuid`;
  assert.equal(untouched.count, 0);
  console.log("PASS migration idempotence and ordinary task compatibility");

  // Bind serialized JSON as text before PostgreSQL parses it exactly once.
  const [binding] = await sql`SELECT jsonb_typeof(${JSON.stringify({ text: "hello" })}::text::jsonb) AS kind`;
  assert.equal(binding.kind, "object");
  const eventId = crypto.randomUUID();
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => append(eventId)));
  assert.ok(concurrent.every((value) => value.sequence === "1"), JSON.stringify(concurrent));
  assert.equal((await append(eventId, 1, { text: "different" })).code, "TASK_OUTPUT_IDEMPOTENCY_CONFLICT");
  const more = await Promise.all(Array.from({ length: 20 }, () => append()));
  assert.equal(new Set(more.map((value) => value.sequence)).size, 20);
  const history = await read();
  assert.deepEqual(history.events.map((value: { sequence: string }) => value.sequence), Array.from({ length: 21 }, (_, n) => String(n + 1)));
  console.log("PASS concurrent allocation and idempotent uncertain writes");

  const rollbackId = crypto.randomUUID();
  await assert.rejects(sql.begin(async (tx) => {
    await tx`SELECT public.supacloud_append_task_output('demo', ${id}::uuid, 1, ${rollbackId}::uuid, 'output.delta', '{}'::jsonb)`;
    throw new Error("intentional rollback");
  }));
  assert.equal((await append(rollbackId)).sequence, "22");
  assert.equal((await read("22")).events.length, 0);
  const firstPage = await read("0", "demo", owner, 10);
  assert.equal(firstPage.has_more, true); assert.equal(firstPage.next_cursor, "10");
  assert.equal((await read("23")).code, "TASK_OUTPUT_CURSOR_AHEAD");
  console.log("PASS rollback-safe sequence and bounded pagination");

  assert.equal((await read("0", "other"))._error, 404);
  assert.equal((await read("0", "demo", other))._error, 404);
  assert.equal((await append(crypto.randomUUID(), 1, { text: "cross project" }, "other"))._error, 404);
  const [privileges] = await sql`SELECT
    (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.project_task_output_streams'::regclass, 'public.project_task_output_events'::regclass)) AS rls,
    (SELECT count(*)::int FROM pg_proc, LATERAL aclexplode(proacl) AS acl
      WHERE proname IN ('supacloud_append_task_output', 'supacloud_read_task_output') AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute`;
  assert.equal(privileges.rls, true); assert.equal(privileges.public_execute, 0);
  console.log("PASS project/owner isolation and no direct PUBLIC access");

  await sql`UPDATE public.project_tasks SET status = 'retry_scheduled', lease_until = NULL WHERE id = ${id}::uuid`;
  assert.equal((await append()).code, "TASK_OUTPUT_STALE_ATTEMPT");
  await sql`UPDATE public.project_tasks SET status = 'running', attempt = 2, lease_until = clock_timestamp() + interval '10 minutes' WHERE id = ${id}::uuid`;
  assert.equal((await append()).code, "TASK_OUTPUT_STALE_ATTEMPT");
  const second = await append(crypto.randomUUID(), 2); assert.equal(second.attempt, 2);
  const updated = await read();
  assert.ok(updated.events.some((value: { type: string }) => value.type === "task.retry_scheduled"));
  await sql`UPDATE public.project_tasks SET cancel_requested_at = clock_timestamp() WHERE id = ${id}::uuid`;
  assert.equal((await append(crypto.randomUUID(), 2)).code, "TASK_OUTPUT_STALE_ATTEMPT");
  await sql`UPDATE public.project_tasks SET cancel_requested_at = NULL, lease_until = clock_timestamp() - interval '1 second' WHERE id = ${id}::uuid`;
  assert.equal((await append(crypto.randomUUID(), 2)).code, "TASK_OUTPUT_STALE_ATTEMPT");
  console.log("PASS retry boundaries, cancellation and expired leases");

  await sql`UPDATE public.project_tasks SET lease_until = clock_timestamp() + interval '10 minutes' WHERE id = ${id}::uuid`;
  assert.equal((await append(crypto.randomUUID(), 2, { text: "x".repeat(17000) }))._error, 413);
  await sql`UPDATE public.project_task_output_streams SET output_count = 4096 WHERE task_id = ${id}::uuid`;
  assert.equal((await append(crypto.randomUUID(), 2))._error, 413);
  await sql`UPDATE public.project_tasks SET status = 'succeeded', result = '{"ok":true}'::jsonb,
    completed_at = clock_timestamp() - interval '8 days' WHERE id = ${id}::uuid`;
  const finished = await read(); assert.equal(finished.events.at(-1).type, "task.succeeded");
  assert.equal((await append(eventId)).sequence, "1", "acknowledge an already committed event even after terminal state");
  await sql`SELECT public.supacloud_prune_task_output()`;
  const expired = await read(); assert.equal(expired.replay_available, false); assert.equal(expired.retained_after, finished.last_sequence);
  assert.equal((await read(expired.retained_after)).events.length, 0);
  const [facts] = await sql`SELECT task.result, stream.output_count FROM public.project_tasks AS task
    JOIN public.project_task_output_streams AS stream ON task.id = stream.task_id WHERE task.id = ${id}::uuid`;
  assert.deepEqual(facts.result, { ok: true }); assert.equal(facts.output_count, 4096);
  console.log("PASS bounded outputs, terminal lifecycle and retention without deleting results");
} finally {
  // Deliberately retain disposable fixtures for debugging; never delete a caller's database.
  await sql.close();
}
