//! Supabase Realtime `postgres_changes` filter parsing and matching.
//!
//! Grammar: `<column>=<op>.<value>` with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`,
//! `in.(a,b,c)` and `is.null` / `is.not.null`. Matching mirrors PostgREST
//! comparison semantics closely enough for change delivery: stringified
//! scalars, numeric coercion for ordered operators, and `null` awareness.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum FilterOp {
    Eq(String),
    Neq(String),
    Gt(f64),
    Gte(f64),
    Lt(f64),
    Lte(f64),
    In(Vec<String>),
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
}

impl ColumnFilter {
    pub fn parse(input: &str) -> Option<Self> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return None;
        }
        let eq = trimmed.find('=')?;
        let column = trimmed[..eq].trim();
        if column.is_empty() {
            return None;
        }
        let right = trimmed[eq + 1..].trim();
        let dot = right.find('.')?;
        let op_name = &right[..dot];
        let raw = &right[dot + 1..];

        let op = match op_name {
            "eq" => FilterOp::Eq(unquote(raw)),
            "neq" => FilterOp::Neq(unquote(raw)),
            "gt" => FilterOp::Gt(raw.parse().ok()?),
            "gte" => FilterOp::Gte(raw.parse().ok()?),
            "lt" => FilterOp::Lt(raw.parse().ok()?),
            "lte" => FilterOp::Lte(raw.parse().ok()?),
            "in" => {
                let inner = raw.strip_prefix('(')?.strip_suffix(')')?;
                FilterOp::In(inner.split(',').map(|part| unquote(part.trim())).collect())
            }
            "is" => {
                if raw.eq_ignore_ascii_case("null") {
                    FilterOp::IsNull
                } else if raw.eq_ignore_ascii_case("not.null") {
                    FilterOp::IsNotNull
                } else {
                    return None;
                }
            }
            _ => return None,
        };

        Some(ColumnFilter {
            column: column.to_string(),
            op,
        })
    }

    pub fn matches(&self, record: &Value) -> bool {
        let Some(object) = record.as_object() else {
            return false;
        };
        let value = object.get(&self.column);

        match &self.op {
            FilterOp::IsNull => value.is_none_or(Value::is_null),
            FilterOp::IsNotNull => value.is_some_and(|v| !v.is_null()),
            FilterOp::Eq(expected) => value.is_some_and(|v| scalar_string(v) == *expected),
            FilterOp::Neq(expected) => value.is_none_or(|v| scalar_string(v) != *expected),
            FilterOp::Gt(limit) => value.and_then(as_f64).is_some_and(|n| n > *limit),
            FilterOp::Gte(limit) => value.and_then(as_f64).is_some_and(|n| n >= *limit),
            FilterOp::Lt(limit) => value.and_then(as_f64).is_some_and(|n| n < *limit),
            FilterOp::Lte(limit) => value.and_then(as_f64).is_some_and(|n| n <= *limit),
            FilterOp::In(candidates) => {
                value.is_some_and(|v| candidates.iter().any(|c| c == &scalar_string(v)))
            }
        }
    }
}

fn unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Stringify a JSON scalar the way the existing TypeScript engine does.
pub fn scalar_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eq_matches_numbers_and_strings() {
        let f = ColumnFilter::parse("id=eq.123").unwrap();
        assert!(f.matches(&json!({"id": 123})));
        assert!(f.matches(&json!({"id": "123"})));
        assert!(!f.matches(&json!({"id": 456})));
    }

    #[test]
    fn ordered_ops() {
        let f = ColumnFilter::parse("score=gte.10.5").unwrap();
        assert!(f.matches(&json!({"score": 11})));
        assert!(f.matches(&json!({"score": 10.5})));
        assert!(!f.matches(&json!({"score": 10})));
    }

    #[test]
    fn in_list() {
        let f = ColumnFilter::parse("role=in.(admin,editor)").unwrap();
        assert!(f.matches(&json!({"role": "admin"})));
        assert!(!f.matches(&json!({"role": "viewer"})));
    }

    #[test]
    fn null_ops() {
        let f = ColumnFilter::parse("deleted_at=is.null").unwrap();
        assert!(f.matches(&json!({"deleted_at": null})));
        assert!(f.matches(&json!({})));
        assert!(!f.matches(&json!({"deleted_at": "2026-01-01"})));

        let f = ColumnFilter::parse("deleted_at=is.not.null").unwrap();
        assert!(!f.matches(&json!({"deleted_at": null})));
        assert!(f.matches(&json!({"deleted_at": "2026-01-01"})));
    }

    #[test]
    fn invalid_filters_are_rejected() {
        assert!(ColumnFilter::parse("").is_none());
        assert!(ColumnFilter::parse("id").is_none());
        assert!(ColumnFilter::parse("id=like.abc").is_none());
    }
}
