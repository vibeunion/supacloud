import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  RealtimeProxySession, realtimeProjectConnections, MAX_CONNECTIONS_PER_PROJECT,
  REALTIME_DEADLINES,
  type RealtimeProxyDependencies, type RealtimeUpstreamCallbacks,
} from "../../src/services/realtime-proxy-session";
import { parsePhoenixMessage, isPhoenixBroadcastFrame, type PhoenixMessage } from "../../src/utils/phoenix-message";
import type { ChangeEvent, PostgresChangeConfig } from "../../src/utils/realtime-change";

const sessions: RealtimeProxySession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });
const changes: PostgresChangeConfig[] = [{ event: "*", schema: "public", table: "orders" }];
const change: ChangeEvent = {
  ids: ["server-id"],
  data: { type: "INSERT", schema: "public", table: "orders", record: { id: 1 }, columns: [],
    commit_timestamp: "2026-09-08T00:00:00Z", errors: [] },
};
const join = (topic = "realtime:orders", ref = "1"): PhoenixMessage => ({
  topic, ref, join_ref: ref, event: "phx_join", payload: { config: { postgres_changes: changes }, access_token: "initial" },
});
const ack = (message: PhoenixMessage): PhoenixMessage => ({
  ...message, event: "phx_reply", payload: { status: "ok", response: { postgres_changes: [{ ...changes[0], id: "server-id" }] } },
});
async function settled() { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); }
function clock() {
  let now = 0;
  const jobs = new Map<() => void, number>();
  return {
    schedule(callback: () => void, milliseconds: number) {
      jobs.set(callback, now + milliseconds);
      return () => { jobs.delete(callback); };
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [callback, due] of [...jobs]) {
        if (due <= now && jobs.delete(callback)) callback();
      }
    },
    pending: () => jobs.size,
  };
}
function broadcastFrame(payloadBytes = 0): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(9 + payloadBytes);
  frame.set([3, 0, 0, 1, 1, 0, 0, 116, 101]);
  return frame;
}

function fixture(
  backendOverrides: Partial<RealtimeProxyDependencies["backend"]> = {},
  overrides: Partial<RealtimeProxyDependencies> = {},
) {
  let callbacks: RealtimeUpstreamCallbacks | undefined;
  let counter = 0;
  const sent: unknown[] = [];
  const forwarded: unknown[] = [];
  const closed: Array<{ code: number | undefined; reason: string | undefined }> = [];
  const removed: string[] = [];
  const mappings: Array<{ project: string; state: string; mappings: unknown }> = [];
  const tokens: string[] = [];
  const events = new EventEmitter<Record<`change:${string}`, [ChangeEvent]>>();
  const backend: RealtimeProxyDependencies["backend"] = {
    events,
    subscribeTenant: async () => `native-${++counter}`,
    unsubscribeSubscription: (_project, id) => { removed.push(id); },
    registerSubscriptionIds: (project, state, value) => { mappings.push({ project, state, mappings: value }); return true; },
    updateSubscriptionToken: async (_project, _state, token) => { tokens.push(token); return true; },
    ...backendOverrides,
  };
  const upstream: { readyState: number; send: (value: unknown) => number; close: () => void } =
    { readyState: WebSocket.OPEN, send: (value) => forwarded.push(value), close: () => {} };
  const dependencies: RealtimeProxyDependencies = {
    backend,
    resolveKey: async () => ({ ref: "fixture", kind: "anon", role: "anon", upstreamKey: "translated" }),
    connect: (_project, _key, _version, handlers) => { callbacks = handlers; return upstream; },
    ...overrides,
  };
  const session = new RealtimeProxySession({
    send: (data) => sent.push(data),
    close: (code, reason) => closed.push({ code, reason }),
  }, dependencies);
  sessions.push(session);
  return {
    session, backend, events, upstream, sent, forwarded, closed, removed, mappings, tokens,
    open: (suffix = "") => session.open(new Request(`http://localhost/ws/realtime/v1/websocket?apikey=fixture${suffix}`)),
    receive: async (value: unknown) => { callbacks?.message(value); await settled(); },
    upstreamOpen: () => { upstream.readyState = WebSocket.OPEN; callbacks?.open(); },
  };
}

