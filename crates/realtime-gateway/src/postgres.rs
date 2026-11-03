use crate::broadcast::{ChannelHub, PostgresChangeEvent};
use crate::tenant::TenantConfig;
use futures_util::stream::poll_fn;
use futures_util::StreamExt;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

pub struct PostgresListenerManager {
    hub: Arc<ChannelHub>,
    active_listeners: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl PostgresListenerManager {
    pub fn new(hub: Arc<ChannelHub>) -> Arc<Self> {
        Arc::new(Self {
            hub,
            active_listeners: Mutex::new(HashMap::new()),
        })
    }

    /// Start a Postgres listener for a given tenant
    pub fn start_listener(&self, tenant: TenantConfig) {
        let tenant_id = tenant.id.clone();
        let mut map = self.active_listeners.lock();

        // If listener already running for this tenant, stop previous one
        if let Some(stop_tx) = map.remove(&tenant_id) {
            let _ = stop_tx.send(());
        }

        let (stop_tx, stop_rx) = oneshot::channel();
        map.insert(tenant_id.clone(), stop_tx);

        let hub = self.hub.clone();
        tokio::spawn(async move {
            run_listener_loop(hub, tenant, stop_rx).await;
        });
    }

    /// Stop listener for a tenant
    pub fn stop_listener(&self, tenant_id: &str) {
        let mut map = self.active_listeners.lock();
        if let Some(stop_tx) = map.remove(tenant_id) {
            let _ = stop_tx.send(());
        }
    }
}

async fn run_listener_loop(
    hub: Arc<ChannelHub>,
    tenant: TenantConfig,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let tenant_id = tenant.id.clone();
    info!(tenant = %tenant_id, "Starting Postgres CDC listener for tenant");

    let conn_str = format!(
        "host={} port={} dbname={} user={} password={}",
        tenant.db_host, tenant.db_port, tenant.db_name, tenant.db_user, tenant.db_password
    );

    let mut backoff = Duration::from_millis(500);
    let max_backoff = Duration::from_secs(10);

    loop {
        tokio::select! {
            _ = &mut stop_rx => {
                info!(tenant = %tenant_id, "Stopping Postgres listener (canceled)");
                return;
            }
            conn_res = tokio_postgres::connect(&conn_str, tokio_postgres::NoTls) => {
                match conn_res {
                    Ok((client, mut connection)) => {
                        info!(tenant = %tenant_id, "Connected to Postgres for LISTEN realtime_changes");
                        backoff = Duration::from_millis(500);

                        // Listen on realtime_changes notification channel
                        if let Err(e) = client.batch_execute("LISTEN realtime_changes;").await {
                            warn!(tenant = %tenant_id, error = %e, "Failed to execute LISTEN realtime_changes");
                            tokio::time::sleep(backoff).await;
                            continue;
                        }

                        // Stream notifications
                        let mut stream = poll_fn(move |cx| connection.poll_message(cx));

                        loop {
                            tokio::select! {
                                _ = &mut stop_rx => {
                                    info!(tenant = %tenant_id, "Stopping listener loop");
                                    return;
                                }
                                msg = stream.next() => {
                                    match msg {
                                        Some(Ok(tokio_postgres::AsyncMessage::Notification(notif))) => {
                                            let payload = notif.payload();
                                            match serde_json::from_str::<PostgresChangeEvent>(payload) {
                                                Ok(change) => {
                                                    hub.dispatch_cdc(&tenant_id, &change);
                                                }
                                                Err(e) => {
                                                    warn!(tenant = %tenant_id, error = %e, "Failed to parse NOTIFY JSON payload");
                                                }
                                            }
                                        }
                                        Some(Ok(_)) => {
                                            // Other async message (notice, parameter status, etc.)
                                        }
                                        Some(Err(e)) => {
                                            warn!(tenant = %tenant_id, error = %e, "Postgres connection error");
                                            break;
                                        }
                                        None => {
                                            warn!(tenant = %tenant_id, "Postgres connection closed");
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        debug!(tenant = %tenant_id, error = %e, "Failed to connect to Postgres, retrying...");
                    }
                }
            }
        }

        // Backoff before reconnecting
        tokio::select! {
            _ = &mut stop_rx => return,
            _ = tokio::time::sleep(backoff) => {
                backoff = (backoff * 2).min(max_backoff);
            }
        }
    }
}
