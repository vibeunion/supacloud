/** Run AFTER task-output.postgres.ts, against its explicitly named disposable database. */
import { SQL } from "bun";
import assert from "node:assert/strict";
import { createBackgroundAttemptStore } from "../../src/repositories/background-attempt-store";
import { createTaskEventClient, TaskEventError } from "../../../supacloud-js/src/task-events";
import { createTaskOutputRoutes } from "../../src/routes/task-output-route-factory";
import { resolveTaskOutputInvoker } from "../../src/utils/task-output";
import { SignJWT, jwtVerify } from "jose";

const connection = process.env.SUPACLOUD_TEST_TASK_OUTPUT_DATABASE_URL;
if (!connection) throw new Error("An explicit task_output_test database is required");
const url = new URL(connection);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/task_output_test") {
  throw new Error("Refusing a non-loopback or non-test database");
}
const sql = new SQL(connection, { max: 10 });
const store = createBackgroundAttemptStore(sql);
const owner = crypto.randomUUID(), other = crypto.randomUUID();
let server: ReturnType<typeof Bun.serve> | undefined;
let closeRuntimeDb: (() => Promise<void>) | undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function task(status = "leased", attempt = 1) {
  const identity = { id: crypto.randomUUID(), project_ref: "fence-demo", attempt };
  await sql`INSERT INTO public.project_tasks(id, project_ref, task_type, status, attempt, lease_until, invoker_user_id)
    VALUES (${identity.id}::uuid, ${identity.project_ref}, 'edge_function', ${status}, ${attempt},
      clock_timestamp() + interval '10 minutes', ${owner}::uuid)`;
  return identity;
}
async function facts(id: string) {
  const [row] = await sql`SELECT status, attempt, result, lease_until, cancel_requested_at FROM public.project_tasks WHERE id = ${id}::uuid`;
  return row;
}
async function history(id: string) {
  const [row] = await sql`SELECT public.supacloud_read_task_output('fence-demo', ${id}::uuid, 0, 100, ${owner}::uuid) AS value`;
  return row.value;
}
async function append(id: string, attempt = 1) {
  const [row] = await sql`SELECT public.supacloud_append_task_output('fence-demo', ${id}::uuid, ${attempt},
    ${crypto.randomUUID()}::uuid, 'output.delta', '{"text":"durable"}'::jsonb) AS value`;
  return row.value;
}
try {
  const [guard] = await sql`SELECT current_database() AS name, to_regclass('public.project_task_output_events') AS journal`;
  assert.equal(guard.name, "task_output_test"); assert.ok(guard.journal, "Run the journal acceptance script first");
  await sql`ALTER TABLE public.project_tasks
    ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'edge_function',
    ADD COLUMN IF NOT EXISTS error text, ADD COLUMN IF NOT EXISTS cancellation_reason text,
    ADD COLUMN IF NOT EXISTS next_run_at timestamptz, ADD COLUMN IF NOT EXISTS started_at timestamptz,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT clock_timestamp()`;
  await sql`CREATE TABLE IF NOT EXISTS public.project_task_attempts(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES public.project_tasks(id),
    project_ref text NOT NULL, attempt_no integer NOT NULL, status text NOT NULL,
    started_at timestamptz NOT NULL, completed_at timestamptz, duration_ms integer,
    error text, response_status integer, logs jsonb DEFAULT '[]', updated_at timestamptz DEFAULT clock_timestamp(),
    UNIQUE(task_id, attempt_no)
  )`;

  const one = await task();
  assert.equal((await Promise.all(Array.from({ length: 8 }, () => store.start(one, 60)))).filter(Boolean).length, 1);
  assert.equal(await store.start(one, 60), false);
  assert.equal(await store.renew({ ...one, project_ref: "different" }, 60), false);
  assert.equal(await store.renew({ ...one, attempt: 2 }, 60), false);
  await append(one.id);
  const completed = await Promise.all(Array.from({ length: 8 }, (_, n) => store.finish(one, { status: "succeeded", result: { winner: n } })));
  assert.equal(completed.filter(Boolean).length, 1);
  const [attemptRow] = await sql`SELECT status FROM public.project_task_attempts WHERE task_id = ${one.id}::uuid`;
  assert.equal(attemptRow.status, (await facts(one.id)).status);
  assert.equal((await history(one.id)).events.at(-1).type, "task.succeeded");
  assert.equal(await store.renew(one, 60), false);
  assert.equal(await store.finish(one, { status: "dead_lettered", error: "late" }), null);
  console.log("PASS one start/settlement per attempt, atomic attempt history and lifecycle, project isolation");

  const old = await task(); await store.start(old, 60); await append(old.id);
  await sql`UPDATE public.project_tasks SET status = 'dead_lettered', lease_until = NULL WHERE id = ${old.id}::uuid`;
  // Simulate the existing explicit retry/claim contract: the attempt NEVER resets.
  await sql`UPDATE public.project_tasks SET status = 'leased', attempt = 2,
    lease_until = clock_timestamp() + interval '1 minute' WHERE id = ${old.id}::uuid`;
  const newer = { ...old, attempt: 2 }; assert.equal(await store.start(newer, 60), true);
  assert.equal(await store.finish(old, { status: "succeeded", result: { stale: true } }), null);
  assert.equal(await store.finish(old, { status: "retry_scheduled", nextRunAt: new Date() }), null);
  assert.equal(await store.finish(old, { status: "cancelled" }), null);
  assert.equal(await store.renew(old, 1800), false);
  assert.equal(await store.requestCancellation(old), null);
  assert.equal((await append(old.id)).code, "TASK_OUTPUT_STALE_ATTEMPT");
  assert.equal((await facts(old.id)).status, "running"); assert.equal((await facts(old.id)).attempt, 2);
  await append(old.id, 2); await store.finish(newer, { status: "succeeded", result: { current: true } });
  assert.deepEqual((await facts(old.id)).result, { current: true });
  console.log("PASS late success/failure/cancellation/heartbeat cannot overwrite a newer attempt");

  const locked = await task(); await store.start(locked, 60);
  await sql`UPDATE public.project_tasks SET lease_until = clock_timestamp() + interval '250 milliseconds' WHERE id = ${locked.id}::uuid`;
  const acquired = deferred();
  const holder = sql.begin(async tx => {
    await tx`SELECT id FROM public.project_tasks WHERE id = ${locked.id}::uuid FOR UPDATE`;
    acquired.resolve(); await sleep(500);
  });
  await acquired.promise; const renewal = store.renew(locked, 60); await holder;
  assert.equal(await renewal, false, "recheck the database clock AFTER a lock wait");
  assert.equal(await store.finish(locked, { status: "succeeded" }), null);
  console.log("PASS expired lease cannot be resurrected, including expiration during a row-lock wait");

  const cancelled = await task(); await store.start(cancelled, 60); await append(cancelled.id);
  assert.equal((await store.requestCancellation(cancelled))?.status, "running");
  assert.equal(await store.renew(cancelled, 60), false);
  assert.equal((await store.finish(cancelled, { status: "succeeded", result: { ignored: true } }))?.status, "cancelled");
  assert.equal((await facts(cancelled.id)).result, null);
  assert.equal((await history(cancelled.id)).events.at(-1).type, "task.cancelled");
  assert.equal((await append(cancelled.id)).code, "TASK_OUTPUT_STALE_ATTEMPT");
  const queued = await task("pending", 0);
  assert.equal((await store.requestCancellation(queued))?.status, "cancelled");
  assert.equal((await facts(queued.id)).lease_until, null);
  console.log("PASS cancellation wins over success and queued cancellation is atomic");

  const rollback = await task(); await store.start(rollback, 60); await append(rollback.id);
  const before = await history(rollback.id);
  await sql`ALTER TABLE public.project_task_attempts ADD CONSTRAINT reject_fixture_history CHECK(error IS DISTINCT FROM 'reject-history')`;
  await assert.rejects(store.finish(rollback, { status: "dead_lettered", error: "reject-history" }));
  assert.equal((await facts(rollback.id)).status, "running");
  assert.equal((await history(rollback.id)).last_sequence, before.last_sequence);
  const [rolledAttempt] = await sql`SELECT status FROM public.project_task_attempts WHERE task_id = ${rollback.id}::uuid`;
  assert.equal(rolledAttempt.status, "running");
  await sql`ALTER TABLE public.project_task_attempts DROP CONSTRAINT reject_fixture_history`;
  await store.finish(rollback, { status: "succeeded" });
  console.log("PASS history-write failure rolls back task state AND output lifecycle, without a cursor hole");

  const abandoned = await task(); await store.start(abandoned, 60); await store.requestCancellation(abandoned);
  await sql`UPDATE public.project_tasks SET lease_until = clock_timestamp() - interval '1 second' WHERE id = ${abandoned.id}::uuid`;
  const live = await task(); await store.start(live, 60); await store.requestCancellation(live);
  assert.equal(await store.recoverCancelled(), 1);
  assert.equal((await facts(abandoned.id)).status, "cancelled"); assert.equal((await facts(live.id)).status, "running");
  assert.equal(await store.recoverCancelled(), 0);
  console.log("PASS crashed cancelled attempts converge without retrying; live leases are not reaped");

  // Use the actual mirror service and its normal project DB resolver, not copied SQL.
  await sql`CREATE TABLE IF NOT EXISTS public.projects(ref text PRIMARY KEY, db_name text NOT NULL)`;
  await sql`INSERT INTO public.projects(ref, db_name) VALUES ('fence-demo', 'task_output_test') ON CONFLICT DO NOTHING`;
  await sql`CREATE SCHEMA IF NOT EXISTS auth`;
  await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY, deleted_at timestamptz)`;
  await sql`INSERT INTO auth.users(id) VALUES (${owner}::uuid)`;
  await sql`CREATE TABLE IF NOT EXISTS public.background_task_mirrors(
    id uuid PRIMARY KEY, project_ref text NOT NULL, task_type text, function_slug text, status text,
    invoker_user_id uuid, attempt integer, max_attempts integer, trace_id text,
    created_at timestamptz, updated_at timestamptz
  )`;
  process.env.DATABASE_URL = connection;
  const runtimeDb = await import("../../src/db"); closeRuntimeDb = runtimeDb.closeDb;
  const mirrorService = await import("../../src/services/background-task.service");
  const evidence = { ...old, task_type: "edge_function", function_slug: "fixture", max_attempts: 3, trace_id: null,
    payload: { auth: { invoker_user_id: owner } } } as Parameters<typeof mirrorService.createBackgroundTaskMirrorIfUserExists>[0];
  await mirrorService.createBackgroundTaskMirrorIfUserExists({ ...evidence, attempt: 2 });
  await mirrorService.createBackgroundTaskMirrorIfUserExists(evidence);
  await mirrorService.removeBackgroundTaskMirror(evidence);
  const [mirror] = await sql`SELECT attempt FROM public.background_task_mirrors WHERE id = ${old.id}::uuid`;
  assert.equal(mirror.attempt, 2);
  await mirrorService.removeBackgroundTaskMirror({ ...evidence, attempt: 2 });
  assert.equal((await sql`SELECT id FROM public.background_task_mirrors WHERE id = ${old.id}::uuid`).length, 0);
  console.log("PASS actual mirror service refuses stale upsert/cleanup while permitting current cleanup");

  // Real loopback HTTP, production Elysia routes + service + SDK + PostgreSQL.
  // JWTs are genuinely signed/verified; this is a fixture issuer, NOT a live GoTrue deployment.
  const { taskOutputService } = await import("../../src/services/task-output.service");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const issuer = "task-output-fixture";
  const jwt = (sub: string, ref = "fence-demo") => new SignJWT({ role: "authenticated", ref }).setProtectedHeader({ alg: "HS256" })
    .setSubject(sub).setIssuer(issuer).setAudience(issuer).setExpirationTime("5m").sign(key);
  const ownerToken = await jwt(owner), otherToken = await jwt(other), foreignToken = await jwt(owner, "foreign");
  const writerToken = crypto.randomUUID();
  const routes = createTaskOutputRoutes({
    ...taskOutputService,
    async authorizeRead(request, ref) {
      const sub = await resolveTaskOutputInvoker(request, async token => {
        try {
          const { payload } = await jwtVerify(token, key, { issuer, audience: issuer, algorithms: ["HS256"] });
          return { ref: String(payload.ref), role: String(payload.role), sub: payload.sub };
        } catch { return null; }
      }, false, ref);
      return sub ? { invokerUserId: sub } : Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    },
    async authorizeWrite(request) {
      return request.headers.get("authorization") === `Bearer ${writerToken}` ? null : Response.json({ code: "FORBIDDEN" }, { status: 403 });
    },
  });
  let unavailable = false;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: request => unavailable ? new Response("proxy temporarily unavailable", { status: 503 }) : routes.handle(request) });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = (token: string) => createTaskEventClient({ baseUrl, projectRef: "fence-demo", getHeaders: () => ({ Authorization: `Bearer ${token}` }) });
  const reader = client(ownerToken), writer = client(writerToken);
  const streamed = await task(); await store.start(streamed, 60);
  const write = (text: string, attempt = 1) => writer.append(streamed.id, { attempt, event_id: crypto.randomUUID(), type: "output.delta", payload: { text } });
  await write("before disconnect");
  let checkpoint = "0";
  const initial = reader.watch(streamed.id, { pollIntervalMs: 10, onCursor: value => { checkpoint = value; } });
  assert.equal((await initial.next()).value?.sequence, "1");
  // Returning/breaking before resuming must NOT checkpoint an unacknowledged event.
  await initial.return(); assert.equal(checkpoint, "0");
  await write("while disconnected");
  const recovered: string[] = [], attempts: number[] = [];
  const consume = (async () => {
    for await (const event of reader.watch(streamed.id, { after: checkpoint, pollIntervalMs: 10,
      onCursor: value => { checkpoint = value; }, subscribe: () => () => {} })) {
      recovered.push(event.sequence); attempts.push(event.attempt);
    }
  })();
  await sleep(50);
  unavailable = true; await sleep(50); unavailable = false;
  await write("after reconnect");
  await store.finish(streamed, { status: "succeeded", result: { text: "final durable result" } });
  await consume;
  assert.deepEqual(recovered, ["1", "2", "3", "4"]); assert.equal(checkpoint, "4");
  assert.ok(attempts.every(value => value === 1));
  await assert.rejects(client(otherToken).list(streamed.id), error => error instanceof TaskEventError && error.status === 404);
  await assert.rejects(client(foreignToken).list(streamed.id), error => error instanceof TaskEventError && error.status === 401);
  await assert.rejects(reader.append(streamed.id, { attempt: 1, event_id: crypto.randomUUID(), type: "progress", payload: {} }),
    error => error instanceof TaskEventError && error.status === 403);
  assert.deepEqual((await facts(streamed.id)).result, { text: "final durable result" });
  console.log("PASS actual HTTP + signed JWT fixture + SDK replay/polling recovers terminal output without Realtime notifications");
} finally {
  await server?.stop(true);
  await closeRuntimeDb?.();
  await sql.close();
}
