import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createSupaCloudClient, SupaCloudTaskSubmitError } from "./index";

function createFakeSupabase() {
  const removeChannel = mock(async () => "ok");
  type FakeChannel = {
    on: ReturnType<typeof mock>;
    subscribe: ReturnType<typeof mock>;
  };

  let channelInstance: FakeChannel;
  channelInstance = {
    on: mock(function () {
      return channelInstance;
    }),
    subscribe: mock(function () {
      return channelInstance;
    }),
  };

  const supabase = {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "token-123" } },
        error: null,
      }),
    },
    functions: {
      invoke: mock(),
    },
    channel: mock(() => channelInstance),
    removeChannel,
  };

  return { supabase, channelInstance, removeChannel };
}

describe("@supacloud/js", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("submit preserves plain invoke options and returns a receipt", async () => {
    const { supabase } = createFakeSupabase();
    supabase.functions.invoke.mockResolvedValue({
      data: { task_id: "tsk_123", status: "enqueued" },
      error: null,
    });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const receipt = await client.tasks.submit("aorist-ai/generate/crop", {
      body: { image_id: "img_1" },
      retries: 2,
      timeoutSec: 300,
      idempotencyKey: "crop-img_1-v1",
    });

    expect(receipt.taskId).toBe("tsk_123");
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
    expect(supabase.functions.invoke.mock.calls[0]?.[1]).toMatchObject({
      body: { image_id: "img_1" },
      headers: {},
    });
  });

  test("submit throws a dedicated error when the task was not enqueued", async () => {
    const { supabase } = createFakeSupabase();
    supabase.functions.invoke.mockResolvedValue({
      data: { prediction: { image: "https://example.com/image.png" } },
      error: null,
    });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
    });

    await expect(
      client.tasks.submit("aorist-ai/generate/crop"),
    ).rejects.toBeInstanceOf(SupaCloudTaskSubmitError);
  });

  test("get/list/cancel/retry build management-api requests with bearer auth", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ id: "tsk_123", status: "running" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    await client.tasks.get("tsk_123");
    await client.tasks.list({ status: ["running", "failed"], functionSlug: "aorist-ai", limit: 5 });
    await client.tasks.cancel("tsk_123");
    await client.tasks.retry("tsk_123");
    await client.tasks.listDlq(10);

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123");
    expect(calls[1]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks?status=running%2Cfailed&function_slug=aorist-ai&limit=5");
    expect(calls[2]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123/cancel");
    expect(calls[2]?.init?.method).toBe("POST");
    expect(calls[3]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123/retry");
    expect(calls[4]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/dlq?limit=10");
    expect((calls[0]?.init?.headers as Record<string, string>)?.authorization).toBe("Bearer token-123");
  });

  test("queue client builds management-api requests with bearer auth", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ id: "msg_123", status: "leased", payload: { hello: "world" } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });
    const queue = client.queue("emails");

    await queue.send({ hello: "world" }, { delayMs: 1000, maxAttempts: 5, idempotencyKey: "email-1" });
    await queue.receive({ visibilityTimeoutSec: 60 });
    await queue.list({ status: ["pending", "leased"], limit: 10 });
    await queue.get("msg_123");
    await queue.ack("msg_123", { ok: true });
    await queue.release("msg_123", { delayMs: 5000, error: "retry later" });
    await queue.fail("msg_123", { error: "boom" });
    await queue.delete("msg_123");

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages");
    expect(calls[1]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/receive");
    expect(calls[2]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages?status=pending%2Cleased&limit=10");
    expect(calls[3]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123");
    expect(calls[4]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123/ack");
    expect(calls[5]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123/release");
    expect(calls[6]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123/fail");
    expect(calls[7]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123");
    expect(calls[7]?.init?.method).toBe("DELETE");
    expect((calls[0]?.init?.headers as Record<string, string>)?.authorization).toBe("Bearer token-123");
  });

  test("queue receive returns null when no message is available", async () => {
    const { supabase } = createFakeSupabase();
    globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const message = await client.queue("emails").receive();
    expect(message).toBe(null);
  });

  test("wait polls until a terminal task status is reached", async () => {
    const { supabase } = createFakeSupabase();
    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running" })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed" });

    const task = await client.tasks.wait("tsk_123");

    expect(task.status).toBe("completed");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  test("subscribe falls back to polling on channel error", async () => {
    const { supabase, channelInstance, removeChannel } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: string[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10 })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed", progress: 100 });

    let subscribeHandler:
      | ((status: string, error?: unknown) => void | Promise<void>)
      | undefined;

    channelInstance.subscribe.mockImplementation((...args: unknown[]) => {
      const [handler] = args as [((status: string, error?: unknown) => void | Promise<void>)?];
      subscribeHandler = handler;
      return channelInstance;
    });

    const subscription = client.tasks.subscribe("tsk_123", {
      onUpdate(snapshot) {
        snapshots.push(String(snapshot.status));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await subscribeHandler?.("CHANNEL_ERROR", new Error("realtime down"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("polling");
    expect(snapshots).toContain("completed");
    expect(removeChannel).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    expect(getSpy).toHaveBeenCalled();
  });

  test("subscribe falls back to polling when realtime does not connect in time", async () => {
    const { supabase, channelInstance, removeChannel } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: string[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10 })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed", progress: 100 });

    channelInstance.subscribe.mockImplementation(() => channelInstance);

    const subscription = client.tasks.subscribe("tsk_123", {
      realtimeTimeoutMs: 1,
      onUpdate(snapshot) {
        snapshots.push(String(snapshot.status));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("polling");
    expect(snapshots).toContain("completed");
    expect(removeChannel).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    expect(getSpy).toHaveBeenCalled();
  });

  test("subscribe reconciles while realtime is connected", async () => {
    const { supabase, channelInstance } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: number[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10 })
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 20 });

    let subscribeHandler:
      | ((status: string, error?: unknown) => void | Promise<void>)
      | undefined;

    channelInstance.subscribe.mockImplementation((...args: unknown[]) => {
      const [handler] = args as [((status: string, error?: unknown) => void | Promise<void>)?];
      subscribeHandler = handler;
      return channelInstance;
    });

    const subscription = client.tasks.subscribe("tsk_123", {
      reconcileIntervalMs: 1,
      stopOnTerminal: false,
      onUpdate(snapshot) {
        snapshots.push(Number(snapshot.progress));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await subscribeHandler?.("SUBSCRIBED");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("realtime");
    expect(snapshots).toContain(10);
    expect(snapshots).toContain(20);
    expect(getSpy.mock.calls.length >= 2).toBe(true);

    subscription.unsubscribe();
  });
});
