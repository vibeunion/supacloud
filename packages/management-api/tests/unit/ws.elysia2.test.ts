import { afterAll, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { websocket } from "elysia/websocket";

const authorize = mock(async (request: Request) => {
  const token = request.headers.get("authorization");
  if (token === "Bearer admin-test") return { role: "master" as const, principalId: "master" as const };
  if (token === "Bearer project-test" && new URL(request.url).pathname.endsWith("/project-a")) {
    return { role: "project" as const, ref: "project-a", principalId: "project-test" };
  }
  return { status: 403, body: { error: "Forbidden" } };
});

mock.module("../../src/middleware/auth", () => ({
  getAuthContext: authorize,
  checkAuth: async (request: Request) => {
    const result = await authorize(request);
    return "status" in result ? result : undefined;
  },
  requireAdminAuth: async () => undefined,
  readStudioSessionToken: () => null,
  isSameOriginStudioRequest: () => true,
}));
mock.module("../../src/utils/project-auth", () => ({
  resolveProjectApiKey: async () => null,
}));

const { wsRoutes, getWsConnectionCount, broadcastTaskUpdate } = await import("../../src/routes/ws");
const app = new Elysia().use(websocket()).use(wsRoutes);
await app.modules;
await new Promise<void>((resolve, reject) => {
  try {
    app.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve());
  } catch (error) {
    reject(error);
  }
});
const base = `ws://127.0.0.1:${app.server!.port}`;
const clients: WebSocket[] = [];
const messageQueues = new WeakMap<WebSocket, {
  messages: Record<string, unknown>[];
  waiters: Array<(message: Record<string, unknown>) => void>;
}>();

afterAll(async () => {
  for (const client of clients) client.close();
  await app.stop(true);
});

function open(path: string) {
  const ws = new WebSocket(`${base}${path}`);
  messageQueues.set(ws, { messages: [], waiters: [] });
  ws.addEventListener("message", (event) => {
    const queue = messageQueues.get(ws);
    if (!queue) return;
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = queue.waiters.shift();
    if (waiter) waiter(message);
    else queue.messages.push(message);
  });
  clients.push(ws);
  return ws;
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  const queue = messageQueues.get(ws);
  if (!queue) return Promise.reject(new Error("WebSocket was not created by open()"));
  const message = queue.messages.shift();
  if (message) return Promise.resolve(message);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket message timed out")), 2000);
    queue.waiters.push((message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket close timed out")), 2000);
    ws.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve(event.code);
    }, { once: true });
  });
}

test("task state survives separate Elysia open, message and close callbacks", async () => {
  const baseline = getWsConnectionCount();
  const ws = open("/ws/tasks?token=admin-test&project=project-a");
  expect(await nextMessage(ws)).toMatchObject({ type: "connected", projectFilter: "project-a" });
  expect(getWsConnectionCount()).toBe(baseline + 1);
  const subscribed = nextMessage(ws);
  ws.send(JSON.stringify({ type: "subscribe", projectRef: "project-b" }));
  expect(await subscribed).toMatchObject({ type: "subscribed", projectRef: "project-b" });
  const update = nextMessage(ws);
  broadcastTaskUpdate({ taskId: "t1", projectRef: "project-b", taskType: "test", status: "running" });
  expect(await update).toMatchObject({ type: "task_update", taskId: "t1" });
  const done = closed(ws);
  ws.close();
  await done;
  await Bun.sleep(0);
  expect(getWsConnectionCount()).toBe(baseline);
});

test("project sessions reauthorize subscriptions and retain the original filter on denial", async () => {
  const ws = open("/ws/tasks?token=project-test&project=project-a");
  expect(await nextMessage(ws)).toMatchObject({ type: "connected" });
  const denied = nextMessage(ws);
  ws.send(JSON.stringify({ type: "subscribe", projectRef: "project-b" }));
  expect(await denied).toMatchObject({ type: "error" });
  const update = nextMessage(ws);
  broadcastTaskUpdate({ taskId: "t2", projectRef: "project-a", taskType: "test", status: "running" });
  expect(await update).toMatchObject({ taskId: "t2" });
  const done = closed(ws);
  ws.close();
  await done;
  await Bun.sleep(0);
});

test("failed task and realtime authentication closes without registering a subscriber", async () => {
  const baseline = getWsConnectionCount();
  const invalidTask = open("/ws/tasks?token=invalid");
  const missingRealtimeKey = open("/ws/realtime/v1/websocket");
  const invalidRealtimeKey = open("/ws/realtime/v1/websocket?apikey=invalid");
  expect(await Promise.all([closed(invalidTask), closed(missingRealtimeKey), closed(invalidRealtimeKey)]))
    .toEqual([1008, 1008, 1008]);
  await Bun.sleep(0);
  expect(getWsConnectionCount()).toBe(baseline);
});
