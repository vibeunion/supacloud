# SupaCloud Realtime Adapter

`@supacloud/js/realtime` provides a pluggable, standard-compliant Realtime Channel facade that fully mimics the syntax and ergonomics of `@supabase/supabase-js`.

It allows decoupling client application code from backend real-time protocols (Phoenix Channel, Centrifugo, lightweight WebSocket brokers, or SSE) without altering client syntax.

---

## 1. Features

- **100% Supabase-compatible channel API**:
  - `channel.on('postgres_changes', filter, callback)`
  - `channel.on('broadcast', filter, callback)`
  - `channel.on('presence', filter, callback)`
  - `channel.subscribe(callback)`
  - `channel.send(broadcast)`
  - `channel.track(payload)` / `channel.untrack()`
  - `channel.presenceState()`
- **Custom Transport Interface**:
  - Implement `RealtimeTransport` to direct messages through any broker or backend service.
  - Built-in `MemoryRealtimeTransport` for zero-setup local testing and single-node in-memory event dispatch.
- **Client-side Filter Matching**:
  - Evaluates standard Supabase filter strings (`id=eq.1`, `status=neq.deleted`, `score=gte.10`, `role=in.(admin,editor)`) locally.

---

## 2. Basic Usage

```typescript
import { createRealtimeAdapter } from "@supacloud/js/realtime";

const realtime = createRealtimeAdapter();

const channel = realtime.channel("room-1")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "messages" },
    (payload) => {
      console.log("Postgres change:", payload.new);
    }
  )
  .on("broadcast", { event: "cursor" }, ({ payload }) => {
    console.log("Cursor position:", payload);
  })
  .on("presence", { event: "sync" }, () => {
    console.log("Online users:", channel.presenceState());
  })
  .subscribe((status) => {
    if (status === "SUBSCRIBED") {
      console.log("Connected to channel");
    }
  });

// Broadcast
await channel.send({
  type: "broadcast",
  event: "cursor",
  payload: { x: 100, y: 250 },
});

// Presence
await channel.track({ username: "alice", online_at: new Date().toISOString() });
```

---

## 3. Integration with `createSupaCloudClient`

When instantiating the main platform client, an optional `realtimeTransport` can be supplied to override the default transport:

```typescript
import { createSupaCloudClient } from "@supacloud/js";
import { MemoryRealtimeTransport } from "@supacloud/js/realtime";

const client = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://api.example.com",
  projectRef: "default",
  realtimeTransport: new MemoryRealtimeTransport(),
});

// Returns the adapted RealtimeChannel instance
const channel = client.channel("room-1");
```
