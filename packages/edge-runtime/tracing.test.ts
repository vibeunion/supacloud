import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  createFunctionTrace, createTracedFetch, parseTraceparent, runFunctionTrace,
  traceHeaders, traceSampleRate,
} from "./tracing";

const parent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
afterEach(() => mock.restore());

test("only valid version-00 nonzero identifiers are accepted", () => {
  expect(parseTraceparent(parent)?.sampled).toBe(true);
  for (const value of [null, "", parent.toUpperCase(), parent.replace("00-", "ff-"),
    parent.replace("0123456789abcdef0123456789abcdef", "0".repeat(32)),
    parent.replace("-0123456789abcdef-", `-${"0".repeat(16)}-`), parent + "-extra"]) {
    expect(parseTraceparent(value)).toBeNull();
  }
  expect(traceSampleRate()).toBe(0.1);
  for (const value of ["", "bad", "-1", "2", "Infinity"]) expect(traceSampleRate(value)).toBe(0);
});

test("scoped concurrent fetches preserve headers but never borrow tenant traces", async () => {
  const logs = spyOn(console, "info").mockImplementation(() => {});
  const seen: Headers[] = [];
  const fetcher = createTracedFetch((async (_input, init) => {
    await Promise.resolve();
    seen.push(new Headers(init?.headers));
    return new Response("ok");
  }) as typeof fetch);
  const contexts = ["tenant_a", "tenant_b"].map((project, index) =>
    createFunctionTrace(project, new Headers({
      traceparent: index ? parent.replace("0123456789abcdef0123456789abcdef", "1".repeat(32)) : parent,
    }), 1));
  await Promise.all(contexts.map((trace) => runFunctionTrace(trace, async () => {
    await Promise.resolve();
    return fetcher(new Request("https://example.test/private?token=secret", {
      headers: { authorization: "Bearer private", baggage: "token=secret", tracestate: "private", "x-test": trace.projectRef },
    }));
  })));
  for (const trace of contexts) {
    const headers = seen.find((headers) => headers.get("x-test") === trace.projectRef)!;
    expect(parseTraceparent(headers.get("traceparent"))?.traceId).toBe(trace.traceId);
    expect(headers.get("authorization")).toBe("Bearer private");
    expect(headers.has("baggage")).toBe(false);
    expect(headers.has("tracestate")).toBe(false);
  }
  const serialized = JSON.stringify(logs.mock.calls);
  expect(serialized).not.toContain("private");
  expect(serialized).not.toContain("secret");
  expect(logs.mock.calls.length).toBe(4);
});

test("closed async scopes no longer attach request identity", async () => {
  spyOn(console, "info").mockImplementation(() => {});
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let delayed!: Promise<Response>;
  let seen: Headers | undefined;
  const fetcher = createTracedFetch((async (_input, init) => {
    seen = new Headers(init?.headers);
    return new Response("ok");
  }) as typeof fetch);
  await runFunctionTrace(createFunctionTrace("tenant_a", new Headers({ traceparent: parent }), 1), async () => {
    delayed = ready.then(() => fetcher("https://example.test/"));
  });
  release();
  await delayed;
  expect(seen!.has("traceparent")).toBe(false);
});

test("unsampled parents propagate without producing spans and span volume is bounded", async () => {
  const logs = spyOn(console, "info").mockImplementation(() => {});
  const fetcher = createTracedFetch((async () => new Response("ok")) as typeof fetch);
  const unsampled = createFunctionTrace("tenant_a", new Headers({ traceparent: parent.slice(0, -2) + "00" }), 1);
  await runFunctionTrace(unsampled, () => fetcher("https://example.test/"));
  expect(logs).not.toHaveBeenCalled();
  await runFunctionTrace(createFunctionTrace("tenant_a", new Headers({ traceparent: parent }), 1), async () => {
    for (let index = 0; index < 100; index++) await fetcher("https://example.test/");
  });
  expect(logs.mock.calls.length).toBe(65);
});

test("failed fetch emits only approved metadata and preserves the original error", async () => {
  const logs = spyOn(console, "info").mockImplementation(() => {});
  const failure = new Error("token=private");
  const fetcher = createTracedFetch((async () => { throw failure; }) as unknown as typeof fetch);
  const trace = createFunctionTrace("tenant_a", new Headers({ traceparent: parent }), 1);
  await expect(runFunctionTrace(trace, () => fetcher("https://example.test/"))).rejects.toBe(failure);
  expect(JSON.stringify(logs.mock.calls)).not.toContain("private");
  expect(JSON.parse(String(logs.mock.calls[0]![0])).status).toBe(500);
  expect(parseTraceparent(traceHeaders(trace).get("traceparent"))?.spanId).toBe(trace.spanId);
});
