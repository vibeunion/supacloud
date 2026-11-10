/**
 * WebSocket Routes — Real-time task progress notifications
 *
 * Uses Elysia's native WebSocket support (powered by Bun's uWebSockets).
 * Auth: same-origin Studio cookies for the console, or an explicit project
 * token for non-browser/project-scoped clients.
 */
import { Elysia, t } from "elysia";
import { websocket } from "elysia/websocket";
import {
  checkAuth,
  getAuthContext,
  isSameOriginStudioRequest,
  readStudioSessionToken,
  requireAdminAuth,
  type AuthContext,
} from "../middleware/auth";
import { logger } from "../utils/logger";
import { publicRealtimeUpstream } from "../services/realtime-public-contract";
import { parsePhoenixMessage } from "../utils/phoenix-message";

// --- Subscriber registry ---
interface WsClient {
  id: string;
  projectFilter?: string; // optional: only receive events for this project
  send: (data: string) => void;
}

const taskSubscribers = new Map<string, WsClient>();
let clientIdCounter = 0;

const MAX_CONNECTIONS_PER_PROJECT = 200;
const MAX_BROADCAST_SIZE = 1024 * 1024;
const projectConnectionCounts = new Map<string, number>();
// lib.dom's constructor omits Bun's headers option.
const BunWebSocket = WebSocket as typeof WebSocket & {
  new(url: string, options: Bun.WebSocketOptions): WebSocket;
};

type TaskSocketData = {
  request?: Request;
  __clientId?: string;
  __authToken?: string;
  __isAdmin?: boolean;
  __closed?: boolean;
};

