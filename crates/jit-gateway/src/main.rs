use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing::info;

mod gateway;
mod policy;

use gateway::{CreateBindingRequest, GatewayManager};

fn control_authorized(headers: &HeaderMap) -> bool {
    let expected = std::env::var("JIT_GATEWAY_CONTROL_TOKEN").unwrap_or_default();
    if expected.is_empty() {
        let host = std::env::var("JIT_GATEWAY_CONTROL_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        return host == "127.0.0.1" || host == "::1" || host == "localhost";
    }
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected)
}

fn unauthorized() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "status": "error", "message": "unauthorized" })),
    )
}


#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,supacloud_jit_gateway=debug".into()),
        )
        .init();

    let control_host = std::env::var("JIT_GATEWAY_CONTROL_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let control_port = std::env::var("JIT_GATEWAY_CONTROL_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(9012);

    let bind_host = std::env::var("JIT_GATEWAY_BIND_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let upstream_host = std::env::var("JIT_GATEWAY_UPSTREAM_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let upstream_port = std::env::var("JIT_GATEWAY_UPSTREAM_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(5432);

    let manager = GatewayManager::new(bind_host, upstream_host, upstream_port);
    let state = Arc::new(manager);

    let app = Router::new()
        .route("/healthcheck", get(healthcheck))
        .route("/health", get(healthcheck))
        .route("/v1/bindings", post(create_binding).get(list_bindings))
        .route(
            "/v1/bindings/{credential_id}",
            delete(delete_binding).get(get_binding),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let control_addr: SocketAddr = format!("{}:{}", control_host, control_port)
        .parse()
        .expect("Invalid control bind address");

    info!(
        "🚀 SupaCloud JIT Database Gateway (Rust) control listening on http://{}",
        control_addr
    );

    let listener = tokio::net::TcpListener::bind(&control_addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn healthcheck() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "status": "healthy",
            "engine": "supacloud-jit-gateway/rust",
            "version": env!("CARGO_PKG_VERSION")
        })),
    )
}

async fn create_binding(
    State(manager): State<Arc<GatewayManager>>,
    headers: HeaderMap,
    Json(payload): Json<CreateBindingRequest>,
) -> impl IntoResponse {
    if !control_authorized(&headers) {
        return unauthorized();
    }
    let credential_id = payload.credential_id.clone();
    match manager.bind(payload).await {
        Ok(actual_port) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "credential_id": credential_id,
                "bound_port": actual_port
            })),
        ),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": "error",
                "message": err
            })),
        ),
    }
}

async fn list_bindings(State(manager): State<Arc<GatewayManager>>, headers: HeaderMap) -> impl IntoResponse {
    if !control_authorized(&headers) {
        return unauthorized();
    }
    let bindings = manager.list_bindings();
    (StatusCode::OK, Json(json!({ "bindings": bindings })))
}

async fn get_binding(
    State(manager): State<Arc<GatewayManager>>,
    headers: HeaderMap,
    Path(credential_id): Path<String>,
) -> impl IntoResponse {
    if !control_authorized(&headers) {
        return unauthorized();
    }
    if let Some(port) = manager.bound_port(&credential_id) {
        (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "credential_id": credential_id,
                "bound_port": port
            })),
        )
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({
                "status": "not_found",
                "message": "Binding not found"
            })),
        )
    }
}

async fn delete_binding(
    State(manager): State<Arc<GatewayManager>>,
    headers: HeaderMap,
    Path(credential_id): Path<String>,
) -> impl IntoResponse {
    if !control_authorized(&headers) {
        return unauthorized();
    }
    let released = manager.release(&credential_id);
    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "released": released,
            "credential_id": credential_id
        })),
    )
}
