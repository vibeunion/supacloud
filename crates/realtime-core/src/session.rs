//! Transport-free Realtime state machine.
//!
//! Input is a JSON command from the Bun host; output is a JSON batch of
//! outbound frames plus host effects (RLS authorization probes, broadcast
//! persistence). The core never performs I/O, so the same crate is reusable by
//! the standalone Rust gateway and by `supacloud-lite` over FFI.
//!
//! Commands:
//!
//! ```json
//! {"op":"frame","connection_id":"c1","frame": <phoenix frame value>}
//! {"op":"authorize_result","connection_id":"c1","request_id":"a1","read":true,"write":false}
//! {"op":"cdc","event":{"schema":"public","table":"todos","type":"INSERT","record":{}}}
//! {"op":"presence_state","connection_id":"c1","topic":"realtime:chat"}
//! {"op":"disconnect","connection_id":"c1"}
//! ```
//!
//! Responses are `{"frames":[{"connection_id":"c1","frame":...}],"effects":[...],"errors":[...]}`.

use crate::filter::ColumnFilter;
use crate::presence::PresenceManager;
use crate::protocol::{Frame, FrameError, Vsn};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Marker key the host uses for a payload it keeps on its own heap.
///
/// The core treats payloads as opaque, so a host that stages a large payload
/// sends `{ KEY: id }` instead and the core echoes that marker back inside every
/// frame. The host splices the real bytes in while writing the socket, which
/// keeps `subscribers x payload` bytes out of the JSON response.
pub const PAYLOAD_REF_KEY: &str = "\u{0}sc_payload_ref";

#[derive(Debug, Clone)]
struct Binding {
    id: u32,
    event: String,
    schema: String,
    table: String,
    filter: Option<ColumnFilter>,
    /// Original filter text echoed back in the join reply.
    filter_raw: Option<String>,
}

#[derive(Debug, Clone)]
struct Channel {
    join_ref: Option<String>,
    /// Client ref of the latest join push, echoed on the join reply.
    reference: Option<String>,
    private: bool,
    pending_authz: Option<String>,
    can_broadcast: bool,
    broadcast_self: bool,
    broadcast_ack: bool,
    presence_enabled: bool,
    presence_key: Option<String>,
    bindings: Vec<Binding>,
}

#[derive(Debug)]
struct Connection {
    vsn: Vsn,
    channels: HashMap<String, Channel>,
    /// Join order, so disconnect-time presence leaves match the TypeScript engine.
    channel_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutgoingFrame {
    pub connection_id: String,
    pub frame: Value,
}

/// Work the host must perform because it owns the database.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Run the `realtime.messages` RLS probe and call back with
    /// `authorize_result`.
    Authorize {
        request_id: String,
        connection_id: String,
        topic: String,
        join_ref: Option<String>,
    },
    /// Persist / relay a broadcast outside this process. Local fan-out has
    /// already been performed by the core.
    Broadcast {
        topic: String,
        event: String,
        payload: Value,
        private: bool,
    },
}

impl Effect {
    fn to_json(&self) -> Value {
        match self {
            Effect::Authorize {
                request_id,
                connection_id,
                topic,
                join_ref,
            } => json!({
                "type": "authorize",
                "request_id": request_id,
                "connection_id": connection_id,
                "topic": topic,
                "join_ref": join_ref,
            }),
            Effect::Broadcast {
                topic,
                event,
                payload,
                private,
            } => json!({
                "type": "broadcast",
                "topic": topic,
                "event": event,
                "payload": payload,
                "private": private,
            }),
        }
    }
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub frames: Vec<OutgoingFrame>,
    pub effects: Vec<Effect>,
    pub errors: Vec<String>,
}

impl Outcome {
    pub fn into_json(self) -> Value {
        json!({
            "frames": self.frames.iter().map(|f| json!({
                "connection_id": f.connection_id,
                "frame": f.frame,
            })).collect::<Vec<_>>(),
            "effects": self.effects.iter().map(Effect::to_json).collect::<Vec<_>>(),
            "errors": self.errors,
        })
    }
}

#[derive(Debug, Default)]
pub struct Session {
    connections: HashMap<String, Connection>,
    presence: PresenceManager,
    next_binding: u32,
    next_authz: u64,
    next_phx_ref: u64,
}

