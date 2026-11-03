import { describe, expect, it } from "bun:test";
import {
  createRealtimeAdapter,
  matchesPostgresFilter,
  MemoryRealtimeTransport,
  SupaCloudRealtimeChannel,
  type RealtimePostgresChangesPayload,
} from "./realtime.js";

describe("Realtime Adapter — Postgres Filter Matching", () => {
  it("matches empty or whitespace filter", () => {
    expect(matchesPostgresFilter(undefined, { id: 1 })).toBe(true);
    expect(matchesPostgresFilter("", { id: 1 })).toBe(true);
    expect(matchesPostgresFilter("   ", { id: 1 })).toBe(true);
  });

  it("matches eq and neq operators", () => {
    expect(matchesPostgresFilter("status=eq.active", { status: "active" })).toBe(true);
    expect(matchesPostgresFilter("status=eq.active", { status: "inactive" })).toBe(false);

    expect(matchesPostgresFilter("status=neq.deleted", { status: "active" })).toBe(true);
    expect(matchesPostgresFilter("status=neq.deleted", { status: "deleted" })).toBe(false);
  });

  it("matches numerical comparison operators (gt, gte, lt, lte)", () => {
    expect(matchesPostgresFilter("score=gt.10", { score: 15 })).toBe(true);
    expect(matchesPostgresFilter("score=gt.10", { score: 10 })).toBe(false);

    expect(matchesPostgresFilter("score=gte.10", { score: 10 })).toBe(true);
    expect(matchesPostgresFilter("score=gte.10", { score: 9 })).toBe(false);

    expect(matchesPostgresFilter("score=lt.20", { score: 15 })).toBe(true);
    expect(matchesPostgresFilter("score=lt.20", { score: 20 })).toBe(false);

    expect(matchesPostgresFilter("score=lte.20", { score: 20 })).toBe(true);
    expect(matchesPostgresFilter("score=lte.20", { score: 25 })).toBe(false);
  });

  it("matches in list operator", () => {
    expect(matchesPostgresFilter("role=in.(admin,editor)", { role: "admin" })).toBe(true);
    expect(matchesPostgresFilter("role=in.(admin,editor)", { role: "editor" })).toBe(true);
    expect(matchesPostgresFilter("role=in.(admin,editor)", { role: "viewer" })).toBe(false);
  });
});

describe("Realtime Adapter — Channel Lifecycle & Subscriptions", () => {
  it("subscribes and receives SUBSCRIBED status", () => {
    const transport = new MemoryRealtimeTransport();
    const channel = new SupaCloudRealtimeChannel("test-room", transport);

    let status = "";
    channel.subscribe((s) => {
      status = s;
    });

    expect(status).toBe("SUBSCRIBED");
    expect(channel.state).toBe("SUBSCRIBED");
  });

  it("unsubscribes and updates state to CLOSED", async () => {
    const transport = new MemoryRealtimeTransport();
    const channel = new SupaCloudRealtimeChannel("test-room", transport);

    let finalStatus = "";
    channel.subscribe((s) => {
      finalStatus = s;
    });
    expect(finalStatus).toBe("SUBSCRIBED");

    const res = await channel.unsubscribe();
    expect(res).toBe("ok");
    expect(finalStatus).toBe("CLOSED");
    expect(channel.state).toBe("CLOSED");
  });
});

