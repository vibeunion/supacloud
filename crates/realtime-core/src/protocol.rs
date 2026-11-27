//! Phoenix channel frame codec.
//!
//! Supabase Realtime clients negotiate one of two serializations:
//!
//! * `vsn=1.0.0` — JSON objects `{join_ref, ref, topic, event, payload}`
//! * `vsn=2.0.0` — JSON arrays `[join_ref, ref, topic, event, payload]`
//!
//! The core normalizes both into [`Frame`] and re-encodes replies in the
//! serializer the connection negotiated, so the Bun transport never has to
//! understand either shape.

use serde_json::{Map, Value};

/// Serializer version negotiated by a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vsn {
    V1,
    V2,
}

impl Vsn {
    pub fn as_str(self) -> &'static str {
        match self {
            Vsn::V1 => "1.0.0",
            Vsn::V2 => "2.0.0",
        }
    }
}

/// A decoded channel message, independent of the wire serializer.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub join_ref: Option<String>,
    pub reference: Option<String>,
    pub topic: String,
    pub event: String,
    pub payload: Value,
    pub vsn: Vsn,
    /// Serialize `join_ref` for replies. Server-initiated pushes omit it in
    /// the v1 object serializer, matching the Supabase wire behaviour.
    pub emit_join_ref: bool,
}

#[derive(Debug)]
pub enum FrameError {
    NotAnObjectOrArray,
    InvalidArrayShape,
    MissingTopic,
    MissingEvent,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            FrameError::NotAnObjectOrArray => "frame must be a JSON object or 5-element array",
            FrameError::InvalidArrayShape => {
                "array frame must be [join_ref, ref, topic, event, payload]"
            }
            FrameError::MissingTopic => "frame is missing a string topic",
            FrameError::MissingEvent => "frame is missing a string event",
        };
        f.write_str(msg)
    }
}

