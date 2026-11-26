use crate::broadcast::ChannelHub;
use crate::tenant::TenantConfig;
use crate::wal::{self, ChangeFeed, PublicationFilter};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

/// Membership is refreshed on a timer rather than on every poll: the gateway
/// polls a few times per second per tenant, and `ALTER PUBLICATION` is rare.
const PUBLICATION_REFRESH: Duration = Duration::from_secs(3);

/// How long a slot may keep producing rows before the poller yields, so one
/// busy tenant cannot starve the runtime.
const POLL_YIELD_AFTER: usize = 8;

/// A persisted slot is adopted instead of a second one being created.
///
/// Upstream Realtime names its slot `supabase_realtime_<ref>_<random suffix>`,
/// while this gateway asks for exactly `supabase_realtime_<ref>`. Creating a
/// second slot next to an existing one would retain the same WAL twice, so an
/// existing slot with that prefix is adopted and the suffix kept.
const SLOT_LOOKUP_SQL: &str = "\
SELECT slot_name FROM pg_replication_slots \
WHERE database = current_database() AND plugin = 'wal2json' \
  AND (slot_name = $1 OR starts_with(slot_name, $1 || '_')) \
ORDER BY slot_name LIMIT 1";

const SLOT_CREATE_SQL: &str = "SELECT pg_create_logical_replication_slot($1, 'wal2json')";

const PUBLICATION_SQL: &str = "\
SELECT p.pubinsert, p.pubupdate, p.pubdelete, \
       coalesce((SELECT string_agg(t.schemaname || chr(1) || t.tablename, chr(2)) \
                 FROM pg_publication_tables t WHERE t.pubname = p.pubname), '') \
FROM pg_publication p WHERE p.pubname = $1";

/// Official `realtime.list_changes`: one slot read, then `realtime.apply_rls`.
/// Rows with no matching subscription are already removed. A null `wal` is the
/// sentinel that reports how many slot records were consumed.
const LIST_CHANGES_SQL: &str = "\
SELECT wal, subscription_ids::text[], errors \
FROM realtime.list_changes($1::name, $2::name, $3::integer, $4::integer) \
WHERE wal IS NOT NULL";

/// Advances a slot whose publication does not exist yet. `list_changes` does
/// not call `pg_logical_slot_get_changes` when the publication is missing, and
/// a stalled slot retains WAL. Nothing from this call is delivered.
const DISCARD_SLOT_SQL: &str = "\
SELECT count(*) FROM pg_logical_slot_get_changes(\
$1, NULL, $2, \
'include-pk', 'true', \
'include-transaction', 'false', \
'include-timestamp', 'true', \
'include-type-oids', 'true', \
'format-version', '2', \
'actions', '', \
'add-tables', '')";

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

    /// Start a Postgres CDC poller for a given tenant
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

/// The slot this tenant's change stream lives in.
pub(crate) fn slot_name(tenant: &TenantConfig) -> String {
    match tenant
        .slot_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(name) => name.to_owned(),
        None => format!("supabase_realtime_{}", tenant.id.replace(['-', '.'], "_")),
    }
}

fn change_feed(tenant: &TenantConfig) -> ChangeFeed {
    ChangeFeed::new(
        tenant.publication.clone(),
        slot_name(tenant),
        tenant.poll_interval_ms,
        tenant.poll_max_changes,
        tenant.poll_max_record_bytes,
    )
}

enum Outcome {
    Stopped,
    Retry(String),
}

