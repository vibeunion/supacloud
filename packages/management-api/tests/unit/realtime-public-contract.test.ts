import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PUBLIC_REALTIME_CLIENT_PATH,
  PUBLIC_REALTIME_SOCKET_OWNER,
  publicRealtimeUpstream,
} from "../../src/services/realtime-public-contract";

const root = join(import.meta.dir, "../..");

test("the published socket is an Elixir proxy with no LISTEN/NOTIFY failover", () => {
  expect(PUBLIC_REALTIME_CLIENT_PATH).toBe("/realtime/v1/websocket");
  expect(PUBLIC_REALTIME_SOCKET_OWNER).toBe("elixir-realtime");
  expect(publicRealtimeUpstream(
    "http://127.0.0.1:4000",
    "/realtime/v1/websocket",
    "?apikey=k&vsn=2.0.0",
  )).toBe("ws://127.0.0.1:4000/socket/websocket?apikey=k&vsn=2.0.0");
  expect(publicRealtimeUpstream(
    "https://realtime.internal",
    "/realtime/v1/api/broadcast",
    "",
  )).toBe("wss://realtime.internal/socket/api/broadcast");
  expect(() => publicRealtimeUpstream("http://127.0.0.1:4000", "/ws/realtime/v1/websocket", "")).toThrow("/realtime/v1");
  expect(() => publicRealtimeUpstream("ws://127.0.0.1:4000", "/realtime/v1/websocket", "")).toThrow("http(s)");
});

test("published and legacy realtime sockets do not subscribe to the Bun listener", () => {
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  const ws = readFileSync(join(root, "src/routes/ws.ts"), "utf8");
  expect(index).toContain("publicRealtimeUpstream");
  expect(ws).toContain("publicRealtimeUpstream");
  expect(index).not.toContain("realtime-bun");
  expect(ws).not.toContain("realtime-bun");
  expect(ws).not.toContain("subscribeTenant");
});
