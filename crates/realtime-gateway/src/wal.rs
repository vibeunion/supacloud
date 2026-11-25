//! Decoding the tenant's change stream.
//!
//! The gateway reads the tenant's single `wal2json` replication slot with the
//! same decoding options the official Realtime `realtime.list_changes.sql` uses
//! (upstream `realtime` 2.150.0, sha256 `24bcf1db…`). Possessing the same slot
//! and the same options is what makes this one change stream rather than a
//! second one: a table in the `supabase_realtime` publication produces exactly
//! the rows both consumers would see.
//!
//! `realtime.list_changes` is what the poller calls. It decodes the same slot
//! and then routes every change through `realtime.apply_rls`, which keeps a
//! change only when a row in `realtime.subscription` matches it. Subscriptions
//! are written there on join and removed on leave. `change_from_wal` remains
//! the shape reference for a raw wal2json row; it is not the delivery path.

use crate::broadcast::PostgresChangeEvent;
use serde_json::{json, Map, Value};
use std::time::Duration;

/// Fallback publication, matching `POSTGRES_CDC_DEFAULTS` in
/// `packages/management-api/src/services/realtime-tenant-payload.ts`.
pub(crate) const DEFAULT_PUBLICATION: &str = "supabase_realtime";
pub(crate) const DEFAULT_POLL_INTERVAL_MS: u64 = 100;
pub(crate) const DEFAULT_POLL_MAX_CHANGES: i32 = 100;
pub(crate) const DEFAULT_POLL_MAX_RECORD_BYTES: usize = 1_048_576;

#[derive(Debug, Clone)]
pub(crate) struct ChangeFeed {
    pub publication: String,
    pub slot: String,
    pub interval: Duration,
    pub max_changes: i32,
    pub max_record_bytes: usize,
}

impl ChangeFeed {
    pub(crate) fn new(
        publication: String,
        slot: String,
        poll_interval_ms: u64,
        max_changes: i32,
        max_record_bytes: i32,
    ) -> Self {
        Self {
            publication,
            slot,
            interval: Duration::from_millis(poll_interval_ms.max(10)),
            max_changes: max_changes.max(1),
            max_record_bytes: usize::try_from(max_record_bytes)
                .ok()
                .filter(|bytes| *bytes > 0)
                .unwrap_or(DEFAULT_POLL_MAX_RECORD_BYTES),
        }
    }
}

/// The publication's membership and actions, as wal2json wants them.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct PublicationFilter {
    /// `insert,update,delete`, the subset the publication publishes.
    pub actions: String,
    /// `schema.table,schema.table`, escaped for wal2json.
    pub tables: String,
}

impl PublicationFilter {
    /// An empty publication still has to be polled: skipping the call would let
    /// the slot hold a growing backlog of WAL nobody advances.
    pub(crate) fn is_empty(&self) -> bool {
        self.actions.is_empty() || self.tables.is_empty()
    }
}

