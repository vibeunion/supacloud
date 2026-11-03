use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
}

impl ColumnFilter {
    /// Parse standard Supabase Realtime filter string like:
    /// `id=eq.1`, `status=neq.deleted`, `score=gte.10`, `role=in.(admin,editor)`, `deleted_at=is.null`
    pub fn parse(filter_str: &str) -> Option<Self> {
        let trimmed = filter_str.trim();
        if trimmed.is_empty() {
            return None;
        }

        let eq_idx = trimmed.find('=')?;
        let column = trimmed[..eq_idx].trim().to_string();
        let right = trimmed[eq_idx + 1..].trim();

        let dot_idx = right.find('.')?;
        let op_name = &right[..dot_idx];
        let val_str = &right[dot_idx + 1..];

        let op = match op_name {
            "eq" => FilterOp::Eq(strip_quotes(val_str)),
            "neq" => FilterOp::Neq(strip_quotes(val_str)),
            "gt" => FilterOp::Gt(val_str.parse().ok()?),
            "gte" => FilterOp::Gte(val_str.parse().ok()?),
            "lt" => FilterOp::Lt(val_str.parse().ok()?),
            "lte" => FilterOp::Lte(val_str.parse().ok()?),
            "in" => {
                let inner = val_str.strip_prefix('(')?.strip_suffix(')')?;
                let items: Vec<String> = inner
                    .split(',')
                    .map(|s| strip_quotes(s.trim()))
                    .collect();
                FilterOp::In(items)
            }
            "is" => {
                if val_str.eq_ignore_ascii_case("null") {
                    FilterOp::IsNull
                } else if val_str.eq_ignore_ascii_case("not.null") {
                    FilterOp::IsNotNull
                } else {
                    return None;
                }
            }
            _ => return None,
        };

        Some(ColumnFilter { column, op })
    }

    /// Check if a JSON record matches this filter
    pub fn matches(&self, record: &Value) -> bool {
        let obj = match record {
            Value::Object(map) => map,
            _ => return false,
        };

        let val = obj.get(&self.column);

        match &self.op {
            FilterOp::IsNull => val.map_or(true, |v| v.is_null()),
            FilterOp::IsNotNull => val.map_or(false, |v| !v.is_null()),
            FilterOp::Eq(expected) => {
                match val {
                    Some(v) => value_to_string(v) == *expected,
                    None => false,
                }
            }
            FilterOp::Neq(expected) => {
                match val {
                    Some(v) => value_to_string(v) != *expected,
                    None => true,
                }
            }
            FilterOp::Gt(num) => {
                match val.and_then(|v| value_to_f64(v)) {
                    Some(n) => n > *num,
                    None => false,
                }
            }
            FilterOp::Gte(num) => {
                match val.and_then(|v| value_to_f64(v)) {
                    Some(n) => n >= *num,
                    None => false,
                }
            }
            FilterOp::Lt(num) => {
                match val.and_then(|v| value_to_f64(v)) {
                    Some(n) => n < *num,
                    None => false,
                }
            }
            FilterOp::Lte(num) => {
                match val.and_then(|v| value_to_f64(v)) {
                    Some(n) => n <= *num,
                    None => false,
                }
            }
            FilterOp::In(candidates) => {
                match val {
                    Some(v) => {
                        let s = value_to_string(v);
                        candidates.iter().any(|c| c == &s)
                    }
                    None => false,
                }
            }
        }
    }
}

fn strip_quotes(s: &str) -> String {
    let trimmed = s.trim();
    if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        if trimmed.len() >= 2 {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn value_to_string(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

fn value_to_f64(val: &Value) -> Option<f64> {
    match val {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_filter_eq() {
        let filter = ColumnFilter::parse("id=eq.123").unwrap();
        assert_eq!(filter.column, "id");
        assert!(filter.matches(&json!({"id": 123})));
        assert!(filter.matches(&json!({"id": "123"})));
        assert!(!filter.matches(&json!({"id": 456})));
    }

    #[test]
    fn test_filter_neq() {
        let filter = ColumnFilter::parse("status=neq.deleted").unwrap();
        assert!(filter.matches(&json!({"status": "active"})));
        assert!(!filter.matches(&json!({"status": "deleted"})));
    }

    #[test]
    fn test_filter_numbers() {
        let gte = ColumnFilter::parse("score=gte.10.5").unwrap();
        assert!(gte.matches(&json!({"score": 11})));
        assert!(gte.matches(&json!({"score": 10.5})));
        assert!(!gte.matches(&json!({"score": 10})));
    }

    #[test]
    fn test_filter_in() {
        let filter = ColumnFilter::parse("role=in.(admin,editor)").unwrap();
        assert!(filter.matches(&json!({"role": "admin"})));
        assert!(filter.matches(&json!({"role": "editor"})));
        assert!(!filter.matches(&json!({"role": "viewer"})));
    }

    #[test]
    fn test_filter_is_null() {
        let filter = ColumnFilter::parse("deleted_at=is.null").unwrap();
        assert!(filter.matches(&json!({"deleted_at": null})));
        assert!(filter.matches(&json!({})));
        assert!(!filter.matches(&json!({"deleted_at": "2026-11-03"})));
    }
}