test.each([null, {}, [], [null], [null, null, 1, "event", {}], [null, null, "topic", "event", null]].map((value) => ({ value })))(
  "rejects malformed Phoenix envelope %#", ({ value }) => {
    expect(parsePhoenixMessage(value)).toBeNull();
  },
);

test("parsed Elysia JSON is encoded as Phoenix text and subscription IDs are scoped to one state", async () => {
  const f = fixture();
  await f.open();
  const message = join();
  await f.session.message([message.join_ref, message.ref, message.topic, message.event, message.payload]);
  expect(typeof f.forwarded[0]).toBe("string");
  f.events.emit("change:native-1", change);
  expect(f.sent).toHaveLength(0);
  await f.receive(ack(message));
  expect(f.mappings).toMatchObject([{ project: "fixture", state: "native-1" }]);
  f.events.emit("change:native-1", change);
  expect(parsePhoenixMessage(f.sent[1])?.payload).toEqual({ ...change });
  await f.receive({ ...message, event: "postgres_changes", payload: { ...change } });
  expect(f.sent).toHaveLength(2);
});

test("closing during API key resolution cannot allocate an upstream or decrement another connection", async () => {
  const first = fixture();
  await first.open();
  const release = Promise.withResolvers<void>();
  let connections = 0;
  const second = fixture({}, {
    resolveKey: async () => {
      await release.promise;
      return { ref: "fixture", kind: "anon", role: "anon", upstreamKey: "translated" };
    },
    connect: () => { connections++; return first.upstream; },
  });
  const pending = second.open();
  second.session.close();
  release.resolve();
  await pending;
  expect(connections).toBe(0);
  expect(realtimeProjectConnections().get("fixture")).toBe(1);
});

test("connection limit rejection cannot steal a live connection's count", async () => {
  for (let index = 0; index <= MAX_CONNECTIONS_PER_PROJECT; index++) {
    const f = fixture();
    await f.open();
    if (index === MAX_CONNECTIONS_PER_PROJECT) expect(f.closed[0]?.code).toBe(1008);
  }
  expect(realtimeProjectConnections().get("fixture")).toBe(MAX_CONNECTIONS_PER_PROJECT);
});

test.each(["&ref=other", "&vsn=invalid", "&apikey=duplicate"])("rejects conflicting connection parameters %s", async (suffix) => {
  const f = fixture();
  await f.open(suffix);
  expect(f.closed[0]?.code).toBe(1008);
  expect(realtimeProjectConnections().size).toBe(0);
});

test("leave during native registration releases the late handle and queued join", async () => {
  const release = Promise.withResolvers<string | null>();
  const f = fixture({ subscribeTenant: () => release.promise });
  f.upstream.readyState = WebSocket.CONNECTING;
  await f.open();
  const message = join();
  await f.session.message(message);
  await f.session.message({ ...message, ref: "2", event: "phx_leave", payload: {} });
  release.resolve("late");
  await settled();
  expect(f.removed).toEqual(["late"]);
  expect(f.events.listenerCount("change:late")).toBe(0);
  f.upstreamOpen();
  expect(f.forwarded).toEqual([]);
  expect(parsePhoenixMessage(f.sent[0])?.event).toBe("phx_reply");
});

test("rejoining a topic detaches the old handler and maps the new state", async () => {
  const f = fixture();
  await f.open();
  await f.session.message(join());
  await f.receive(ack(join()));
  await f.session.message(join("realtime:orders", "2"));
  await f.receive(ack(join("realtime:orders", "2")));
  expect(f.removed).toEqual(["native-1"]);
  expect(f.events.listenerCount("change:native-1")).toBe(0);
  expect(f.events.listenerCount("change:native-2")).toBe(1);
  expect(f.mappings.map((entry) => entry.state)).toEqual(["native-1", "native-2"]);
  f.session.close();
  expect(f.removed).toEqual(["native-1", "native-2"]);
  expect(f.events.listenerCount("change:native-2")).toBe(0);
});

