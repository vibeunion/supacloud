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

    /// Decode the frame a supabase-js client actually sends.
    ///
    /// `vsn=2.0.0` is a 5-element array. `vsn=1.0.0` is a JSON object
    /// `{join_ref, ref, topic, event, payload}`. Official compliance runs both.
    pub fn decode_client_frame(raw: &str) -> Result<Self, ProtocolError> {
        let value: Value =
            serde_json::from_str(raw).map_err(|_| ProtocolError::InvalidFrameFormat)?;
        if value.is_array() {
            return serde_json::from_value(value).map_err(|_| ProtocolError::InvalidFrameFormat);
        }
        if !value.is_object() {
            return Err(ProtocolError::InvalidFrameFormat);
        }
        let topic = value
            .get("topic")
            .and_then(Value::as_str)
            .ok_or(ProtocolError::InvalidFrameFormat)?
            .to_string();
        let event = value
            .get("event")
            .and_then(Value::as_str)
            .ok_or(ProtocolError::InvalidFrameFormat)?
            .to_string();
        let payload = value
            .get("payload")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        Ok(Self {
            join_ref: optional_frame_ref(value.get("join_ref")),
            reference: optional_frame_ref(value.get("ref")),
            topic,
            event,
            payload,
        })
    }

    /// Encode for the serializer selected by the client's `vsn` query parameter.
    pub fn encode_for_client(&self, vsn: &str) -> Result<String, serde_json::Error> {
        if client_uses_phoenix_v2(vsn) {
            self.encode()
        } else {
            serde_json::to_string(&serde_json::json!({
                "join_ref": self.join_ref,
                "ref": self.reference,
                "topic": self.topic,
                "event": self.event,
                "payload": self.payload,
            }))
        }
    }
}

fn client_uses_phoenix_v2(vsn: &str) -> bool {
    vsn.split('.').next() == Some("2")
}

/// `realtime-js` v2 sends broadcast pushes as a binary frame (kind 3), not a
/// JSON array. The layout matches `Serializer._encodeUserBroadcastPush`.
const USER_BROADCAST_PUSH_KIND: u8 = 3;
const USER_BROADCAST_JSON_ENCODING: u8 = 1;

impl PhoenixV2Message {
    pub fn decode_user_broadcast_push(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.first() != Some(&USER_BROADCAST_PUSH_KIND) || bytes.len() < 7 {
            return Err(ProtocolError::InvalidFrameFormat);
        }
        let join_len = bytes[1] as usize;
        let ref_len = bytes[2] as usize;
        let topic_len = bytes[3] as usize;
        let event_len = bytes[4] as usize;
        let metadata_len = bytes[5] as usize;
        let encoding = bytes[6];
        if encoding != USER_BROADCAST_JSON_ENCODING {
            return Err(ProtocolError::InvalidFrameFormat);
        }
        let mut offset = 7;
        let join_ref = read_counted_string(bytes, &mut offset, join_len)?;
        let reference = read_counted_string(bytes, &mut offset, ref_len)?;
        let topic = read_counted_string(bytes, &mut offset, topic_len)?;
        let user_event = read_counted_string(bytes, &mut offset, event_len)?;
        let metadata_end = offset
            .checked_add(metadata_len)
            .ok_or(ProtocolError::InvalidFrameFormat)?;
        if metadata_end > bytes.len() {
            return Err(ProtocolError::InvalidFrameFormat);
        }
        offset = metadata_end;
        let user_payload: Value = serde_json::from_slice(&bytes[offset..])
            .map_err(|_| ProtocolError::InvalidFrameFormat)?;
        let topic = topic.ok_or(ProtocolError::InvalidFrameFormat)?;
        let user_event = user_event.ok_or(ProtocolError::InvalidFrameFormat)?;
        Ok(Self {
            join_ref,
            reference,
            topic,
            event: "broadcast".to_string(),
            payload: serde_json::json!({
                "type": "broadcast",
                "event": user_event,
                "payload": user_payload,
            }),
        })
    }
}

fn read_counted_string(
    bytes: &[u8],
    offset: &mut usize,
    length: usize,
) -> Result<Option<String>, ProtocolError> {
    let end = offset
        .checked_add(length)
        .ok_or(ProtocolError::InvalidFrameFormat)?;
    if end > bytes.len() {
        return Err(ProtocolError::InvalidFrameFormat);
    }
    let text =
        std::str::from_utf8(&bytes[*offset..end]).map_err(|_| ProtocolError::InvalidFrameFormat)?;
    *offset = end;
    Ok(if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    })
}

fn optional_frame_ref(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(other.to_string()),
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
    fn test_phoenix_v1_object_round_trip() {
        let raw = r#"{"join_ref":"1","ref":"8","topic":"realtime:room","event":"broadcast","payload":{"event":"test-event","payload":{"message":"test"}}}"#;
        let decoded = PhoenixV2Message::decode_client_frame(raw).unwrap();
        assert_eq!(decoded.join_ref.as_deref(), Some("1"));
        assert_eq!(decoded.reference.as_deref(), Some("8"));
        assert_eq!(decoded.topic, "realtime:room");
        assert_eq!(decoded.event, "broadcast");

        let encoded = decoded.encode_for_client("1.0.0").unwrap();
        let echoed: Value = serde_json::from_str(&encoded).unwrap();
        assert!(echoed.is_object());
        assert_eq!(echoed["event"], "broadcast");
        assert_eq!(echoed["ref"], "8");
        assert!(PhoenixV2Message::decode_client_frame(&encoded).is_ok());
    }

    #[test]
    fn test_v2_binary_broadcast_push_decodes_to_a_broadcast_message() {
        // Kind 3 frame produced the same way as realtime-js
        // Serializer._encodeUserBroadcastPush for a JSON user payload.
        let join_ref = "3";
        let reference = "9";
        let topic = "realtime:room";
        let user_event = "test-event";
        let user_payload = br#"{"message":"test"}"#;
        let mut frame = vec![
            3,
            join_ref.len() as u8,
            reference.len() as u8,
            topic.len() as u8,
            user_event.len() as u8,
            0,
            1,
        ];
        frame.extend_from_slice(join_ref.as_bytes());
        frame.extend_from_slice(reference.as_bytes());
        frame.extend_from_slice(topic.as_bytes());
        frame.extend_from_slice(user_event.as_bytes());
        frame.extend_from_slice(user_payload);

        let decoded = PhoenixV2Message::decode_user_broadcast_push(&frame).unwrap();
        assert_eq!(decoded.join_ref.as_deref(), Some(join_ref));
        assert_eq!(decoded.reference.as_deref(), Some(reference));
        assert_eq!(decoded.topic, topic);
        assert_eq!(decoded.event, "broadcast");
        assert_eq!(decoded.payload["event"], user_event);
        assert_eq!(decoded.payload["payload"]["message"], "test");
    }

    #[test]
    fn test_v2_client_still_uses_the_array_serializer() {
        let msg = PhoenixV2Message::reply(None, Some("hb".to_string()), "phoenix", "ok", json!({}));
        let encoded = msg.encode_for_client("2.0.0").unwrap();
        assert!(encoded.starts_with('['));
        assert_eq!(
            PhoenixV2Message::decode_client_frame(&encoded).unwrap(),
            msg
        );
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
