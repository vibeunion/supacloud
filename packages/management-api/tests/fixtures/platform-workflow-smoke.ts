import assert from "node:assert/strict";
import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { SupaCloudWorkflowsClient } from "../../../supacloud-js/src/workflows";

// Own only the generated run in a dedicated, otherwise idle acceptance tenant.
assert.equal(process.env.SUPACLOUD_WORKFLOW_TEST, "1");
const ref = process.env.SUPACLOUD_TEST_PROJECT_REF;
assert.ok(ref && /^[a-z0-9]{10,20}$/.test(ref));
assert.ok(process.env.DATABASE_URL);
const meta = new SQL(process.env.DATABASE_URL);
let database: SQL | undefined;
let workflows: SupaCloudWorkflowsClient | undefined;
let attempted = false;
const runId = crypto.randomUUID();
const evidence: Record<string, boolean> = {};
let failure: unknown;
try {
  const [project] = await meta`
    SELECT name, db_name, service_role_key FROM projects WHERE ref = ${ref} AND deleted_at IS NULL
  `;
  assert.ok(project?.name.startsWith("platform-app-acceptance-"));
  assert.equal(project.db_name, `supa_${ref}`);
  assert.ok(project.service_role_key);
  const connection = new URL(process.env.DATABASE_URL);
  database = new SQL({
    hostname: connection.hostname, port: Number(connection.port || 5432),
    username: decodeURIComponent(connection.username), password: decodeURIComponent(connection.password),
    database: project.db_name, max: 1,
  });
  const [identity] = await database`SELECT current_database() AS name`;
  assert.equal(identity?.name, project.db_name);
  const [extension] = await database`SELECT extname FROM pg_extension WHERE extname = 'pgmq'`;
  assert.equal(extension?.extname, "pgmq");
  const [lock] = await database`
    SELECT pg_try_advisory_lock(hashtextextended(${"supacloud.platform-workflow-acceptance"}, 0)) AS acquired
  `;
  assert.equal(lock?.acquired, true, "Another workflow acceptance run owns this tenant");
  const [pending] = await database`
    SELECT count(*)::int AS count FROM pgmq.q_supacloud_internal_workflows
  `;
  assert.equal(pending?.count, 0, "Workflow acceptance requires an idle dedicated queue");
  const hostname = `${ref}.api.localhost`;
  const origin = `https://${hostname}`;
  let completionReceipt: { status: number; code: unknown; message: unknown } | undefined;
  const client = createClient(origin, project.service_role_key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const target = new URL(request.url);
      assert.equal(target.origin, origin);
      target.hostname = "127.0.0.1";
      const headers = new Headers(request.headers);
      headers.set("host", hostname);
      const response = await fetch(target, {
        method: request.method, headers, redirect: "error",
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        tls: { rejectUnauthorized: false },
      });
      if (target.pathname === "/rest/v1/rpc/supacloud_workflow_complete" && !response.ok) {
        const body = await response.clone().json() as { code?: unknown; message?: unknown };
        completionReceipt = { status: response.status, code: body.code, message: body.message };
      }
      return response;
    }) as typeof fetch },
  });
  workflows = new SupaCloudWorkflowsClient(client);
  const input = { runId, workflowName: "acceptance.review", workflowVersion: "1",
    firstStepKey: "verify", input: { marker: runId }, maxAttempts: 3 };
  attempted = true;
  const started = await workflows.start(input);
  assert.equal(started.status, "queued");
  assert.equal(started.idempotent, false);
  const replay = await workflows.start(input);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.steps[0]?.stepId, started.steps[0]?.stepId);
  evidence.startAndIdempotentReplay = true;
  const workerId = `acceptance-${runId}`;
  const first = await workflows.claim({ workerId, visibilityTimeoutSeconds: 15 });
  assert.ok(first?.status === "claimed");
  assert.equal(first.runId, runId);
  assert.equal(first.attempt, 1);
  assert.deepEqual(first.input, input.input);
  assert.equal(await workflows.claim({ workerId, visibilityTimeoutSeconds: 30 }), null);
  evidence.nativeQueueClaimAndLease = true;
  const attempt = (claim: typeof first) => ({
    stepId: claim.stepId, messageId: claim.messageId, attempt: claim.attempt, workerId: claim.workerId,
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [lease] = await database`
      SELECT vt <= clock_timestamp() AS expired FROM pgmq.q_supacloud_internal_workflows
      WHERE msg_id = ${first.messageId}::bigint AND message->>'run_id' = ${runId}
    `;
    if (lease?.expired === true) break;
    assert.ok(Date.now() < deadline, "Workflow visibility lease did not expire");
    await Bun.sleep(100);
  }
  const second = await workflows.claim({ workerId, visibilityTimeoutSeconds: 30 });
  assert.ok(second?.status === "claimed");
  assert.equal(second.runId, runId);
  assert.equal(second.attempt, 2);
  evidence.expiredLeaseRedelivery = true;
  await assert.rejects(workflows.complete({
    ...attempt(first), stepOutput: { stale: true }, runOutput: { stale: true },
  }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
    && error.code === "WORKFLOW_COMPLETE_UNCONFIRMED"
    && "mutationMayHaveApplied" in error && error.mutationMayHaveApplied === true));
  assert.equal(completionReceipt?.status, 500);
  assert.equal(completionReceipt?.code, "40001");
  assert.equal(completionReceipt?.message, "SUPACLOUD_WORKFLOW_STALE_ATTEMPT");
  const unchanged = await workflows.get(runId);
  assert.equal(unchanged?.status, "running");
  assert.deepEqual(unchanged?.output, {});
  assert.equal(unchanged?.steps[0]?.attempts, 2);
  evidence.staleAttemptRejected = true;
  const retried = await workflows.retry({ ...attempt(second), errorMessage: "ACCEPTANCE_RETRY", delaySeconds: 0 });
  assert.equal(retried.steps[0]?.status, "queued");
  const third = await workflows.claim({ workerId, visibilityTimeoutSeconds: 30 });
  assert.ok(third?.status === "claimed");
  assert.equal(third.runId, runId);
  assert.equal(third.attempt, 3);
  evidence.retryAndRedelivery = true;
  const output = { marker: runId, verified: true };
  const completed = await workflows.complete({ ...attempt(third), stepOutput: output, runOutput: output });
  assert.equal(completed.status, "completed");
  const replayedCompletion = await workflows.complete({ ...attempt(third), stepOutput: output, runOutput: output });
  assert.equal(replayedCompletion.idempotent, true);
  assert.equal(replayedCompletion.rowVersion, completed.rowVersion);
  evidence.idempotentSettlement = true;
  const freshClient = new SupaCloudWorkflowsClient(client);
  const observed = await freshClient.get(runId);
  assert.equal(observed?.status, "completed");
  assert.deepEqual(observed?.output, output);
  const [persisted] = await database`
    SELECT status, output FROM supacloud_workflows.runs WHERE id = ${runId}::uuid
  `;
  assert.equal(persisted?.status, "completed");
  assert.deepEqual(persisted?.output, output);
  const events = await freshClient.events(runId);
  assert.deepEqual(events.map(event => event.eventType), [
    "run_started", "step_claimed", "step_claimed", "step_retried", "step_claimed", "step_completed", "run_completed",
  ]);
  evidence.completedAndDurableReadback = true;
  assert.equal(await workflows.claim({ workerId, visibilityTimeoutSeconds: 30 }), null);
  evidence.queueDrained = true;
} catch (error) {
  failure = error;
} finally {
  try {
    if (attempted && database && workflows) {
      // Cancel first so an interrupted attempt cannot leave a claimable step.
      const [run] = await database`SELECT status FROM supacloud_workflows.runs WHERE id = ${runId}::uuid`;
      if (run && ["queued", "running"].includes(run.status)) {
        try { await workflows.cancel(runId, "Acceptance cleanup"); }
        catch { evidence.cancelUnavailable = true; }
      }
      await database.begin(async tx => {
        await tx`DELETE FROM pgmq.q_supacloud_internal_workflows WHERE message->>'run_id' = ${runId}`;
        await tx`DELETE FROM pgmq.a_supacloud_internal_workflows WHERE message->>'run_id' = ${runId}`;
        await tx`DELETE FROM supacloud_workflows.runs WHERE id = ${runId}::uuid`;
      });
      const [remaining] = await database`
        SELECT
          (SELECT count(*) FROM supacloud_workflows.runs WHERE id = ${runId}::uuid) +
          (SELECT count(*) FROM pgmq.q_supacloud_internal_workflows WHERE message->>'run_id' = ${runId}) +
          (SELECT count(*) FROM pgmq.a_supacloud_internal_workflows WHERE message->>'run_id' = ${runId}) AS count
      `;
      assert.equal(Number(remaining?.count), 0);
      evidence.cleanup = true;
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Workflow acceptance and cleanup failed") : error;
  } finally {
    await database?.close();
    await meta.close();
  }
}
if (failure) throw failure;
console.log(JSON.stringify(evidence));