async fn run_listener_loop(
    hub: Arc<ChannelHub>,
    tenant: TenantConfig,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let tenant_id = tenant.id.clone();
    let feed = change_feed(&tenant);
    info!(
        tenant = %tenant_id,
        publication = %feed.publication,
        slot = %feed.slot,
        "Starting Postgres CDC poller for tenant"
    );

    let mut backoff = Duration::from_millis(500);
    let max_backoff = Duration::from_secs(10);
    let mut attempts = 0_u32;

    loop {
        // Built per attempt, not once: `Config::connect` borrows it across the
        // await, and a reconnect should not reuse a stale configuration.
        let config = connection_config(&tenant);
        let connection = tokio::select! {
            _ = &mut stop_rx => {
                info!(tenant = %tenant_id, "Stopping Postgres listener (canceled)");
                return;
            }
            connection = config.connect(tokio_postgres::NoTls) => connection,
        };
        attempts += 1;

        match connection {
            Ok((client, connection)) => {
                info!(tenant = %tenant_id, "Connected to Postgres for the change stream");
                backoff = Duration::from_millis(500);
                // The protocol only advances while the connection is polled, so
                // it owns a task of its own and the poller uses the client.
                let driver = tokio::spawn(async move {
                    if let Err(error) = connection.await {
                        debug!(error = %error, "Postgres change stream connection closed");
                    }
                });
                let outcome = poll_changes(&hub, &tenant_id, &client, &feed, &mut stop_rx).await;
                driver.abort();
                match outcome {
                    Outcome::Stopped => {
                        info!(tenant = %tenant_id, "Stopping Postgres CDC poller");
                        return;
                    }
                    Outcome::Retry(error) => {
                        warn!(tenant = %tenant_id, error = %error, "Postgres CDC poller stopped, reconnecting");
                    }
                }
            }
            Err(error) => {
                // A tenant whose database is unreachable gets no CDC at all, so
                // the first failure belongs in the log at a level an operator
                // sees. The retries stay at debug.
                if attempts == 1 {
                    warn!(tenant = %tenant_id, error = %error, "Failed to connect to Postgres for the change stream, retrying...");
                } else {
                    debug!(tenant = %tenant_id, error = %error, "Failed to connect to Postgres, retrying...");
                }
            }
        }

        tokio::select! {
            _ = &mut stop_rx => return,
            _ = tokio::time::sleep(backoff) => {
                backoff = (backoff * 2).min(max_backoff);
            }
        }
    }
}

/// Streams the slot into the hub until the connection or the tenant goes away.
async fn poll_changes(
    hub: &Arc<ChannelHub>,
    tenant_id: &str,
    client: &tokio_postgres::Client,
    feed: &ChangeFeed,
    stop_rx: &mut oneshot::Receiver<()>,
) -> Outcome {
    let slot = match ensure_slot(client, &feed.slot).await {
        Ok(slot) => slot,
        Err(error) => return Outcome::Retry(error),
    };

    let mut publication: Option<PublicationFilter> = None;
    let mut publication_missing = false;
    let mut refresh_at = std::time::Instant::now();
    let mut warned_missing_publication = false;

    loop {
        tokio::select! {
            _ = &mut *stop_rx => return Outcome::Stopped,
            _ = tokio::time::sleep(feed.interval) => {}
        }
        if client.is_closed() {
            return Outcome::Retry("the change stream connection closed".to_owned());
        }

        if publication.is_none() || std::time::Instant::now() >= refresh_at {
            refresh_at = std::time::Instant::now() + PUBLICATION_REFRESH;
            match load_publication(client, &feed.publication).await {
                Ok(Some(filter)) => {
                    publication_missing = false;
                    if filter.is_empty() && !warned_missing_publication {
                        warned_missing_publication = true;
                        warn!(
                            tenant = %tenant_id,
                            publication = %feed.publication,
                            "The Realtime publication has no tables; subscriptions will not receive changes until a table is added"
                        );
                    }
                    publication = Some(filter);
                }
                Ok(None) => {
                    publication_missing = true;
                    if !warned_missing_publication {
                        warned_missing_publication = true;
                        warn!(
                            tenant = %tenant_id,
                            publication = %feed.publication,
                            "The Realtime publication does not exist in this database; nothing will be delivered"
                        );
                    }
                    publication = Some(PublicationFilter::default());
                }
                Err(error) => return Outcome::Retry(error),
            }
        }

        if publication_missing {
            if let Err(error) = client
                .query(DISCARD_SLOT_SQL, &[&slot, &feed.max_changes])
                .await
            {
                return Outcome::Retry(error.to_string());
            }
            continue;
        }

        let max_bytes = i32::try_from(feed.max_record_bytes).unwrap_or(i32::MAX);
        let rows = match client
            .query(
                LIST_CHANGES_SQL,
                &[&feed.publication, &slot, &feed.max_changes, &max_bytes],
            )
            .await
        {
            Ok(rows) => rows,
            Err(error) => return Outcome::Retry(error.to_string()),
        };

        for (index, row) in rows.iter().enumerate() {
            let wal: Value = row.get(0);
            let subscription_ids: Vec<String> = row.get(1);
            let errors: Vec<String> = row.get::<_, Option<Vec<String>>>(2).unwrap_or_default();
            if subscription_ids.is_empty() {
                continue;
            }
            hub.dispatch_applied(tenant_id, &wal, &errors, &subscription_ids);
            if index + 1 >= POLL_YIELD_AFTER {
                tokio::task::yield_now().await;
            }
        }
    }
}

