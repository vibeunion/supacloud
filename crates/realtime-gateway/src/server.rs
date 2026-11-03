use crate::broadcast::{
    next_connection_id, ChannelHub, PostgresChangeEvent, PostgresChangeSubscription,
    TopicSubscriptionConfig,
};
use crate::filter::ColumnFilter;
use crate::postgres::PostgresListenerManager;
use crate::protocol::PhoenixV2Message;
use crate::tenant::{TenantConfig, TenantRegistry};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, Request, State,
    },
    middleware::{from_fn_with_state, Next},
    http::{HeaderMap, StatusCode},
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
    if state.control_token.is_empty() || presented != Some(state.control_token.as_str()) {
        return Err(StatusCode::UNAUTHORIZED);
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
        .route("/api/tenants/{id}", get(get_tenant).delete(delete_tenant))
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

async fn register_tenant(
    State(state): State<AppState>,
    Json(tenant): Json<TenantConfig>,
) -> impl IntoResponse {
    info!(id = %tenant.id, "Registering tenant in native Realtime Gateway");
    state.pg_manager.start_listener(tenant.clone());
    state.registry.register(tenant);

    (
        StatusCode::CREATED,
        Json(json!({ "message": "Tenant registered successfully" })),
    )
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

async fn delete_tenant(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
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

async fn ingest_cdc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(event): Json<PostgresChangeEvent>,
) -> impl IntoResponse {
    state.hub.dispatch_cdc(&id, &event);
    Json(json!({ "status": "dispatched" }))
}

#[derive(Debug, Deserialize)]
struct BroadcastBody {
    topic: String,
    payload: Value,
}

async fn api_broadcast(
    State(state): State<AppState>,
    Json(body): Json<BroadcastBody>,
) -> impl IntoResponse {
    state.hub.broadcast(None, &body.topic, body.payload);
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
        .or(if !apikey.is_empty() { Some(&apikey) } else { None })
        .unwrap_or("default");

    let tenant_id = if let Some(tenant) = state.registry.resolve_tenant(candidate_ref) {
        tenant.id
    } else {
        candidate_ref.to_string()
    };

    ws.on_upgrade(move |socket| handle_socket(socket, state, tenant_id, apikey))
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    tenant_id: String,
    _apikey: String,
) {
    let conn_id = next_connection_id();
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<PhoenixV2Message>();

    state.hub.add_connection(conn_id.clone(), tenant_id.clone(), tx);
    info!(conn_id = %conn_id, tenant = %tenant_id, "WebSocket client connected");

    // Task to send messages from channel to WebSocket client
    let conn_id_clone = conn_id.clone();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg.encode() {
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
                match PhoenixV2Message::decode(text_str) {
                    Ok(parsed) => {
                        handle_client_message(&hub, &conn_id_recv, parsed).await;
                    }
                    Err(e) => {
                        warn!(conn_id = %conn_id_recv, error = %e, "Malformed Phoenix frame received");
                    }
                }
            }
            Message::Binary(_) => {
                // Ignore raw binary frame or forward if needed
            }
            Message::Ping(_) => {}
            Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    // Client disconnected
    send_task.abort();
    let presence_diffs = hub.remove_connection(&conn_id);
    for (topic, diff) in presence_diffs {
        let diff_msg = PhoenixV2Message::presence_diff(&topic, json!(diff.joins), json!(diff.leaves));
        hub.send_to_topic(&topic, None, diff_msg);
    }
    info!(conn_id = %conn_id, "WebSocket client disconnected");
}

async fn handle_client_message(
    hub: &Arc<ChannelHub>,
    conn_id: &str,
    msg: PhoenixV2Message,
) {
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

        // Parse postgres_changes
        let mut change_subs = Vec::new();
        let mut response_postgres_changes = Vec::new();

        if let Some(changes_val) = config.get("postgres_changes").and_then(|v| v.as_array()) {
            for (idx, item) in changes_val.iter().enumerate() {
                if let Some(obj) = item.as_object() {
                    let id = obj
                        .get("id")
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            Value::Number(n) => n.to_string(),
                            _ => v.to_string(),
                        })
                        .unwrap_or_else(|| idx.to_string());

                    let event = obj
                        .get("event")
                        .and_then(|v| v.as_str())
                        .unwrap_or("*")
                        .to_string();

                    let schema = obj
                        .get("schema")
                        .and_then(|v| v.as_str())
                        .unwrap_or("public")
                        .to_string();

                    let table = obj
                        .get("table")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let filter = obj
                        .get("filter")
                        .and_then(|v| v.as_str())
                        .and_then(ColumnFilter::parse);

                    change_subs.push(PostgresChangeSubscription {
                        id: Some(id.clone()),
                        event,
                        schema,
                        table,
                        filter,
                    });

                    response_postgres_changes.push(json!({ "id": id }));
                }
            }
        }

        let sub_config = TopicSubscriptionConfig {
            join_ref: join_ref.clone(),
            broadcast_self,
            broadcast_ack,
            presence_key,
            postgres_changes: change_subs,
        };

        hub.subscribe(conn_id, topic, sub_config);

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
        let pres_state = hub.get_presence_state(topic);
        if pres_state != json!({}) {
            let state_msg = PhoenixV2Message::presence_state(topic, pres_state);
            hub.send_to_connection(conn_id, state_msg);
        }
        return;
    }

    // 3. phx_leave
    if event == "phx_leave" {
        let diff = hub.unsubscribe(conn_id, topic);
        if let Some(diff) = diff {
            let diff_msg = PhoenixV2Message::presence_diff(topic, json!(diff.joins), json!(diff.leaves));
            hub.send_to_topic(topic, None, diff_msg);
        }

        let reply = PhoenixV2Message::reply(join_ref, reference, topic, "ok", json!({}));
        hub.send_to_connection(conn_id, reply);
        return;
    }

    // 4. broadcast
    if event == "broadcast" {
        let bcast_payload = msg.payload.clone();
        hub.broadcast(Some(conn_id), topic, bcast_payload);

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
            let diff = hub.track_presence(conn_id, topic, None, payload);
            let diff_msg = PhoenixV2Message::presence_diff(topic, json!(diff.joins), json!(diff.leaves));
            hub.send_to_topic(topic, None, diff_msg);

            if let Some(ref r) = reference {
                let reply = PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}));
                hub.send_to_connection(conn_id, reply);
            }
        } else if pres_type == Some("untrack") {
            let diff = hub.untrack_presence(conn_id, topic);
            if let Some(diff) = diff {
                let diff_msg = PhoenixV2Message::presence_diff(topic, json!(diff.joins), json!(diff.leaves));
                hub.send_to_topic(topic, None, diff_msg);
            }

            if let Some(ref r) = reference {
                let reply = PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}));
                hub.send_to_connection(conn_id, reply);
            }
        }
        return;
    }

    // 6. access_token update
    if event == "access_token" {
        if let Some(ref r) = reference {
            let reply = PhoenixV2Message::reply(join_ref, Some(r.clone()), topic, "ok", json!({}));
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
