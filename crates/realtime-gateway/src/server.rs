use crate::broadcast::{
    next_connection_id, ChannelHub, PostgresChangeSubscription, TopicSubscriptionConfig,
};
use crate::postgres::PostgresListenerManager;
use crate::protocol::PhoenixV2Message;
use crate::subscriptions::{self, ChangeSpec};
use crate::tenant::{TenantConfig, TenantRegistry};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, Request, State,
    },
    http::{HeaderMap, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{debug, info, warn};

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<TenantRegistry>,
    pub hub: Arc<ChannelHub>,
    pub pg_manager: Arc<PostgresListenerManager>,
    pub control_token: String,
}

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub apikey: Option<String>,
    #[serde(default = "default_vsn")]
    pub vsn: String,
    #[serde(rename = "ref")]
    pub ref_: Option<String>,
}

fn default_vsn() -> String {
    "2.0.0".to_string()
}

async fn require_control_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let presented = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let Some(token) = presented else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let raw_token_ok = !state.control_token.is_empty() && token == state.control_token;
    if !raw_token_ok {
        let jwt_ok = state
            .registry
            .verify_jwt(token, None)
            .and_then(|claims| claims.role)
            .is_some_and(|role| role == "supabase_admin" || role == "service_role");
        if !jwt_ok {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    Ok(next.run(request).await)
}

pub fn create_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let control = Router::new()
        .route("/api/tenants", post(register_tenant).get(list_tenants))
        .route(
            "/api/tenants/{id}",
            get(get_tenant).put(update_tenant).delete(delete_tenant),
        )
        .route("/api/tenants/{id}/cdc", post(ingest_cdc))
        .route("/api/broadcast", post(api_broadcast))
        .route_layer(from_fn_with_state(state.clone(), require_control_token));

    Router::new()
        .route("/", get(health_check))
        .route("/healthcheck", get(health_check))
        .route("/realtime/v1/health", get(health_check))
        .route("/api/health", get(health_check))
        .route("/metrics", get(metrics))
        .route("/socket/websocket", get(ws_handler))
        .route("/realtime/v1/websocket", get(ws_handler))
        .merge(control)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "engine": "supacloud-realtime-gateway/rust",
        "version": env!("CARGO_PKG_VERSION"),
        "connections": state.hub.connection_count(),
        "topics": state.hub.topic_count(),
    }))
}

async fn metrics(State(state): State<AppState>) -> impl IntoResponse {
    format!(
        "# HELP supacloud_realtime_connections Current active WebSocket connections\n\
         # TYPE supacloud_realtime_connections gauge\n\
         supacloud_realtime_connections {}\n\
         # HELP supacloud_realtime_topics Current active topics\n\
         # TYPE supacloud_realtime_topics gauge\n\
         supacloud_realtime_topics {}\n",
        state.hub.connection_count(),
        state.hub.topic_count()
    )
}

async fn register_tenant(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let tenant = match TenantConfig::from_registration(payload) {
        Ok(tenant) => tenant,
        Err(error) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "error": error })),
            )
                .into_response();
        }
    };

    info!(id = %tenant.id, "Registering tenant in native Realtime Gateway");
    state.pg_manager.start_listener(tenant.clone());
    state.registry.register(tenant);

    (
        StatusCode::CREATED,
        Json(json!({ "message": "Tenant registered successfully" })),
    )
        .into_response()
}

async fn list_tenants(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.registry.list())
}

async fn get_tenant(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TenantConfig>, StatusCode> {
    state
        .registry
        .get(&id)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn delete_tenant(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    info!(id = %id, "Removing tenant from Realtime Gateway");
    state.pg_manager.stop_listener(&id);
    let removed = state.registry.remove(&id);

    if removed.is_some() {
        (
            StatusCode::OK,
            Json(json!({ "message": "Tenant deleted successfully" })),
        )
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Tenant not found" })),
        )
    }
}

async fn update_tenant(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    let tenant = match TenantConfig::from_registration(payload) {
        Ok(tenant) => tenant,
        Err(error) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "error": error })),
            )
                .into_response();
        }
    };
    if tenant.id != id && tenant.external_id.as_deref() != Some(id.as_str()) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": "tenant id does not match the URL" })),
        )
            .into_response();
    }
    info!(id = %tenant.id, "Updating tenant in native Realtime Gateway");
    state.pg_manager.start_listener(tenant.clone());
    state.registry.register(tenant);
    (
        StatusCode::OK,
        Json(json!({ "message": "Tenant updated successfully" })),
    )
        .into_response()
}