/// Returns the slot to poll, adopting an existing one or creating it once.
async fn ensure_slot(client: &tokio_postgres::Client, wanted: &str) -> Result<String, String> {
    let existing = client
        .query(SLOT_LOOKUP_SQL, &[&wanted])
        .await
        .map_err(|error| format!("failed to look for the replication slot: {error}"))?;
    if let Some(row) = existing.first() {
        let name: String = row.get(0);
        if name != wanted {
            info!(slot = %name, requested = %wanted, "Adopting the existing wal2json replication slot");
        }
        return Ok(name);
    }

    client
        .query(SLOT_CREATE_SQL, &[&wanted])
        .await
        .map_err(|error| {
            format!(
                "failed to create the replication slot {wanted} (the database needs the wal2json \
                 output plugin and a user with REPLICATION): {error}"
            )
        })?;
    info!(slot = %wanted, "Created the wal2json replication slot");
    Ok(wanted.to_owned())
}

async fn load_publication(
    client: &tokio_postgres::Client,
    publication: &str,
) -> Result<Option<PublicationFilter>, String> {
    let rows = client
        .query(PUBLICATION_SQL, &[&publication])
        .await
        .map_err(|error| format!("failed to read the publication {publication}: {error}"))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    let mut actions = Vec::new();
    if row.get::<_, Option<bool>>(0).unwrap_or(false) {
        actions.push("insert");
    }
    if row.get::<_, Option<bool>>(1).unwrap_or(false) {
        actions.push("update");
    }
    if row.get::<_, Option<bool>>(2).unwrap_or(false) {
        actions.push("delete");
    }

    let membership: String = row.get::<_, Option<String>>(3).unwrap_or_default();
    let tables: Vec<(String, String)> = membership
        .split('\u{2}')
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let (schema, table) = entry.split_once('\u{1}')?;
            Some((schema.to_owned(), table.to_owned()))
        })
        .collect();

    Ok(Some(PublicationFilter {
        actions: actions.join(","),
        tables: wal::add_tables(
            tables
                .iter()
                .map(|(schema, table)| (schema.as_str(), table.as_str())),
        ),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tenant(id: &str, slot: Option<&str>) -> TenantConfig {
        TenantConfig {
            id: id.to_owned(),
            external_id: Some(id.to_owned()),
            jwt_secret: "secret".to_owned(),
            jwt_jwks: None,
            db_host: "127.0.0.1".to_owned(),
            db_port: 5432,
            db_name: "postgres".to_owned(),
            db_user: "postgres".to_owned(),
            db_password: String::new(),
            slot_name: slot.map(str::to_owned),
            publication: wal::DEFAULT_PUBLICATION.to_owned(),
            poll_interval_ms: wal::DEFAULT_POLL_INTERVAL_MS,
            poll_max_changes: wal::DEFAULT_POLL_MAX_CHANGES,
            poll_max_record_bytes: wal::DEFAULT_POLL_MAX_RECORD_BYTES as i32,
        }
    }

    #[test]
    fn a_tenant_without_a_slot_name_gets_a_default() {
        assert_eq!(
            slot_name(&tenant("proj-1.example", None)),
            "supabase_realtime_proj_1_example"
        );
        assert_eq!(
            slot_name(&tenant("proj-1", Some("supabase_realtime_proj_1_ab12"))),
            "supabase_realtime_proj_1_ab12"
        );
        assert_eq!(
            slot_name(&tenant("proj-1", Some("   "))),
            "supabase_realtime_proj_1"
        );
    }

    #[test]
    fn the_poll_uses_the_registration_parameters() {
        let mut config = tenant("proj-1", None);
        config.publication = "other_pub".to_owned();
        config.poll_max_changes = 5;
        config.poll_max_record_bytes = 2048;
        config.poll_interval_ms = 250;

        let feed = change_feed(&config);
        assert_eq!(feed.publication, "other_pub");
        assert_eq!(feed.slot, "supabase_realtime_proj_1");
        assert_eq!(feed.max_changes, 5);
        assert_eq!(feed.max_record_bytes, 2048);
        assert_eq!(feed.interval, Duration::from_millis(250));
    }

    #[test]
    fn a_passwordless_tenant_sends_no_password() {
        let config = connection_config(&tenant("proj-1", None));
        assert_eq!(
            config.get_password(),
            None,
            "an empty password must not be sent"
        );
        assert_eq!(config.get_user(), Some("postgres"));
        assert_eq!(config.get_dbname(), Some("postgres"));

        let mut with_password = tenant("proj-1", None);
        with_password.db_password = "with space".to_owned();
        let config = connection_config(&with_password);
        assert_eq!(config.get_password(), Some("with space".as_bytes()));
    }
}