test("refresh pauses native delivery and forwards the token only after native verification", async () => {
  const release = Promise.withResolvers<boolean>();
  const f = fixture({ updateSubscriptionToken: () => release.promise });
  await f.open();
  await f.session.message(join());
  await f.receive(ack(join()));
  const pending = f.session.message({ ...join(), event: "access_token", payload: { access_token: "new" } });
  await settled();
  f.events.emit("change:native-1", change);
  expect(f.sent).toHaveLength(1);
  expect(f.forwarded).toHaveLength(1);
  release.resolve(true);
  await pending;
  expect(parsePhoenixMessage(f.forwarded[1])?.payload.access_token).toBe("new");
  f.events.emit("change:native-1", change);
  expect(f.sent).toHaveLength(2);
});

test("rejected refresh and rejected upstream joins revoke native subscriptions", async () => {
  const f = fixture({ updateSubscriptionToken: async () => false });
  await f.open();
  await f.session.message(join());
  await f.receive(ack(join()));
  await f.session.message({ ...join(), event: "access_token", payload: { access_token: "invalid" } });
  expect(f.removed).toEqual(["native-1"]);
  expect(parsePhoenixMessage(f.sent.at(-1))?.event).toBe("phx_error");
  expect(parsePhoenixMessage(f.forwarded.at(-1))?.event).toBe("phx_leave");
  await f.session.message(join("realtime:next", "2"));
  await f.receive({ ...ack(join("realtime:next", "2")), payload: { status: "error", response: {} } });
  expect(f.removed).toEqual(["native-1", "native-2"]);
});

test("pending native rejection cannot send a successful join reply", async () => {
  const f = fixture({ subscribeTenant: async () => null });
  await f.open();
  await f.session.message(join());
  await f.receive(ack(join()));
  expect(parsePhoenixMessage(f.sent[0])?.payload.status).toBe("error");
});

test("buffer and frame size budgets apply to text and binary messages", async () => {
  const f = fixture();
  f.upstream.readyState = WebSocket.CONNECTING;
  await f.open();
  for (let index = 0; index < 3; index++) await f.session.message(broadcastFrame(400 * 1024));
  expect(f.closed[0]?.code).toBe(1009);
  expect(realtimeProjectConnections().size).toBe(0);
});

test("Phoenix V1 uses object replies and binary buffers are forwarded without object coercion", async () => {
  const f = fixture();
  f.upstream.readyState = WebSocket.CONNECTING;
  await f.open("&vsn=1.0.0");
  await f.session.message({ topic: "phoenix", event: "heartbeat", ref: "1", payload: {} });
  const reply: unknown = JSON.parse(String(f.sent[0]));
  expect(Array.isArray(reply)).toBe(false);
  const data = broadcastFrame();
  await f.session.message(data);
  data[0] = 9;
  f.upstreamOpen();
  expect(f.forwarded[0]).toEqual(broadcastFrame());
});

test("binary frames cannot smuggle Phoenix control messages or truncated metadata", () => {
  expect(isPhoenixBroadcastFrame(broadcastFrame(), "client")).toBe(true);
  expect(isPhoenixBroadcastFrame(broadcastFrame(), "server")).toBe(false);
  expect(isPhoenixBroadcastFrame(new Uint8Array([3, 0, 0, 10, 10, 0, 0]), "client")).toBe(false);
  const topic = Buffer.from("realtime:orders");
  const control = Buffer.from("phx_join");
  const frame = new Uint8Array([0, 0, 0, topic.length, control.length, ...topic, ...control]);
  expect(isPhoenixBroadcastFrame(frame, "client")).toBe(false);
});

test("late replies from a previous join cannot update or activate a replacement subscription", async () => {
  const f = fixture();
  await f.open();
  await f.session.message(join());
  await f.session.message(join("realtime:orders", "2"));
  await f.receive(ack(join()));
  expect(f.sent).toEqual([]);
  expect(f.mappings).toEqual([]);
  await f.receive(ack(join("realtime:orders", "2")));
  expect(f.mappings.map((entry) => entry.state)).toEqual(["native-2"]);
});

