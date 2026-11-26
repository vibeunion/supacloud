//! Tenant `realtime.subscription` rows, the input `realtime.apply_rls` filters on.
//!
//! Official Realtime (v2.150.0) does not keep `postgres_changes` subscriptions in
//! the socket process. It inserts one row per published table, with the caller's
//! JWT claims, and `realtime.list_changes` drops any WAL record whose
//! `subscription_ids` come back empty. This module is that insert and delete.
//! A join that cannot persist the row is refused: decoded WAL is not delivered
//! in its place.

use crate::postgres::connection_config;
use crate::tenant::TenantConfig;
use serde_json::{Map, Value};
use tokio_postgres::types::Json;
use uuid::Uuid;

const FILTER_OPS: &[&str] = &[
    "eq",
    "neq",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "like",
    "ilike",
    "is",
    "match",
    "imatch",
    "isdistinct",
];

/// One `postgres_changes` entry from a `phx_join`, in the shape the official
/// insert expects: one action, one schema/table pattern, and primitive filter
/// arrays the server turns into `realtime.user_defined_filter[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeSpec {
    pub client_id: String,
    pub action_filter: String,
    pub schema: String,
    pub table: String,
    pub filters: Vec<ParsedFilter>,
    pub selected_columns: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFilter {
    pub column: String,
    pub op: String,
    pub value: String,
    pub negate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSubscription {
    pub client_id: String,
    pub db_id: String,
}

/// The insert from `Realtime.Tenants` / `postgres_cdc_rls` subscriptions
/// (`subscriptions.ex` in Realtime 2.150.0). A `*` schema or table expands to
/// the publication's current members. Zero rows means nothing matched, and the
/// caller must not accept the join.
const INSERT_SQL: &str = "\
WITH candidates AS (
    SELECT pub.schemaname, pub.tablename
    FROM pg_publication_tables pub
    WHERE pub.pubname = $1
      AND pub.schemaname LIKE (CASE $2 WHEN '*' THEN '%' ELSE $2 END)
      AND pub.tablename LIKE (CASE $3 WHEN '*' THEN '%' ELSE $3 END)
),
sub_tables AS (
    SELECT format('%I.%I', c.schemaname, c.tablename)::regclass AS entity
    FROM candidates c
    WHERE ($2 = '*' OR c.schemaname = $2 OR NOT EXISTS (
              SELECT 1 FROM candidates e WHERE e.schemaname = $2))
      AND ($3 = '*' OR c.tablename = $3 OR NOT EXISTS (
              SELECT 1 FROM candidates e WHERE e.tablename = $3))
)
INSERT INTO realtime.subscription AS x (
    subscription_id, entity, filters, claims, action_filter, selected_columns
)
SELECT
    $4::text::uuid,
    sub_tables.entity,
    (
        SELECT coalesce(
            array_agg(row(c, o::realtime.equality_op, v, n)::realtime.user_defined_filter),
            '{}'::realtime.user_defined_filter[]
        )
        FROM unnest($6::text[], $7::text[], $8::text[], $9::boolean[]) AS f(c, o, v, n)
    ),
    $5,
    $10,
    $11
FROM sub_tables
ON CONFLICT (
    subscription_id, entity, realtime.filters_hash(filters), action_filter,
    coalesce(selected_columns, '{}')
)
DO UPDATE SET claims = excluded.claims, created_at = now()";

const DELETE_SQL: &str = "\
DELETE FROM realtime.subscription WHERE subscription_id::text = ANY($1::text[])";

const UPDATE_CLAIMS_SQL: &str = "\
UPDATE realtime.subscription SET claims = $1 WHERE subscription_id::text = ANY($2::text[])";

