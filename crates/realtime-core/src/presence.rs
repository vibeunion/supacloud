//! Presence tracking without any transport or clock dependency.
//!
//! `phx_ref` values are supplied by the caller so the core stays deterministic
//! and testable; the Bun binding generates UUIDs and passes them in, which also
//! keeps the crate free of a random source.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct PresenceMeta {
    pub phx_ref: String,
    pub payload: Value,
}

/// A join/leave delta ready to be pushed as `presence_diff`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PresenceDiff {
    pub joins: Map<String, Value>,
    pub leaves: Map<String, Value>,
}

impl PresenceDiff {
    pub fn is_empty(&self) -> bool {
        self.joins.is_empty() && self.leaves.is_empty()
    }
}

#[derive(Debug, Default)]
pub struct PresenceManager {
    /// (topic, connection_id) -> tracked (key, meta)
    by_connection: HashMap<(String, String), Vec<(String, PresenceMeta)>>,
    /// topic -> key -> metas
    by_topic: HashMap<String, HashMap<String, Vec<PresenceMeta>>>,
}

impl PresenceManager {
    pub fn track(
        &mut self,
        topic: &str,
        connection_id: &str,
        key: Option<String>,
        phx_ref: String,
        payload: Value,
    ) -> PresenceDiff {
        let resolved = key.unwrap_or_else(|| derive_key(connection_id, &payload));
        let connection_key = (topic.to_string(), connection_id.to_string());
        let previous = self.by_connection.remove(&connection_key).unwrap_or_default();
        let mut leaves_by_key: HashMap<String, Vec<Value>> = HashMap::new();

        if let Some(topic_map) = self.by_topic.get_mut(topic) {
            for (old_key, old_meta) in previous {
                if let Some(metas) = topic_map.get_mut(&old_key) {
                    metas.retain(|meta| meta.phx_ref != old_meta.phx_ref);
                }
                leaves_by_key
                    .entry(old_key)
                    .or_default()
                    .push(old_meta.payload);
            }
            topic_map.retain(|_, metas| !metas.is_empty());
        }
        if self
            .by_topic
            .get(topic)
            .is_some_and(|topic_map| topic_map.is_empty())
        {
            self.by_topic.remove(topic);
        }

        let mut meta = match payload {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        meta.insert("phx_ref".into(), Value::String(phx_ref.clone()));
        let meta_value = Value::Object(meta);

        let entry = PresenceMeta {
            phx_ref,
            payload: meta_value.clone(),
        };

        self.by_connection
            .entry(connection_key)
            .or_default()
            .push((resolved.clone(), entry.clone()));

        self.by_topic
            .entry(topic.to_string())
            .or_default()
            .entry(resolved.clone())
            .or_default()
            .push(entry);

        let mut joins = Map::new();
        joins.insert(resolved, json!({ "metas": [meta_value] }));
        let leaves = leaves_by_key
            .into_iter()
            .map(|(key, metas)| (key, json!({ "metas": metas })))
            .collect();
        PresenceDiff {
            joins,
            leaves,
        }
    }

    pub fn untrack(&mut self, topic: &str, connection_id: &str) -> Option<PresenceDiff> {
        let removed = self
            .by_connection
            .remove(&(topic.to_string(), connection_id.to_string()))?;
        if removed.is_empty() {
            return None;
        }

        let mut leaves = Map::new();
        if let Some(topic_map) = self.by_topic.get_mut(topic) {
            for (key, meta) in removed {
                if let Some(metas) = topic_map.get_mut(&key) {
                    metas.retain(|m| m.phx_ref != meta.phx_ref);
                    if metas.is_empty() {
                        topic_map.remove(&key);
                    }
                }
                leaves.insert(key, json!({ "metas": [meta.payload] }));
            }
            if topic_map.is_empty() {
                self.by_topic.remove(topic);
            }
        }

        Some(PresenceDiff {
            joins: Map::new(),
            leaves,
        })
    }

    /// Drop every topic for a connection (socket close).
    pub fn untrack_all(&mut self, connection_id: &str) -> Vec<(String, PresenceDiff)> {
        let topics: Vec<String> = self
            .by_connection
            .keys()
            .filter(|(_, conn)| conn == connection_id)
            .map(|(topic, _)| topic.clone())
            .collect();

        let mut diffs = Vec::new();
        for topic in topics {
            if let Some(diff) = self.untrack(&topic, connection_id) {
                if !diff.leaves.is_empty() {
                    diffs.push((topic, diff));
                }
            }
        }
        diffs
    }

    pub fn state(&self, topic: &str) -> Value {
        let mut out = Map::new();
        if let Some(topic_map) = self.by_topic.get(topic) {
            for (key, metas) in topic_map {
                let metas: Vec<Value> = metas.iter().map(|m| m.payload.clone()).collect();
                out.insert(key.clone(), json!({ "metas": metas }));
            }
        }
        Value::Object(out)
    }
}

fn derive_key(connection_id: &str, payload: &Value) -> String {
    if let Some(key) = payload.get("key").and_then(Value::as_str) {
        return key.to_string();
    }
    if let Some(user_id) = payload.get("user_id") {
        return match user_id {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            other => other.to_string(),
        };
    }
    connection_id.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_untrack_lifecycle() {
        let mut manager = PresenceManager::default();
        let diff = manager.track(
            "realtime:chat",
            "conn_1",
            Some("user_1".into()),
            "F1".into(),
            json!({"name": "ada"}),
        );
        assert!(diff.joins.contains_key("user_1"));
        assert_eq!(
            manager.state("realtime:chat")["user_1"]["metas"][0]["name"],
            json!("ada")
        );

        let leave = manager.untrack("realtime:chat", "conn_1").unwrap();
        assert!(leave.leaves.contains_key("user_1"));
        assert_eq!(manager.state("realtime:chat"), json!({}));
    }

    #[test]
    fn multiple_metas_per_key() {
        let mut manager = PresenceManager::default();
        manager.track("t", "c1", Some("u".into()), "F1".into(), json!({}));
        manager.track("t", "c2", Some("u".into()), "F2".into(), json!({}));
        assert_eq!(
            manager.state("t")["u"]["metas"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn retracking_replaces_the_connection_meta() {
        let mut manager = PresenceManager::default();
        manager.track("t", "c1", Some("u".into()), "F1".into(), json!({"name": "ada"}));
        let diff = manager.track("t", "c1", Some("u".into()), "F2".into(), json!({"name": "grace"}));

        assert_eq!(manager.state("t")["u"]["metas"].as_array().unwrap().len(), 1);
        assert_eq!(manager.state("t")["u"]["metas"][0]["name"], json!("grace"));
        assert_eq!(diff.leaves["u"]["metas"][0]["name"], json!("ada"));
        assert_eq!(diff.joins["u"]["metas"][0]["name"], json!("grace"));
    }

    #[test]
    fn untrack_all_returns_each_topic() {
        let mut manager = PresenceManager::default();
        manager.track("a", "c1", None, "F1".into(), json!({}));
        manager.track("b", "c1", None, "F2".into(), json!({}));
        let diffs = manager.untrack_all("c1");
        assert_eq!(diffs.len(), 2);
    }
}
