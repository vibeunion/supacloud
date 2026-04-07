/**
 * WebSocket Routes — Real-time task progress notifications
 *
 * Uses Elysia's native WebSocket support (powered by Bun's uWebSockets).
 * Auth: query parameter ?token=<session_token> (WebSocket can't send custom headers)
 */
import { Elysia, t } from "elysia";
import { logger } from "../utils/logger";

// --- Subscriber registry ---
interface WsClient {
  id: string;
  projectFilter?: string; // optional: only receive events for this project
  send: (data: string) => void;
}

const taskSubscribers = new Map<string, WsClient>();
let clientIdCounter = 0;

/** Broadcast a task update to all connected WebSocket clients */
export function broadcastTaskUpdate(event: {
  taskId: string;
  projectRef: string;
  taskType: string;
  status: string;
  progress?: number;
  error?: string | null;
}) {
  const payload = JSON.stringify({ type: "task_update", ...event, timestamp: new Date().toISOString() });

  for (const [, client] of taskSubscribers) {
    // If client has a project filter, only send matching events
    if (client.projectFilter && client.projectFilter !== event.projectRef) continue;
    try {
      client.send(payload);
    } catch {
      // Client disconnected, will be cleaned up on close
    }
  }
}

/** Broadcast a generic system event */
export function broadcastSystemEvent(event: { type: string; message: string; data?: unknown }) {
  const payload = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
  for (const [, client] of taskSubscribers) {
    try {
      client.send(payload);
    } catch { /* ignore */ }
  }
}

/** Get count of active WebSocket connections */
export function getWsConnectionCount(): number {
  return taskSubscribers.size;
}

export const wsRoutes = new Elysia({ prefix: "/ws" })
  .ws("/tasks", {
    body: t.Optional(t.Object({
      type: t.Optional(t.String()),
      projectRef: t.Optional(t.String()),
    })),
    open(ws) {
      const id = `ws-${++clientIdCounter}`;
      // Extract project filter from query params if present
      const url = new URL(ws.data.request?.url || "http://localhost", "http://localhost");
      const projectFilter = url.searchParams.get("project") || undefined;

      // Store clientId on the ws instance for reliable cleanup
      (ws.data as Record<string, unknown>).__clientId = id;

      taskSubscribers.set(id, {
        id,
        projectFilter,
        send: (data: string) => ws.send(data),
      });

      ws.send(JSON.stringify({
        type: "connected",
        clientId: id,
        projectFilter: projectFilter || "all",
        timestamp: new Date().toISOString(),
      }));

      logger.info(`[WS] Client ${id} connected (filter: ${projectFilter || "all"}, total: ${taskSubscribers.size})`);
    },

    message(ws, message) {
      // Client can dynamically update project filter
      if (typeof message === "object" && message !== null) {
        const msg = message as Record<string, unknown>;
        if (msg.type === "subscribe" && typeof msg.projectRef === "string") {
          const clientId = (ws.data as Record<string, unknown>).__clientId as string;
          const client = clientId ? taskSubscribers.get(clientId) : undefined;
          if (client) {
            client.projectFilter = msg.projectRef as string;
            ws.send(JSON.stringify({ type: "subscribed", projectRef: msg.projectRef }));
          }
        }
      }
    },

    close(ws) {
      const clientId = (ws.data as Record<string, unknown>).__clientId as string;
      if (clientId) {
        taskSubscribers.delete(clientId);
        logger.info(`[WS] Client ${clientId} disconnected (total: ${taskSubscribers.size})`);
      }
    },
  });
