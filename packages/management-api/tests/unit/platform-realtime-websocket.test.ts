import { afterEach, expect, test } from "bun:test";
import { verifyGatewayRealtime } from "../fixtures/platform-realtime-websocket";

const OriginalWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = OriginalWebSocket; });

function socketFixture(options: { ready?: boolean; wrongTable?: boolean } = {}) {
  let topic = "";
  let socket: FakeSocket;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    closed = false;
    constructor() {
      super();
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    message(message: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
    send(text: string) {
      const message = JSON.parse(text);
      queueMicrotask(() => {
        if (message.ref === "join-1") {
          topic = message.topic;
          this.message({ topic, event: "phx_reply", ref: "join-1", payload: { status: "ok" } });
          if (options.ready !== false) {
            this.message({ topic, event: "system", payload: { extension: "postgres_changes", status: "ok" } });
            this.message({ topic, event: "system", payload: { extension: "postgres_changes", status: "ok" } });
          }
        } else if (message.ref === "broadcast-1") {
          this.message({ topic, event: "broadcast", payload: message.payload });
        } else if (message.ref === "invalid-1") {
          this.message({
            topic: message.topic, event: "phx_reply", ref: "invalid-1",
            payload: { status: "error", response: { reason: "invalid signature" } },
          });
        }
      });
    }
    close() { this.closed = true; this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  return {
    change(marker: string) {
      socket.message({ topic, event: "postgres_changes", payload: { data: {
        schema: "public", table: options.wrongTable ? "other_table" : "fixture",
        type: "INSERT", record: { marker },
      } } });
    },
    get closed() { return socket.closed; },
  };
}

const input = { hostname: "fixture.api.localhost", anonKey: "fixture", accessToken: "header.payload.c2ln", timeoutMs: 100 };

test("broadcast-only proof remains supported", async () => {
  const socket = socketFixture();
  const evidence = await verifyGatewayRealtime(input);
  expect(evidence.gatewayRealtimeSelfBroadcast).toBe(true);
  expect(evidence.gatewayRealtimeInvalidSignatureRejected).toBe(true);
  expect(evidence.gatewayRealtimePostgresChanges).toBeUndefined();
  expect(socket.closed).toBe(true);
});

test("CDC requires subscription readiness and a matching database event", async () => {
  const socket = socketFixture();
  let inserts = 0;
  const evidence = await verifyGatewayRealtime({ ...input, cdc: {
    table: "fixture", insert: async marker => {
      inserts++;
      socket.change(marker);
    },
  } });
  expect(inserts).toBe(1);
  expect(evidence.gatewayRealtimePostgresChanges).toBe(true);
  expect(socket.closed).toBe(true);
});

test("broadcast plus signature rejection cannot satisfy CDC acceptance", async () => {
  socketFixture();
  await expect(verifyGatewayRealtime({ ...input, cdc: {
    table: "fixture", insert: async () => {},
  } })).rejects.toThrow("delivery timed out");
});

test("never inserts before the subscription is ready", async () => {
  socketFixture({ ready: false });
  let inserts = 0;
  await expect(verifyGatewayRealtime({ ...input, cdc: {
    table: "fixture", insert: async () => { inserts++; },
  } })).rejects.toThrow("delivery timed out");
  expect(inserts).toBe(0);
});

test("a matching marker on another table does not pass", async () => {
  const socket = socketFixture({ wrongTable: true });
  await expect(verifyGatewayRealtime({ ...input, cdc: {
    table: "fixture", insert: async marker => { socket.change(marker); },
  } })).rejects.toThrow("Unexpected Realtime channel response");
});

test("timeout cancels and drains insertion before returning to cleanup", async () => {
  const socket = socketFixture();
  let drained = false;
  await expect(verifyGatewayRealtime({ ...input, cdc: {
    table: "fixture", insert: async (_marker, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      drained = true;
    },
  } })).rejects.toThrow("delivery timed out");
  expect(drained).toBe(true);
  expect(socket.closed).toBe(true);
});

test("a database callback failure cannot be hidden by a matching event", async () => {
  const socket = socketFixture();
  await expect(verifyGatewayRealtime({ ...input, cdc: {
    table: "fixture", insert: async marker => {
      socket.change(marker);
      await Bun.sleep(10);
      throw new Error("database insert failed");
    },
  } })).rejects.toThrow("database insert failed");
  expect(socket.closed).toBe(true);
});
