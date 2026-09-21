// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, createSupaCloudWorkflowFetch, createSupaCloudCommandFetch, createSupaCloudArtifactFetch } from "../../../supacloud-js/src/index";
import { withNativePostgres, waitForPostgresFixture } from "../helpers/native-postgres";

const pgImage = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const restImage = "postgrest/postgrest@sha256:85258123312dc496ad4c2ed832154a65e9746f84df0d6d09b44229ff9230c08e";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/workflows-public.sql", import.meta.url), "utf8");
const commandSql = await readFile(new URL("../../src/db/sql-modules/commands-public.sql", import.meta.url), "utf8");
const artifactSql = await readFile(new URL("../../src/db/sql-modules/artifacts-public.sql", import.meta.url), "utf8");
const secret = "synthetic-workflow-http-jwt-secret-not-for-production";

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Workflow PostgREST fixture failed: ${stderr}`);
  return stdout.trim();
}

function token(role: "service_role" | "anon" | "authenticated"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

test("official durable SDKs validate receipts and committed-response loss through live PostgREST", async () => {
  await withNativePostgres(async (db, _url, databaseName) => {
    await db.unsafe(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE ROLE api LOGIN PASSWORD 'synthetic'; GRANT anon, authenticated, service_role TO api;
    `);
    await db.begin(async tx => { await tx.unsafe(moduleSql); });
    await db.begin(async tx => { await tx.unsafe(commandSql); });
    await db.unsafe(`
      CREATE SCHEMA storage;
      CREATE TABLE storage.objects (
        id uuid PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL, version text NOT NULL,
        UNIQUE (bucket_id, name)
      );
    `);
    await db.begin(async tx => { await tx.unsafe(artifactSql); });
    await db.unsafe(`
      SELECT setval(pg_get_serial_sequence('pgmq.q_supacloud_internal_workflows', 'msg_id'), 9007199254740992, true);
      SELECT setval(pg_get_serial_sequence('supacloud_workflows.events', 'id'), 9007199254740992, true);
      CREATE OR REPLACE FUNCTION public.supacloud_workflow_retry(request jsonb)
      RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
        SELECT supacloud_workflows.retry_step(
          supacloud_workflows.request_uuid(request, 'stepId'), (request ->> 'messageId')::bigint,
          (request ->> 'attempt')::integer, request ->> 'workerId',
          request ->> 'errorMessage', coalesce((request ->> 'delaySeconds')::integer, 0))
      $$;
    `);
    const network = `supacloud-workflow-rest-${crypto.randomUUID()}`;
    const restName = `${network}-api`;
    let connected = false;
    let started = false;
    await docker("network", "create", network);
    try {
      await docker("network", "connect", network, databaseName);
      connected = true;
      await docker("run", "--detach", "--rm", "--name", restName, "--network", network,
        "--publish", "127.0.0.1::3000",
        "--env", `PGRST_DB_URI=postgres://api:synthetic@${databaseName}:5432/fixture`,
        "--env", "PGRST_DB_SCHEMAS=public", "--env", "PGRST_DB_ANON_ROLE=anon",
        "--env", `PGRST_JWT_SECRET=${secret}`, restImage);
      started = true;
      const mapping = await docker("port", restName, "3000/tcp");
      const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
      if (!port) throw new Error("Expected loopback PostgREST port");
      const base = `http://127.0.0.1:${port}`;
      await waitForPostgresFixture(async () => {
        try {
          const response = await fetch(base, { signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          return response.ok;
        } catch { return false; }
      });
      const calls: Array<{ path: string; status: number; body: unknown }> = [];
      let wireCalls = 0;
      let dropNextRetry = false;
      let dropNextCommand = false;
      let dropNextArtifact: "register" | "link" | null = null;
      const workflowGuard = createSupaCloudWorkflowFetch({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (!url.pathname.startsWith("/rest/v1/")) throw new Error("Unexpected workflow SDK request");
          // Match the gateway prefix without replacing the real HTTP transport.
          url.pathname = url.pathname.slice("/rest/v1".length);
          wireCalls++;
          return fetch(new Request(url, request));
        },
      });
      const guarded = createSupaCloudArtifactFetch({ fetch: createSupaCloudCommandFetch({ fetch: workflowGuard }) });
      const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        url.pathname = url.pathname.slice("/rest/v1".length);
        const response = await guarded(input, init);
        const body: unknown = await response.clone().json();
        calls.push({ path: url.pathname, status: response.status, body });
        if (dropNextRetry && url.pathname === "/rpc/supacloud_workflow_retry") {
          dropNextRetry = false;
          await response.arrayBuffer();
          throw new Error("Injected loss after committed HTTP response");
        }
        if (dropNextCommand && url.pathname === "/rpc/supacloud_command_submit") {
          dropNextCommand = false;
          await response.arrayBuffer();
          throw new Error("Injected loss after committed command response");
        }
        if (dropNextArtifact && url.pathname === `/rpc/supacloud_artifact_${dropNextArtifact}`) {
          dropNextArtifact = null;
          await response.arrayBuffer();
          throw new Error("Injected loss after committed artifact response");
        }
        return response;
      }, { preconnect: globalThis.fetch.preconnect });
      const clientFor = (role: "service_role" | "anon" | "authenticated") => {
        const supabase = createClient(base, token(role), {
          global: { fetch: transport },
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        });
        return createSupaCloudClient({
          supabase, managementApiUrl: "http://127.0.0.1:1", projectRef: "fixture",
          getAccessToken: () => { throw new Error("Unexpected Management API request"); },
        });
      };
      const workflowsFor = (role: "service_role" | "anon" | "authenticated") => clientFor(role).workflows;
      const workflows = workflowsFor("service_role");
      const runId = crypto.randomUUID();
      const run = await workflows.start({
        runId, workflowName: "http.retry", workflowVersion: "1", firstStepKey: "work",
        input: { nested: [false, null, "original"] }, maxAttempts: 2,
      });
      expect(run.steps[0]?.queueMessageId).toBe("9007199254740993");
      expect(await workflows.get(runId)).toEqual(run);
      const first = await workflows.claim({ workerId: "first" });
      if (first?.status !== "claimed") throw new Error("Expected first HTTP claim");
      const retry = {
        stepId: first.stepId, messageId: first.messageId, attempt: first.attempt,
        workerId: first.workerId, errorMessage: "temporary", delaySeconds: 0,
      };
      const beforeLegacy = calls.length;
      await expect(workflows.retry(retry)).rejects.toMatchObject({
        code: "WORKFLOW_RETRY_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(calls.length - beforeLegacy).toBe(1);
      expect(calls.at(-1)).toMatchObject({ status: 200, body: { idempotent: false } });
      expect(calls.at(-1)?.body).not.toHaveProperty("retryReceipt");
      await db.begin(async tx => { await tx.unsafe(moduleSql); });
      const second = await workflows.claim({ workerId: "second" });
      if (second?.status !== "claimed") throw new Error("Expected second HTTP claim");
      expect(second).toMatchObject({ stepId: first.stepId, messageId: first.messageId, attempt: 2 });
      const current = await workflows.get(runId);
      const replay = await workflows.retry(retry);
      expect(replay).toEqual({ ...current, idempotent: true });
      expect(calls.at(-1)).toMatchObject({
        status: 200, body: { retryReceipt: { ...retry, operation: "retry" } },
      });
      expect(replay).not.toHaveProperty("retryReceipt");
      const terminal = {
        stepId: second.stepId, messageId: second.messageId, attempt: second.attempt,
        workerId: second.workerId, errorMessage: "permanent", delaySeconds: 0,
      };
      dropNextRetry = true;
      const beforeLoss = calls.length;
      await expect(workflows.retry(terminal)).rejects.toMatchObject({
        code: "WORKFLOW_RETRY_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(calls.length - beforeLoss).toBe(1);
      expect(calls.at(-1)).toMatchObject({
        status: 200, body: { status: "failed", idempotent: false, retryReceipt: { ...terminal, operation: "retry" } },
      });
      const committed = await workflows.get(runId);
      expect(committed).toMatchObject({
        status: "failed", steps: [{ status: "dead_lettered", claimedBy: "second", attempts: 2 }],
      });
      const replays = await Promise.all([workflows.retry(terminal), workflows.retry(terminal)]);
      for (const result of replays) expect(result).toEqual({ ...committed, idempotent: true });
      expect(await workflows.get(runId)).toEqual(committed);
      const page1 = await workflows.events(runId, { afterEventId: "9007199254740992", limit: 2 });
      if (page1.length !== 2 || !page1[1]) throw new Error("Expected two events on first page");
      const page2 = await workflows.events(runId, { afterEventId: page1[1].eventId, limit: 2 });
      if (page2.length !== 2 || !page2[1]) throw new Error("Expected two events on second page");
      const page3 = await workflows.events(runId, { afterEventId: page2[1].eventId, limit: 2 });
      const events = [...page1, ...page2, ...page3];
      expect(events.map(event => event.eventId)).toEqual([
        "9007199254740993", "9007199254740994", "9007199254740995",
        "9007199254740996", "9007199254740997",
      ]);
      expect(events.map(event => event.eventType)).toEqual([
        "run_started", "step_claimed", "step_retried", "step_claimed", "step_dead_lettered",
      ]);
      const rows = await db`SELECT public.supacloud_workflow_events(${JSON.stringify({
        runId, afterEventId: "0", limit: 100,
      })}::text::jsonb) AS result`;
      expect(events).toEqual(rows[0]?.result);
      expect(await workflows.events(runId, { afterEventId: "9007199254740997" })).toEqual([]);
      const beforeConflict = calls.length;
      await expect(workflows.retry({ ...retry, workerId: "wrong" })).rejects.toMatchObject({ code: "23505" });
      expect(calls.length - beforeConflict).toBe(1);
      for (const role of ["anon", "authenticated"] as const) {
        const denied = workflowsFor(role);
        await expect(denied.get(runId)).rejects.toMatchObject({ code: "42501" });
        await expect(denied.events(runId)).rejects.toMatchObject({ code: "42501" });
        await expect(denied.retry(retry)).rejects.toMatchObject({ code: "42501" });
      }
      expect(await workflows.get(runId)).toEqual(committed);
      expect(await workflows.events(runId)).toEqual(events);
      const counts = await db.unsafe(`
        SELECT (SELECT count(*)::integer FROM pgmq.q_supacloud_internal_workflows) AS queued,
          (SELECT count(*)::integer FROM pgmq.a_supacloud_internal_workflows) AS archived
      `);
      expect(counts[0]).toMatchObject({ queued: 0, archived: 1 });
      const largeId = crypto.randomUUID();
      const largeRequest = {
        runId: largeId, workflowName: "http.large", workflowVersion: "1", firstStepKey: "work",
        input: { text: "x".repeat(600_000) },
      };
      const largeSnapshot = async (): Promise<unknown> => {
        const rows = await db`
          SELECT
            md5(public.supacloud_workflow_get(jsonb_build_object('runId', ${largeId}::uuid))::text) AS run_hash,
            octet_length(public.supacloud_workflow_get(jsonb_build_object('runId', ${largeId}::uuid))::text)::integer AS response_bytes,
            (SELECT count(*)::integer FROM supacloud_workflows.runs) AS runs,
            (SELECT count(*)::integer FROM supacloud_workflows.steps) AS steps,
            (SELECT count(*)::integer FROM supacloud_workflows.events) AS events,
            (SELECT count(*)::integer FROM pgmq.q_supacloud_internal_workflows) AS queued,
            (SELECT sum(read_ct)::integer FROM pgmq.q_supacloud_internal_workflows) AS reads,
            (SELECT last_value::text FROM pgmq.q_supacloud_internal_workflows_msg_id_seq) AS queue_sequence,
            (SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY msg_id)::text)
              FROM pgmq.q_supacloud_internal_workflows q) AS queue_hash
        `;
        const result: unknown = rows[0];
        return result;
      };
      const beforeOversized = wireCalls;
      const beforeParsed = calls.length;
      await expect(workflows.start(largeRequest)).rejects.toMatchObject({
        code: "WORKFLOW_START_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(wireCalls - beforeOversized).toBe(1);
      expect(calls.length).toBe(beforeParsed);
      const largeCommitted = await largeSnapshot();
      expect(largeCommitted).toMatchObject({
        runs: 2, steps: 2, events: 6, queued: 1, reads: 0, queue_sequence: "9007199254740994",
      });
      if (largeCommitted === null || typeof largeCommitted !== "object"
        || !("response_bytes" in largeCommitted)) throw new Error("Expected response byte count");
      expect(largeCommitted.response_bytes).toBeGreaterThan(1024 * 1024);
      await expect(workflows.get(largeId)).rejects.toMatchObject({
        code: "WORKFLOW_READ_INVALID", mutationMayHaveApplied: false,
      });
      expect(wireCalls - beforeOversized).toBe(2);
      expect(calls.length).toBe(beforeParsed);
      expect(await largeSnapshot()).toEqual(largeCommitted);
      await expect(workflows.start(largeRequest)).rejects.toMatchObject({
        code: "WORKFLOW_START_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(wireCalls - beforeOversized).toBe(3);
      expect(calls.length).toBe(beforeParsed);
      expect(await largeSnapshot()).toEqual(largeCommitted);
      expect(await workflows.events(largeId)).toMatchObject([{ runId: largeId, eventType: "run_started" }]);
      expect(wireCalls - beforeOversized).toBe(4);
      expect(calls.length).toBe(beforeParsed + 1);
      expect(await largeSnapshot()).toEqual(largeCommitted);

      const commands = clientFor("service_role").commands;
      const commandId = crypto.randomUUID();
      const commandRequest = {
        commandId, commandType: "report.issue", targetType: "report", targetId: "report-1",
        payload: { nested: [false, null, "original"] }, maxAttempts: 2,
      };
      const state = async (): Promise<unknown> => {
        const rows = await db.unsafe(`
          SELECT jsonb_build_object(
            'commands', (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM supacloud_commands.receipts c),
            'runs', (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM supacloud_workflows.runs r),
            'steps', (SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) FROM supacloud_workflows.steps s),
            'events', (SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY id)::text) FROM supacloud_workflows.events e),
            'queue', (SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY msg_id)::text) FROM pgmq.q_supacloud_internal_workflows q),
            'archive', (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY msg_id)::text) FROM pgmq.a_supacloud_internal_workflows a),
            'sequence', (SELECT last_value::text FROM pgmq.q_supacloud_internal_workflows_msg_id_seq)
          ) AS result
        `);
        const result: unknown = rows[0]?.result;
        return result;
      };
      dropNextCommand = true;
      const beforeCommand = wireCalls;
      await expect(commands.submit(commandRequest)).rejects.toMatchObject({
        code: "COMMAND_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(wireCalls - beforeCommand).toBe(1);
      expect(calls.at(-1)).toMatchObject({
        status: 200, body: { commandId, idempotent: false },
      });
      const commandState = await state();
      const command = await commands.get(commandId);
      expect(command).toMatchObject({
        commandId, workflow: { steps: [{ queueMessageId: "9007199254740995", maxAttempts: 2 }] },
      });
      const commandRows = await db`
        SELECT public.supacloud_command_get(${JSON.stringify({ commandId })}::text::jsonb) AS result
      `;
      expect(command).toEqual(commandRows[0]?.result);
      const commandReplays = await Promise.all([
        commands.submit(commandRequest), commands.submit({ ...commandRequest, maxAttempts: 100 }),
      ]);
      for (const replay of commandReplays) expect(replay).toEqual({ ...command, idempotent: true });
      expect(await state()).toEqual(commandState);
      await expect(commands.submit({ ...commandRequest, payload: { changed: true } }))
        .rejects.toMatchObject({ code: "23505" });
      for (const role of ["anon", "authenticated"] as const) {
        const denied = clientFor(role).commands;
        await expect(denied.get(commandId)).rejects.toMatchObject({ code: "42501" });
        await expect(denied.submit(commandRequest)).rejects.toMatchObject({ code: "42501" });
      }
      expect(await state()).toEqual(commandState);
      await workflows.cancel(commandId, "native command replay fixture");
      const cancelledState = await state();
      const cancelledCommand = await commands.get(commandId);
      expect(cancelledCommand).toMatchObject({ workflow: { status: "cancelled" } });
      expect(await commands.submit(commandRequest)).toEqual({ ...cancelledCommand, idempotent: true });
      expect(await state()).toEqual(cancelledState);

      const oversizedCommand = {
        ...commandRequest, commandId: crypto.randomUUID(), payload: { text: "x".repeat(600_000) },
      };
      const beforeLargeCommand = wireCalls, parsedCommands = calls.length;
      await expect(commands.submit(oversizedCommand)).rejects.toMatchObject({
        code: "COMMAND_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(wireCalls - beforeLargeCommand).toBe(1);
      expect(calls.length).toBe(parsedCommands);
      const oversizedState = await state();
      const sizeRows = await db`
        SELECT octet_length(public.supacloud_command_get(
          ${JSON.stringify({ commandId: oversizedCommand.commandId })}::text::jsonb
        )::text)::integer AS bytes
      `;
      expect(sizeRows[0]?.bytes).toBeGreaterThan(1024 * 1024);
      await expect(commands.get(oversizedCommand.commandId)).rejects.toMatchObject({
        code: "COMMAND_READ_INVALID", mutationMayHaveApplied: false,
      });
      await expect(commands.submit(oversizedCommand)).rejects.toMatchObject({
        code: "COMMAND_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
      });
      expect(wireCalls - beforeLargeCommand).toBe(3);
      expect(calls.length).toBe(parsedCommands);
      expect(await state()).toEqual(oversizedState);

      const artifacts = clientFor("service_role").artifacts;
      const parentArtifactId = crypto.randomUUID(), childArtifactId = crypto.randomUUID();
      for (const id of [parentArtifactId, childArtifactId]) {
        await db`INSERT INTO storage.objects VALUES (${crypto.randomUUID()}::uuid, 'reports', ${id}, 'v1')`;
      }
      const registration = {
        artifactId: childArtifactId, bucketId: "reports", objectPath: childArtifactId, artifactType: "report",
        sha256: "a".repeat(64), sizeBytes: "9007199254740993", mimeType: "application/octet-stream",
        retentionUntil: "2099-01-01T08:00:00.123456+08:00",
      };
      await artifacts.register({ ...registration, artifactId: parentArtifactId, objectPath: parentArtifactId });
      const link = { parentArtifactId, childArtifactId, relationType: "derived_from", metadata: { source: true } };
      const artifactState = async (): Promise<unknown> => {
        const rows = await db.unsafe(`
          SELECT jsonb_build_object(
            'artifacts', (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM supacloud_artifacts.artifacts a),
            'lineage', (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY parent_artifact_id, child_artifact_id, relation_type)::text)
              FROM supacloud_artifacts.lineage l),
            'objects', (SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY id)::text) FROM storage.objects o)
          ) AS result
        `);
        const result: unknown = rows[0]?.result;
        return result;
      };
      for (const operation of ["register", "link"] as const) {
        dropNextArtifact = operation;
        const before = wireCalls;
        await expect(operation === "register" ? artifacts.register(registration) : artifacts.link(link))
          .rejects.toMatchObject({
            code: operation === "register" ? "ARTIFACT_REGISTER_UNCONFIRMED" : "ARTIFACT_LINK_UNCONFIRMED",
            mutationMayHaveApplied: true,
          });
        expect(wireCalls - before).toBe(1);
        expect(calls.at(-1)).toMatchObject({
          status: 200, body: { artifactId: childArtifactId, idempotent: false },
        });
        const committedArtifact = await artifactState();
        const currentArtifact = await artifacts.get(childArtifactId);
        expect(currentArtifact).toMatchObject({
          sizeBytes: "9007199254740993", retentionUntil: "2099-01-01T00:00:00.123456+00:00",
        });
        const sqlArtifact = await db`
          SELECT public.supacloud_artifact_get(${JSON.stringify({ artifactId: childArtifactId })}::text::jsonb) AS result
        `;
        expect(currentArtifact).toEqual(sqlArtifact[0]?.result);
        expect(operation === "register" ? await artifacts.register(registration) : await artifacts.link(link))
          .toEqual({ ...currentArtifact, idempotent: true });
        expect(await artifactState()).toEqual(committedArtifact);
      }
      const linkedState = await artifactState();
      await expect(artifacts.link({ ...link, metadata: { source: false } })).rejects.toMatchObject({ code: "23505" });
      await expect(artifacts.link({ ...link, parentArtifactId: childArtifactId, childArtifactId: parentArtifactId }))
        .rejects.toMatchObject({ code: "23514" });
      for (const role of ["anon", "authenticated"] as const) {
        const denied = clientFor(role).artifacts;
        await expect(denied.get(childArtifactId)).rejects.toMatchObject({ code: "42501" });
        await expect(denied.register(registration)).rejects.toMatchObject({ code: "42501" });
        await expect(denied.link(link)).rejects.toMatchObject({ code: "42501" });
      }
      const updateObject = async () => { await db`UPDATE storage.objects SET version = 'v2' WHERE name = ${childArtifactId}`; };
      await expect(updateObject()).rejects.toMatchObject({ errno: "55000" });
      expect(await artifactState()).toEqual(linkedState);

      const largeArtifactId = crypto.randomUUID();
      await db`INSERT INTO storage.objects VALUES (${crypto.randomUUID()}::uuid, 'reports', ${largeArtifactId}, 'v1')`;
      const largeRegistration = {
        ...registration, artifactId: largeArtifactId, objectPath: largeArtifactId,
        metadata: { text: "\u4e2d".repeat(350_000) },
      };
      const largeLink = { ...link, relationType: "large_source", metadata: { text: "\u4e2d".repeat(350_000) } };
      for (const operation of ["register", "link"] as const) {
        const before = wireCalls, parsed = calls.length;
        const id = operation === "register" ? largeArtifactId : childArtifactId;
        const submit = () => operation === "register" ? artifacts.register(largeRegistration) : artifacts.link(largeLink);
        await expect(submit()).rejects.toMatchObject({
          code: operation === "register" ? "ARTIFACT_REGISTER_UNCONFIRMED" : "ARTIFACT_LINK_UNCONFIRMED",
          mutationMayHaveApplied: true,
        });
        expect(wireCalls - before).toBe(1);
        expect(calls.length).toBe(parsed);
        const committedArtifact = await artifactState();
        const sizes = await db`
          SELECT octet_length(public.supacloud_artifact_get(${JSON.stringify({ artifactId: id })}::text::jsonb)::text)::integer AS bytes
        `;
        expect(sizes[0]?.bytes).toBeGreaterThan(1024 * 1024);
        await expect(artifacts.get(id)).rejects.toMatchObject({
          code: "ARTIFACT_READ_INVALID", mutationMayHaveApplied: false,
        });
        await expect(submit()).rejects.toMatchObject({
          code: operation === "register" ? "ARTIFACT_REGISTER_UNCONFIRMED" : "ARTIFACT_LINK_UNCONFIRMED",
          mutationMayHaveApplied: true,
        });
        expect(wireCalls - before).toBe(3);
        expect(calls.length).toBe(parsed);
        expect(await artifactState()).toEqual(committedArtifact);
      }
      // Retire the oversized fixtures through SQL so workers only see the new lifecycle cases.
      for (const id of [largeId, oversizedCommand.commandId]) {
        await db`SELECT supacloud_workflows.cancel_run(${id}::uuid, 'oversized fixture cleanup')`;
      }
      for (const outcome of ["completed", "cancelled"] as const) {
        const request = { ...commandRequest, commandId: crypto.randomUUID() };
        await commands.submit(request);
        const claim = await workflows.claim({ workerId: "lifecycle-worker" });
        expect(claim).toMatchObject({ status: "claimed", runId: request.commandId, stepKey: "execute" });
        if (!claim || claim.status !== "claimed") throw new Error("Expected command lifecycle claim");
        const attempt = {
          stepId: claim.stepId, messageId: claim.messageId, attempt: claim.attempt, workerId: claim.workerId,
        };
        if (outcome === "completed") {
          await workflows.advance({ ...attempt, nextStepKey: "finish", nextInput: { ready: true } });
          const advanced = await commands.get(request.commandId);
          expect(advanced?.workflow).toMatchObject({ status: "running", startedAt: expect.any(String), completedAt: null });
          expect(advanced?.workflow.steps.find(step => step.stepKey === "execute"))
            .toMatchObject({ status: "completed", nextStepKey: "finish", completedAt: expect.any(String) });
          const next = await workflows.claim({ workerId: "finish-worker" });
          expect(next).toMatchObject({ status: "claimed", runId: request.commandId, stepKey: "finish" });
          if (!next || next.status !== "claimed") throw new Error("Expected finish claim");
          await workflows.complete({
            stepId: next.stepId, messageId: next.messageId, attempt: next.attempt,
            workerId: next.workerId, runOutput: { done: true },
          });
        } else {
          const delayed = { ...attempt, errorMessage: "temporary", delaySeconds: 86400 };
          await workflows.retry(delayed);
          const waiting = await commands.get(request.commandId);
          expect(waiting?.workflow).toMatchObject({
            status: "running", completedAt: null,
            steps: [{ status: "queued", claimedBy: "lifecycle-worker", attempts: 1, retryDelaySeconds: 86400 }],
          });
          await workflows.cancel(request.commandId, "stop waiting");
          const cancelled = await workflows.get(request.commandId);
          const beforeHistoricalReplay = await state();
          expect(await workflows.retry(delayed)).toEqual({ ...cancelled, idempotent: true });
          expect(await state()).toEqual(beforeHistoricalReplay);
        }
        const terminalCommand = await commands.get(request.commandId);
        expect(terminalCommand?.workflow).toMatchObject({
          status: outcome, startedAt: expect.any(String), completedAt: expect.any(String),
        });
        const raw = await db`
          SELECT public.supacloud_command_get(${JSON.stringify({ commandId: request.commandId })}::text::jsonb) AS receipt
        `;
        expect(terminalCommand).toEqual(raw[0]?.receipt);
        const beforeReplay = await state(), beforeReplayCalls = wireCalls;
        expect(await commands.submit({ ...request, maxAttempts: 100 })).toEqual({ ...terminalCommand, idempotent: true });
        expect(wireCalls - beforeReplayCalls).toBe(1);
        expect(await state()).toEqual(beforeReplay);
        expect(await workflows.claim({ workerId: "another-worker" })).toBeNull();
      }
      const orderedRequest = {
        runId: crypto.randomUUID(), workflowName: "http.start-order", workflowVersion: "1",
        firstStepKey: "first", input: { shared: true }, maxAttempts: 3,
      };
      const successorId = "00000000-0000-0000-8000-000000000000";
      await db.begin(async tx => {
        await tx`SELECT public.supacloud_workflow_start(${JSON.stringify(orderedRequest)}::text::jsonb)`;
        await tx.unsafe(`
          SELECT public.supacloud_workflow_advance(
            public.supacloud_workflow_claim('{"workerId":"order-worker"}'::jsonb)
            || '{"nextStepKey":"finish","nextInput":{"shared":true},"nextMaxAttempts":3}'::jsonb
          )
        `);
        // Fix the unclaimed successor's identity, keeping real transaction timestamps.
        await tx`
          UPDATE supacloud_workflows.steps SET id = ${successorId}::uuid
          WHERE run_id = ${orderedRequest.runId}::uuid AND step_key = 'finish'
        `;
        await tx`
          UPDATE pgmq.q_supacloud_internal_workflows q
          SET message = jsonb_set(q.message, '{step_id}', to_jsonb(${successorId}::text))
          FROM supacloud_workflows.steps s WHERE s.id = ${successorId}::uuid AND q.msg_id = s.queue_message_id
        `;
      });
      const order = await db`
        SELECT count(distinct created_at)::integer AS timestamps,
          array_agg(step_key ORDER BY created_at, id) AS keys
        FROM supacloud_workflows.steps WHERE run_id = ${orderedRequest.runId}::uuid
      `;
      expect(Array.from(order)).toEqual([{ timestamps: 1, keys: ["finish", "first"] }]);
      for (const phase of ["active", "reinstalled", "completed"]) {
        if (phase === "reinstalled") {
          const beforeInstall = await state();
          await db.begin(async tx => { await tx.unsafe(moduleSql); });
          expect(await state()).toEqual(beforeInstall);
        } else if (phase === "completed") {
          const next = await workflows.claim({ workerId: "order-finisher" });
          expect(next).toMatchObject({ status: "claimed", stepId: successorId, runId: orderedRequest.runId });
          if (!next || next.status !== "claimed") throw new Error("Expected ordered workflow successor");
          await workflows.complete({
            stepId: next.stepId, messageId: next.messageId, attempt: next.attempt, workerId: next.workerId,
          });
        }
        const current = await workflows.get(orderedRequest.runId);
        expect(current?.status).toBe(phase === "completed" ? "completed" : "running");
        const raw = await db`
          SELECT public.supacloud_workflow_get(
            ${JSON.stringify({ runId: orderedRequest.runId })}::text::jsonb
          ) AS receipt
        `;
        expect(current).toEqual(raw[0]?.receipt);
        const beforeReplay = await state(), beforeCalls = wireCalls;
        expect(await workflows.start(orderedRequest)).toEqual({ ...current, idempotent: true });
        expect(wireCalls - beforeCalls).toBe(1);
        expect(await state()).toEqual(beforeReplay);
        await expect(workflows.start({ ...orderedRequest, firstStepKey: "finish" }))
          .rejects.toMatchObject({ code: "23505" });
        expect(calls.at(-1)).toMatchObject({ status: 409, body: { code: "23505" } });
        expect(wireCalls - beforeCalls).toBe(2);
        expect(await state()).toEqual(beforeReplay);
      }
    } finally {
      try {
        if (started) await docker("rm", "--force", restName);
      } finally {
        try {
          if (connected) await docker("network", "disconnect", network, databaseName);
        } finally { await docker("network", "rm", network); }
      }
    }
  }, { image: pgImage });
}, 60_000);
