/**
 * Realtime Service native replacement
 * Emulates the Supabase Realtime (Phoenix Channels) WebSocket protocol.
 */
import { Elysia, t } from "elysia";
import { logger } from "../utils/logger";

// Track presence states
// Topic -> ConnectionId -> PresenceMetas
const presences = new Map<string, Map<string, any>>();
const channels = new Map<string, Set<any>>();
const connections = new Map<string, any>();

let connCounter = 0;

function sendPresenceState(ws: any, join_ref: string, ref: string, topic: string) {
  const topicPresences = presences.get(topic);
  if (!topicPresences) return;
  
  const state: Record<string, any> = {};
  for (const [connId, metas] of topicPresences.entries()) {
    state[connId] = { metas: [metas] };
  }
  
  ws.send(JSON.stringify([
    join_ref,
    null,
    topic,
    "presence_state",
    state
  ]));
}

function broadcastPresenceDiff(topic: string, joins: Record<string, any>, leaves: Record<string, any>) {
  const channelSet = channels.get(topic);
  if (!channelSet) return;
  const msg = JSON.stringify([null, null, topic, "presence_diff", { joins, leaves }]);
  for (const client of channelSet) {
    try { client.send(msg); } catch { /* ignore */ }
  }
}

export const realtimeRoutes = new Elysia()
  .ws("/realtime/v1/websocket", {
    query: t.Optional(t.Object({
      apikey: t.Optional(t.String()),
      vsn: t.Optional(t.String())
    })),
    open(ws) {
      const id = `conn-${++connCounter}`;
      (ws.data as any).__connId = id;
      (ws.data as any).__topics = new Set<string>();
      connections.set(id, ws);
    },
    async message(ws, message) {
      let msgArr: any[];
      try {
        msgArr = typeof message === "string" ? JSON.parse(message) : message;
        if (!Array.isArray(msgArr) || msgArr.length !== 5) return;
      } catch {
        return;
      }

      const [join_ref, ref, topic, event, payload] = msgArr;
      const connId = (ws.data as any).__connId;

      if (topic === "phoenix" && event === "heartbeat") {
        ws.send(JSON.stringify([null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]));
        return;
      }

      if (event === "phx_join") {
        const topics = (ws.data as any).__topics as Set<string>;
        topics.add(topic);

        if (!channels.has(topic)) channels.set(topic, new Set());
        channels.get(topic)!.add(ws);

        ws.send(JSON.stringify([
          join_ref, 
          ref, 
          topic, 
          "phx_reply", 
          { status: "ok", response: { postgres_changes: [] } }
        ]));
        
        // If they configured presence, they will send a presence event next usually, 
        // but we can send presence_state immediately.
        sendPresenceState(ws, join_ref, ref, topic);
        return;
      }

      if (event === "phx_leave") {
        const topics = (ws.data as any).__topics as Set<string>;
        topics.delete(topic);
        
        channels.get(topic)?.delete(ws);
        
        const tPres = presences.get(topic);
        if (tPres && tPres.has(connId)) {
          const metas = tPres.get(connId);
          tPres.delete(connId);
          broadcastPresenceDiff(topic, {}, { [connId]: { metas: [metas] } });
        }
        
        ws.send(JSON.stringify([join_ref, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        return;
      }

      if (event.startsWith("broadcast")) {
        const channelSet = channels.get(topic);
        if (channelSet) {
          const broadcastMsg = JSON.stringify([join_ref, null, topic, event, payload]);
          for (const client of channelSet) {
            if (client !== ws || payload?.self === true) {
               client.send(broadcastMsg);
            }
          }
        }
        ws.send(JSON.stringify([join_ref, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        return;
      }

      if (event === "presence") {
        if (!presences.has(topic)) presences.set(topic, new Map());
        const tPres = presences.get(topic)!;
        
        // Track the presence meta
        const meta = { phx_ref: ref, ...payload };
        tPres.set(connId, meta);
        
        ws.send(JSON.stringify([join_ref, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        
        // Broadcast the join
        broadcastPresenceDiff(topic, { [connId]: { metas: [meta] } }, {});
        return;
      }
    },
    close(ws) {
      const connId = (ws.data as any).__connId;
      if (connId) {
        connections.delete(connId);
        const topics = (ws.data as any).__topics as Set<string>;
        if (topics) {
          for (const topic of topics) {
            channels.get(topic)?.delete(ws);
            
            const tPres = presences.get(topic);
            if (tPres && tPres.has(connId)) {
              const metas = tPres.get(connId);
              tPres.delete(connId);
              broadcastPresenceDiff(topic, {}, { [connId]: { metas: [metas] } });
            }
          }
        }
      }
    }
  });

export function broadcastToTopic(topic: string, event: string, payload: any) {
  const channelSet = channels.get(topic);
  if (!channelSet) return;
  const msg = JSON.stringify([null, null, topic, event, payload]);
  for (const client of channelSet) {
    try { client.send(msg); } catch { /* skip */ }
  }
}