/// Mirrors `realtime.wal2json_escape_identifier(text)`:
/// `regexp_replace(name, '([\\,.[:space:]])', '\\\1', 'g')`.
///
/// wal2json's `add-tables` option is a comma-separated list, so a table or
/// schema name containing a comma, a dot, a backslash or whitespace has to be
/// escaped before it can be matched.
pub(crate) fn escape_identifier(name: &str) -> String {
    let mut escaped = String::with_capacity(name.len());
    for character in name.chars() {
        if character == '\\' || character == ',' || character == '.' || character.is_whitespace() {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// Builds the wal2json `add-tables` value from `pg_publication_tables` rows.
pub(crate) fn add_tables<'a>(tables: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    tables
        .into_iter()
        .map(|(schema, table)| {
            format!("{}.{}", escape_identifier(schema), escape_identifier(table))
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Converts one `wal2json` row (format version 2) into the delivery shape.
///
/// `None` means "nothing to deliver": transaction boundaries, messages, and any
/// action the protocol does not model.
/// Shape of one raw wal2json row. Delivery goes through `realtime.apply_rls`,
/// so this decoder stays for the shape checks and is not called on the poll path.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn change_from_wal(wal: &Value) -> Option<PostgresChangeEvent> {
    let action = wal.get("action")?.as_str()?;
    let change_type = match action {
        "I" => "INSERT",
        "U" => "UPDATE",
        "D" => "DELETE",
        _ => return None,
    };
    let schema = wal.get("schema")?.as_str()?.to_owned();
    let table = wal.get("table")?.as_str()?.to_owned();

    let columns = wal
        .get("columns")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    let identity = wal
        .get("identity")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    let primary_key = wal.get("pk").and_then(Value::as_array).map(Vec::as_slice);

    // An INSERT and an UPDATE carry the new row; a DELETE carries nothing but
    // the identity the row had.
    let (record, old_record, described) = match change_type {
        "DELETE" => (
            json!({}),
            identity.and_then(record_from_columns),
            primary_key.or(identity),
        ),
        _ => {
            let record = columns
                .and_then(record_from_columns)
                .unwrap_or_else(|| json!({}));
            let old_record = if change_type == "UPDATE" {
                identity.and_then(record_from_columns)
            } else {
                None
            };
            (record, old_record, columns)
        }
    };

    Some(PostgresChangeEvent {
        schema,
        table,
        change_type: change_type.to_owned(),
        record,
        old_record,
        columns: described.map(column_metadata),
        commit_timestamp: wal
            .get("timestamp")
            .and_then(Value::as_str)
            .map(normalize_timestamp),
    })
}

#[cfg_attr(not(test), allow(dead_code))]
fn record_from_columns(columns: &[Value]) -> Option<Value> {
    let mut record = Map::new();
    for column in columns {
        let name = column.get("name").and_then(Value::as_str)?;
        record.insert(
            name.to_owned(),
            column.get("value").cloned().unwrap_or(Value::Null),
        );
    }
    Some(Value::Object(record))
}

#[cfg_attr(not(test), allow(dead_code))]
fn column_metadata(columns: &[Value]) -> Value {
    Value::Array(
        columns
            .iter()
            .filter_map(|column| {
                Some(json!({
                    "name": column.get("name")?.as_str()?,
                    "type": column.get("type").and_then(Value::as_str).unwrap_or("unknown"),
                }))
            })
            .collect(),
    )
}

/// `wal2json` prints `2026-01-01 00:00:00.123456+08`; the wire contract is
/// ISO 8601, so the date and time need their `T` and the offset its minutes.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn normalize_timestamp(raw: &str) -> String {
    let mut timestamp = raw.replacen(' ', "T", 1);
    let bytes = timestamp.as_bytes();
    let offset_start = timestamp
        .char_indices()
        .rev()
        .find(|(_, character)| *character == '+' || *character == '-')
        .map(|(index, _)| index);
    if let Some(index) = offset_start {
        let offset = &timestamp[index..];
        let digits = &bytes[index + 1..];
        let whole_hours = digits.len() == 2 && digits.iter().all(u8::is_ascii_digit);
        if whole_hours {
            let suffix = format!("{offset}:00");
            timestamp.truncate(index);
            timestamp.push_str(&suffix);
        }
    }
    timestamp
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wal(value: Value) -> Value {
        value
    }

    #[test]
    fn escape_identifier_matches_the_sql_rule() {
        assert_eq!(escape_identifier("public"), "public");
        assert_eq!(escape_identifier("my_table"), "my_table");
        assert_eq!(escape_identifier("with space"), "with\\ space");
        assert_eq!(escape_identifier("a,b"), "a\\,b");
        assert_eq!(escape_identifier("a.b"), "a\\.b");
        assert_eq!(escape_identifier("a\\b"), "a\\\\b");
        assert_eq!(escape_identifier("tab\there"), "tab\\\there");
    }

    #[test]
    fn add_tables_joins_escaped_pairs() {
        assert_eq!(
            add_tables([("public", "todos"), ("odd schema", "a,b")]),
            "public.todos,odd\\ schema.a\\,b"
        );
        assert_eq!(add_tables(Vec::<(&str, &str)>::new()), "");
    }

    #[test]
    fn insert_carries_the_new_row_and_its_columns() {
        let event = change_from_wal(&wal(json!({
            "action": "I",
            "timestamp": "2026-01-01 00:00:00.500000+00",
            "schema": "public",
            "table": "todos",
            "columns": [
                {"name": "id", "type": "integer", "typeoid": 23, "value": 7},
                {"name": "task", "type": "text", "typeoid": 25, "value": "write"},
            ],
            "pk": [{"name": "id", "type": "integer", "typeoid": 23}]
        })))
        .expect("an insert is deliverable");

        assert_eq!(event.change_type, "INSERT");
        assert_eq!(event.record, json!({"id": 7, "task": "write"}));
        assert_eq!(event.old_record, None);
        assert_eq!(
            event.columns,
            Some(json!([{"name": "id", "type": "integer"}, {"name": "task", "type": "text"}]))
        );
        assert_eq!(
            event.commit_timestamp.as_deref(),
            Some("2026-01-01T00:00:00.500000+00:00")
        );
    }

    #[test]
    fn update_carries_the_new_row_and_the_old_identity() {
        let event = change_from_wal(&wal(json!({
            "action": "U",
            "schema": "public",
            "table": "todos",
            "columns": [
                {"name": "id", "type": "integer", "value": 7},
                {"name": "task", "type": "text", "value": "done"},
            ],
            "identity": [{"name": "id", "type": "integer", "value": 7}],
        })))
        .expect("an update is deliverable");

        assert_eq!(event.change_type, "UPDATE");
        assert_eq!(event.record, json!({"id": 7, "task": "done"}));
        assert_eq!(event.old_record, Some(json!({"id": 7})));
    }

    #[test]
    fn delete_carries_only_the_identity() {
        let event = change_from_wal(&wal(json!({
            "action": "D",
            "schema": "public",
            "table": "todos",
            "identity": [{"name": "id", "type": "integer", "value": 7}],
            "pk": [{"name": "id", "type": "integer"}],
        })))
        .expect("a delete is deliverable");

        assert_eq!(event.change_type, "DELETE");
        assert_eq!(event.record, json!({}));
        assert_eq!(event.old_record, Some(json!({"id": 7})));
        assert_eq!(
            event.columns,
            Some(json!([{"name": "id", "type": "integer"}]))
        );
    }

    #[test]
    fn transaction_boundaries_and_messages_are_not_deliveries() {
        for action in ["B", "C", "M", "T", "R"] {
            assert!(
                change_from_wal(&wal(json!({"action": action}))).is_none(),
                "{action} must not become a delivery"
            );
        }
        assert!(change_from_wal(&wal(json!({"no": "action"}))).is_none());
    }

    #[test]
    fn timestamps_become_iso_8601() {
        assert_eq!(
            normalize_timestamp("2026-01-01 12:00:00.123456+00"),
            "2026-01-01T12:00:00.123456+00:00"
        );
        assert_eq!(
            normalize_timestamp("2026-01-01 12:00:00.123456-05"),
            "2026-01-01T12:00:00.123456-05:00"
        );
        assert_eq!(
            normalize_timestamp("2026-01-01 12:00:00+05:30"),
            "2026-01-01T12:00:00+05:30"
        );
        assert_eq!(
            normalize_timestamp("2026-01-01T00:00:00Z"),
            "2026-01-01T00:00:00Z"
        );
    }

    #[test]
    fn the_feed_clamps_its_poll_parameters() {
        let feed = ChangeFeed::new("pub".into(), "slot".into(), 0, 0, -5);
        assert_eq!(feed.interval, Duration::from_millis(10));
        assert_eq!(feed.max_changes, 1);
        assert_eq!(feed.max_record_bytes, DEFAULT_POLL_MAX_RECORD_BYTES);
    }
}