/// Retired. Injecting a decoded row here skipped `realtime.apply_rls`.
async fn ingest_cdc() -> impl IntoResponse {
    (
        StatusCode::GONE,
        Json(json!({
            "error": "postgres_changes are read from the tenant replication slot and filtered by realtime.apply_rls"
        })),
    )
}

#[derive(Debug, Deserialize)]
struct BroadcastBody {
    #[serde(alias = "tenant", alias = "ref")]
    tenant_id: String,
    topic: String,
    payload: Value,
}

async fn api_broadcast(
    State(state): State<AppState>,
    Json(body): Json<BroadcastBody>,
) -> impl IntoResponse {
    state
        .hub
        .broadcast(None, &body.tenant_id, &body.topic, body.payload);
    Json(json!({ "status": "broadcasted" }))
}

async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Resolve project/tenant reference
    let apikey = query.apikey.clone().unwrap_or_default();
    let header_ref = headers
        .get("x-project-ref")
        .or_else(|| headers.get("x-supabase-project"))
        .and_then(|v| v.to_str().ok());

    let host_ref = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.split('.').next());

    let candidate_ref = query
        .ref_
        .as_deref()
        .or(header_ref)
        .or(host_ref)
        .or(if !apikey.is_empty() {
            Some(&apikey)
        } else {
            None
        })
        .unwrap_or("default");

    let Some(tenant) = state.registry.resolve_tenant(candidate_ref) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if apikey.is_empty() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(mut claims) = state
        .registry
        .verify_jwt_payload(&apikey, Some(&tenant.jwt_secret))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let role = claims
        .get("role")
        .and_then(Value::as_str)
        .filter(|role| !role.is_empty())
        .unwrap_or("anon")
        .to_owned();
    if claims.get("role").and_then(Value::as_str).is_none() {
        claims["role"] = json!(role);
    }
    let tenant_id = tenant.id;
    let client_vsn = query.vsn;

    ws.on_upgrade(move |socket| handle_socket(socket, state, tenant_id, role, claims, client_vsn))
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    tenant_id: String,
    role: String,
    claims: Value,
    client_vsn: String,
) {
    let conn_id = next_connection_id();
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<PhoenixV2Message>();

    state
        .hub
        .add_connection(conn_id.clone(), tenant_id.clone(), role.clone(), tx);
    info!(conn_id = %conn_id, tenant = %tenant_id, vsn = %client_vsn, "WebSocket client connected");

    // Task to send messages from channel to WebSocket client
    let conn_id_clone = conn_id.clone();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg.encode_for_client(&client_vsn) {
                Ok(text) => {
                    if let Err(e) = ws_sender.send(Message::Text(text.into())).await {
                        debug!(conn_id = %conn_id_clone, error = %e, "Failed to send WS message");
                        break;
                    }
                }
                Err(e) => {
                    warn!(conn_id = %conn_id_clone, error = %e, "Failed to encode message");
                }
            }
        }
    });

    // Loop to read incoming WebSocket messages from client
    let hub = state.hub.clone();
    let conn_id_recv = conn_id.clone();
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(text) => {
                let text_str = text.as_str();
                match PhoenixV2Message::decode_client_frame(text_str) {
                    Ok(parsed) => {
                        handle_client_message(
                            &state,
                            &tenant_id,
                            &role,
                            &claims,
                            &conn_id_recv,
                            parsed,
                        )
                        .await;
                    }
                    Err(e) => {
                        warn!(conn_id = %conn_id_recv, error = %e, "Malformed Phoenix frame received");
                    }
                }
            }
            Message::Binary(bytes) => {
                // realtime-js v2 encodes broadcast pushes as a binary frame.
                // JSON text broadcasts stay on the text path above.
                match PhoenixV2Message::decode_user_broadcast_push(bytes.as_ref()) {
                    Ok(parsed) => {
                        handle_client_message(
                            &state,
                            &tenant_id,
                            &role,
                            &claims,
                            &conn_id_recv,
                            parsed,
                        )
                        .await;
                    }
                    Err(e) => {
                        warn!(
                            conn_id = %conn_id_recv,
                            error = %e,
                            kind = bytes.first().copied(),
                            "Unparseable or unknown-kind binary Realtime frame"
                        );
                    }
                }
            }
            Message::Ping(_) => {}
            Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    // Client disconnected. Drop the subscription rows first so a later poll
    // cannot hand this socket a change it has already left.
    send_task.abort();
    let subscription_ids = hub.subscription_db_ids(&conn_id);
    if let Some(tenant) = state.registry.get(&tenant_id) {
        if let Err(error) = subscriptions::delete_subscriptions(&tenant, &subscription_ids).await {
            warn!(conn_id = %conn_id, error = %error, "Failed to delete realtime.subscription rows");
        }
    }
    let presence_diffs = hub.remove_connection(&conn_id);
    for (topic, diff) in presence_diffs {
        let diff_msg =
            PhoenixV2Message::presence_diff(&topic, json!(diff.joins), json!(diff.leaves));
        hub.send_to_topic(&tenant_id, &topic, None, diff_msg);
    }
    info!(conn_id = %conn_id, "WebSocket client disconnected");
}

