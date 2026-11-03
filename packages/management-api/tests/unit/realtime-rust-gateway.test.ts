import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type Subprocess } from "bun";

const repoRoot = join(import.meta.dir, "../../../..");
const TEST_PORT = 9890;
const CONTROL_TOKEN = "test-realtime-control-token";

function controlFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${CONTROL_TOKEN}`);
  return fetch(url, { ...init, headers });
}
let proc: Subprocess | null = null;

const binaryPath = join(repoRoot, "dist/supacloud-realtime-gateway");
const binaryAvailable = existsSync(binaryPath);

beforeAll(async () => {
  if (!binaryAvailable) return;
  proc = spawn({
    cmd: [binaryPath],
    env: {
      ...process.env,
      REALTIME_BIND_HOST: "127.0.0.1",
      REALTIME_PORT: String(TEST_PORT),
      API_JWT_SECRET: "test-secret-for-realtime",
      REALTIME_CONTROL_TOKEN: CONTROL_TOKEN,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const start = Date.now();
  let healthy = false;
  while (Date.now() - start < 10000) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/healthcheck`, {
        signal: AbortSignal.timeout(300),
      });
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      await Bun.sleep(50);
    }
  }
  if (!healthy) {
    proc.kill();
    throw new Error("supacloud-realtime-gateway failed to start in test harness");
  }
});

afterAll(() => {
  if (proc) proc.kill();
});

