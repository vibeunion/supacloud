use std::env;
use std::net::SocketAddr;
use supacloud_realtime_gateway::{
    create_router, AppState, ChannelHub, PostgresListenerManager, TenantRegistry,
};
use supacloud_runtime_core::{init_tracing, resolve_socket_addr, shutdown_signal};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing("info,supacloud_realtime_gateway=debug,tower_http=info");

    let addr = resolve_socket_addr(
        "REALTIME_BIND_HOST",
        &["REALTIME_PORT", "PORT"],
        "0.0.0.0",
        4000,
    )?;

    let global_jwt_secret = env::var("API_JWT_SECRET")
        .or_else(|_| env::var("JWT_SECRET"))
        .or_else(|_| env::var("SUPACLOUD_JWT_SECRET"))
        .ok();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "Starting SupaCloud native Realtime Gateway"
    );

    let hub = ChannelHub::new();
    let registry = TenantRegistry::new(global_jwt_secret);
    let pg_manager = PostgresListenerManager::new(hub.clone());

    let control_token = env::var("REALTIME_CONTROL_TOKEN").unwrap_or_default();
    if control_token.is_empty() {
        return Err(
            "REALTIME_CONTROL_TOKEN is required before the realtime control API can start".into(),
        );
    }

    let state = AppState {
        registry,
        hub,
        pg_manager,
        control_token,
    };

    let app = create_router(state);

    info!("Realtime Gateway listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    info!("Realtime Gateway stopped cleanly");
    Ok(())
}