async fn handle_client_message(
    state: &AppState,
    tenant_id: &str,
    _role: &str,
    claims: &Value,
    conn_id: &str,
    msg: PhoenixV2Message,
) {
    let hub = &state.hub;
    let topic = &msg.topic;
    let event = &msg.event;
    let join_ref = msg.join_ref.clone();
    let reference = msg.reference.clone();

    // 1. Heartbeat on topic "phoenix"
    if topic == "phoenix" && event == "heartbeat" {
        let reply = PhoenixV2Message::reply(None, reference, "phoenix", "ok", json!({}));
        hub.send_to_connection(conn_id, reply);
        return;
    }

    // 2. phx_join
    if event == "phx_join" {
        let config = msg.payload.get("config").cloned().unwrap_or(json!({}));
        let broadcast_self = config
            .get("broadcast")
            .and_then(|b| b.get("self"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let broadcast_ack = config
            .get("broadcast")
            .and_then(|b| b.get("ack"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let presence_key = config
            .get("presence")
            .and_then(|p| p.get("key"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut specs: Vec<ChangeSpec> = Vec::new();
        if let Some(changes_val) = config.get("postgres_changes").and_then(Value::as_array) {
            for (idx, item) in changes_val.iter().enumerate() {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                match subscriptions::change_spec_from_config(obj, idx) {
                    Ok(spec) => specs.push(spec),
                    Err(reason) => {
                        let reply = PhoenixV2Message::reply(
                            join_ref,
                            reference,
                            topic,
                            "error",
                            json!({ "reason": reason }),
                        );
                        hub.send_to_connection(conn_id, reply);
                        return;
                    }
                }
            }
        }

        let stored = if specs.is_empty() {
            Vec::new()
        } else {
            let Some(tenant) = state.registry.get(tenant_id) else {
                let reply = PhoenixV2Message::reply(
                    join_ref,
                    reference,
                    topic,
                    "error",
                    json!({
                        "reason": "postgres_changes subscription was not stored: tenant is not registered"
                    }),
                );
                hub.send_to_connection(conn_id, reply);
                return;
            };
            match subscriptions::store_subscriptions(&tenant, claims, &specs).await {
                Ok(stored) => stored,
                Err(reason) => {
                    let reply = PhoenixV2Message::reply(
                        join_ref,
                        reference,
                        topic,
                        "error",
                        json!({ "reason": reason }),
                    );
                    hub.send_to_connection(conn_id, reply);
                    return;
                }
            }
        };

        let mut change_subs = Vec::new();
        let mut response_postgres_changes = Vec::new();
        for (spec, row) in specs.iter().zip(stored.iter()) {
            response_postgres_changes.push(json!({ "id": spec.client_id }));
            change_subs.push(PostgresChangeSubscription {
                id: Some(spec.client_id.clone()),
                db_id: Some(row.db_id.clone()),
                event: spec.action_filter.clone(),
                schema: spec.schema.clone(),
                table: Some(spec.table.clone()),
            });
        }

        let sub_config = TopicSubscriptionConfig {
            join_ref: join_ref.clone(),
            broadcast_self,
            broadcast_ack,
            presence_key,
            postgres_changes: change_subs,
        };

        hub.subscribe(conn_id, tenant_id, topic, sub_config);

        // Send phx_reply: ok directly to connecting client
        let reply = PhoenixV2Message::reply(
            join_ref,
            reference,
            topic,
            "ok",
            json!({
                "postgres_changes": response_postgres_changes
            }),
        );
        hub.send_to_connection(conn_id, reply);

        // Send current presence_state if any directly to connecting client
        let pres_state = hub.get_presence_state(tenant_id, topic);
        if pres_state != json!({}) {
            let state_msg = PhoenixV2Message::presence_state(topic, pres_state);
            hub.send_to_connection(conn_id, state_msg);
        }
        return;
    }

    // 3. phx_leave
    if event == "phx_leave" {
        let subscription_ids = hub.subscription_db_ids_for_topic(conn_id, Some(topic));
        if let Some(tenant) = state.registry.get(tenant_id) {
            if let Err(error) =
                subscriptions::delete_subscriptions(&tenant, &subscription_ids).await
            {
                warn!(conn_id = %conn_id, error = %error, "Failed to delete realtime.subscription rows");
            }
        }
        let diff = hub.unsubscribe(conn_id, tenant_id, topic);
        if let Some(diff) = diff {
            let diff_msg =
                PhoenixV2Message::presence_diff(topic, json!(diff.joins), json!(diff.leaves));
            hub.send_to_topic(tenant_id, topic, None, diff_msg);
        }

        let reply = PhoenixV2Message::reply(join_ref, reference, topic, "ok", json!({}));
        hub.send_to_connection(conn_id, reply);
        return;
    }

    // 4. broadcast
    if event == "broadcast" {
        let bcast_payload = msg.payload.clone();
        hub.broadcast(Some(conn_id), tenant_id, topic, bcast_payload);

        // Send ack if requested
        if let Some(ref r) = reference {
            let reply = PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}));
            hub.send_to_connection(conn_id, reply);
        }
        return;
    }

    // 5. presence
    if event == "presence" {
        let pres_type = msg.payload.get("event").and_then(|v| v.as_str());
        if pres_type == Some("track") {
            let payload = msg.payload.get("payload").cloned().unwrap_or(json!({}));
            let diff = hub.track_presence(conn_id, tenant_id, topic, None, payload);
            let diff_msg =
                PhoenixV2Message::presence_diff(topic, json!(diff.joins), json!(diff.leaves));
            hub.send_to_topic(tenant_id, topic, None, diff_msg);

            if let Some(ref r) = reference {
                let reply =
                    PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}));
                hub.send_to_connection(conn_id, reply);
            }
        } else if pres_type == Some("untrack") {
            let diff = hub.untrack_presence(conn_id, tenant_id, topic);
            if let Some(diff) = diff {
                let diff_msg =
                    PhoenixV2Message::presence_diff(topic, json!(diff.joins), json!(diff.leaves));
                hub.send_to_topic(tenant_id, topic, None, diff_msg);
            }

            if let Some(ref r) = reference {
                let reply =
                    PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}));
                hub.send_to_connection(conn_id, reply);
            }
        }
        return;
    }

    // 6. access_token update
    if event == "access_token" {
        let token = msg
            .payload
            .get("access_token")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let tenant_secret = state
            .registry
            .get(tenant_id)
            .map(|tenant| tenant.jwt_secret);
        let valid = !token.is_empty()
            && state
                .registry
                .verify_jwt(token, tenant_secret.as_deref())
                .is_some();
        if let Some(ref r) = reference {
            let reply = if valid {
                PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}))
            } else {
                PhoenixV2Message::reply(
                    join_ref,
                    Some(r.clone()),
                    topic,
                    "error",
                    json!({ "reason": "invalid access_token" }),
                )
            };
            hub.send_to_connection(conn_id, reply);
        }
        return;
    }

    // Default: reply ok for unknown messages
    if let Some(ref r) = reference {
        let reply = PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}));
        hub.send_to_connection(conn_id, reply);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broadcast::TopicSubscriptionConfig;
    use crate::postgres::PostgresListenerManager;
    use crate::tenant::TenantRegistry;

    fn user_broadcast_push(
        join_ref: &str,
        reference: &str,
        topic: &str,
        event: &str,
        payload: &[u8],
    ) -> Vec<u8> {
        let mut frame = vec![
            3,
            join_ref.len() as u8,
            reference.len() as u8,
            topic.len() as u8,
            event.len() as u8,
            0,
            1,
        ];
        frame.extend_from_slice(join_ref.as_bytes());
        frame.extend_from_slice(reference.as_bytes());
        frame.extend_from_slice(topic.as_bytes());
        frame.extend_from_slice(event.as_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    async fn deliver(frame: &[u8]) -> Vec<PhoenixV2Message> {
        let parsed = PhoenixV2Message::decode_user_broadcast_push(frame).unwrap();
        let topic = parsed.topic.clone();
        let hub = ChannelHub::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        hub.add_connection("conn".into(), "tenant".into(), "anon".into(), tx);
        hub.subscribe(
            "conn",
            "tenant",
            &topic,
            TopicSubscriptionConfig {
                join_ref: parsed.join_ref.clone(),
                broadcast_self: true,
                broadcast_ack: true,
                presence_key: None,
                postgres_changes: Vec::new(),
            },
        );
        let state = AppState {
            registry: TenantRegistry::new(None),
            hub: hub.clone(),
            pg_manager: PostgresListenerManager::new(hub),
            control_token: "control".into(),
        };
        handle_client_message(
            &state,
            "tenant",
            "anon",
            &json!({"role": "anon"}),
            "conn",
            parsed,
        )
        .await;
        let mut messages = Vec::new();
        while let Ok(message) = rx.try_recv() {
            messages.push(message);
        }
        messages
    }

    #[tokio::test]
    async fn binary_broadcast_with_a_ref_produces_a_json_phx_reply_ack() {
        let frame = user_broadcast_push(
            "1",
            "4",
            "realtime:room",
            "test-event",
            br#"{"message":"test"}"#,
        );
        let messages = deliver(&frame).await;
        let ack = messages
            .iter()
            .find(|message| message.event == "phx_reply")
            .expect("a broadcast with a ref must be acknowledged");
        assert_eq!(ack.join_ref.as_deref(), Some("1"));
        assert_eq!(ack.reference.as_deref(), Some("4"));
        assert_eq!(ack.payload["status"], "ok");
        let encoded = ack.encode_for_client("2.0.0").unwrap();
        assert!(
            encoded.starts_with('['),
            "the v2 acknowledgement stays a Phoenix JSON text array"
        );
        let decoded = PhoenixV2Message::decode_client_frame(&encoded).unwrap();
        assert_eq!(decoded.event, "phx_reply");
        assert_eq!(decoded.reference.as_deref(), Some("4"));
    }

    #[tokio::test]
    async fn binary_broadcast_without_a_ref_is_not_acknowledged() {
        let frame = user_broadcast_push(
            "1",
            "",
            "realtime:room",
            "test-event",
            br#"{"message":"test"}"#,
        );
        let messages = deliver(&frame).await;
        assert!(messages.iter().all(|message| message.event != "phx_reply"));
    }
}
