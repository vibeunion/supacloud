import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../../src/config";

// Integration test for Native Realtime & Edge Functions
// Requires a running local instance or staging instance of the Management API

const SUPABASE_URL = process.env.TEST_SUPABASE_URL || `http://${config.baseDomain}:9090`;
const SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY ?? "anon-key-not-set";

describe("SDK Compatibility - Core & Realtime", () => {
  let supabase1: SupabaseClient;
  let supabase2: SupabaseClient;
  let isAvailable = false;

  beforeAll(async () => {
    try {
      if (process.env.TEST_FIXED_JWT_SECRET) {
          throw new Error("Skipping legacy hardcoded automation tests in favor of compliance dynamic tenant tests in CI.");
      }
      await fetch(SUPABASE_URL, { signal: AbortSignal.timeout(1000) });
      isAvailable = true;
    } catch {
      console.warn("API server not available or CI environment detected. Skipping realtime tests.");
      return;
    }

    supabase1 = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    });

    supabase2 = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    });
  });

  afterAll(async () => {
    if (isAvailable) {
      supabase1?.removeAllChannels();
      supabase2?.removeAllChannels();
    }
  });

  test("Realtime - Broadcast event is received by other peers", async () => {
    if (!isAvailable) return;
    const channelName = "room-test-1";
    const channel1 = supabase1.channel(channelName);
    const channel2 = supabase2.channel(channelName);

    let receivedPayload: any = null;

    // Client 2 listens for 'message' event on broadcast
    channel2.on(
      "broadcast",
      { event: "message" },
      (payload) => {
        receivedPayload = payload;
      }
    );

    // Join both channels
    await Promise.all([
      new Promise<void>((resolve) => {
        channel1.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve();
        });
      }),
      new Promise<void>((resolve) => {
        channel2.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve();
        });
      }),
    ]);

    // Send broadcast from Client 1
    const testData = { hello: "world", rnd: Math.random() };
    await channel1.send({
      type: "broadcast",
      event: "message",
      payload: testData,
    });

    // Wait slightly for websocket propagation
    await new Promise((r) => setTimeout(r, 500));

    // Verify it was received
    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload.payload.hello).toBe("world");
    expect(receivedPayload.payload.rnd).toBe(testData.rnd);
  });

  test("Realtime - Presence syncs correctly", async () => {
    if (!isAvailable) return;
    const channelName = "room-presence-1";
    const channel1 = supabase1.channel(channelName);
    const channel2 = supabase2.channel(channelName);

    let syncCount2 = 0;

    channel2.on("presence", { event: "sync" }, () => {
      syncCount2++;
    });

    await Promise.all([
      new Promise<void>((resolve) => {
        channel1.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve();
        });
      }),
      new Promise<void>((resolve) => {
        channel2.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve();
        });
      }),
    ]);

    // Track a new presence state
    await channel1.track({ user: "client1", online_at: new Date().toISOString() });

    await new Promise((r) => setTimeout(r, 500));

    // Client 2 should see both clients in the presence state
    const state = channel2.presenceState();
    expect(Object.keys(state).length).toBeGreaterThan(0);
    expect(syncCount2).toBeGreaterThan(0);
  });

});