type TaskSocket = {
  data: TaskSocketData;
  send: (data: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

const taskSocketData = new WeakMap<object, TaskSocketData>();

function taskSocketAdapter(ws: {
  raw?: object;
  request: Request;
  send: (data: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
}): TaskSocket {
  const key = ws.raw ?? ws;
  let data = taskSocketData.get(key);
  if (!data) {
    data = {};
    taskSocketData.set(key, data);
  }
  data.request = ws.request;
  return { data, send: ws.send.bind(ws), close: ws.close.bind(ws) };
}

type RealtimeSocketState = {
  request?: Request;
  query: Record<string, string | undefined>;
  projectRef?: string;
  apikey?: string;
  upstream?: WebSocket;
  buffer: Array<string | ArrayBuffer | ArrayBufferView<ArrayBuffer>>;
  closed: boolean;
  counted: boolean;
};

const realtimeSocketStates = new WeakMap<object, RealtimeSocketState>();

function realtimeSocketState(ws: {
  raw?: object;
  request: Request;
  query?: Record<string, string | undefined>;
}): RealtimeSocketState {
  const key = ws.raw ?? ws;
  let state = realtimeSocketStates.get(key);
  if (!state) {
    state = {
      request: ws.request,
      query: ws.query ?? {},
      buffer: [],
      closed: false,
      counted: false,
    };
    realtimeSocketStates.set(key, state);
  } else {
    state.request = ws.request;
    state.query = ws.query ?? state.query;
  }
  return state;
}

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

function parseTaskSocketMessage(message: unknown): Record<string, unknown> | null {
  if (typeof message === "string") {
    try {
      const parsed = JSON.parse(message);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return message && typeof message === "object" ? message as Record<string, unknown> : null;
}

type TaskSocketAuthResolver = (
  request: Request,
) => Promise<AuthContext | { status: number; body: { error: string } }>;

export async function openTaskWebSocket(
  ws: TaskSocket,
  resolveAuth: TaskSocketAuthResolver = getAuthContext,
) {
  const id = `ws-${++clientIdCounter}`;
  const url = new URL(ws.data.request?.url || "http://localhost", "http://localhost");
  const projectFilter = url.searchParams.get("project") || undefined;
  const token = url.searchParams.get("token") || "";

  const authUrl = new URL(url.toString());
  if (projectFilter) {
    authUrl.pathname = `/v1/projects/${projectFilter}`;
  }
  const headers = new Headers(ws.data.request?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const authRequest = new Request(authUrl.toString(), {
    headers,
  });
  if (!token && readStudioSessionToken(authRequest) && !isSameOriginStudioRequest(authRequest)) {
    ws.close(1008, "Cross-origin session request denied");
    return;
  }
  const auth = await resolveAuth(authRequest);
  if (ws.data.__closed) return;
  if ("status" in auth) {
    ws.close(auth.status === 403 ? 1008 : 1002, auth.body.error);
    return;
  }

  const isAdmin = auth.role === "master" || auth.role === "admin";
  if (!projectFilter && !isAdmin) {
    ws.close(1008, "Project filter required for non-admin websocket sessions");
    return;
  }

  ws.data.__clientId = id;
  ws.data.__authToken = token;
  ws.data.__isAdmin = isAdmin;

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
}

export async function messageTaskWebSocket(ws: TaskSocket, message: unknown) {
  const msg = parseTaskSocketMessage(message);
  if (!msg || msg.type !== "subscribe" || typeof msg.projectRef !== "string") return;

  const clientId = ws.data.__clientId;
  const client = clientId ? taskSubscribers.get(clientId) : undefined;
  if (!client) return;

  const isAdmin = ws.data.__isAdmin === true;
  if (!isAdmin) {
    const token = ws.data.__authToken || "";
    const authUrl = new URL(`http://localhost/v1/projects/${msg.projectRef}`);
    const authRequest = new Request(authUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const authError = await checkAuth(authRequest);
    if (authError) {
      ws.send(JSON.stringify({ type: "error", message: `No access to project ${msg.projectRef}` }));
      return;
    }
  }

  client.projectFilter = msg.projectRef;
  ws.send(JSON.stringify({ type: "subscribed", projectRef: msg.projectRef }));
}

export function closeTaskWebSocket(ws: TaskSocket) {
  ws.data.__closed = true;
  const clientId = ws.data.__clientId;
  if (clientId) {
    taskSubscribers.delete(clientId);
    logger.info(`[WS] Client ${clientId} disconnected (total: ${taskSubscribers.size})`);
  }
}

export const wsRoutes = new Elysia({ prefix: "/ws" })
  .use(websocket())
  .get("/realtime/v1/health", { detail: { tags: ["projects"], summary: "Get WebSocket realtime health status" } }, async ({ request, set }) => {
    const authError = await requireAdminAuth(request);
    if (authError) {
      set.status = authError.status;
      return { error: authError.body.error };
    }

    const projectConnections: Record<string, number> = {};
    for (const [ref, count] of projectConnectionCounts) {
      if (count > 0) projectConnections[ref] = count;
    }
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      task_subscribers: taskSubscribers.size,
      realtime_projects: Object.keys(projectConnections).length,
      realtime_connections: Object.values(projectConnections).reduce((a, b) => a + b, 0),
      project_connections: projectConnections,
    };
  })
  .get("/realtime/v1/status", { detail: { tags: ["projects"], summary: "Get realtime connection status for a project" } }, async ({ query, set, request }) => {
    const authError = await requireAdminAuth(request);
    if (authError) {
      set.status = authError.status;
      return { error: authError.body.error };
    }

    const ref = query.project_ref;
    if (!ref) {
      set.status = 400;
      return { error: "project_ref query parameter required" };
    }
    const connections = projectConnectionCounts.get(ref) || 0;
    return {
      project_ref: ref,
      realtime_connections: connections,
      max_connections: MAX_CONNECTIONS_PER_PROJECT,
      connection_available: connections < MAX_CONNECTIONS_PER_PROJECT,
    };
  })
  .ws("/tasks", {
    body: t.Optional(t.Object({
      type: t.Optional(t.String()),
      projectRef: t.Optional(t.String()),
    })),
    async open(ws) {
      await openTaskWebSocket(taskSocketAdapter(ws));
    },

    async message(ws, message) {
      await messageTaskWebSocket(taskSocketAdapter(ws), message);
    },

    close(ws) {
      closeTaskWebSocket(taskSocketAdapter(ws));
    },
  })
  
  // Legacy path. supabase-js uses /realtime/v1/websocket, which the server
  // intercepts before Elysia. This route is the same Elixir proxy and does
  // not subscribe to RealtimeBunService.
  .ws("/realtime/v1/websocket", {
    async open(ws) {
        const state = realtimeSocketState(ws);
        try {
            const query = state.query;
            const apikey = query.apikey || "";
            const vsn = query.vsn || "2.0.0"; // P1-6: Default to 2.0.0
            
            if (!apikey) {
                ws.close(1008, "apikey is required to connect to Realtime");
                return;
            }

            const { resolveProjectApiKey } = await import("../utils/project-auth");
            const resolvedApiKey = await resolveProjectApiKey(apikey);
            if (state.closed) return;
            const ref = resolvedApiKey?.ref || "";
            if (!resolvedApiKey || !ref) {
                ws.close(1008, "Invalid apikey");
                return;
            }
            const requestedRef = state.request?.headers.get("x-project-ref") || state.request?.headers.get("x-supabase-project") || query.ref || "";
            if (requestedRef && requestedRef !== ref) {
                ws.close(1008, "Project reference does not match apikey");
                return;
            }
            const currentConns = projectConnectionCounts.get(ref) || 0;
            if (currentConns >= MAX_CONNECTIONS_PER_PROJECT) {
                ws.close(1008, `Connection limit reached for project ${ref} (max ${MAX_CONNECTIONS_PER_PROJECT})`);
                return;
            }
            projectConnectionCounts.set(ref, currentConns + 1);
            state.projectRef = ref;
            state.apikey = resolvedApiKey.upstreamKey;
            state.counted = true;

            const { config } = await import("../config");
            if (state.closed) return;

            // Same Elixir upstream as the published /realtime/v1 socket. This
            // legacy /ws route does not attach LISTEN/NOTIFY.
            const tenantHost = `${ref}.api.${config.baseDomain}`;
            const targetUrl = publicRealtimeUpstream(
                config.realtimeAdminUrl,
                "/realtime/v1/websocket",
                `?apikey=${encodeURIComponent(resolvedApiKey.upstreamKey)}&vsn=${encodeURIComponent(vsn)}`,
            );
            
            const upstream = new BunWebSocket(targetUrl, {
                headers: {
                    "Host": tenantHost,
                    "x-project-ref": ref
                }
            });
            upstream.binaryType = "arraybuffer";

            state.upstream = upstream;

            // Elixir frames are forwarded unchanged. Do not also emit Bun
            // LISTEN/NOTIFY events on this socket.
            upstream.onmessage = (event) => {
                ws.send(event.data);
            };
            
            upstream.onopen = () => {
                const buf = state.buffer;
                for (const msg of buf) {
                    upstream.send(msg);
                }
                state.buffer = [];
            };

            upstream.onclose = () => {
                ws.close();
            };

            upstream.onerror = (err) => {
                import("../utils/logger").then(m => m.logger.error(`[Realtime Proxy] Upstream error for ${ref}`, { error: String(err) }));
                try { ws.close(1011, "Upstream connection error"); } catch {}
            };
            
        } catch (err: unknown) {
            import("../utils/logger").then(m => m.logger.error("[Realtime Proxy] Fault initializing link", { error: String(err) }));
            ws.close(1011, "Proxy initialization fault");
        }
    },
    message(ws, rawMessage) {
        const state = realtimeSocketState(ws);
        if (state.closed) return;
        const upstream = state.upstream;

        // P0-2: Binary frames (broadcast ArrayBuffer) — forward directly, no interception needed
        if (rawMessage instanceof ArrayBuffer || ArrayBuffer.isView(rawMessage)) {
            if (rawMessage.byteLength > MAX_BROADCAST_SIZE) {
                return;
            }
            const binary = rawMessage instanceof ArrayBuffer ? rawMessage : new Uint8Array(
                rawMessage.buffer, rawMessage.byteOffset, rawMessage.byteLength,
            ).slice();
            if (upstream?.readyState === WebSocket.OPEN) {
                upstream.send(binary);
            } else if (upstream?.readyState === WebSocket.CONNECTING) {
                state.buffer.push(binary);
            }
            return;
        }
        const textMessage = typeof rawMessage === "string" ? rawMessage : JSON.stringify(rawMessage);
        if (textMessage === undefined || Buffer.byteLength(textMessage) > MAX_BROADCAST_SIZE) return;

        // Elixir owns channel state. Reply locally only while the upstream
        // socket is not open, so a slow connect does not time the client out.
        try {
            const parsed = parsePhoenixMessage(rawMessage);
            if (parsed?.event === "heartbeat" && (!upstream || upstream.readyState !== WebSocket.OPEN)) {
                const vsn = state.query.vsn || "2.0.0";
                if (vsn === "1.0.0") {
                    ws.send(JSON.stringify({ topic: parsed.topic, event: "phx_reply", payload: { status: "ok", response: {} }, ref: parsed.ref }));
                } else {
                    ws.send(JSON.stringify([parsed.join_ref, parsed.ref, parsed.topic, "phx_reply", { status: "ok", response: {} }]));
                }
                return;
            }
        } catch {
            // Unparsed frames are still forwarded to Elixir.
        }

        if (!upstream) return;
        
        if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(textMessage);
        } else if (upstream.readyState === WebSocket.CONNECTING) {
            state.buffer.push(textMessage);
        }
    },
    close(ws) {
        const state = realtimeSocketState(ws);
        if (state.closed) return;
        state.closed = true;
        state.buffer = [];
        const upstream = state.upstream;
        if (upstream && upstream.readyState !== WebSocket.CLOSED) {
            upstream.close();
        }

        const ref = state.projectRef;
        if (ref && state.counted) {
            state.counted = false;
            const count = projectConnectionCounts.get(ref) || 0;
            if (count > 1) {
                projectConnectionCounts.set(ref, count - 1);
            } else {
                projectConnectionCounts.delete(ref);
            }
        }

    }
  });
