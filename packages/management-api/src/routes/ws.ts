/**
 * WebSocket Routes — Real-time task progress notifications
 *
 * Uses Elysia's native WebSocket support (powered by Bun's uWebSockets).
 * Auth: same-origin Studio cookies for the console, or an explicit project
 * token for non-browser/project-scoped clients.
 */
import { Elysia, t } from "elysia";
import {
  checkAuth,
  getAuthContext,
  isSameOriginStudioRequest,
  readStudioSessionToken,
  requireAdminAuth,
  type AuthContext,
} from "../middleware/auth";
import { logger } from "../utils/logger";

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

type TaskSocketData = {
  request?: Request;
  __clientId?: string;
  __authToken?: string;
  __isAdmin?: boolean;
};

type TaskSocket = {
  data: TaskSocketData;
  send: (data: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

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
  const clientId = ws.data.__clientId;
  if (clientId) {
    taskSubscribers.delete(clientId);
    logger.info(`[WS] Client ${clientId} disconnected (total: ${taskSubscribers.size})`);
  }
}

export const wsRoutes = new Elysia({ prefix: "/ws" })
  .get("/realtime/v1/health", async ({ request, set }) => {
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
  }, { detail: { tags: ["projects"], summary: "Get WebSocket realtime health status" } })
  .get("/realtime/v1/status", async ({ query, set, request }) => {
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
  }, { detail: { tags: ["projects"], summary: "Get realtime connection status for a project" } })
  .ws("/tasks", {
    body: t.Optional(t.Object({
      type: t.Optional(t.String()),
      projectRef: t.Optional(t.String()),
    })),
    async open(ws) {
      await openTaskWebSocket(ws as unknown as TaskSocket);
    },

    async message(ws, message) {
      await messageTaskWebSocket(ws as unknown as TaskSocket, message);
    },

    close(ws) {
      closeTaskWebSocket(ws as unknown as TaskSocket);
    },
  })
  
  .ws("/realtime/v1/websocket", {
    async open(ws) {
        try {
            const query = (ws.data as any).query || {};
            const apikey = query.apikey || "";
            const vsn = query.vsn || "2.0.0"; // P1-6: Default to 2.0.0
            
            if (!apikey) {
                ws.close(1008, "apikey is required to connect to Realtime");
                return;
            }

            const { resolveProjectApiKey } = await import("../utils/project-auth");
            const resolvedApiKey = await resolveProjectApiKey(apikey);
            const ref = resolvedApiKey?.ref || "";
            if (!resolvedApiKey || !ref) {
                ws.close(1008, "Invalid apikey");
                return;
            }
            const requestedRef = ws.data.request?.headers?.get("x-project-ref") || ws.data.request?.headers?.get("x-supabase-project") || query.ref || "";
            if (requestedRef && requestedRef !== ref) {
                ws.close(1008, "Project reference does not match apikey");
                return;
            }
            (ws.data as any).projectRef = ref;
            (ws.data as any).apikey = resolvedApiKey.upstreamKey;

            const currentConns = projectConnectionCounts.get(ref) || 0;
            if (currentConns >= MAX_CONNECTIONS_PER_PROJECT) {
                ws.close(1008, `Connection limit reached for project ${ref} (max ${MAX_CONNECTIONS_PER_PROJECT})`);
                return;
            }
            projectConnectionCounts.set(ref, currentConns + 1);

            const { config } = await import("../config");
            const hostIp = config.dockerHostIp || "127.0.0.1";
            
            // Elixir Realtime resolves tenants by extracting the first subdomain
            // from the Host header. The registered external_id is the project ref,
            // so the Host must always be "{ref}.api.{baseDomain}" — custom domains
            // would extract the wrong subdomain and break tenant resolution.
            const tenantHost = `${ref}.api.${config.baseDomain}`;
            
            const targetUrl = `ws://${hostIp}:4000/socket/websocket?apikey=${encodeURIComponent(resolvedApiKey.upstreamKey)}&vsn=${encodeURIComponent(vsn)}`;
            
            const upstream = new WebSocket(targetUrl, {
                headers: {
                    "Host": tenantHost,
                    "x-project-ref": ref
                }
            } as any);

            (ws.data as any).__upstream = upstream;
            (ws.data as any).__buffer = [];

            // Native Bun pg_listen state
            (ws.data as any).__bunSubscriptions = new Set<string>();

            // Upstream proxying (Elixir -> Client)
            upstream.onmessage = (event) => {
                try {
                    const data = typeof event.data === 'string' ? event.data : '';
                    if (data) {
                        const raw = JSON.parse(data);
                        let parsed: any;
                        if (Array.isArray(raw)) {
                            parsed = { join_ref: raw[0], ref: raw[1], topic: raw[2], event: raw[3], payload: raw[4] };
                        } else {
                            parsed = raw;
                        }
                        if (parsed.event === 'phx_reply' && parsed.payload?.response?.postgres_changes) {
                            const mappings = parsed.payload.response.postgres_changes;
                            if (Array.isArray(mappings) && ref) {
                                import("../services/realtime-bun.service").then(({ realtimeBunService }) => {
                                    realtimeBunService.registerSubscriptionIds(ref, mappings);
                                }).catch(() => {});
                            }
                        }
                    }
                } catch {}
                ws.send(event.data);
            };
            
            upstream.onopen = () => {
                const buf = (ws.data as any).__buffer || [];
                for (const msg of buf) {
                    upstream.send(msg);
                }
                (ws.data as any).__buffer = [];
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
        const upstream = (ws.data as any).__upstream as WebSocket | undefined;
        const ref = (ws.data as any).projectRef as string | undefined;

        // P0-2: Binary frames (broadcast ArrayBuffer) — forward directly, no interception needed
        if (typeof rawMessage !== 'string') {
            if ((rawMessage as ArrayBuffer).byteLength > MAX_BROADCAST_SIZE) {
                return;
            }
            if (upstream?.readyState === WebSocket.OPEN) {
                upstream.send(rawMessage as any);
            } else if (upstream?.readyState === WebSocket.CONNECTING) {
                ((ws.data as Record<string,any>).__buffer || []).push(rawMessage);
            }
            return;
        }

        // --- NATIVE BUN REALTIME INTERCEPTS ---
        try {
            // P0-1: Handle Phoenix V2 array format [join_ref, ref, topic, event, payload]
            // The Supabase Realtime SDK uses V2 serialization by default (DEFAULT_VSN = '2.0.0')
            const raw = JSON.parse(rawMessage);
            let parsed: { join_ref?: string | null; ref?: string | null; topic: string; event: string; payload: any };
            if (Array.isArray(raw)) {
                parsed = { join_ref: raw[0], ref: raw[1], topic: raw[2], event: raw[3], payload: raw[4] };
            } else {
                parsed = raw;
            }
            
            // P0-12, P0-4: phx_leave intercept (graceful teardown locally + proxy)
            if (parsed.event === 'phx_leave') {
                 // Format based on vsn
                 const vsn = (ws.data as any).query?.vsn || "2.0.0";
                 if (vsn === "1.0.0") {
                     ws.send(JSON.stringify({ topic: parsed.topic, event: "phx_reply", payload: { status: "ok", response: {} }, ref: parsed.ref }));
                 } else {
                     ws.send(JSON.stringify([parsed.join_ref, parsed.ref, parsed.topic, 'phx_reply', { status: 'ok', response: {} }]));
                 }
                 
                 if ((ws.data as any).__bunSubscriptions && (ws.data as any).__bunSubscriptions.has(parsed.topic)) {
                     (ws.data as any).__bunSubscriptions.delete(parsed.topic);
                     
                     // P0-4: Cleanup handler from events to prevent memory leak AND ghost events
                     const handler = (ws.data as any)[`__handler_${parsed.topic}`];
                     if (handler) {
                         import("../services/realtime-bun.service").then(({ realtimeBunService }) => {
                             const state = ((ws.data as any).__bunSubscriptionStates as Map<string, any> | undefined)?.get(parsed.topic);
                             if (state) realtimeBunService.events.off(`change:${state.id}`, handler);
                             if (ref && state) realtimeBunService.unsubscribeSubscription(ref, state.id);
                         });
                         ((ws.data as any).__bunSubscriptionStates as Map<string, any> | undefined)?.delete(parsed.topic);
                         delete (ws.data as any)[`__handler_${parsed.topic}`];
                     }
                 }
            }

            // P0-5: heartbeat local reply ONLY if upstream is not connected to prevent client timeout.
            // If upstream is open, we let upstream handle it to avoid duplicate replies.
            if (parsed.event === 'heartbeat') {
                if (!upstream || upstream.readyState !== WebSocket.OPEN) {
                    const vsn = (ws.data as any).query?.vsn || "2.0.0";
                    if (vsn === "1.0.0") {
                        ws.send(JSON.stringify({ topic: parsed.topic, event: "phx_reply", payload: { status: "ok", response: {} }, ref: parsed.ref }));
                    } else {
                        ws.send(JSON.stringify([parsed.join_ref, parsed.ref, parsed.topic, 'phx_reply', { status: 'ok', response: {} }]));
                    }
                    return; // Block from queuing to upstream since we replied
                }
            }

            // P0-13: access_token intercept
            if (parsed.event === 'access_token') {
                const newToken = parsed.payload?.access_token;
                if (newToken) {
                    (ws.data as any).token = newToken;
                    // Forward to Elixir for upstream tenant isolation
                }
            }

            // P0-14: postgres_changes multiplexing
            if (parsed.event === 'phx_join') {
                const joinToken = parsed.payload?.access_token || (ws.data as any).token || (ws.data as any).apikey;
                if (joinToken) {
                    (ws.data as any).token = joinToken;
                }

                const changes = parsed.payload?.config?.postgres_changes;
                if (changes && Array.isArray(changes) && changes.length > 0 && ref) {
                    const topic = parsed.topic;
                    const subscriptions = changes;
                    
                    import("../services/realtime-bun.service").then(async ({ realtimeBunService }) => {
                         const subscriptionStateId = await realtimeBunService.subscribeTenant(ref, subscriptions, joinToken);
                         if (!subscriptionStateId) return;
                         if (!(ws.data as any).__bunSubscriptions) (ws.data as any).__bunSubscriptions = new Set();
                         if (!(ws.data as any).__bunSubscriptionStates) (ws.data as any).__bunSubscriptionStates = new Map();
                         
                         const subs = (ws.data as any).__bunSubscriptions;
                         const subscriptionStates = (ws.data as any).__bunSubscriptionStates as Map<string, { id: string }>;
                         subscriptionStates.set(topic, { id: subscriptionStateId });
                         if (!subs.has(topic)) {
                             subs.add(topic);
                             const handler = (payload: any) => {
                                 const vsn = (ws.data as any).query?.vsn || "2.0.0";
                                 if (vsn === "1.0.0") {
                                     ws.send(JSON.stringify({ topic, event: "postgres_changes", payload, ref: null }));
                                 } else {
                                     ws.send(JSON.stringify([null, null, topic, 'postgres_changes', payload]));
                                 }
                             };
                             (ws.data as any)[`__handler_${topic}`] = handler;
                             realtimeBunService.events.on(`change:${subscriptionStateId}`, handler);
                         }
                    }).catch(console.error);
                }
            }

        } catch (err) {
            // Not JSON or parse error, just proxy raw
        }
        
        // --- END NATIVE INTERCEPTS ---

        if (!upstream) return;
        
        if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(rawMessage as any);
        } else if (upstream.readyState === WebSocket.CONNECTING) {
            ((ws.data as Record<string,any>).__buffer || []).push(rawMessage);
        }
    },
    close(ws) {
        const upstream = (ws.data as Record<string,any>).__upstream as WebSocket | undefined;
        if (upstream && upstream.readyState !== WebSocket.CLOSED) {
            upstream.close();
        }

        const ref = (ws.data as any).projectRef;
        if (ref) {
            const count = projectConnectionCounts.get(ref) || 0;
            if (count > 1) {
                projectConnectionCounts.set(ref, count - 1);
            } else {
                projectConnectionCounts.delete(ref);
            }
        }

        const subs = (ws.data as any).__bunSubscriptions as Set<string> | undefined;
        const subscriptionStates = (ws.data as any).__bunSubscriptionStates as Map<string, any> | undefined;
        if (subs && ref) {
            import("../services/realtime-bun.service").then(({ realtimeBunService }) => {
                for (const topic of subs) {
                    const handler = (ws.data as any)[`__handler_${topic}`];
                    const state = subscriptionStates?.get(topic);
                    if (handler && state) realtimeBunService.events.off(`change:${state.id}`, handler);
                    if (state) realtimeBunService.unsubscribeSubscription(ref, state.id);
                }
            }).catch(console.error);
        }
    }
  });