pub fn change_spec_from_config(
    item: &Map<String, Value>,
    index: usize,
) -> Result<ChangeSpec, String> {
    let client_id = item
        .get("id")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            other => other.to_string(),
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| index.to_string());

    let event = item.get("event").and_then(Value::as_str).unwrap_or("*");
    let action_filter = match event.to_ascii_uppercase().as_str() {
        "INSERT" | "UPDATE" | "DELETE" => event.to_ascii_uppercase(),
        _ => "*".to_owned(),
    };

    let schema = match item.get("schema") {
        Some(Value::String(schema)) if !schema.is_empty() => Some(schema.clone()),
        Some(_) => {
            return Err(
                "postgres_changes schema must be a string. Provide a schema or a table.".to_owned(),
            )
        }
        None => None,
    };
    let table = match item.get("table") {
        Some(Value::String(table)) if !table.is_empty() => Some(table.clone()),
        Some(_) => {
            return Err(
                "postgres_changes table must be a string. Provide a schema or a table.".to_owned(),
            )
        }
        None => None,
    };
    let (schema, table) = match (schema, table) {
        (Some(schema), Some(table)) => (schema, table),
        (Some(schema), None) => (schema, "*".to_owned()),
        (None, Some(table)) => ("public".to_owned(), table),
        (None, None) => {
            return Err("postgres_changes needs a schema or a table. Refusing the join.".to_owned())
        }
    };

    let filters = match item.get("filter") {
        None => Vec::new(),
        Some(Value::String(filter)) => parse_filters(filter)?,
        Some(_) => return Err("postgres_changes filter must be a string".to_owned()),
    };

    let selected_columns = match item.get("select") {
        None => None,
        Some(Value::Array(columns)) => Some(
            columns
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        ),
        Some(_) => {
            return Err(
                "postgres_changes select must be a list of column names, or omitted".to_owned(),
            )
        }
    };
    if selected_columns.is_some() && (schema == "*" || table == "*") {
        return Err(
            "column selection is not supported for a wildcard schema or table. Name both."
                .to_owned(),
        );
    }

    Ok(ChangeSpec {
        client_id,
        action_filter,
        schema,
        table,
        filters,
        selected_columns,
    })
}

pub fn parse_filters(filter: &str) -> Result<Vec<ParsedFilter>, String> {
    let trimmed = filter.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    split_top_level(trimmed)?
        .into_iter()
        .map(|segment| parse_segment(&segment))
        .collect()
}

fn split_top_level(filter: &str) -> Result<Vec<String>, String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut depth = 0_i32;
    let mut quoted = false;
    let mut chars = filter.chars().peekable();
    while let Some(character) = chars.next() {
        if quoted {
            current.push(character);
            if character == '\\' {
                if let Some(escaped) = chars.next() {
                    current.push(escaped);
                }
                continue;
            }
            if character == '"' {
                quoted = false;
            }
            continue;
        }
        match character {
            '"' => {
                quoted = true;
                current.push(character);
            }
            '(' => {
                depth += 1;
                current.push(character);
            }
            ')' => {
                depth = depth.saturating_sub(1);
                current.push(character);
            }
            ',' if depth == 0 => {
                segments.push(std::mem::take(&mut current));
            }
            _ => current.push(character),
        }
    }
    if quoted {
        return Err("postgres_changes filter has an unclosed quote".to_owned());
    }
    segments.push(current);
    Ok(segments)
}

fn parse_segment(segment: &str) -> Result<ParsedFilter, String> {
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return Err(
            "postgres_changes filter must not contain empty segments. Check for an extra comma."
                .to_owned(),
        );
    }
    let Some((column, rest)) = trimmed.split_once('=') else {
        return Err(format!(
            "postgres_changes filter could not be parsed: {trimmed}"
        ));
    };
    let column = column.trim();
    if column.is_empty() {
        return Err(format!(
            "postgres_changes filter is missing a column: {trimmed}"
        ));
    }
    let (negate, rest) = rest
        .strip_prefix("not.")
        .map(|rest| (true, rest))
        .unwrap_or((false, rest));
    let Some((op, value)) = rest.split_once('.') else {
        return Err(format!(
            "postgres_changes filter could not be parsed: {trimmed}"
        ));
    };
    if !FILTER_OPS.contains(&op) {
        return Err(format!(
            "postgres_changes filter operator `{op}` is not supported"
        ));
    }
    let value = if op == "in" {
        let inner = value
            .strip_prefix('(')
            .and_then(|body| body.strip_suffix(')'))
            .ok_or_else(|| {
                "postgres_changes `in` filter value must be wrapped in parentheses".to_owned()
            })?;
        format!("{{{inner}}}")
    } else {
        unquote(value)
    };
    Ok(ParsedFilter {
        column: column.to_owned(),
        op: op.to_owned(),
        value,
        negate,
    })
}

fn unquote(value: &str) -> String {
    let Some(rest) = value.strip_prefix('"') else {
        return value.to_owned();
    };
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            if let Some(escaped) = chars.next() {
                out.push(escaped);
            }
            continue;
        }
        if character == '"' {
            return out;
        }
        out.push(character);
    }
    value.to_owned()
}

