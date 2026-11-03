use std::env;
use std::net::SocketAddr;
use supacloud_realtime_gateway::{
    create_router, AppState, ChannelHub, PostgresListenerManager, TenantRegistry,
};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Setup tracing subscriber
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,supacloud_realtime_gateway=debug,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let bind_host = env::var("REALTIME_BIND_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port: u16 = env::var("REALTIME_PORT")
        .or_else(|_| env::var("PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4000);

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

    let addr: SocketAddr = format!("{}:{}", bind_host, port).parse()?;
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

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
