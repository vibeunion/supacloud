/** Run after task-output.postgres.ts, BEFORE background-attempt.postgres.ts. */
import { SQL } from "bun";
import assert from "node:assert/strict";
import schema from "../../src/db/task-output-governance.sql" with { type: "text" };
import { splitSqlStatements } from "../../src/db/sql-statements";
import { maintainTaskOutput } from "../../src/repositories/task-output-maintenance-store";
import { controlPlaneDatabaseFingerprint, inspectControlPlaneDatabaseIdentity } from "../../src/db/control-plane-database-identity";
import { createTaskOutputRoutes } from "../../src/routes/task-output-route-factory";
import { TaskOutputError } from "../../src/utils/task-output";

const connection = process.env.SUPACLOUD_TEST_TASK_OUTPUT_DATABASE_URL;
if (!connection) throw new Error("An explicit disposable task_output_test database is required");
const url = new URL(connection);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/task_output_test") {
  throw new Error("Refusing a non-loopback or non-test database");
}
const sql = new SQL(connection, { max: 12 });
const owner = crypto.randomUUID();
let server: ReturnType<typeof Bun.serve> | undefined;
let closeRuntimeDb: (() => Promise<void>) | undefined;
const migrate = () => sql.begin(async tx => {
  for (const statement of splitSqlStatements(schema)) await tx.unsafe(statement);
});
async function task(ref: string) {
  const id = crypto.randomUUID();
  await sql`INSERT INTO public.project_tasks(id, project_ref, status, attempt, lease_until, invoker_user_id)
    VALUES (${id}::uuid, ${ref}, 'running', 1, clock_timestamp() + interval '10 minutes', ${owner}::uuid)`;
  return id;
}
async function append(ref: string, id: string, eventId = crypto.randomUUID(), text = "hello") {
  const [row] = await sql`SELECT public.supacloud_append_task_output_governed(${ref}, ${id}::uuid, 1,
    ${eventId}::uuid, 'output.delta', ${JSON.stringify({ text })}::text::jsonb) AS value`;
  return row.value;
}
async function quota(ref: string) {
  const [row] = await sql`SELECT retained_bytes::text, retained_events::text, window_bytes::text,
    window_events, max_events_per_minute, max_retained_events FROM public.project_task_output_quotas WHERE project_ref = ${ref}`;
  return row;
}
async function history(ref: string, id: string) {
  const [row] = await sql`SELECT public.supacloud_read_task_output(${ref}, ${id}::uuid, 0, 100, ${owner}::uuid) AS value`;
  return row.value;
}
try {
  const [guard] = await sql`SELECT current_database() AS name, to_regclass('public.project_task_output_events') AS journal`;
  assert.equal(guard.name, "task_output_test"); assert.ok(guard.journal, "Run journal acceptance first");
  await sql`CREATE TABLE IF NOT EXISTS public.projects(ref text PRIMARY KEY, db_name text NOT NULL)`;
  await sql`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$`;
  // Simulate permissive default ACLs; the optional control schema must revoke them.
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated`;
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated`;
  await migrate();
  const fingerprint = controlPlaneDatabaseFingerprint(await inspectControlPlaneDatabaseIdentity(sql));
  const [size] = await sql`SELECT octet_length('{"text":"hello"}'::jsonb::text) AS bytes`;

  await sql`INSERT INTO public.project_task_output_quotas(project_ref, max_events_per_minute)
    VALUES ('quota-race', 5)`;
  const ids = await Promise.all(Array.from({ length: 24 }, () => task("quota-race")));
  const eventIds = ids.map(() => crypto.randomUUID());
  const replies = await Promise.all(ids.map((id, n) => append("quota-race", id, eventIds[n])));
  const winners = replies.map((reply, n) => reply._error ? -1 : n).filter(n => n >= 0);
  assert.equal(winners.length, 5, JSON.stringify(replies));
  assert.equal(replies.filter(value => value.code === "TASK_OUTPUT_PROJECT_RATE_LIMIT").length, 19);
  assert.equal((await quota("quota-race")).window_events, 5);
  assert.equal((await quota("quota-race")).retained_bytes, String(size.bytes * 5));
  const win = winners[0];
  assert.equal((await append("quota-race", ids[win], eventIds[win])).sequence, "1");
  assert.equal((await quota("quota-race")).window_events, 5, "deduplication must not consume quota");
  for (const n of replies.map((reply, n) => reply._error ? n : -1).filter(n => n >= 0)) {
    assert.equal((await history("quota-race", ids[n])).last_sequence, "0", "rejection rolls back stream allocation");
  }
  const independent = await task("quota-other");
  assert.equal((await append("quota-other", independent)).sequence, "1");
  await migrate();
  assert.equal((await quota("quota-race")).window_events, 5);
  assert.equal((await quota("quota-race")).max_events_per_minute, 5);
  assert.equal((await quota("quota-race")).retained_bytes, String(size.bytes * 5));
  console.log("PASS cross-task concurrency, project isolation, deduplication and migration reconciliation");

  const rejected = replies.findIndex(value => value._error);
  await sql`UPDATE public.project_task_output_quotas SET window_start = clock_timestamp() - interval '2 minutes' WHERE project_ref = 'quota-race'`;
  assert.equal((await append("quota-race", ids[rejected], eventIds[rejected])).sequence, "1");
  assert.equal((await quota("quota-race")).window_events, 1);
  await sql`INSERT INTO public.project_task_output_quotas(project_ref, max_bytes_per_minute)
    VALUES ('quota-bytes', ${size.bytes * 2})`;
  const byteIds = await Promise.all(Array.from({ length: 3 }, () => task("quota-bytes")));
  const byteReplies = await Promise.all(byteIds.map(id => append("quota-bytes", id)));
  assert.equal(byteReplies.filter(value => !value._error).length, 2);
  assert.equal((await quota("quota-bytes")).window_bytes, String(size.bytes * 2));
  console.log("PASS database-clock window reset and shared byte-rate limit");

  await sql`INSERT INTO public.project_task_output_quotas(project_ref) VALUES ('quota-expiry')`;
  const expires = await task("quota-expiry");
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>(resolve => { acquired = resolve; });
  const holder = sql.begin(async tx => {
    await tx`SELECT project_ref FROM public.project_task_output_quotas WHERE project_ref = 'quota-expiry' FOR UPDATE`;
    await tx`UPDATE public.project_tasks SET lease_until = clock_timestamp() + interval '200 milliseconds' WHERE id = ${expires}::uuid`;
    acquired(); await new Promise(resolve => setTimeout(resolve, 450));
  });
  await acquiredPromise;
  const pending = append("quota-expiry", expires);
  await holder;
  assert.equal((await pending).code, "TASK_OUTPUT_STALE_ATTEMPT");
  assert.equal((await quota("quota-expiry")).retained_events, "0");
  console.log("PASS lease expiration cannot be hidden by a quota lock wait");

  const rolled = await task("quota-rollback");
  const rolledEvent = crypto.randomUUID();
  await assert.rejects(sql.begin(async tx => {
    await tx`SELECT public.supacloud_append_task_output_governed('quota-rollback', ${rolled}::uuid, 1,
      ${rolledEvent}::uuid, 'output.delta', '{"text":"hello"}'::jsonb)`;
    throw new Error("rollback fixture");
  }));
  assert.equal((await history("quota-rollback", rolled)).last_sequence, "0");
  assert.equal((await append("quota-rollback", rolled, rolledEvent)).sequence, "1");
  assert.equal((await quota("quota-rollback")).retained_events, "1");
  await assert.rejects(sql`UPDATE public.project_task_output_events SET payload = '{}'::jsonb WHERE task_id = ${rolled}::uuid`);
  await assert.rejects(sql`TRUNCATE public.project_task_output_events`);
  console.log("PASS rollback-safe accounting and immutable output history");

  await sql`INSERT INTO public.project_task_output_quotas(project_ref, max_retained_events) VALUES ('quota-store', 1)`;
  const archived = await task("quota-store"), blocked = await task("quota-store");
  await append("quota-store", archived);
  assert.equal((await append("quota-store", blocked)).code, "TASK_OUTPUT_PROJECT_STORAGE_LIMIT");
  await sql`UPDATE public.project_tasks SET status = 'succeeded', completed_at = clock_timestamp() - interval '8 days',
    result = '{"final":"preserved"}'::jsonb WHERE id = ${archived}::uuid`;
  assert.equal((await history("quota-store", archived)).events.at(-1).type, "task.succeeded");
  const beforeMaintenance = await quota("quota-store");
  const dry = await maintainTaskOutput(sql, { fingerprint, apply: false, limit: 1 });
  assert.equal(dry.mode, "dry-run"); assert.equal(dry.pruned_tasks, 0);
  assert.deepEqual(await quota("quota-store"), beforeMaintenance);
  await assert.rejects(maintainTaskOutput(sql, { fingerprint: "0".repeat(64), apply: true, limit: 1 }));
  assert.deepEqual(await quota("quota-store"), beforeMaintenance);
  const applied = await maintainTaskOutput(sql, { fingerprint, apply: true, limit: 1 });
  assert.equal(applied.lock_acquired, true); assert.equal(applied.pruned_tasks, 1);
  assert.equal((await quota("quota-store")).retained_bytes, "0");
  assert.equal((await quota("quota-store")).window_events, 1, "retention does not refund rate usage");
  assert.equal((await history("quota-store", archived)).replay_available, false);
  const [facts] = await sql`SELECT task.result, stream.output_count FROM public.project_tasks AS task
    JOIN public.project_task_output_streams AS stream ON stream.task_id = task.id WHERE task.id = ${archived}::uuid`;
  assert.deepEqual(facts.result, { final: "preserved" }); assert.equal(facts.output_count, 1);
  assert.equal((await append("quota-store", blocked)).sequence, "1");
  await sql`DELETE FROM public.project_tasks WHERE id = ${blocked}::uuid`;
  assert.equal((await quota("quota-store")).retained_events, "0", "FK cascade releases retained capacity");
  assert.equal((await quota("quota-store")).window_events, 2);
  assert.equal((await maintainTaskOutput(sql, { fingerprint, apply: true, limit: 25 })).pruned_tasks, 0);
  console.log("PASS fingerprint-pinned retention, dry-run, terminal exemption, watermarks, results and cascade accounting");

  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('supacloud.task-output-retention.v1', 0))`;
    const other = await maintainTaskOutput(sql, { fingerprint, apply: true, limit: 25 });
    assert.equal(other.lock_acquired, false); assert.equal(other.pruned_tasks, 0);
  });
  const [privileges] = await sql`SELECT
    has_table_privilege('authenticated', 'public.project_task_output_quotas', 'SELECT') AS can_read,
    has_function_privilege('authenticated', 'public.supacloud_append_task_output_governed(text,uuid,integer,uuid,text,jsonb)', 'EXECUTE') AS can_write`;
  assert.equal(privileges.can_read, false); assert.equal(privileges.can_write, false);
  console.log("PASS multi-instance cleanup exclusion and restricted control-plane grants");

  process.env.DATABASE_URL = connection;
  const runtimeDb = await import("../../src/db"); closeRuntimeDb = runtimeDb.closeDb;
  const { taskOutputService } = await import("../../src/services/task-output.service");
  // Production service and HTTP error mapping, not driver-error message matching.
  await sql`UPDATE public.project_task_output_quotas SET max_events_per_minute = 1,
    window_start = date_trunc('minute', clock_timestamp()), window_events = 1 WHERE project_ref = 'quota-race'`;
  const httpId = await task("quota-race"), writerToken = crypto.randomUUID();
  const routes = createTaskOutputRoutes({ ...taskOutputService,
    async authorizeRead() { return { invokerUserId: owner }; },
    async authorizeWrite(request) { return request.headers.get('authorization') === `Bearer ${writerToken}`
      ? null : Response.json({ code: 'FORBIDDEN' }, { status: 403 }); },
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => routes.handle(request) });
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/projects/quota-race/tasks/${httpId}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${writerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ attempt: 1, event_id: crypto.randomUUID(), type: 'progress', payload: {} }),
  });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
  assert.equal((await response.json()).code, 'TASK_OUTPUT_PROJECT_RATE_LIMIT');
  const storeId = await task("quota-store");
  await sql`UPDATE public.project_task_output_quotas SET max_retained_bytes = 1 WHERE project_ref = 'quota-store'`;
  await assert.rejects(taskOutputService.append('quota-store', storeId, {
    attempt: 1, event_id: crypto.randomUUID(), type: 'output.delta', payload: { text: 'hello' },
  }), error => error instanceof TaskOutputError && error.statusCode === 413 && error.code === 'TASK_OUTPUT_PROJECT_STORAGE_LIMIT');
  console.log("PASS actual HTTP Retry-After and service-level storage error contracts");
} finally {
  server?.stop(true);
  await closeRuntimeDb?.();
  await sql.close();
}