pub async fn store_subscriptions(
    tenant: &TenantConfig,
    claims: &Value,
    specs: &[ChangeSpec],
) -> Result<Vec<StoredSubscription>, String> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    if !claims.as_object().is_some_and(|object| {
        object
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| !role.is_empty())
    }) {
        return Err(
            "postgres_changes subscription was not stored: the JWT has no role, so realtime.apply_rls has nothing to evaluate"
                .to_owned(),
        );
    }

    let (mut client, connection) = connection_config(tenant)
        .connect(tokio_postgres::NoTls)
        .await
        .map_err(|error| format!("postgres_changes subscription was not stored: {error}"))?;
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    let stored = async {
        let transaction = client.transaction().await.map_err(store_error)?;
        let mut stored = Vec::with_capacity(specs.len());
        for spec in specs {
            let db_id = Uuid::new_v4().to_string();
            let columns: Vec<String> = spec.filters.iter().map(|filter| filter.column.clone()).collect();
            let ops: Vec<String> = spec.filters.iter().map(|filter| filter.op.clone()).collect();
            let values: Vec<String> = spec.filters.iter().map(|filter| filter.value.clone()).collect();
            let negates: Vec<bool> = spec.filters.iter().map(|filter| filter.negate).collect();
            let inserted = transaction
                .execute(
                    INSERT_SQL,
                    &[
                        &tenant.publication,
                        &spec.schema,
                        &spec.table,
                        &db_id,
                        &Json(claims),
                        &columns,
                        &ops,
                        &values,
                        &negates,
                        &spec.action_filter,
                        &spec.selected_columns,
                    ],
                )
                .await
                .map_err(store_error)?;
            if inserted == 0 {
                transaction.rollback().await.ok();
                return Err(format!(
                    "postgres_changes subscription was not stored: no table in publication {} matches {}.{}",
                    tenant.publication, spec.schema, spec.table
                ));
            }
            stored.push(StoredSubscription {
                client_id: spec.client_id.clone(),
                db_id,
            });
        }
        transaction.commit().await.map_err(store_error)?;
        Ok(stored)
    }
    .await;
    driver.abort();
    stored
}

pub async fn update_claims(
    tenant: &TenantConfig,
    db_ids: &[String],
    claims: &Value,
) -> Result<(), String> {
    if db_ids.is_empty() {
        return Ok(());
    }
    let (client, connection) = connection_config(tenant)
        .connect(tokio_postgres::NoTls)
        .await
        .map_err(|error| format!("failed to update realtime.subscription claims: {error}"))?;
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    let updated = client
        .execute(UPDATE_CLAIMS_SQL, &[&Json(claims), &db_ids])
        .await
        .map(|_| ())
        .map_err(|error| format!("failed to update realtime.subscription claims: {error}"));
    driver.abort();
    updated
}

pub async fn delete_subscriptions(tenant: &TenantConfig, db_ids: &[String]) -> Result<(), String> {
    if db_ids.is_empty() {
        return Ok(());
    }
    let (client, connection) = connection_config(tenant)
        .connect(tokio_postgres::NoTls)
        .await
        .map_err(|error| format!("failed to delete realtime.subscription rows: {error}"))?;
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    let deleted = client
        .execute(DELETE_SQL, &[&db_ids])
        .await
        .map(|_| ())
        .map_err(|error| format!("failed to delete realtime.subscription rows: {error}"));
    driver.abort();
    deleted
}

fn store_error(error: impl std::fmt::Display) -> String {
    format!("postgres_changes subscription was not stored: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_official_filter_shapes() {
        assert_eq!(parse_filters("").unwrap(), Vec::new());
        assert_eq!(parse_filters("   ").unwrap(), Vec::new());
        assert_eq!(
            parse_filters("task=eq.keep").unwrap(),
            vec![ParsedFilter {
                column: "task".into(),
                op: "eq".into(),
                value: "keep".into(),
                negate: false,
            }]
        );
        assert_eq!(
            parse_filters("subject=not.like.hey%").unwrap(),
            vec![ParsedFilter {
                column: "subject".into(),
                op: "like".into(),
                value: "hey%".into(),
                negate: true,
            }]
        );
        assert_eq!(
            parse_filters("subject=in.(hidee,ho)").unwrap(),
            vec![ParsedFilter {
                column: "subject".into(),
                op: "in".into(),
                value: "{hidee,ho}".into(),
                negate: false,
            }]
        );
        assert_eq!(parse_filters("id=gt.0,id=lt.100").unwrap().len(), 2);
        assert!(parse_filters("subject=foo.hey").is_err());
        assert!(parse_filters("undefined").is_err());
    }

    #[test]
    fn a_subscription_needs_a_schema_or_a_table() {
        let missing = json!({"event": "*"});
        assert!(change_spec_from_config(missing.as_object().unwrap(), 0).is_err());

        let table_only = json!({"event": "INSERT", "table": "todos", "filter": "task=eq.keep"});
        let spec = change_spec_from_config(table_only.as_object().unwrap(), 3).unwrap();
        assert_eq!(spec.schema, "public");
        assert_eq!(spec.table, "todos");
        assert_eq!(spec.action_filter, "INSERT");
        assert_eq!(spec.client_id, "3");
        assert_eq!(spec.filters[0].value, "keep");
    }
}
