import { describe, expect, test } from "bun:test";
import { parseProjectLogsResponse, readProjectLogsResponse } from "./project-logs";

const entry = {
  id: "log-1", timestamp: "1970-01-01T00:00:00.000Z", event_message: "",
  severity: "info", service: "auth", metadata: { project_ref: "a" },
};
const receipt = {
  backend: "victorialogs", project_ref: "a", live_stream: true, sources: ["auth"],
  result: [entry], pagination: { limit: 200, offset: 0, total: 1 },
};
const expected = { projectRef: "a", limit: 200, offset: 0 };

describe("project log response decoding", () => {
  test("preserves empty messages and epoch timestamps while copying only consumed fields", () => {
    const parsed = parseProjectLogsResponse(receipt, expected);
    expect(parsed.entries).toEqual([{
      id: "log-1", timestamp: "1970-01-01T00:00:00.000Z", event_message: "", severity: "info", service: "auth",
    }]);
    const first = parsed.entries[0];
    if (!first) throw new Error("Missing fixture log");
    first.id = "changed";
    parsed.sources.push("other");
    expect(entry.id).toBe("log-1");
    expect(receipt.sources).toEqual(["auth"]);
  });

  test("rejects malformed envelopes, cross-project identities and inconsistent pagination", () => {
    for (const invalid of [null, [], {}, { ...receipt, backend: "legacy" },
      { ...receipt, project_ref: "b" }, { ...receipt, live_stream: "true" },
      { ...receipt, sources: ["auth", "auth"] }, { ...receipt, sources: [1] },
      { ...receipt, sources: new Array(1) }, { ...receipt, result: {} },
      { ...receipt, pagination: { ...receipt.pagination, total: "1" } },
      { ...receipt, pagination: { ...receipt.pagination, total: 2 } },
      { ...receipt, pagination: { ...receipt.pagination, offset: 1 } },
      { ...receipt, pagination: { ...receipt.pagination, limit: 199 } }]) {
      expect(() => parseProjectLogsResponse(invalid, expected)).toThrow("Invalid project logs response");
    }
    expect(() => parseProjectLogsResponse({
      ...receipt, result: [], pagination: { ...receipt.pagination, total: 0 }, project_ref: "b",
    }, expected)).toThrow();
  });

  test("rejects the entire result for invalid rows, duplicate IDs or excessive rows", () => {
    for (const invalid of [null, [], { ...entry, timestamp: 0 }, { ...entry, timestamp: "bad" },
      { ...entry, timestamp: "1970-01-01" }, { ...entry, event_message: {} },
      { ...entry, severity: "fatal" }, { ...entry, service: "x".repeat(129) },
      { ...entry, metadata: { project_ref: "b" } }, { ...entry, id: "" }]) {
      expect(() => parseProjectLogsResponse({
        ...receipt, result: [entry, invalid], pagination: { ...receipt.pagination, total: 2 },
      }, expected)).toThrow();
    }
    expect(() => parseProjectLogsResponse({
      ...receipt, result: [entry, entry], pagination: { ...receipt.pagination, total: 2 },
    }, expected)).toThrow();
    expect(() => parseProjectLogsResponse({
      ...receipt, result: new Array(1),
    }, expected)).toThrow();
    expect(() => parseProjectLogsResponse({
      ...receipt, result: [entry, { ...entry, id: "log-2" }], pagination: { limit: 1, offset: 0, total: 2 },
    }, { ...expected, limit: 1 })).toThrow();
  });

  test("reads validated HTTP bytes and rejects malformed UTF-8 or JSON", async () => {
    const abort = new AbortController();
    expect(await readProjectLogsResponse(Response.json(receipt), expected, abort.signal))
      .toEqual(parseProjectLogsResponse(receipt, expected));
    for (const response of [new Response(new Uint8Array([0xff])), new Response('{"result":'),
      new Response(null), new Response("private-error", { status: 503 })]) {
      await expect(readProjectLogsResponse(response, expected, abort.signal)).rejects.toThrow("Invalid project logs response");
    }
  });

  test("bounds actual response size, cancels oversized bodies and releases readers", async () => {
    for (const declared of [false, true]) {
      let cancelled = 0;
      let pulled = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled++; },
      });
      const response = new Response(source, declared ? { headers: { "content-length": String(9 * 1024 * 1024) } } : {});
      await expect(readProjectLogsResponse(response, expected, new AbortController().signal)).rejects.toThrow();
      expect(cancelled).toBe(1);
      expect(pulled).toBeLessThanOrEqual(10);
      expect(source.locked).toBe(false);
    }
  });

  test("cancellation settles a stalled body without returning a partial receipt", async () => {
    const abort = new AbortController();
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const reading = readProjectLogsResponse(new Response(source), expected, abort.signal);
    abort.abort();
    await expect(reading).rejects.toThrow();
    expect(cancelled).toBe(1);
    expect(source.locked).toBe(false);
  });
});
