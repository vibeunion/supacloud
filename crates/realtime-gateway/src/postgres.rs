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

/// Builds the connection from the tenant's fields instead of interpolating a
/// keyword string.
///
/// The string form broke in two ways: an empty password produced
/// `password=` and `tokio-postgres` rejected the whole string as invalid (so a
/// trust-authenticated or otherwise passwordless tenant silently received no
/// CDC at all), and a password containing a space or a quote corrupted the
/// keyword/value parsing. Setting the fields directly has neither problem, and
/// an absent `dbname` still defaults to the user name on the server.
pub(crate) fn connection_config(tenant: &TenantConfig) -> tokio_postgres::Config {
    let mut config = tokio_postgres::Config::new();
    config
        .host(&tenant.db_host)
        .port(tenant.db_port)
        .user(&tenant.db_user);
    if !tenant.db_name.trim().is_empty() {
        config.dbname(&tenant.db_name);
    }
    if !tenant.db_password.is_empty() {
        config.password(&tenant.db_password);
    }
    config
}

/// Issues `LISTEN` while polling the connection.
///
/// `tokio-postgres` only advances the protocol while the `Connection` future is
/// polled, so `client.batch_execute(..).await` on its own deadlocks: the client
/// waits for a response, and nothing drives the socket that would deliver it.
/// The `LISTEN` then never completes and no notification is ever dispatched,
/// which is exactly how this listener behaved — it logged "Connected", then sat
/// on a half-finished batch forever. Polling both here is the documented way to
/// use a client and its connection together.
async fn listen_channel(
    client: &tokio_postgres::Client,
    connection: &mut tokio_postgres::Connection<
        tokio_postgres::Socket,
        tokio_postgres::tls::NoTlsStream,
    >,
) -> Result<(), String> {
    let listen = client.batch_execute("LISTEN realtime_changes;");
    tokio::pin!(listen);
    let mut messages = poll_fn(|cx| connection.poll_message(cx));
    loop {
        tokio::select! {
            result = &mut listen => return result.map_err(|error| error.to_string()),
            // Notices and parameter-status messages are not interesting here;
            // a closed connection is, because the batch will never complete.
            message = messages.next() => {
                if message.is_none() {
                    return Err("connection closed before LISTEN completed".to_owned());
                }
            }
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

    let mut backoff = Duration::from_millis(500);
    let max_backoff = Duration::from_secs(10);
    let mut attempts = 0_u32;

    loop {
        // Built per attempt, not once: `Config::connect` borrows it across the
        // await, and a reconnect should not reuse a stale configuration.
        let config = connection_config(&tenant);
        tokio::select! {
            _ = &mut stop_rx => {
                info!(tenant = %tenant_id, "Stopping Postgres listener (canceled)");
                return;
            }
            conn_res = config.connect(tokio_postgres::NoTls) => {
                attempts += 1;
                match conn_res {
                    Ok((client, mut connection)) => {
                        info!(tenant = %tenant_id, "Connected to Postgres for LISTEN realtime_changes");
                        backoff = Duration::from_millis(500);

                        // Listen on realtime_changes notification channel
                        if let Err(e) = listen_channel(&client, &mut connection).await {
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
                        // A tenant whose database is unreachable gets no CDC at
                        // all, so the first failure belongs in the log at a
                        // level an operator sees. The retries stay at debug.
                        if attempts == 1 {
                            warn!(tenant = %tenant_id, error = %e, "Failed to connect to Postgres for LISTEN realtime_changes, retrying...");
                        } else {
                            debug!(tenant = %tenant_id, error = %e, "Failed to connect to Postgres, retrying...");
                        }
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
