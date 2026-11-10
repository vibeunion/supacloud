import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) files.push(path);
  }
  return files;
}

function importsListenHelper(source: string): boolean {
  return /from\s+["'][^"']*(?:internal\/realtime-listen|realtime-bun|realtime-proxy-session)["']/.test(source);
}

test("published routes and services do not compose the internal LISTEN/NOTIFY helper", () => {
  const offenders: string[] = [];
  for (const file of [join(root, "src/index.ts"), ...sourceFiles(join(root, "src/routes")), ...sourceFiles(join(root, "src/services"))]) {
    if (importsListenHelper(readFileSync(file, "utf8"))) offenders.push(file.slice(root.length + 1));
  }
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  const ws = readFileSync(join(root, "src/routes/ws.ts"), "utf8");
  expect(index).toContain("publicRealtimeUpstream");
  expect(ws).toContain("publicRealtimeUpstream");
  expect(offenders).toEqual([]);
});
