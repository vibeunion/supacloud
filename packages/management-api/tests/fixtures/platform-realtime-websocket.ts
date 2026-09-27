import assert from "node:assert/strict";
import type { WebSocketOptions } from "bun";

export async function verifyGatewayRealtime(input: {
  hostname: string; anonKey: string; accessToken: string;
  cdc?: { table: string; insert: (marker: string, signal: AbortSignal) => Promise<void> };
  timeoutMs?: number;
}): Promise<Record<string, boolean>> {
  // lib.dom's constructor omits Bun's supported TLS/header options.
  const BunWebSocket = WebSocket as typeof WebSocket & {
    new(url: string, options: WebSocketOptions): WebSocket;
  };
  const topic = `realtime:acceptance-${crypto.randomUUID()}`;
  const invalidTopic = `${topic}-invalid`;
  const marker = crypto.randomUUID();
  const tokenParts = input.accessToken.split(".");
  assert.equal(tokenParts.length, 3);
  const signature = Buffer.from(tokenParts[2]!, "base64url");
  assert.ok(signature.length > 0);
  signature[0] = signature[0]! ^ 1;
  const invalidToken = `${tokenParts[0]}.${tokenParts[1]}.${signature.toString("base64url")}`;
  const ws = new BunWebSocket(
    `wss://127.0.0.1/realtime/v1/websocket?apikey=${encodeURIComponent(input.anonKey)}&vsn=1.0.0`,
    { headers: { host: input.hostname }, tls: { rejectUnauthorized: false } },
  );
  let joined = false;
  let broadcast = false;
  let postgresChange = false;
  let inserted = false;
  let insertComplete = false;
  let rejectedSignature = false;
  const controller = new AbortController();
  let insertion: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", ref: crypto.randomUUID(), payload: {} }));
    }
  }, 15_000);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(
        `Realtime gateway delivery timed out (joined=${joined}, broadcast=${broadcast}, inserted=${inserted}, change=${postgresChange}, rejected=${rejectedSignature})`,
      )), input.timeoutMs ?? 120_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      const complete = () => {
        if (broadcast && rejectedSignature && (!input.cdc || (postgresChange && insertComplete))) {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.addEventListener("error", () => fail(new Error("Realtime gateway WebSocket failed")));
      ws.addEventListener("close", () => fail(new Error("Realtime closed before delivery proof")));
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          topic, event: "phx_join", ref: "join-1",
          payload: {
            config: {
              broadcast: { self: true, ack: true }, presence: { key: "" },
              postgres_changes: input.cdc ? [{ event: "INSERT", schema: "public", table: input.cdc.table }] : [],
            },
            access_token: input.accessToken,
          },
        }));
      });
      ws.addEventListener("message", (event) => {
        try {
          assert.equal(typeof event.data, "string");
          const message = JSON.parse(event.data);
          if (message.topic === invalidTopic && message.event === "phx_reply" && message.ref === "invalid-1") {
            assert.ok(broadcast);
            assert.equal(message.payload.status, "error", "Invalid OIDC signature was accepted");
            assert.match(String(message.payload.response?.reason), /jwt|token|signature/i);
            rejectedSignature = true;
            complete();
            return;
          }
          if (message.topic !== topic) return;
          if (message.event === "phx_reply" && message.ref === "join-1") {
            assert.equal(message.payload.status, "ok", "OIDC user channel join rejected");
            joined = true;
            ws.send(JSON.stringify({
              topic, event: "broadcast", ref: "broadcast-1",
              payload: { type: "broadcast", event: "acceptance", payload: { marker } },
            }));
          }
          // Join acknowledgment precedes the CDC subscription being ready.
          if (input.cdc && message.event === "system"
            && message.payload?.extension === "postgres_changes") {
            assert.equal(message.payload.status, "ok", "Postgres Changes subscription failed");
            if (!inserted) {
              inserted = true;
              insertion = input.cdc.insert(marker, controller.signal);
              void insertion.then(() => {
                insertComplete = true;
                complete();
              }, error => fail(error instanceof Error ? error : new Error(String(error))));
            }
          }
          if (message.event === "broadcast" && message.payload?.event === "acceptance") {
            assert.ok(joined);
            assert.equal(message.payload.payload.marker, marker);
            broadcast = true;
            ws.send(JSON.stringify({
              topic: invalidTopic, event: "phx_join", ref: "invalid-1",
              payload: { config: { broadcast: { self: true }, postgres_changes: [] }, access_token: invalidToken },
            }));
          }
          if (message.event === "postgres_changes"
            && message.payload?.data?.record?.marker === marker) {
            assert.equal(message.payload.data.schema, "public");
            assert.equal(message.payload.data.table, input.cdc?.table);
            assert.equal(message.payload.data.type, "INSERT");
            postgresChange = true;
            complete();
          }
        } catch {
          fail(new Error("Unexpected Realtime channel response"));
        }
      });
    });
    return {
      gatewayRealtimeOidcJoin: true, gatewayRealtimeSelfBroadcast: true,
      ...(input.cdc ? { gatewayRealtimePostgresChanges: postgresChange } : {}),
      gatewayRealtimeInvalidSignatureRejected: true,
    };
  } finally {
    controller.abort();
    clearInterval(heartbeat);
    ws.close();
    // Do not let a timed-out insertion race the caller's table/pool cleanup.
    await insertion?.catch(() => undefined);
  }
}
