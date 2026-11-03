use crate::filter::ColumnFilter;
use crate::presence::{PresenceDiff, PresenceManager};
use crate::protocol::PhoenixV2Message;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

static CONN_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn next_connection_id() -> String {
    format!("conn_{}", CONN_COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresChangeSubscription {
    pub id: Option<String>,
    pub event: String,
    pub schema: String,
    pub table: Option<String>,
    pub filter: Option<ColumnFilter>,
}

#[derive(Debug, Clone)]
pub struct TopicSubscriptionConfig {
    pub join_ref: Option<String>,
    pub broadcast_self: bool,
    pub broadcast_ack: bool,
    pub presence_key: Option<String>,
    pub postgres_changes: Vec<PostgresChangeSubscription>,
}

pub struct ConnectionState {
    pub id: String,
    pub tenant_id: String,
    pub role: String,
    pub tx: mpsc::UnboundedSender<PhoenixV2Message>,
    pub subscriptions: HashMap<String, TopicSubscriptionConfig>,
}

fn topic_key(tenant_id: &str, topic: &str) -> String {
    format!("{tenant_id}\u{1f}{topic}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresChangeEvent {
    pub schema: String,
    pub table: String,
    #[serde(rename = "type")]
    pub change_type: String, // "INSERT" | "UPDATE" | "DELETE"
    #[serde(default)]
    pub record: Value,
    #[serde(default)]
    pub old_record: Option<Value>,
    #[serde(default)]
    pub columns: Option<Value>,
    #[serde(default)]
    pub commit_timestamp: Option<String>,
}

pub struct ChannelHub {
    // connection_id -> ConnectionState
    connections: RwLock<HashMap<String, ConnectionState>>,
    // (tenant_id, topic) -> Set<connection_id>
    topic_subscribers: RwLock<HashMap<String, HashSet<String>>>,
    // presence manager
    presence: RwLock<PresenceManager>,
}

impl ChannelHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connections: RwLock::new(HashMap::new()),
            topic_subscribers: RwLock::new(HashMap::new()),
            presence: RwLock::new(PresenceManager::new()),
        })
    }

    /// Register a new active WebSocket connection
    pub fn add_connection(
        &self,
        id: String,
        tenant_id: String,
        role: String,
        tx: mpsc::UnboundedSender<PhoenixV2Message>,
    ) {
        let state = ConnectionState {
            id: id.clone(),
            tenant_id,
            role,
            tx,
            subscriptions: HashMap::new(),
        };
        self.connections.write().insert(id, state);
    }

    /// Subscribe connection to a topic
    pub fn subscribe(
        &self,
        connection_id: &str,
        tenant_id: &str,
        topic: &str,
        config: TopicSubscriptionConfig,
    ) {
        let mut conns = self.connections.write();
        if let Some(conn) = conns.get_mut(connection_id) {
            conn.subscriptions.insert(topic.to_string(), config);
        }

        let mut topics = self.topic_subscribers.write();
        topics
            .entry(topic_key(tenant_id, topic))
            .or_default()
            .insert(connection_id.to_string());
    }

    /// Unsubscribe connection from a topic
    pub fn unsubscribe(
        &self,
        connection_id: &str,
        tenant_id: &str,
        topic: &str,
    ) -> Option<PresenceDiff> {
        let mut conns = self.connections.write();
        if let Some(conn) = conns.get_mut(connection_id) {
            conn.subscriptions.remove(topic);
        }

        let key = topic_key(tenant_id, topic);
        let mut topics = self.topic_subscribers.write();
        if let Some(subs) = topics.get_mut(&key) {
            subs.remove(connection_id);
            if subs.is_empty() {
                topics.remove(&key);
            }
        }

        self.presence
            .write()
            .untrack(tenant_id, connection_id, topic)
    }

    /// Disconnect connection and cleanup all state
    pub fn remove_connection(&self, connection_id: &str) -> Vec<(String, PresenceDiff)> {
        let (tenant_id, joined_topics) = {
            let mut conns = self.connections.write();
            if let Some(conn) = conns.remove(connection_id) {
                (
                    conn.tenant_id.clone(),
                    conn.subscriptions.keys().cloned().collect::<Vec<_>>(),
                )
            } else {
                (String::new(), Vec::new())
            }
        };

        if tenant_id.is_empty() {
            return Vec::new();
        }

        {
            let mut topics = self.topic_subscribers.write();
            for topic in &joined_topics {
                let key = topic_key(&tenant_id, topic);
                if let Some(subs) = topics.get_mut(&key) {
                    subs.remove(connection_id);
                    if subs.is_empty() {
                        topics.remove(&key);
                    }
                }
            }
        }

        let mut diffs = Vec::new();
        for topic in joined_topics {
            if let Some(diff) = self
                .presence
                .write()
                .untrack(&tenant_id, connection_id, &topic)
            {
                diffs.push((topic, diff));
            }
        }
        diffs
    }

    /// Send a message directly to a specific connection
    pub fn send_to_connection(&self, connection_id: &str, msg: PhoenixV2Message) {
        let conns = self.connections.read();
        if let Some(conn) = conns.get(connection_id) {
            let _ = conn.tx.send(msg);
        }
    }

    /// Broadcast client message to all other subscribers of the topic
    pub fn broadcast(&self, sender_id: Option<&str>, tenant_id: &str, topic: &str, payload: Value) {
        let msg = PhoenixV2Message::broadcast(topic, payload);
        self.send_to_topic(tenant_id, topic, sender_id, msg);
    }

    /// Broadcast a Phoenix message to all subscribers of a topic in one tenant.
    pub fn send_to_topic(
        &self,
        tenant_id: &str,
        topic: &str,
        sender_id: Option<&str>,
        msg: PhoenixV2Message,
    ) {
        let subscriber_ids = {
            let topics = self.topic_subscribers.read();
            topics
                .get(&topic_key(tenant_id, topic))
                .cloned()
                .unwrap_or_default()
        };

        let conns = self.connections.read();
        for conn_id in subscriber_ids {
            if let Some(conn) = conns.get(&conn_id) {
                // If sender, check broadcast_self preference
                if let Some(sid) = sender_id {
                    if sid == conn_id {
                        let self_allowed = conn
                            .subscriptions
                            .get(topic)
                            .map(|sub| sub.broadcast_self)
                            .unwrap_or(false);
                        if !self_allowed {
                            continue;
                        }
                    }
                }
                let _ = conn.tx.send(msg.clone());
            }
        }
    }

    /// Track presence for a connection on a topic and return the diff to broadcast
    pub fn track_presence(
        &self,
        connection_id: &str,
        tenant_id: &str,
        topic: &str,
        key: Option<String>,
        payload: Value,
    ) -> PresenceDiff {
        self.presence
            .write()
            .track(tenant_id, connection_id, topic, key, payload)
    }

    /// Untrack presence for a connection on a topic
    pub fn untrack_presence(
        &self,
        connection_id: &str,
        tenant_id: &str,
        topic: &str,
    ) -> Option<PresenceDiff> {
        self.presence
            .write()
            .untrack(tenant_id, connection_id, topic)
    }

    /// Get current presence state for one tenant topic
    pub fn get_presence_state(&self, tenant_id: &str, topic: &str) -> Value {
        self.presence.read().get_state(tenant_id, topic)
    }

    /// Dispatch CDC event to all subscribers matching the change
    pub fn dispatch_cdc(&self, tenant_id: &str, change: &PostgresChangeEvent) {
        let conns = self.connections.read();
        let timestamp = change
            .commit_timestamp
            .clone()
            .unwrap_or_else(|| chrono_like_now());

        for conn in conns.values() {
            if conn.tenant_id != tenant_id {
                continue;
            }

            for (topic, sub) in &conn.subscriptions {
                let mut matched_ids = Vec::new();

                for pcs in &sub.postgres_changes {
                    // 1. Check event type
                    if pcs.event != "*" && !pcs.event.eq_ignore_ascii_case(&change.change_type) {
                        continue;
                    }

                    // 2. Check schema
                    if pcs.schema != "*" && pcs.schema != change.schema {
                        continue;
                    }

                    // 3. Check table
                    if let Some(ref tbl) = pcs.table {
                        if tbl != "*" && tbl != &change.table {
                            continue;
                        }
                    }

                    // 4. Check filter against record (or old_record if DELETE)
                    if let Some(ref flt) = pcs.filter {
                        let target_record = if change.change_type.eq_ignore_ascii_case("DELETE") {
                            change.old_record.as_ref().unwrap_or(&change.record)
                        } else {
                            &change.record
                        };
                        if !flt.matches(target_record) {
                            continue;
                        }
                    }

                    matched_ids.push(pcs.id.clone().unwrap_or_else(|| "0".to_string()));
                }

                if !matched_ids.is_empty() {
                    let mut payload_map = serde_json::Map::new();
                    let data = json!({
                        "schema": change.schema,
                        "table": change.table,
                        "type": change.change_type,
                        "commit_timestamp": timestamp,
                        "record": change.record,
                        "old_record": change.old_record,
                        "columns": change.columns.clone().unwrap_or(json!([])),
                        "errors": []
                    });

                    payload_map.insert("data".to_string(), data);
                    payload_map.insert("ids".to_string(), json!(matched_ids));

                    let msg = PhoenixV2Message::postgres_changes(
                        topic.clone(),
                        Value::Object(payload_map),
                    );
                    let _ = conn.tx.send(msg);
                }
            }
        }
    }

    /// Return total active connections count
    pub fn connection_count(&self) -> usize {
        self.connections.read().len()
    }

    /// Return total active topics count
    pub fn topic_count(&self) -> usize {
        self.topic_subscribers.read().len()
    }
}