fn stringish(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

fn required_string(value: Option<&Value>, error: FrameError) -> Result<String, FrameError> {
    match value {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(error),
    }
}

impl Frame {
    /// Decode a wire frame. Accepts both serializers.
    pub fn decode(raw: &str) -> Result<Self, FrameError> {
        let value: Value = serde_json::from_str(raw).map_err(|_| FrameError::NotAnObjectOrArray)?;
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Result<Self, FrameError> {
        match value {
            Value::Array(items) => {
                if items.len() != 5 {
                    return Err(FrameError::InvalidArrayShape);
                }
                let mut it = items.into_iter();
                let join_ref = stringish(it.next().as_ref());
                let reference = stringish(it.next().as_ref());
                let topic = required_string(it.next().as_ref(), FrameError::MissingTopic)?;
                let event = required_string(it.next().as_ref(), FrameError::MissingEvent)?;
                let payload = it.next().unwrap_or(Value::Null);
                Ok(Frame {
                    join_ref,
                    reference,
                    topic,
                    event,
                    payload,
                    vsn: Vsn::V2,
                    emit_join_ref: true,
                })
            }
            Value::Object(mut map) => {
                let join_ref = stringish(map.get("join_ref"));
                let reference = stringish(map.get("ref"));
                let topic = required_string(map.get("topic"), FrameError::MissingTopic)?;
                let event = required_string(map.get("event"), FrameError::MissingEvent)?;
                let payload = map.remove("payload").unwrap_or(Value::Null);
                Ok(Frame {
                    join_ref,
                    reference,
                    topic,
                    event,
                    payload,
                    vsn: Vsn::V1,
                    emit_join_ref: true,
                })
            }
            _ => Err(FrameError::NotAnObjectOrArray),
        }
    }

    /// Encode into the wire serializer used by `vsn`.
    pub fn encode(&self, vsn: Vsn) -> Value {
        match vsn {
            Vsn::V2 => Value::Array(vec![
                opt_string(self.join_ref.as_deref()),
                opt_string(self.reference.as_deref()),
                Value::String(self.topic.clone()),
                Value::String(self.event.clone()),
                self.payload.clone(),
            ]),
            Vsn::V1 => {
                let mut map = Map::new();
                if self.emit_join_ref {
                    map.insert("join_ref".into(), opt_string(self.join_ref.as_deref()));
                }
                map.insert("ref".into(), opt_string(self.reference.as_deref()));
                map.insert("topic".into(), Value::String(self.topic.clone()));
                map.insert("event".into(), Value::String(self.event.clone()));
                map.insert("payload".into(), self.payload.clone());
                Value::Object(map)
            }
        }
    }

    pub fn reply(
        vsn: Vsn,
        join_ref: Option<String>,
        reference: Option<String>,
        topic: impl Into<String>,
        status: &str,
        response: Value,
    ) -> Self {
        Self {
            join_ref,
            reference,
            topic: topic.into(),
            event: "phx_reply".into(),
            payload: serde_json::json!({ "status": status, "response": response }),
            vsn,
            emit_join_ref: true,
        }
    }

    pub fn ok(
        vsn: Vsn,
        join_ref: Option<String>,
        reference: Option<String>,
        topic: impl Into<String>,
        response: Value,
    ) -> Self {
        Self::reply(vsn, join_ref, reference, topic, "ok", response)
    }

    pub fn error(
        vsn: Vsn,
        join_ref: Option<String>,
        reference: Option<String>,
        topic: impl Into<String>,
        reason: &str,
    ) -> Self {
        Self::reply(
            vsn,
            join_ref,
            reference,
            topic,
            "error",
            serde_json::json!({ "reason": reason }),
        )
    }

    pub fn event(topic: impl Into<String>, event: &str, payload: Value) -> Self {
        Self {
            join_ref: None,
            reference: None,
            topic: topic.into(),
            event: event.into(),
            payload,
            vsn: Vsn::V1,
            emit_join_ref: false,
        }
    }

    pub fn with_vsn(mut self, vsn: Vsn) -> Self {
        self.vsn = vsn;
        self
    }
}

fn opt_string(value: Option<&str>) -> Value {
    match value {
        Some(s) => Value::String(s.to_string()),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_v2_array() {
        let frame = Frame::decode(r#"["1","2","realtime:room","phx_join",{"config":{}}]"#).unwrap();
        assert_eq!(frame.vsn, Vsn::V2);
        assert_eq!(frame.join_ref.as_deref(), Some("1"));
        assert_eq!(frame.reference.as_deref(), Some("2"));
        assert_eq!(frame.topic, "realtime:room");
        assert_eq!(frame.event, "phx_join");
    }

    #[test]
    fn decodes_v1_object() {
        let frame = Frame::decode(
            r#"{"topic":"phoenix","event":"heartbeat","payload":{},"ref":"3","join_ref":null}"#,
        )
        .unwrap();
        assert_eq!(frame.vsn, Vsn::V1);
        assert_eq!(frame.reference.as_deref(), Some("3"));
        assert!(frame.join_ref.is_none());
    }

    #[test]
    fn encodes_reply_per_vsn() {
        let reply = Frame::ok(
            Vsn::V2,
            Some("1".into()),
            Some("9".into()),
            "realtime:room",
            json!({"postgres_changes": []}),
        );
        let encoded = reply.encode(Vsn::V2);
        assert!(encoded.is_array());
        assert_eq!(encoded[3], json!("phx_reply"));
        assert_eq!(encoded[4]["status"], json!("ok"));

        let encoded_v1 = reply.encode(Vsn::V1);
        assert_eq!(encoded_v1["event"], json!("phx_reply"));
        assert_eq!(
            encoded_v1["payload"]["response"],
            json!({"postgres_changes": []})
        );
    }

    #[test]
    fn rejects_bad_frames() {
        assert!(Frame::decode("[]").is_err());
        assert!(Frame::decode(r#"{"event":"x"}"#).is_err());
        assert!(Frame::decode("42").is_err());
    }
}
