import { describe, expect, test } from "bun:test";
import {
  BackgroundDispatchOutcomeUnknownError, dispatchBackgroundFunction, parseBackgroundDispatchResult,
} from "../../src/services/background-runtime-dispatcher";

const receipt = {
  status: 201, headers: { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] }, bodyText: "written",
  logs: [{ timestamp: "2026-09-09T00:00:00.000Z", stream: "stdout", level: "info", message: "Authorization: Bearer synthetic" }],
};
const invocation = () => ({
  projectRef: "proj_1", functionSlug: "fn",
  request: new Request("http://localhost/internal/background/proj_1/fn", { method: "POST", body: "{}" }),
});
const response = (value: unknown) => Response.json(value, { headers: { "x-supacloud-background-envelope": "true" } });

describe("background runtime response boundary", () => {
  test("validates the complete receipt before delivering copied, redacted logs", async () => {
    const delivered: string[] = [];
    const result = await dispatchBackgroundFunction({
      ...invocation(), fetcher: async () => response(receipt),
      onLog(entry) { delivered.push(entry.message); entry.message = "observer mutation"; },
    });
    expect(result.status).toBe(201);
    expect(result.bodyText).toBe("written");
    expect(result.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(delivered).toEqual(["Authorization=[REDACTED]"]);
    expect(result.logs[0]?.message).toBe("Authorization=[REDACTED]");
  });

  test("malformed receipts are unknown outcomes, not fabricated success", async () => {
    for (const invalid of [null, [], {}, { ...receipt, status: "200" }, { ...receipt, status: 200.5 },
      { ...receipt, status: 199 }, { ...receipt, status: 600 }, { ...receipt, bodyText: {} },
      { ...receipt, headers: { "content-type": {} } }, { ...receipt, headers: { "content-type": "ok\nforged: yes" } },
      { ...receipt, headers: { "Content-Type": "text/plain", "content-type": "text/html" } },
      { ...receipt, headers: { "x-value": [1] } }, { ...receipt, headers: { "x-value": [] } },
      { ...receipt, logs: [receipt.logs[0], { timestamp: true }] }, { ...receipt, logs: new Array(1) },
      { ...receipt, logs: Array.from({ length: 201 }, () => receipt.logs[0]) }]) {
      const logs: string[] = [];
      await expect(dispatchBackgroundFunction({
        ...invocation(), fetcher: async () => response(invalid), onLog(entry) { logs.push(entry.message); },
      })).rejects.toBeInstanceOf(BackgroundDispatchOutcomeUnknownError);
      expect(logs).toEqual([]);
    }
    expect(() => parseBackgroundDispatchResult({ ...receipt, logs: new Array(1) })).toThrow();
  });

  test("non-envelope, truncated and invalid UTF-8 responses never retry or reread the body", async () => {
    for (const makeResponse of [
      () => new Response("not JSON"),
      () => response({}),
      () => new Response('{"status":200', { headers: { "x-supacloud-background-envelope": "true" } }),
      () => new Response(new Uint8Array([0xff]), { headers: { "x-supacloud-background-envelope": "true" } }),
      () => Response.json(receipt, { status: 503, headers: { "x-supacloud-background-envelope": "true" } }),
    ]) {
      let requests = 0;
      await expect(dispatchBackgroundFunction({
        ...invocation(), fetcher: async () => { requests++; return makeResponse(); },
      })).rejects.toThrow("outcome is unknown");
      expect(requests).toBe(1);
    }
  });

  test("bounds response bytes and cancels a stalled stream at its deadline", async () => {
    for (const oversized of [false, true]) {
      let cancelled = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) { if (oversized) controller.enqueue(new Uint8Array(9 * 1024 * 1024)); },
        cancel() { cancelled++; },
      });
      await expect(dispatchBackgroundFunction({
        ...invocation(), timeoutMs: 20,
        fetcher: async () => new Response(source, { headers: { "x-supacloud-background-envelope": "true" } }),
      })).rejects.toThrow("outcome is unknown");
      expect(cancelled).toBe(1);
      expect(source.locked).toBe(false);
    }
  });

  test("callback failures cannot change successful results and invalid timeouts do not send", async () => {
    const result = await dispatchBackgroundFunction({
      ...invocation(), fetcher: async () => response(receipt), onLog() { throw new Error("observer failed"); },
    });
    expect(result.status).toBe(201);
    let calls = 0;
    for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 1_830_001]) {
      await expect(dispatchBackgroundFunction({
        ...invocation(), timeoutMs, fetcher: async () => { calls++; return response(receipt); },
      })).rejects.toThrow("Invalid background dispatch timeout");
    }
    expect(calls).toBe(0);
  });

  test("a real HTTP side effect with an invalid receipt is sent once and is not reported as success", async () => {
    let writes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        writes++;
        return new Response('{"status":201,', { headers: { "x-supacloud-background-envelope": "true" } });
      },
    });
    try {
      await expect(dispatchBackgroundFunction({
        ...invocation(),
        request: new Request(`http://127.0.0.1:${server.port}/internal/background/proj_1/fn`, { method: "POST", body: "{}" }),
      })).rejects.toThrow("outcome is unknown");
      expect(writes).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
});