fn chrono_like_now() -> String {
    // Generate ISO8601 timestamp string without heavy external chrono crate
    use std::time::SystemTime;
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    format!("{}.{:03}Z", secs, millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_broadcast_and_subscription() {
        let hub = ChannelHub::new();
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();

        hub.add_connection("c1".into(), "tenant1".into(), "service_role".into(), tx1);
        hub.add_connection("c2".into(), "tenant1".into(), "service_role".into(), tx2);

        hub.subscribe(
            "c1",
            "tenant1",
            "room1",
            TopicSubscriptionConfig {
                join_ref: Some("1".into()),
                broadcast_self: false,
                broadcast_ack: false,
                presence_key: None,
                postgres_changes: vec![],
            },
        );

        hub.subscribe(
            "c2",
            "tenant1",
            "room1",
            TopicSubscriptionConfig {
                join_ref: Some("1".into()),
                broadcast_self: false,
                broadcast_ack: false,
                presence_key: None,
                postgres_changes: vec![],
            },
        );

        // Broadcast from c1
        hub.broadcast(Some("c1"), "tenant1", "room1", json!({"hello": "world"}));

        // c1 should not receive it (broadcast_self: false)
        assert!(rx1.try_recv().is_err());

        // c2 should receive it
        let received = rx2.try_recv().unwrap();
        assert_eq!(received.event, "broadcast");
        assert_eq!(received.payload["hello"], "world");
    }

    #[tokio::test]
    async fn test_broadcast_is_tenant_scoped() {
        let hub = ChannelHub::new();
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();

        hub.add_connection("a".into(), "tenant_a".into(), "service_role".into(), tx_a);
        hub.add_connection("b".into(), "tenant_b".into(), "service_role".into(), tx_b);

        for (conn, tenant) in [("a", "tenant_a"), ("b", "tenant_b")] {
            hub.subscribe(
                conn,
                tenant,
                "room1",
                TopicSubscriptionConfig {
                    join_ref: Some("1".into()),
                    broadcast_self: false,
                    broadcast_ack: false,
                    presence_key: None,
                    postgres_changes: vec![],
                },
            );
        }

        hub.broadcast(Some("a"), "tenant_a", "room1", json!({"hello": "a"}));

        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_err());
        assert_eq!(hub.get_presence_state("tenant_b", "room1"), json!({}));
    }

    #[tokio::test]
    async fn test_cdc_dispatch_with_filter() {
        let hub = ChannelHub::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        hub.add_connection("c1".into(), "tenant_a".into(), "service_role".into(), tx);

        let filter = ColumnFilter::parse("id=eq.42").unwrap();
        hub.subscribe(
            "c1",
            "tenant_a",
            "realtime:public:messages",
            TopicSubscriptionConfig {
                join_ref: Some("1".into()),
                broadcast_self: false,
                broadcast_ack: false,
                presence_key: None,
                postgres_changes: vec![PostgresChangeSubscription {
                    id: Some("sub_1".into()),
                    event: "INSERT".into(),
                    schema: "public".into(),
                    table: Some("messages".into()),
                    filter: Some(filter),
                }],
            },
        );

        // Non-matching change (id = 99)
        hub.dispatch_cdc(
            "tenant_a",
            &PostgresChangeEvent {
                schema: "public".into(),
                table: "messages".into(),
                change_type: "INSERT".into(),
                record: json!({"id": 99, "text": "no match"}),
                old_record: None,
                columns: None,
                commit_timestamp: None,
            },
        );
        assert!(rx.try_recv().is_err());

        // Matching change (id = 42)
        hub.dispatch_cdc(
            "tenant_a",
            &PostgresChangeEvent {
                schema: "public".into(),
                table: "messages".into(),
                change_type: "INSERT".into(),
                record: json!({"id": 42, "text": "match!"}),
                old_record: None,
                columns: None,
                commit_timestamp: None,
            },
        );

        let event = rx.try_recv().unwrap();
        assert_eq!(event.event, "postgres_changes");
        assert_eq!(event.payload["data"]["record"]["id"], 42);
        assert_eq!(event.payload["ids"], json!(["sub_1"]));
    }
}
