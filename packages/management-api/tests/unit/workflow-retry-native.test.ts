// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { decodeWorkflowClaim } from "../../../supacloud-js/src/workflow-claim";
import { captureWorkflowRetry, decodeWorkflowRetry } from "../../../supacloud-js/src/workflow-retry";
import { decodeWorkflowRun } from "../../../supacloud-js/src/workflow-run";
import { withNativePostgres } from "../helpers/native-postgres";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/workflows-public.sql", import.meta.url), "utf8");

test("native retry upgrade preserves historical receipts and serializes concurrent replays", async () => {
  await withNativePostgres(async db => {
    await db.unsafe("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    const rpc = async (
      name: "start" | "claim" | "retry" | "get",
      request: object,
      role: "service_role" | "anon" | "authenticated" = "service_role",
    ): Promise<unknown> => db.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      const rows = await tx.unsafe(`SELECT public.supacloud_workflow_${name}($1::text::jsonb) AS result`,
        [JSON.stringify(request)]);
      const result: unknown = rows[0]?.result;
      return result;
    });
    const snapshot = async (): Promise<unknown> => {
      const rows = await db.unsafe(`
        SELECT jsonb_build_object(
          'runs', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM supacloud_workflows.runs r),
          'steps', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM supacloud_workflows.steps s),
          'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM supacloud_workflows.events e),
          'queue', (SELECT jsonb_agg(to_jsonb(q) ORDER BY msg_id) FROM pgmq.q_supacloud_internal_workflows q),
          'archive', (SELECT jsonb_agg(to_jsonb(a) ORDER BY msg_id) FROM pgmq.a_supacloud_internal_workflows a)
        ) AS result
      `);
      const result: unknown = rows[0]?.result;
      return result;
    };
    await db.unsafe(`
      SELECT setval(pg_get_serial_sequence('pgmq.q_supacloud_internal_workflows', 'msg_id'), 9007199254740992, true);
      SELECT setval(pg_get_serial_sequence('supacloud_workflows.events', 'id'), 9007199254740992, true);
    `);
    // Model the pre-receipt public wrapper while retaining the persisted retry ledger.
    await db.unsafe(`
      CREATE OR REPLACE FUNCTION public.supacloud_workflow_retry(request jsonb)
      RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
        SELECT supacloud_workflows.retry_step(
          supacloud_workflows.request_uuid(request, 'stepId'), (request ->> 'messageId')::bigint,
          (request ->> 'attempt')::integer, request ->> 'workerId',
          request ->> 'errorMessage', coalesce((request ->> 'delaySeconds')::integer, 0))
      $$;
    `);
    const runId = crypto.randomUUID();
    const started = decodeWorkflowRun(await rpc("start", {
      runId, workflowName: "native.retry", workflowVersion: "1", firstStepKey: "work",
      input: {}, maxAttempts: 2,
    }), runId);
    expect(started?.steps[0]?.queueMessageId).toBe("9007199254740993");
    const first = decodeWorkflowClaim(await rpc("claim", { workerId: "first", visibilityTimeoutSeconds: 30 }), "first");
    if (first?.status !== "claimed") throw new Error("Expected first native claim");
    const request = captureWorkflowRetry({
      stepId: first.stepId, messageId: first.messageId, attempt: first.attempt,
      workerId: first.workerId, errorMessage: " temporary ", delaySeconds: 0,
    });
    const old = await rpc("retry", request);
    expect(() => decodeWorkflowRetry(old, request)).toThrow("Workflow retry could not be validated");
    const beforeUpgrade = await snapshot();
    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    expect(await snapshot()).toEqual(beforeUpgrade);
    const second = decodeWorkflowClaim(await rpc("claim", { workerId: "second", visibilityTimeoutSeconds: 30 }), "second");
    if (second?.status !== "claimed") throw new Error("Expected second native claim");
    expect(second).toMatchObject({ stepId: first.stepId, messageId: first.messageId, attempt: 2 });
    const beforeReplay = await snapshot();
    const replay = await rpc("retry", request);
    expect(replay).toMatchObject({ retryReceipt: { ...request, operation: "retry" } });
    expect(decodeWorkflowRetry(replay, request)).toMatchObject({
      idempotent: true, status: "running", steps: [{ claimedBy: "second", attempts: 2, status: "running" }],
    });
    expect(await snapshot()).toEqual(beforeReplay);
    for (const patch of [
      { workerId: "wrong" }, { messageId: "9007199254740994" },
      { errorMessage: "different" }, { delaySeconds: 1 },
    ]) {
      await expect(rpc("retry", { ...request, ...patch })).rejects.toMatchObject({ errno: "23505" });
      expect(await snapshot()).toEqual(beforeReplay);
    }
    for (const role of ["anon", "authenticated"] as const) {
      await expect(rpc("retry", request, role)).rejects.toMatchObject({ errno: "42501" });
      await expect(rpc("get", { runId }, role)).rejects.toMatchObject({ errno: "42501" });
      expect(await snapshot()).toEqual(beforeReplay);
    }
    const terminal = captureWorkflowRetry({
      stepId: second.stepId, messageId: second.messageId, attempt: second.attempt,
      workerId: second.workerId, errorMessage: "permanent", delaySeconds: 0,
    });
    const results = await Promise.all([rpc("retry", terminal), rpc("retry", terminal)]);
    const runs = results.map(result => decodeWorkflowRetry(result, terminal));
    expect(runs.map(run => run.idempotent).sort()).toEqual([false, true]);
    for (const run of runs) {
      expect(run).toMatchObject({
        status: "failed", errorMessage: "permanent",
        steps: [{ status: "dead_lettered", attempts: 2, claimedBy: "second" }],
      });
    }
    const events = await db.unsafe(`
      SELECT id::text AS id, event_type, attempt, details
      FROM supacloud_workflows.events ORDER BY id
    `);
    expect(events.map((event: { id: unknown }) => event.id)).toEqual([
      "9007199254740993", "9007199254740994", "9007199254740995",
      "9007199254740996", "9007199254740997",
    ]);
    expect(events.map((event: { event_type: unknown }) => event.event_type)).toEqual([
      "run_started", "step_claimed", "step_retried", "step_claimed", "step_dead_lettered",
    ]);
    const counts = await db.unsafe(`
      SELECT (SELECT count(*)::integer FROM pgmq.q_supacloud_internal_workflows) AS queued,
        (SELECT count(*)::integer FROM pgmq.a_supacloud_internal_workflows) AS archived
    `);
    expect(counts[0]).toMatchObject({ queued: 0, archived: 1 });
    const afterTerminal = await snapshot();
    expect(decodeWorkflowRetry(await rpc("retry", request), request)).toMatchObject({
      status: "failed", idempotent: true,
    });
    expect(await snapshot()).toEqual(afterTerminal);
  }, { image });
}, 60_000);