impl Session {
    pub fn new() -> Self {
        Self {
            next_binding: 1,
            next_authz: 1,
            next_phx_ref: 1,
            ..Default::default()
        }
    }

    /// Execute one JSON command and return the JSON response documented above.
    pub fn handle_json(&mut self, request: &str) -> String {
        match self.handle(request) {
            Ok(outcome) => outcome.into_json().to_string(),
            Err(message) => json!({
                "frames": [],
                "effects": [],
                "errors": [message],
            })
            .to_string(),
        }
    }

    pub fn handle(&mut self, request: &str) -> Result<Outcome, String> {
        let value: Value =
            serde_json::from_str(request).map_err(|e| format!("invalid request JSON: {e}"))?;
        let op = value
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| "request is missing `op`".to_string())?;
        let connection_id = value
            .get("connection_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        match op {
            "frame" => {
                if connection_id.is_empty() {
                    return Err("frame requires connection_id".into());
                }
                let frame = value
                    .get("frame")
                    .cloned()
                    .ok_or_else(|| "frame requires `frame`".to_string())?;
                self.on_frame(&connection_id, frame)
            }
            "authorize_result" => {
                let request_id = value
                    .get("request_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "authorize_result requires request_id".to_string())?
                    .to_string();
                let read = value.get("read").and_then(Value::as_bool).unwrap_or(false);
                let write = value.get("write").and_then(Value::as_bool).unwrap_or(false);
                let reason = value
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.on_authorize_result(&connection_id, &request_id, read, write, reason)
            }
            "authorize" => {
                let topic = value
                    .get("topic")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "authorize requires topic".to_string())?;
                let write = value.get("write").and_then(Value::as_bool).unwrap_or(false);
                self.on_authorize(&connection_id, topic, write)
            }
            "cdc" => {
                let event = value
                    .get("event")
                    .cloned()
                    .ok_or_else(|| "cdc requires `event`".to_string())?;
                let record_ref = value.get("record_ref").and_then(Value::as_str);
                let old_record_ref = value.get("old_record_ref").and_then(Value::as_str);
                self.on_cdc(&event, record_ref, old_record_ref)
            }
            "presence_state" => {
                let topic = value
                    .get("topic")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "presence_state requires topic".to_string())?;
                Ok(self.presence_state(&connection_id, topic))
            }
            "disconnect" => self.on_disconnect(&connection_id),
            other => Err(format!("unsupported op: {other}")),
        }
    }

    fn connection_mut(&mut self, id: &str) -> &mut Connection {
        self.connections
            .entry(id.to_string())
            .or_insert_with(|| Connection {
                vsn: Vsn::V1,
                channels: HashMap::new(),
                channel_order: Vec::new(),
            })
    }

    fn take_channel(&mut self, connection_id: &str, topic: &str) -> Option<Channel> {
        let conn = self.connections.get_mut(connection_id)?;
        conn.channel_order.retain(|joined| joined != topic);
        conn.channels.remove(topic)
    }

    fn on_frame(&mut self, connection_id: &str, raw: Value) -> Result<Outcome, String> {
        let frame = Frame::from_value(raw).map_err(|e: FrameError| e.to_string())?;
        let vsn = frame.vsn;
        self.connection_mut(connection_id).vsn = vsn;
        let mut out = Outcome::default();

        match frame.event.as_str() {
            "phx_join" => {
                self.on_join(connection_id, frame, &mut out)?;
                Ok(out)
            }
            "heartbeat" => {
                out.frames.push(OutgoingFrame {
                    connection_id: connection_id.to_string(),
                    frame: Frame::ok(vsn, frame.join_ref, frame.reference, frame.topic, json!({}))
                        .encode(vsn),
                });
                Ok(out)
            }
            "phx_leave" => {
                self.on_leave(connection_id, frame, &mut out)?;
                Ok(out)
            }
            "broadcast" => {
                self.on_broadcast(connection_id, frame, &mut out)?;
                Ok(out)
            }
            "presence" => {
                self.on_presence(connection_id, frame, &mut out)?;
                Ok(out)
            }
            "access_token" => Ok(out),
            // Unknown events are ignored, exactly like the TypeScript engine.
            _ => Ok(out),
        }
    }

    fn on_join(
        &mut self,
        connection_id: &str,
        frame: Frame,
        out: &mut Outcome,
    ) -> Result<(), String> {
        let topic = frame.topic.clone();
        let config = frame.payload.get("config").cloned().unwrap_or(Value::Null);
        let private = config
            .get("private")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let presence_cfg = config.get("presence");
        // Match the TypeScript engine: presence is opt-out, not opt-in.
        let presence_enabled = presence_cfg
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let presence_key = presence_cfg
            .and_then(|v| v.get("key"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let broadcast_self = config
            .pointer("/broadcast/self")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let broadcast_ack = config
            .pointer("/broadcast/ack")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut bindings = Vec::new();
        if let Some(list) = config.get("postgres_changes").and_then(Value::as_array) {
            for spec in list {
                bindings.push(self.binding_from_spec(spec));
            }
        }

        let request_id = if private {
            let id = format!("authz_{}", self.next_authz);
            self.next_authz += 1;
            id.into()
        } else {
            None
        };

        let channel = Channel {
            join_ref: frame.join_ref.clone(),
            reference: frame.reference.clone(),
            private,
            pending_authz: request_id.clone(),
            can_broadcast: !private,
            broadcast_self,
            broadcast_ack,
            presence_enabled,
            presence_key,
            bindings,
        };
        let conn = self.connection_mut(connection_id);
        if !conn.channel_order.iter().any(|joined| joined == &topic) {
            conn.channel_order.push(topic.clone());
        }
        conn.channels.insert(topic.clone(), channel);

        if let Some(request_id) = request_id {
            out.effects.push(Effect::Authorize {
                request_id,
                connection_id: connection_id.to_string(),
                topic,
                join_ref: frame.join_ref.clone(),
            });
            return Ok(());
        }

        self.send_join_ok(connection_id, &topic, out);
        Ok(())
    }

    fn binding_from_spec(&mut self, spec: &Value) -> Binding {
        let id = spec
            .get("id")
            .and_then(Value::as_u64)
            .map(|n| n as u32)
            .unwrap_or_else(|| {
                let id = self.next_binding;
                self.next_binding += 1;
                id
            });
        Binding {
            id,
            event: spec
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or("*")
                .to_uppercase(),
            schema: spec
                .get("schema")
                .and_then(Value::as_str)
                .unwrap_or("public")
                .to_string(),
            table: spec
                .get("table")
                .and_then(Value::as_str)
                .unwrap_or("*")
                .to_string(),
            filter: spec
                .get("filter")
                .and_then(Value::as_str)
                .and_then(ColumnFilter::parse),
            filter_raw: spec
                .get("filter")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }

    fn send_join_ok(&mut self, connection_id: &str, topic: &str, out: &mut Outcome) {
        let (vsn, join_ref, reference, bindings, presence_enabled) = {
            let Some(conn) = self.connections.get(connection_id) else {
                return;
            };
            let Some(ch) = conn.channels.get(topic) else {
                return;
            };
            let bindings = ch
                .bindings
                .iter()
                .map(|b| {
                    let mut map = Map::new();
                    map.insert("id".into(), json!(b.id));
                    map.insert("event".into(), json!(b.event));
                    map.insert("schema".into(), json!(b.schema));
                    map.insert("table".into(), json!(b.table));
                    if let Some(filter) = &b.filter_raw {
                        map.insert("filter".into(), json!(filter));
                    }
                    Value::Object(map)
                })
                .collect::<Vec<_>>();
            (
                conn.vsn,
                ch.join_ref.clone(),
                ch.reference.clone(),
                bindings,
                ch.presence_enabled,
            )
        };

        out.frames.push(OutgoingFrame {
            connection_id: connection_id.to_string(),
            frame: Frame::ok(
                vsn,
                join_ref,
                reference,
                topic,
                json!({ "postgres_changes": bindings }),
            )
            .encode(vsn),
        });

        if presence_enabled {
            let state = self.presence.state(topic);
            self.push_to_connection(connection_id, topic, "presence_state", state, out);
        }
    }

    fn on_authorize_result(
        &mut self,
        connection_id: &str,
        request_id: &str,
        read: bool,
        write: bool,
        reason: Option<String>,
    ) -> Result<Outcome, String> {
        let mut out = Outcome::default();
        let Some(conn) = self.connections.get(connection_id) else {
            return Err(format!("unknown connection: {connection_id}"));
        };
        let Some(topic) = conn
            .channels
            .iter()
            .find(|(_, ch)| ch.pending_authz.as_deref() == Some(request_id))
            .map(|(topic, _)| topic.clone())
        else {
            return Err(format!("unknown authorization request: {request_id}"));
        };

        if !read {
            let vsn = self.connections[connection_id].vsn;
            let channel = &self.connections[connection_id].channels[&topic];
            let (join_ref, reference) = (channel.join_ref.clone(), channel.reference.clone());
            self.take_channel(connection_id, &topic);
            out.frames.push(OutgoingFrame {
                connection_id: connection_id.to_string(),
                frame: Frame::error(
                    vsn,
                    join_ref,
                    reference,
                    topic,
                    reason.as_deref().unwrap_or("Unauthorized"),
                )
                .encode(vsn),
            });
            return Ok(out);
        }

        {
            let ch = self
                .connections
                .get_mut(connection_id)
                .unwrap()
                .channels
                .get_mut(&topic)
                .unwrap();
            ch.pending_authz = None;
            ch.can_broadcast = write;
        }
        self.send_join_ok(connection_id, &topic, &mut out);
        Ok(out)
    }

    /// Update write authorization after a token refresh without re-joining.
    fn on_authorize(
        &mut self,
        connection_id: &str,
        topic: &str,
        write: bool,
    ) -> Result<Outcome, String> {
        let Some(conn) = self.connections.get_mut(connection_id) else {
            return Err(format!("unknown connection: {connection_id}"));
        };
        let Some(channel) = conn.channels.get_mut(topic) else {
            return Err(format!("unknown channel: {topic}"));
        };
        channel.can_broadcast = write;
        Ok(Outcome::default())
    }

    fn on_leave(
        &mut self,
        connection_id: &str,
        frame: Frame,
        out: &mut Outcome,
    ) -> Result<(), String> {
        let vsn = frame.vsn;
        let topic = frame.topic.clone();
        let removed = self.take_channel(connection_id, &topic);
        if removed.is_some() {
            self.broadcast_presence_leave(&topic, connection_id, out);
        }
        out.frames.push(OutgoingFrame {
            connection_id: connection_id.to_string(),
            frame: Frame::ok(vsn, frame.join_ref, frame.reference, topic, json!({})).encode(vsn),
        });
        Ok(())
    }

    fn on_broadcast(
        &mut self,
        connection_id: &str,
        frame: Frame,
        out: &mut Outcome,
    ) -> Result<(), String> {
        let vsn = frame.vsn;
        let topic = frame.topic.clone();
        let (private, can_broadcast, ack, echo) = {
            let Some(conn) = self.connections.get(connection_id) else {
                return Err(format!("unknown connection: {connection_id}"));
            };
            match conn.channels.get(&topic) {
                Some(ch) => (
                    ch.private,
                    ch.can_broadcast,
                    ch.broadcast_ack,
                    ch.broadcast_self,
                ),
                // Phoenix drops messages for topics without a joined channel.
                None => return Ok(()),
            }
        };

        if private && !can_broadcast {
            // Match the TypeScript engine: only an acked broadcast with a ref
            // gets an error reply, and the reason is the lowercase "unauthorized".
            if ack && frame.reference.is_some() {
                out.frames.push(OutgoingFrame {
                    connection_id: connection_id.to_string(),
                    frame: Frame::error(
                        vsn,
                        frame.join_ref,
                        frame.reference,
                        topic,
                        "unauthorized",
                    )
                    .encode(vsn),
                });
            }
            return Ok(());
        }

        let event = frame
            .payload
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("message")
            .to_string();
        let payload = frame.payload.get("payload").cloned().unwrap_or(Value::Null);

        for target in self.subscribers(&topic) {
            if target == connection_id && !echo {
                continue;
            }
            self.push_to_connection(
                &target,
                &topic,
                "broadcast",
                json!({ "type": "broadcast", "event": event, "payload": payload }),
                out,
            );
        }

        out.effects.push(Effect::Broadcast {
            topic: topic.clone(),
            event,
            payload,
            private,
        });

        if ack {
            out.frames.push(OutgoingFrame {
                connection_id: connection_id.to_string(),
                frame: Frame::ok(vsn, frame.join_ref, frame.reference, topic, json!({}))
                    .encode(vsn),
            });
        }
        Ok(())
    }

    fn on_presence(
        &mut self,
        connection_id: &str,
        frame: Frame,
        out: &mut Outcome,
    ) -> Result<(), String> {
        let vsn = frame.vsn;
        let topic = frame.topic.clone();
        let action = frame
            .payload
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let payload = frame.payload.get("payload").cloned().unwrap_or(Value::Null);
        let (enabled, key) = {
            let Some(conn) = self.connections.get(connection_id) else {
                return Err(format!("unknown connection: {connection_id}"));
            };
            match conn.channels.get(&topic) {
                Some(ch) => (ch.presence_enabled, ch.presence_key.clone()),
                None => (false, None),
            }
        };
        if !enabled {
            return Ok(());
        }

        let diff = match action.as_str() {
            "track" => {
                let phx_ref = format!("F{}", self.next_phx_ref);
                self.next_phx_ref += 1;
                Some(
                    self.presence
                        .track(&topic, connection_id, key, phx_ref, payload),
                )
            }
            "untrack" => self.presence.untrack(&topic, connection_id),
            _ => None,
        };

        if let Some(diff) = diff {
            if !diff.is_empty() {
                let diff_value = json!({ "joins": diff.joins, "leaves": diff.leaves });
                self.fan_out_presence(&topic, "presence_diff", diff_value, out);
            }
        }
        if frame.reference.is_some() {
            out.frames.push(OutgoingFrame {
                connection_id: connection_id.to_string(),
                frame: Frame::ok(vsn, frame.join_ref, frame.reference, topic, json!({}))
                    .encode(vsn),
            });
        }
        Ok(())
    }

    fn on_cdc(
        &mut self,
        event: &Value,
        record_ref: Option<&str>,
        old_record_ref: Option<&str>,
    ) -> Result<Outcome, String> {
        let schema = event
            .get("schema")
            .and_then(Value::as_str)
            .unwrap_or("public");
        let table = event.get("table").and_then(Value::as_str).unwrap_or("");
        let change_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_uppercase();
        let record = event.get("record").cloned().unwrap_or(Value::Null);
        let old_record = event.get("old_record").cloned().unwrap_or(Value::Null);
        let filter_target = if change_type == "DELETE" {
            &old_record
        } else {
            &record
        };

        let mut out = Outcome::default();
        // Bindings still match against the real record; only the copy embedded
        // in the fan-out frames is replaced by the host's marker.
        let emitted_record = match record_ref {
            Some(id) => json!({ PAYLOAD_REF_KEY: id }),
            None => record.clone(),
        };
        let emitted_old_record = match old_record_ref {
            Some(id) => json!({ PAYLOAD_REF_KEY: id }),
            None => old_record.clone(),
        };
        let data = json!({
            "schema": schema,
            "table": table,
            "type": change_type,
            "eventType": change_type,
            "record": emitted_record,
            "old_record": emitted_old_record,
            "columns": event.get("columns").cloned().unwrap_or(Value::Null),
            "commit_timestamp": event.get("commit_timestamp").cloned().unwrap_or(Value::Null),
            "errors": event.get("errors").cloned().unwrap_or(Value::Null),
        });

        let mut matched: Vec<(String, String, Vec<u32>)> = Vec::new();
        for (connection_id, conn) in &self.connections {
            for (topic, channel) in &conn.channels {
                for binding in &channel.bindings {
                    let event_ok = binding.event == "*" || binding.event == change_type;
                    let schema_ok = binding.schema == "*" || binding.schema == schema;
                    let table_ok = binding.table == "*" || binding.table == table;
                    let filter_ok = binding
                        .filter
                        .as_ref()
                        .is_none_or(|f| f.matches(filter_target));
                    if event_ok && schema_ok && table_ok && filter_ok {
                        if let Some((_, _, ids)) =
                            matched.iter_mut().find(|(id, matched_topic, _)| {
                                id == connection_id && matched_topic == topic
                            })
                        {
                            ids.push(binding.id);
                        } else {
                            matched.push((connection_id.clone(), topic.clone(), vec![binding.id]));
                        }
                    }
                }
            }
        }

        for (connection_id, topic, ids) in matched {
            self.push_to_connection(
                &connection_id,
                &topic,
                "postgres_changes",
                json!({ "ids": ids, "data": data }),
                &mut out,
            );
        }
        Ok(out)
    }

    fn presence_state(&mut self, connection_id: &str, topic: &str) -> Outcome {
        let mut out = Outcome::default();
        let state = self.presence.state(topic);
        self.push_to_connection(connection_id, topic, "presence_state", state, &mut out);
        out
    }

    fn on_disconnect(&mut self, connection_id: &str) -> Result<Outcome, String> {
        let mut out = Outcome::default();
        let Some(conn) = self.connections.remove(connection_id) else {
            return Ok(out);
        };
        let mut diffs = Vec::new();
        for topic in &conn.channel_order {
            if let Some(diff) = self.presence.untrack(topic, connection_id) {
                if !diff.is_empty() {
                    diffs.push((topic.clone(), diff));
                }
            }
        }
        diffs.extend(self.presence.untrack_all(connection_id));
        for (topic, diff) in diffs {
            let diff_value = json!({ "joins": diff.joins, "leaves": diff.leaves });
            self.fan_out_presence(&topic, "presence_diff", diff_value, &mut out);
        }
        Ok(out)
    }

    fn broadcast_presence_leave(&mut self, topic: &str, connection_id: &str, out: &mut Outcome) {
        if let Some(diff) = self.presence.untrack(topic, connection_id) {
            if !diff.is_empty() {
                let diff_value = json!({ "joins": diff.joins, "leaves": diff.leaves });
                self.fan_out_presence(topic, "presence_diff", diff_value, out);
            }
        }
    }

    fn subscribers(&self, topic: &str) -> Vec<String> {
        let mut ids = Vec::new();
        for (id, conn) in &self.connections {
            if conn.channels.contains_key(topic) {
                ids.push(id.clone());
            }
        }
        ids
    }

    fn fan_out_presence(&self, topic: &str, event: &str, payload: Value, out: &mut Outcome) {
        for target in self.subscribers(topic) {
            self.push_to_connection(&target, topic, event, payload.clone(), out);
        }
    }

    fn push_to_connection(
        &self,
        connection_id: &str,
        topic: &str,
        event: &str,
        payload: Value,
        out: &mut Outcome,
    ) {
        let Some(conn) = self.connections.get(connection_id) else {
            return;
        };
        let frame = Frame {
            join_ref: None,
            reference: None,
            topic: topic.to_string(),
            event: event.to_string(),
            payload,
            vsn: conn.vsn,
            emit_join_ref: false,
        }
        .encode(conn.vsn);
        out.frames.push(OutgoingFrame {
            connection_id: connection_id.to_string(),
            frame,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(session: &mut Session, request: Value) -> Value {
        let raw = session.handle(request.to_string().as_str()).unwrap();
        serde_json::from_value(raw.into_json()).unwrap()
    }

    fn join(session: &mut Session, connection: &str, topic: &str, config: Value) {
        let _ = call(
            session,
            json!({
                "op": "frame",
                "connection_id": connection,
                "frame": ["1", "1", topic, "phx_join", { "config": config }],
            }),
        );
    }

    #[test]
    fn public_join_replies_and_advertises_bindings() {
        let mut session = Session::new();
        let out = call(
            &mut session,
            json!({
                "op": "frame",
                "connection_id": "c1",
                "frame": ["1", "1", "realtime:room", "phx_join", {
                    "config": { "postgres_changes": [
                        { "event": "INSERT", "schema": "public", "table": "todos" }
                    ] }
                }],
            }),
        );
        let frames = out["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 2);
        let frame = &frames[0]["frame"];
        assert_eq!(frame[3], json!("phx_reply"));
        assert_eq!(frame[4]["status"], json!("ok"));
        assert_eq!(
            frame[4]["response"]["postgres_changes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn private_join_waits_for_authorization() {
        let mut session = Session::new();
        let out = call(
            &mut session,
            json!({
                "op": "frame",
                "connection_id": "c1",
                "frame": ["1", "1", "realtime:secret", "phx_join", {
                    "config": { "private": true }
                }],
            }),
        );
        assert!(out["frames"].as_array().unwrap().is_empty());
        let request_id = out["effects"][0]["request_id"]
            .as_str()
            .unwrap()
            .to_string();

        let denied = call(
            &mut session,
            json!({
                "op": "authorize_result",
                "connection_id": "c1",
                "request_id": request_id,
                "read": false,
                "write": false,
            }),
        );
        let frame = &denied["frames"][0]["frame"];
        assert_eq!(frame[4]["status"], json!("error"));
        assert_eq!(frame[4]["response"]["reason"], json!("Unauthorized"));
    }

    #[test]
    fn cdc_matches_event_table_and_filter() {
        let mut session = Session::new();
        join(
            &mut session,
            "c1",
            "realtime:room",
            json!({ "postgres_changes": [
                { "event": "INSERT", "schema": "public", "table": "todos", "filter": "done=eq.false" }
            ] }),
        );
        let out = call(
            &mut session,
            json!({
                "op": "cdc",
                "event": {
                    "schema": "public", "table": "todos", "type": "INSERT",
                    "record": { "id": 1, "done": false }
                },
            }),
        );
        assert_eq!(out["frames"].as_array().unwrap().len(), 1);
        assert_eq!(out["frames"][0]["frame"][3], json!("postgres_changes"));

        let skipped = call(
            &mut session,
            json!({
                "op": "cdc",
                "event": {
                    "schema": "public", "table": "todos", "type": "INSERT",
                    "record": { "id": 2, "done": true }
                },
            }),
        );
        assert!(skipped["frames"].as_array().unwrap().is_empty());
    }

    #[test]
    fn cdc_payload_ref_keeps_record_out_of_frames() {
        let mut session = Session::new();
        join(
            &mut session,
            "c1",
            "realtime:room",
            json!({ "postgres_changes": [
                { "event": "INSERT", "schema": "public", "table": "todos", "filter": "done=eq.false" }
            ] }),
        );
        let out = call(
            &mut session,
            json!({
                "op": "cdc",
                "event": {
                    "schema": "public", "table": "todos", "type": "INSERT",
                    "record": { "id": 1, "done": false, "blob": "x".repeat(64) }
                },
                "record_ref": "p1",
            }),
        );
        let frame = &out["frames"][0]["frame"];
        // The filter still ran against the real record, but the frame carries the
        // host's marker instead of a second copy of the payload.
        assert_eq!(frame[4]["data"]["record"], json!({ PAYLOAD_REF_KEY: "p1" }));
    }

    #[test]
    fn cdc_merges_multiple_matching_bindings_into_one_frame() {
        let mut session = Session::new();
        join(
            &mut session,
            "c1",
            "realtime:room",
            json!({ "postgres_changes": [
                { "id": 10, "event": "INSERT", "schema": "public", "table": "todos" },
                { "id": 11, "event": "*", "schema": "public", "table": "todos" }
            ] }),
        );

        let out = call(
            &mut session,
            json!({
                "op": "cdc",
                "event": {
                    "schema": "public", "table": "todos", "type": "INSERT",
                    "record": { "id": 1 }
                },
            }),
        );
        assert_eq!(out["frames"].as_array().unwrap().len(), 1);
        assert_eq!(out["frames"][0]["frame"][4]["ids"], json!([10, 11]));
    }

    #[test]
    fn broadcast_fans_out_and_honours_self_flag() {
        let mut session = Session::new();
        join(
            &mut session,
            "c1",
            "realtime:room",
            json!({ "broadcast": { "self": false } }),
        );
        join(&mut session, "c2", "realtime:room", json!({}));

        let out = call(
            &mut session,
            json!({
                "op": "frame",
                "connection_id": "c1",
                "frame": ["1", "2", "realtime:room", "broadcast", {
                    "type": "broadcast", "event": "cursor", "payload": { "x": 1 }
                }],
            }),
        );
        let mut targets: Vec<&str> = out["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["connection_id"].as_str().unwrap())
            .collect();
        targets.sort();
        assert_eq!(targets, vec!["c2"]);
    }

    #[test]
    fn disconnect_emits_presence_leaves() {
        let mut session = Session::new();
        join(
            &mut session,
            "c1",
            "realtime:chat",
            json!({ "presence": {} }),
        );
        join(
            &mut session,
            "c2",
            "realtime:chat",
            json!({ "presence": {} }),
        );
        let _ = call(
            &mut session,
            json!({
                "op": "frame",
                "connection_id": "c1",
                "frame": ["1", "3", "realtime:chat", "presence", {
                    "event": "track", "payload": { "key": "u1", "name": "ada" }
                }],
            }),
        );
        let out = call(
            &mut session,
            json!({ "op": "disconnect", "connection_id": "c1" }),
        );
        let leaves = out["frames"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["frame"][3] == json!("presence_diff"))
            .count();
        assert!(leaves >= 1);
    }
}