describe.skipIf(!binaryAvailable)("Native Rust Realtime Gateway (crates/realtime-gateway)", () => {
  test("healthcheck returns healthy status and engine metadata", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/healthcheck`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; engine: string };
    expect(body.status).toBe("ok");
    expect(body.engine).toBe("supacloud-realtime-gateway/rust");
  });

  test("manages tenants via Management API compatibility endpoints", async () => {
    // 1. Register tenant
    const registerRes = await controlFetch(`http://127.0.0.1:${TEST_PORT}/api/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "proj_demo",
        external_id: "demo-external",
        jwt_secret: "demo_jwt_secret",
        db_host: "127.0.0.1",
        db_port: 5432,
        db_name: "db_demo",
        db_user: "postgres",
        db_password: "password",
      }),
    });
    expect(registerRes.status).toBe(201);

    // 2. Query tenant
    const getRes = await controlFetch(`http://127.0.0.1:${TEST_PORT}/api/tenants/proj_demo`);
    expect(getRes.status).toBe(200);
    const tenant = (await getRes.json()) as { id: string; jwt_secret: string };
    expect(tenant.id).toBe("proj_demo");
    expect(tenant.jwt_secret).toBe("demo_jwt_secret");

    // 3. Delete tenant
    const delRes = await controlFetch(`http://127.0.0.1:${TEST_PORT}/api/tenants/proj_demo`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    const getAfterDel = await controlFetch(`http://127.0.0.1:${TEST_PORT}/api/tenants/proj_demo`);
    expect(getAfterDel.status).toBe(404);
  });

  test("handles Phoenix V2 heartbeat, broadcast, presence, and CDC changes", async () => {
    // Register project for WebSocket test
    await controlFetch(`http://127.0.0.1:${TEST_PORT}/api/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "test-project",
        jwt_secret: "test-secret-for-realtime",
        db_host: "127.0.0.1",
        db_port: 5432,
        db_name: "test_db",
        db_user: "postgres",
        db_password: "pw",
      }),
    });

    const wsUrl = `ws://127.0.0.1:${TEST_PORT}/socket/websocket?apikey=test-key&ref=test-project&vsn=2.0.0`;
    const ws = new WebSocket(wsUrl);

    const incomingMessages: any[] = [];
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        incomingMessages.push(parsed);
      } catch {}
    };

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    // 1. Heartbeat
    ws.send(JSON.stringify([null, "hb_1", "phoenix", "heartbeat", {}]));
    await waitForMessage((m) => m[3] === "phx_reply" && m[1] === "hb_1");
    const hbReply = incomingMessages.find((m) => m[1] === "hb_1");
    expect(hbReply[4].status).toBe("ok");

    // 2. Join channel with broadcast (self=true, ack=true) & presence & postgres_changes
    ws.send(
      JSON.stringify([
        "1",
        "join_1",
        "realtime:chat_room",
        "phx_join",
        {
          config: {
            broadcast: { ack: true, self: true },
            presence: { key: "user_alice" },
            postgres_changes: [
              {
                id: "sub_high_prio",
                event: "INSERT",
                schema: "public",
                table: "todos",
                filter: "priority=eq.high",
              },
            ],
          },
        },
      ])
    );
    await waitForMessage((m) => m[3] === "phx_reply" && m[1] === "join_1");
    const joinReply = incomingMessages.find((m) => m[1] === "join_1");
    expect(joinReply[4].status).toBe("ok");
    expect(joinReply[4].response.postgres_changes).toBeDefined();

    // 3. Broadcast
    ws.send(
      JSON.stringify([
        "1",
        "bcast_1",
        "realtime:chat_room",
        "broadcast",
        {
          type: "broadcast",
          event: "message",
          payload: { text: "hello from rust!" },
        },
      ])
    );
    // Since self: true, should receive broadcast and phx_reply
    await waitForMessage((m) => m[3] === "broadcast" && m[2] === "realtime:chat_room");
    const bcastMsg = incomingMessages.find(
      (m) => m[3] === "broadcast" && m[2] === "realtime:chat_room"
    );
    expect(bcastMsg[4].payload.text).toBe("hello from rust!");

    // 4. Presence track
    ws.send(
      JSON.stringify([
        "1",
        "pres_1",
        "realtime:chat_room",
        "presence",
        {
          type: "presence",
          event: "track",
          payload: { online_at: "2026-11-03T09:00:00Z" },
        },
      ])
    );
    await waitForMessage((m) => m[3] === "presence_diff" && m[2] === "realtime:chat_room");
    const presDiff = incomingMessages.find(
      (m) => m[3] === "presence_diff" && m[2] === "realtime:chat_room"
    );
    expect(presDiff[4].joins).toBeDefined();

    // 5. CDC event dispatch
    // Ingest low-priority change (should NOT trigger subscription)
    await controlFetch(`http://127.0.0.1:${TEST_PORT}/api/tenants/test-project/cdc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "public",
        table: "todos",
        type: "INSERT",
        record: { id: 101, title: "Low prio task", priority: "low" },
      }),
    });
    await Bun.sleep(100);
    const nonMatch = incomingMessages.find(
      (m) => m[3] === "postgres_changes" && m[4]?.data?.record?.id === 101
    );
    expect(nonMatch).toBeUndefined();

    // Ingest high-priority change (should MATCH filter priority=eq.high)
    await controlFetch(`http://127.0.0.1:${TEST_PORT}/api/tenants/test-project/cdc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "public",
        table: "todos",
        type: "INSERT",
        record: { id: 102, title: "Critical fix", priority: "high" },
      }),
    });
    await waitForMessage(
      (m) => m[3] === "postgres_changes" && m[4]?.data?.record?.id === 102
    );
    const cdcMsg = incomingMessages.find(
      (m) => m[3] === "postgres_changes" && m[4]?.data?.record?.id === 102
    );
    expect(cdcMsg).toBeDefined();
    expect(cdcMsg[4].data.record.title).toBe("Critical fix");
    expect(cdcMsg[4].ids).toContain("sub_high_prio");

    // 6. Leave channel
    ws.send(JSON.stringify(["1", "leave_1", "realtime:chat_room", "phx_leave", {}]));
    await waitForMessage((m) => m[3] === "phx_reply" && m[1] === "leave_1");
    const leaveReply = incomingMessages.find((m) => m[1] === "leave_1");
    expect(leaveReply[4].status).toBe("ok");

    ws.close();

    async function waitForMessage(predicate: (m: any) => boolean, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (incomingMessages.some(predicate)) return;
        await Bun.sleep(20);
      }
      throw new Error(`Timed out waiting for message matching condition`);
    }
  });
});
