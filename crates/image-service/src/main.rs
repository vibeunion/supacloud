use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing::{error, info};

mod engine;
mod parser;

use engine::process_image;
use parser::parse_path;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,supacloud_image_service=debug".into()),
        )
        .init();

    let host = std::env::var("IMAGE_SERVICE_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("IMAGE_SERVICE_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(9010);

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .expect("Invalid bind address");

    let app = Router::new()
        .route("/healthcheck", get(healthcheck))
        .route("/health", get(healthcheck))
        .route("/", post(handle_root_post))
        .route("/{*path}", post(handle_transform_post).get(handle_get_dispatch))
        .layer(DefaultBodyLimit::max(engine::MAX_PAYLOAD_BYTES))
        .layer(TraceLayer::new_for_http());

    info!("🚀 SupaCloud Image Service (Rust) listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn with_engine_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-image-engine", "supacloud-image/rust".parse().unwrap());
    headers
}

async fn healthcheck() -> impl IntoResponse {
    let mut headers = with_engine_headers();
    headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    (
        StatusCode::OK,
        headers,
        Json(json!({
            "status": "healthy",
            "engine": "supacloud-image/rust",
            "version": env!("CARGO_PKG_VERSION")
        })),
    )
}

async fn handle_root_post(body: Bytes) -> Response {
    handle_transform(String::new(), body, HeaderMap::new()).await
}

async fn handle_transform_post(
    Path(path): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_transform(path, body, headers).await
}

async fn handle_get_dispatch(Path(path): Path<String>) -> Response {
    if path == "healthcheck" || path == "health" {
        return healthcheck().await.into_response();
    }

    (
        StatusCode::METHOD_NOT_ALLOWED,
        with_engine_headers(),
        "POST request with raw image bytes required for transformations",
    )
        .into_response()
}

async fn handle_transform(
    path: String,
    body: Bytes,
    headers: HeaderMap,
) -> Response {
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            with_engine_headers(),
            "Empty image payload",
        )
            .into_response();
    }

    let mut options = parse_path(&path);
    let negotiated_format = options.format.is_none();

    // imgproxy Pro Auto-Format Negotiation:
    // If no format is explicitly configured, check Accept header
    if options.format.is_none() {
        if let Some(accept) = headers.get(header::ACCEPT).and_then(|h| h.to_str().ok()) {
            if accept.contains("image/avif") {
                options.format = Some(parser::TargetFormat::Avif);
            } else if accept.contains("image/webp") {
                options.format = Some(parser::TargetFormat::WebP);
            }
        }
    }

    let body_arc = Arc::new(body);
    let options_clone = options.clone();

    // Spawn blocking task to utilize thread pool without blocking Tokio runtime
    let result = tokio::task::spawn_blocking(move || {
        process_image(&body_arc, &options_clone)
    })
    .await;

    match result {
        Ok(Ok(output)) => {
            let mut res_headers = with_engine_headers();
            res_headers.insert(
                header::CONTENT_TYPE,
                output.content_type.parse().unwrap(),
            );
            res_headers.insert(
                header::CACHE_CONTROL,
                "public, max-age=3600, stale-while-revalidate=86400".parse().unwrap(),
            );
            if negotiated_format {
                res_headers.insert(header::VARY, "Accept".parse().unwrap());
            }

            (StatusCode::OK, res_headers, output.bytes).into_response()
        }
        Ok(Err(err)) => {
            error!("[ImageService] Processing error: {}", err);
            let status = match err {
                engine::EngineError::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
                engine::EngineError::DimensionsTooLarge(..) => StatusCode::UNPROCESSABLE_ENTITY,
                engine::EngineError::DecodeError(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, with_engine_headers(), err.to_string()).into_response()
        }
        Err(join_err) => {
            error!("[ImageService] Worker thread panic: {}", join_err);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                with_engine_headers(),
                "Internal image processing error",
            )
                .into_response()
        }
    }
}