test("opaque handshake keys are translated in channel join and refresh without replacing user JWTs", async () => {
  const f = fixture();
  await f.open();
  await f.session.message({ ...join(), payload: { config: { postgres_changes: changes }, access_token: "fixture" } });
  expect(parsePhoenixMessage(f.forwarded[0])?.payload.access_token).toBe("translated");
  await f.receive(ack(join()));
  await f.session.message({ ...join(), event: "access_token", payload: { access_token: "user.jwt" } });
  expect(f.tokens).toEqual(["user.jwt"]);
  expect(parsePhoenixMessage(f.forwarded[1])?.payload.access_token).toBe("user.jwt");
});

test("messages received during handshake authentication are bounded and replayed once after it succeeds", async () => {
  const release = Promise.withResolvers<void>();
  const f = fixture({}, {
    resolveKey: async () => {
      await release.promise;
      return { ref: "fixture", kind: "anon", role: "anon", upstreamKey: "translated" };
    },
  });
  const opening = f.open();
  await f.session.message(join());
  expect(f.forwarded).toEqual([]);
  release.resolve();
  await opening;
  expect(f.forwarded).toHaveLength(1);
  expect(parsePhoenixMessage(f.forwarded[0])?.event).toBe("phx_join");
});

test("DELETE stays on the authenticated upstream path and rejects a different channel's IDs", async () => {
  const f = fixture();
  await f.open();
  await f.session.message(join());
  await f.receive(ack(join()));
  const deletion: ChangeEvent = {
    ...change, data: { ...change.data, type: "DELETE", record: {}, old_record: { id: 1 } },
  };
  f.events.emit("change:native-1", deletion);
  expect(f.sent).toHaveLength(1);
  await f.receive({ ...join(), event: "postgres_changes", payload: { ...deletion } });
  expect(f.sent).toHaveLength(2);
  expect(parsePhoenixMessage(f.sent[1])?.payload).toEqual({ ...deletion });
  await f.receive({ ...join(), event: "postgres_changes", payload: { ...deletion, ids: ["other-channel"] } });
  expect(f.closed[0]?.code).toBe(1011);
});

test.each(["timeout", "close"])("authentication settles on %s without waiting for the resolver", async (action) => {
  const timers = clock();
  const f = fixture({}, { schedule: timers.schedule, resolveKey: () => new Promise(() => {}) });
  const opening = f.open();
  expect(timers.pending()).toBe(1);
  if (action === "timeout") timers.advance(REALTIME_DEADLINES.authentication);
  else f.session.close();
  await opening;
  expect(f.closed).toHaveLength(1);
  expect(timers.pending()).toBe(0);
  expect(realtimeProjectConnections().size).toBe(0);
});

test("connection deadline releases counts and a successful open cancels it", async () => {
  const timers = clock();
  const f = fixture({}, { schedule: timers.schedule });
  f.upstream.readyState = WebSocket.CONNECTING;
  await f.open();
  expect(timers.pending()).toBe(1);
  timers.advance(REALTIME_DEADLINES.connection);
  expect(f.closed[0]?.reason).toBe("Upstream connection timed out");
  expect(realtimeProjectConnections().size).toBe(0);
  const success = fixture({}, { schedule: timers.schedule });
  success.upstream.readyState = WebSocket.CONNECTING;
  await success.open();
  success.upstreamOpen();
  expect(timers.pending()).toBe(0);
  timers.advance(REALTIME_DEADLINES.connection);
  expect(success.closed).toEqual([]);
});

test("join timeout aborts registration, rejects pending acknowledgement and cleans up late handles", async () => {
  const timers = clock();
  const release = Promise.withResolvers<string | null>();
  let signal: AbortSignal | undefined;
  const f = fixture({
    subscribeTenant: (_project, _subscriptions, _token, options) => { signal = options?.signal; return release.promise; },
  }, { schedule: timers.schedule });
  await f.open();
  await f.session.message(join());
  await f.receive(ack(join()));
  timers.advance(REALTIME_DEADLINES.join);
  await settled();
  expect(signal?.aborted).toBe(true);
  expect(f.sent.map((entry) => parsePhoenixMessage(entry)?.payload.status)).toEqual(["error"]);
  expect(parsePhoenixMessage(f.forwarded.at(-1))?.event).toBe("phx_leave");
  expect(timers.pending()).toBe(0);
  release.resolve("late");
  await settled();
  expect(f.removed).toEqual(["late"]);
  expect(f.events.listenerCount("change:late")).toBe(0);
  expect(f.sent).toHaveLength(1);
});