describe("Realtime Adapter — Postgres Changes Event Dispatch", () => {
  it("dispatches postgres_changes matching table, schema, and filter", () => {
    const transport = new MemoryRealtimeTransport();
    const channel = new SupaCloudRealtimeChannel("public:messages", transport);

    const received: RealtimePostgresChangesPayload[] = [];
    channel.on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: "status=eq.published",
      },
      (payload) => {
        received.push(payload);
      },
    );

    channel.subscribe();

    // 1. Send matching message
    transport.send({
      topic: "public:messages",
      event: "postgres_changes",
      payload: {
        schema: "public",
        table: "messages",
        commit_timestamp: "2026-11-03T08:00:00Z",
        eventType: "INSERT",
        new: { id: "msg_1", status: "published", text: "hello" },
        old: {},
        errors: [],
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].new.id).toBe("msg_1");

    // 2. Send non-matching filter message
    transport.send({
      topic: "public:messages",
      event: "postgres_changes",
      payload: {
        schema: "public",
        table: "messages",
        commit_timestamp: "2026-11-03T08:00:01Z",
        eventType: "INSERT",
        new: { id: "msg_2", status: "draft", text: "draft message" },
        old: {},
        errors: [],
      },
    });

    expect(received.length).toBe(1);

    // 3. Send non-matching event type
    transport.send({
      topic: "public:messages",
      event: "postgres_changes",
      payload: {
        schema: "public",
        table: "messages",
        commit_timestamp: "2026-11-03T08:00:02Z",
        eventType: "DELETE",
        new: {},
        old: { id: "msg_1", status: "published" },
        errors: [],
      },
    });

    expect(received.length).toBe(1);
  });

  it("supports wildcard '*' for event and schema", () => {
    const transport = new MemoryRealtimeTransport();
    const channel = new SupaCloudRealtimeChannel("all-changes", transport);

    const received: RealtimePostgresChangesPayload[] = [];
    channel.on(
      "postgres_changes",
      { event: "*", schema: "*" },
      (payload) => {
        received.push(payload);
      },
    );

    channel.subscribe();

    transport.send({
      topic: "all-changes",
      event: "postgres_changes",
      payload: {
        schema: "custom_schema",
        table: "any_table",
        commit_timestamp: "2026-11-03T08:00:00Z",
        eventType: "UPDATE",
        new: { id: "1" },
        old: { id: "1" },
        errors: [],
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].eventType).toBe("UPDATE");
  });
});

describe("Realtime Adapter — Broadcast & Presence", () => {
  it("broadcasts messages across multiple channels via shared transport", async () => {
    const transport = new MemoryRealtimeTransport();
    const channelA = new SupaCloudRealtimeChannel("room-chat", transport);
    const channelB = new SupaCloudRealtimeChannel("room-chat", transport);

    const receivedB: unknown[] = [];
    channelB.on("broadcast", { event: "cursor-move" }, (payload) => {
      receivedB.push(payload.payload);
    });

    channelA.subscribe();
    channelB.subscribe();

    const result = await channelA.send({
      type: "broadcast",
      event: "cursor-move",
      payload: { x: 120, y: 340 },
    });

    expect(result).toBe("ok");
    expect(receivedB.length).toBe(1);
    expect(receivedB[0]).toEqual({ x: 120, y: 340 });
  });

  it("broadcasts to self when config.broadcast.self is true", async () => {
    const transport = new MemoryRealtimeTransport();
    const channel = new SupaCloudRealtimeChannel("room-chat", transport, {
      broadcast: { self: true },
    });

    const received: unknown[] = [];
    channel.on("broadcast", { event: "ping" }, (payload) => {
      received.push(payload.payload);
    });

    channel.subscribe();

    await channel.send({
      type: "broadcast",
      event: "ping",
      payload: { time: 123 },
    });

    expect(received.length).toBe(1);
    expect(received[0]).toEqual({ time: 123 });
  });

  it("tracks and untracks presence", async () => {
    const transport = new MemoryRealtimeTransport();
    const channel = new SupaCloudRealtimeChannel("presence-room", transport, {
      presence: { key: "user-123" },
    });

    let syncState: unknown = null;
    let joinState: unknown = null;
    let leaveState: unknown = null;

    channel.on("presence", { event: "sync" }, (state) => {
      syncState = state;
    });
    channel.on("presence", { event: "join" }, (join) => {
      joinState = join;
    });
    channel.on("presence", { event: "leave" }, (leave) => {
      leaveState = leave;
    });

    channel.subscribe();

    // Track
    const trackRes = await channel.track({ username: "alice", status: "online" });
    expect(trackRes).toBe("ok");

    const presences = channel.presenceState();
    expect(presences["user-123"]).toBeDefined();
    expect(presences["user-123"].length).toBe(1);
    expect((presences["user-123"][0] as any).username).toBe("alice");
    expect(joinState).not.toBeNull();
    expect(syncState).not.toBeNull();

    // Untrack
    const untrackRes = await channel.untrack();
    expect(untrackRes).toBe("ok");
    expect(channel.presenceState()["user-123"]).toBeUndefined();
    expect(leaveState).not.toBeNull();
  });

  it("creates adapter with createRealtimeAdapter factory", () => {
    const adapter = createRealtimeAdapter();
    const channel = adapter.channel("room-factory");
    expect(channel).toBeInstanceOf(SupaCloudRealtimeChannel);
    expect(channel.topic).toBe("room-factory");
  });
});
