use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("Invalid Phoenix V2 frame format: expected a 5-element array [join_ref, ref, topic, event, payload]")]
    InvalidFrameFormat,
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// Phoenix V2 wire message frame: `[join_ref, ref, topic, event, payload]`
#[derive(Debug, Clone, PartialEq)]
pub struct PhoenixV2Message {
    pub join_ref: Option<String>,
    pub reference: Option<String>,
    pub topic: String,
    pub event: String,
    pub payload: Value,
}

impl PhoenixV2Message {
    pub fn new(
        join_ref: Option<String>,
        reference: Option<String>,
        topic: impl Into<String>,
        event: impl Into<String>,
        payload: Value,
    ) -> Self {
        Self {
            join_ref,
            reference,
            topic: topic.into(),
            event: event.into(),
            payload,
        }
    }

    /// Construct a Phoenix reply frame `phx_reply`
    pub fn reply(
        join_ref: Option<String>,
        reference: Option<String>,
        topic: impl Into<String>,
        status: &str,
        response: Value,
    ) -> Self {
        let payload = serde_json::json!({
            "status": status,
            "response": response
        });
        Self {
            join_ref,
            reference,
            topic: topic.into(),
            event: "phx_reply".to_string(),
            payload,
        }
    }

    /// Construct an error reply
    pub fn error_reply(
        join_ref: Option<String>,
        reference: Option<String>,
        topic: impl Into<String>,
        reason: &str,
    ) -> Self {
        let payload = serde_json::json!({
            "status": "error",
            "response": { "reason": reason }
        });
        Self {
            join_ref,
            reference,
            topic: topic.into(),
            event: "phx_reply".to_string(),
            payload,
        }
    }

    /// Construct a broadcast message frame
    pub fn broadcast(topic: impl Into<String>, payload: Value) -> Self {
        Self {
            join_ref: None,
            reference: None,
            topic: topic.into(),
            event: "broadcast".to_string(),
            payload,
        }
    }

    /// Construct a postgres_changes event frame
    pub fn postgres_changes(topic: impl Into<String>, payload: Value) -> Self {
        Self {
            join_ref: None,
            reference: None,
            topic: topic.into(),
            event: "postgres_changes".to_string(),
            payload,
        }
    }

    /// Construct a presence_diff event frame
    pub fn presence_diff(topic: impl Into<String>, joins: Value, leaves: Value) -> Self {
        let payload = serde_json::json!({
            "joins": joins,
            "leaves": leaves
        });
        Self {
            join_ref: None,
            reference: None,
            topic: topic.into(),
            event: "presence_diff".to_string(),
            payload,
        }
    }

    /// Construct a presence_state event frame
    pub fn presence_state(topic: impl Into<String>, state: Value) -> Self {
        Self {
            join_ref: None,
            reference: None,
            topic: topic.into(),
            event: "presence_state".to_string(),
            payload: state,
        }
    }

    /// Encode message to Phoenix V2 JSON string array
    pub fn encode(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Decode Phoenix V2 JSON string array into PhoenixV2Message
    pub fn decode(raw: &str) -> Result<Self, ProtocolError> {
        serde_json::from_str(raw).map_err(|_| ProtocolError::InvalidFrameFormat)
    }
}

impl Serialize for PhoenixV2Message {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeSeq;
        let mut seq = serializer.serialize_seq(Some(5))?;
        seq.serialize_element(&self.join_ref)?;
        seq.serialize_element(&self.reference)?;
        seq.serialize_element(&self.topic)?;
        seq.serialize_element(&self.event)?;
        seq.serialize_element(&self.payload)?;
        seq.end()
    }
}

impl<'de> Deserialize<'de> for PhoenixV2Message {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let arr = Vec::<Value>::deserialize(deserializer)?;
        if arr.len() != 5 {
            return Err(serde::de::Error::custom(
                "expected array of 5 elements: [join_ref, ref, topic, event, payload]",
            ));
        }

        let mut it = arr.into_iter();
        let join_ref_val = it.next().unwrap();
        let ref_val = it.next().unwrap();
        let topic_val = it.next().unwrap();
        let event_val = it.next().unwrap();
        let payload_val = it.next().unwrap();

        let join_ref = match join_ref_val {
            Value::String(s) => Some(s),
            Value::Null => None,
            other => Some(other.to_string()),
        };

        let reference = match ref_val {
            Value::String(s) => Some(s),
            Value::Null => None,
            other => Some(other.to_string()),
        };

        let topic = match topic_val {
            Value::String(s) => s,
            _ => return Err(serde::de::Error::custom("expected topic to be a string")),
        };

        let event = match event_val {
            Value::String(s) => s,
            _ => return Err(serde::de::Error::custom("expected event to be a string")),
        };

        Ok(PhoenixV2Message {
            join_ref,
            reference,
            topic,
            event,
            payload: payload_val,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_phoenix_v2_encode_decode() {
        let msg = PhoenixV2Message::new(
            Some("1".to_string()),
            Some("2".to_string()),
            "realtime:room-1",
            "phx_join",
            json!({"config": {"broadcast": {"ack": true}}}),
        );

        let encoded = msg.encode().unwrap();
        assert_eq!(
            encoded,
            r#"["1","2","realtime:room-1","phx_join",{"config":{"broadcast":{"ack":true}}}]"#
        );

        let decoded = PhoenixV2Message::decode(&encoded).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn test_phoenix_v2_null_refs() {
        let raw = r#"[null,null,"phoenix","heartbeat",{}]"#;
        let decoded = PhoenixV2Message::decode(raw).unwrap();
        assert_eq!(decoded.join_ref, None);
        assert_eq!(decoded.reference, None);
        assert_eq!(decoded.topic, "phoenix");
        assert_eq!(decoded.event, "heartbeat");
    }

    #[test]
    fn test_reply_generation() {
        let reply = PhoenixV2Message::reply(
            Some("1".to_string()),
            Some("10".to_string()),
            "realtime:chat",
            "ok",
            json!({"postgres_changes": []}),
        );
        assert_eq!(reply.event, "phx_reply");
        assert_eq!(reply.payload["status"], "ok");
        assert_eq!(reply.payload["response"]["postgres_changes"], json!([]));
    }
}