test("refresh uses one total deadline including native readiness and cancels late verification", async () => {
  const timers = clock();
  const registration = Promise.withResolvers<string | null>();
  const verification = Promise.withResolvers<boolean>();
  const f = fixture({
    subscribeTenant: () => registration.promise,
    updateSubscriptionToken: () => verification.promise,
  }, { schedule: timers.schedule });
  await f.open();
  await f.session.message(join());
  const refreshing = f.session.message({ ...join(), event: "access_token", payload: { access_token: "new" } });
  timers.advance(REALTIME_DEADLINES.refresh - 1);
  registration.resolve("native");
  await settled();
  timers.advance(1);
  await refreshing;
  expect(f.removed).toEqual(["native"]);
  expect(timers.pending()).toBe(0);
  verification.resolve(true);
  await settled();
  expect(f.forwarded.map((entry) => parsePhoenixMessage(entry)?.event)).toEqual(["phx_join", "phx_leave"]);
});

test("leaving settles a pending refresh immediately and successful operations clear timers", async () => {
  const timers = clock();
  const f = fixture({ updateSubscriptionToken: () => new Promise(() => {}) }, { schedule: timers.schedule });
  await f.open();
  await f.session.message(join());
  await f.receive(ack(join()));
  expect(timers.pending()).toBe(0);
  const refreshing = f.session.message({ ...join(), event: "access_token", payload: { access_token: "new" } });
  await settled();
  expect(timers.pending()).toBe(1);
  await f.session.message({ ...join(), event: "phx_leave", payload: {} });
  await refreshing;
  expect(timers.pending()).toBe(0);
  expect(f.removed).toEqual(["native-1"]);
});

test("delegated wildcard changes validate acknowledgements and preserve separate projections", async () => {
  const f = fixture({ subscribeTenant: async () => { throw new Error("Must delegate"); } });
  await f.open();
  const subscriptions: PostgresChangeConfig[] = [
    { event: "*", schema: "public", select: ["id"] },
    { event: "*", schema: "public", select: [] },
  ];
  const message = { ...join(), payload: { config: { postgres_changes: subscriptions }, access_token: "user" } };
  await f.session.message(message);
  await f.receive({
    ...ack(message), payload: { status: "ok", response: {
      postgres_changes: subscriptions.map(({ select: _select, ...sub }, id) => ({ ...sub, id, table: null, filter: "" })),
    } },
  });
  await f.receive({ ...message, event: "postgres_changes", payload: { ...change, ids: [0, 1] } });
  expect(f.mappings).toEqual([]);
  expect(parsePhoenixMessage(f.sent[0])?.payload.response).toEqual({
    postgres_changes: subscriptions.map((sub, id) => ({ ...sub, id })),
  });
  expect(f.sent.map((entry) => parsePhoenixMessage(entry)?.payload)).toMatchObject([
    { status: "ok" },
    { ids: [0], data: { record: { id: 1 } } },
    { ids: [1], data: { record: {} } },
  ]);
  expect(f.removed).toEqual([]);
});

test("events from a replaced join cannot reuse the new join's subscription IDs", async () => {
  const f = fixture();
  await f.open();
  const original = { ...join(), payload: { config: { postgres_changes: [{ event: "*", schema: "public" }] } } };
  const replacement = { ...original, ref: "2", join_ref: "2" };
  const confirm = (message: PhoenixMessage) => ({
    ...message, event: "phx_reply", payload: { status: "ok", response: {
      postgres_changes: [{ id: "server-id", event: "*", schema: "public" }],
    } },
  });
  await f.session.message(original);
  await f.receive(confirm(original));
  await f.session.message(replacement);
  await f.receive(confirm(replacement));
  await f.receive({ ...original, event: "postgres_changes", payload: { ...change } });
  expect(f.sent).toHaveLength(2);
  await f.receive({ ...replacement, event: "postgres_changes", payload: { ...change } });
  expect(f.sent).toHaveLength(3);
});
