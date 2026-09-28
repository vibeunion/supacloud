import assert from "node:assert/strict";
import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";

assert.equal(process.env.SUPACLOUD_QUEUE_TEST, "1");
const ref = process.env.SUPACLOUD_TEST_PROJECT_REF;
assert.ok(ref && /^[a-z0-9]{10,32}$/.test(ref));
const base = "http://127.0.0.1:9090";
const token = process.env.MASTER_TOKEN;
assert.ok(token);
assert.ok(process.env.DATABASE_URL);
const queue = `acceptance_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidence: Record<string, boolean> = {};
let creationAttempted = false;

async function request(path: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}/v1/projects/${ref}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

const meta = new SQL(process.env.DATABASE_URL);
let projectDb: SQL | undefined;
try {
  const [project] = await meta`
    SELECT name, db_name, service_role_key FROM projects WHERE ref = ${ref} AND deleted_at IS NULL
  `;
  assert.ok(project?.db_name);
  assert.ok(project.name.startsWith("platform-app-acceptance-"));
  const metaUrl = new URL(process.env.DATABASE_URL!);
  projectDb = new SQL({
    hostname: metaUrl.hostname,
    port: Number(metaUrl.port),
    username: decodeURIComponent(metaUrl.username),
    password: decodeURIComponent(metaUrl.password),
    database: project.db_name,
  });
  const [identity] = await projectDb`SELECT current_database() AS name`;
  assert.equal(identity.name, project.db_name);
  const hostname = `${ref}.api.localhost`;
  const sdk = createClient(`https://${hostname}`, project.service_role_key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const target = new URL(request.url);
        assert.equal(target.origin, `https://${hostname}`);
        target.hostname = "127.0.0.1";
        const forwarded = new Headers(request.headers);
        forwarded.set("host", hostname);
        return fetch(target, {
          method: request.method, headers: forwarded,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
          tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(15_000),
        });
      }) as typeof fetch,
    },
  });

  try {
    creationAttempted = true;
    const createdResponse = await request("/tasks/queues", {
      method: "POST", body: JSON.stringify({ queue_name: queue }),
    });
    assert.equal(createdResponse.response.status, 201, JSON.stringify(createdResponse.body));
    evidence.queueCreated = true;

    const listed = await request("/tasks/queues");
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.some((item: { queue_name: string }) => item.queue_name === queue));
    evidence.queueListed = true;

    const payload = { kind: "single", nonce: crypto.randomUUID() };
    const sent = await sdk.schema("pgmq_public").rpc("send", {
      queue_name: queue, message: payload, sleep_seconds: 0,
    }).retry(false);
    assert.equal(sent.error, null, `Queue SDK send failed: ${sent.error?.code}`);
    assert.ok(Array.isArray(sent.data) && sent.data.length === 1 && typeof sent.data[0] === "string");
    evidence.sdkGatewaySend = true;

    const batchPayload = [
      { kind: "batch", index: 1, nonce: crypto.randomUUID() },
      { kind: "batch", index: 2, nonce: crypto.randomUUID() },
    ];
    const batch = await request(`/tasks/queues/${queue}/messages/batch`, {
      method: "POST", body: JSON.stringify({ messages: batchPayload }),
    });
    assert.equal(batch.response.status, 202, JSON.stringify(batch.body));
    assert.equal(batch.body.count, 2);
    evidence.messagesSent = true;

    const stats = await request(`/tasks/queues/${queue}/stats`);
    assert.equal(stats.response.status, 200);
    assert.ok(Number(stats.body.queue_length) >= 3);
    evidence.statsRead = true;

    const received = await request(`/tasks/queues/${queue}/messages/receive`, {
      method: "POST", body: JSON.stringify({ count: 3, visibilityTimeoutSec: 30 }),
    });
    assert.equal(received.response.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.length, 3);
    const messages = received.body.map((item: { message: unknown }) => item.message);
    assert.ok(messages.some((item: any) => item.kind === "single" && item.nonce === payload.nonce));
    assert.deepEqual(messages.filter((item: any) => item.kind === "batch").map((item: any) => item.index).sort(), [1, 2]);
    evidence.messagesReceived = true;

    const leased = await request(`/tasks/queues/${queue}/messages/receive`, {
      method: "POST", body: JSON.stringify({ count: 1, visibilityTimeoutSec: 30 }),
    });
    assert.equal(leased.response.status, 204);
    evidence.visibilityLease = true;

    for (const item of received.body) {
      const ack = await sdk.schema("pgmq_public").rpc("archive", {
        queue_name: queue, message_id: item.msg_id,
      }).retry(false);
      assert.equal(ack.error, null, `Queue SDK archive failed: ${ack.error?.code}`);
      assert.equal(ack.data, true);
    }
    evidence.messagesAcknowledged = true;

    const archived = await request(`/tasks/queues/${queue}/messages?archived=true`);
    assert.equal(archived.response.status, 200);
    assert.deepEqual(archived.body.map((item: { msg_id: string }) => item.msg_id).sort(),
      received.body.map((item: { msg_id: string }) => item.msg_id).sort());
    evidence.archiveReadback = true;
    const empty = await request(`/tasks/queues/${queue}/messages/receive`, {
      method: "POST", body: JSON.stringify({ count: 1, visibilityTimeoutSec: 1 }),
    });
    assert.equal(empty.response.status, 204, JSON.stringify(empty.body));
    evidence.emptyReadConfirmed = true;
  } finally {
    if (creationAttempted) {
      const [existing] = await projectDb`
        SELECT count(*)::int AS count FROM pgmq.list_queues() WHERE queue_name = ${queue}
      `;
      if (Number(existing.count) > 0) {
        const dropped = await request(`/tasks/queues/${queue}`, { method: "DELETE" });
        assert.ok([204, 404].includes(dropped.response.status), JSON.stringify(dropped.body));
      }
    }
    const [remaining] = await projectDb`
      SELECT count(*)::int AS count
      FROM pgmq.list_queues()
      WHERE queue_name = ${queue}
    `;
    assert.equal(Number(remaining.count), 0);
    evidence.cleanup = true;
  }
  console.log(JSON.stringify(evidence));
} finally {
  await projectDb?.close();
  await meta.close();
}
