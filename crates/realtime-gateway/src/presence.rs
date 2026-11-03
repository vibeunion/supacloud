use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceMeta {
    pub phx_ref: String,
    pub payload: Value,
}

fn topic_key(tenant_id: &str, topic: &str) -> String {
    format!("{tenant_id}\u{1f}{topic}")
}

fn strip_topic_key<'a>(tenant_id: &str, key: &'a str) -> &'a str {
    key.strip_prefix(&format!("{tenant_id}\u{1f}"))
        .unwrap_or(key)
}

#[derive(Debug, Default)]
pub struct PresenceManager {
    // ((tenant, topic), connection_id) -> Vec<(key, PresenceMeta)>
    connection_presences: HashMap<(String, String), Vec<(String, PresenceMeta)>>,
    // (tenant, topic) -> key -> Vec<PresenceMeta>
    topic_states: HashMap<String, HashMap<String, Vec<PresenceMeta>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceDiff {
    pub joins: HashMap<String, Value>,
    pub leaves: HashMap<String, Value>,
}

impl PresenceManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Track a presence for a connection on a given topic
    pub fn track(
        &mut self,
        tenant_id: &str,
        connection_id: &str,
        topic: &str,
        key: Option<String>,
        payload: Value,
    ) -> PresenceDiff {
        let scoped_topic = topic_key(tenant_id, topic);
        let phx_ref = format!("F{}", Uuid::new_v4().simple());

        // Derive key from key param, or payload.user_id, or payload.key, or connection_id
        let resolved_key = key
            .or_else(|| {
                payload
                    .get("key")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .or_else(|| {
                payload.get("user_id").map(|v| match v {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => v.to_string(),
                })
            })
            .unwrap_or_else(|| connection_id.to_string());

        let mut meta_map = match payload.clone() {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        meta_map.insert("phx_ref".to_string(), Value::String(phx_ref.clone()));
        let meta_value = Value::Object(meta_map);

        let meta = PresenceMeta {
            phx_ref,
            payload: meta_value.clone(),
        };

        // Add to connection_presences
        let conn_key = (scoped_topic.clone(), connection_id.to_string());
        self.connection_presences
            .entry(conn_key)
            .or_default()
            .push((resolved_key.clone(), meta.clone()));

        // Add to topic_states
        let topic_map = self.topic_states.entry(scoped_topic).or_default();
        topic_map
            .entry(resolved_key.clone())
            .or_default()
            .push(meta);

        let mut joins = HashMap::new();
        joins.insert(
            resolved_key,
            json!({
                "metas": [meta_value]
            }),
        );

        PresenceDiff {
            joins,
            leaves: HashMap::new(),
        }
    }

    /// Untrack presences for a connection on a topic
    pub fn untrack(
        &mut self,
        tenant_id: &str,
        connection_id: &str,
        topic: &str,
    ) -> Option<PresenceDiff> {
        let scoped_topic = topic_key(tenant_id, topic);
        let conn_key = (scoped_topic.clone(), connection_id.to_string());
        let removed = self.connection_presences.remove(&conn_key)?;
        if removed.is_empty() {
            return None;
        }

        let mut leaves: HashMap<String, Value> = HashMap::new();
        if let Some(topic_map) = self.topic_states.get_mut(&scoped_topic) {
            for (key, meta) in removed {
                if let Some(metas) = topic_map.get_mut(&key) {
                    metas.retain(|m| m.phx_ref != meta.phx_ref);
                    if metas.is_empty() {
                        topic_map.remove(&key);
                    }
                }
                leaves.insert(
                    key,
                    json!({
                        "metas": [meta.payload]
                    }),
                );
            }
            if topic_map.is_empty() {
                self.topic_states.remove(&scoped_topic);
            }
        }

        Some(PresenceDiff {
            joins: HashMap::new(),
            leaves,
        })
    }

    /// Called on connection disconnect. Untracks from all topics.
    pub fn untrack_all(
        &mut self,
        tenant_id: &str,
        connection_id: &str,
    ) -> Vec<(String, PresenceDiff)> {
        let keys_to_remove: Vec<(String, String)> = self
            .connection_presences
            .keys()
            .filter(|(topic, conn)| {
                conn == connection_id && strip_topic_key(tenant_id, topic) != *topic
            })
            .cloned()
            .collect();

        let mut result = Vec::new();
        for (topic, conn) in keys_to_remove {
            let original_topic = strip_topic_key(tenant_id, &topic).to_string();
            if let Some(diff) = self.untrack(tenant_id, &conn, &original_topic) {
                if !diff.leaves.is_empty() {
                    result.push((original_topic, diff));
                }
            }
        }
        result
    }

    /// Get current presence state for a topic
    pub fn get_state(&self, tenant_id: &str, topic: &str) -> Value {
        let mut map = serde_json::Map::new();
        if let Some(topic_map) = self.topic_states.get(&topic_key(tenant_id, topic)) {
            for (key, metas) in topic_map {
                let metas_json: Vec<Value> = metas.iter().map(|m| m.payload.clone()).collect();
                map.insert(key.clone(), json!({ "metas": metas_json }));
            }
        }
        Value::Object(map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_presence_lifecycle() {
        let mut manager = PresenceManager::new();
        let topic = "realtime:chat";
        let conn_id = "conn_1";

        // Track user
        let diff = manager.track(
            "tenant_a",
            conn_id,
            topic,
            Some("user_alice".to_string()),
            json!({"name": "Alice", "online_at": "now"}),
        );
        assert!(diff.joins.contains_key("user_alice"));
        assert!(diff.leaves.is_empty());

        // Check state
        let state = manager.get_state("tenant_a", topic);
        assert!(state.get("user_alice").is_some());

        // Untrack
        let untrack_diff = manager.untrack("tenant_a", conn_id, topic).unwrap();
        assert!(untrack_diff.leaves.contains_key("user_alice"));

        // Check state is now empty
        let empty_state = manager.get_state("tenant_a", topic);
        assert_eq!(empty_state, json!({}));
    }

    #[test]
    fn test_untrack_all_on_disconnect() {
        let mut manager = PresenceManager::new();
        manager.track(
            "tenant_a",
            "conn_x",
            "realtime:room1",
            Some("u1".into()),
            json!({}),
        );
        manager.track(
            "tenant_a",
            "conn_x",
            "realtime:room2",
            Some("u1".into()),
            json!({}),
        );

        let diffs = manager.untrack_all("tenant_a", "conn_x");
        assert_eq!(diffs.len(), 2);
    }
}
