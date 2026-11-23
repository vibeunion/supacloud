use std::env;
use std::io;
use std::net::SocketAddr;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init_tracing(default_filter: &str) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .try_init();
}

pub fn resolve_socket_addr(
    host_var: &str,
    port_vars: &[&str],
    default_host: &str,
    default_port: u16,
) -> Result<SocketAddr, io::Error> {
    let host = env::var(host_var).unwrap_or_else(|_| default_host.to_owned());
    let port = port_vars
        .iter()
        .find_map(|name| env::var(name).ok().and_then(|value| value.parse().ok()))
        .unwrap_or(default_port);

    format!("{host}:{port}").parse().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid {host_var} bind address: {error}"),
        )
    })
}

pub fn health_payload(engine: &str, version: &str) -> serde_json::Value {
    serde_json::json!({
        "status": "healthy",
        "engine": engine,
        "version": version,
    })
}

pub async fn shutdown_signal() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_payload_is_stable() {
        assert_eq!(
            health_payload("example/rust", "1.2.3"),
            serde_json::json!({
                "status": "healthy",
                "engine": "example/rust",
                "version": "1.2.3",
            })
        );
    }

    #[test]
    fn invalid_host_is_reported_as_an_input_error() {
        let error = resolve_socket_addr(
            "SUPACLOUD_TEST_HOST",
            &["SUPACLOUD_TEST_PORT"],
            "not a host",
            4000,
        )
        .expect_err("invalid host should fail");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
