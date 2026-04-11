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
  })
  
  .ws("/realtime/v1/websocket", {
    async open(ws) {
        try {
            const query = (ws.data as any).query || {};
            const apikey = query.apikey || "";
            const vsn = query.vsn || "1.0.0";
            
            if (!apikey) {
                ws.close(1008, "apikey is required to connect to Realtime");
                return;
            }

            const { sql } = await import("../db");
            const rows = await sql`SELECT ref FROM projects WHERE anon_key = ${apikey} OR service_role_key = ${apikey} LIMIT 1`;
            if (rows.length === 0) {
                ws.close(1008, "Invalid apikey");
                return;
            }
            const ref = rows[0].ref;
            (ws.data as any).projectRef = ref;

            const { config } = await import("../config");
            const hostIp = config.dockerHostIp || "127.0.0.1";
            
            // Proxy connection to Official Elixir Realtime for Presence & Broadcast CRDTs
            // We connect directly to the native Elixir container (4000/socket/websocket) bypassing Kong to avoid infinite loops
            const targetUrl = `ws://${hostIp}:4000/socket/websocket?apikey=${apikey}&vsn=${vsn}`;
            
            const upstream = new WebSocket(targetUrl, {
                headers: {
                    "Host": `${ref}.api.${config.baseDomain}`,
                    "x-project-ref": ref
                }
            } as any);

            (ws.data as any).__upstream = upstream;
            (ws.data as any).__buffer = [];

            // Native Bun pg_listen state
            (ws.data as any).__bunSubscriptions = new Set<string>();

            // Upstream proxying (Elixir -> Client)
            upstream.onmessage = (event) => {
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
            
            // P0-12: phx_leave intercept (graceful teardown locally + proxy)
            if (parsed.event === 'phx_leave') {
                 // P1-3: Reply in V2 array format matching Phoenix serializer expectations
                 ws.send(JSON.stringify([
                     parsed.join_ref, parsed.ref, parsed.topic, 'phx_reply',
                     { status: 'ok', response: {} }
                 ]));
                 
                 // Clean up native bun subscription
                 if ((ws.data as any).__bunSubscriptions && (ws.data as any).__bunSubscriptions.has(parsed.topic)) {
                     (ws.data as any).__bunSubscriptions.delete(parsed.topic);
                 }
                 // We still forward it so Elixir can clean up its presence/broadcast CRDTs!
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
                const joinToken = parsed.payload?.access_token;
                if (joinToken) {
                    (ws.data as any).token = joinToken;
                }

                const changes = parsed.payload?.config?.postgres_changes;
                if (changes && Array.isArray(changes) && changes.length > 0 && ref) {
                    const topic = parsed.topic;
                    const subscriptions = changes;
                    
                    import("../services/realtime-bun.service").then(({ realtimeBunService }) => {
                         realtimeBunService.subscribeTenant(ref);
                         if (!(ws.data as any).__bunSubscriptions) (ws.data as any).__bunSubscriptions = new Set();
                         
                         const subs = (ws.data as any).__bunSubscriptions;
                         if (!subs.has(topic)) {
                             subs.add(topic);
                             const handler = (payload: any) => {
                                 ws.send(JSON.stringify([
                                     null, null, topic, 'postgres_changes',
                                     payload
                                 ]));
                             };
                             (ws.data as any)[`__handler_${topic}`] = handler;
                             realtimeBunService.events.on(`change:${ref}`, handler);
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

        // Cleanup Native listeners
        const ref = (ws.data as any).projectRef;
        const subs = (ws.data as any).__bunSubscriptions as Set<string> | undefined;
        if (subs && ref) {
            import("../services/realtime-bun.service").then(({ realtimeBunService }) => {
                for (const topic of subs) {
                    const handler = (ws.data as any)[`__handler_${topic}`];
                    if (handler) realtimeBunService.events.off(`change:${ref}`, handler);
                }
            }).catch(console.error);
        }
    }
  });