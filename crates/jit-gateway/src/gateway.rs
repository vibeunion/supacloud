use crate::policy::{CompiledPolicy, AllowedNetworksInput};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateBindingRequest {
    pub credential_id: String,
    pub port: u16,
    pub expires_at_ms: u64,
    pub allowed_networks: AllowedNetworksInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingInfo {
    pub credential_id: String,
    pub port: u16,
    pub expires_at_ms: u64,
}

struct ActiveBinding {
    port: u16,
    expires_at_ms: u64,
    cancel_tx: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
pub struct GatewayManager {
    bind_host: String,
    upstream_host: String,
    upstream_port: u16,
    bindings: Arc<RwLock<HashMap<String, ActiveBinding>>>,
}

impl GatewayManager {
    pub fn new(bind_host: String, upstream_host: String, upstream_port: u16) -> Self {
        Self {
            bind_host,
            upstream_host,
            upstream_port,
            bindings: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn list_bindings(&self) -> Vec<BindingInfo> {
        let guard = self.bindings.read();
        guard
            .iter()
            .map(|(id, b)| BindingInfo {
                credential_id: id.clone(),
                port: b.port,
                expires_at_ms: b.expires_at_ms,
            })
            .collect()
    }

    pub fn bound_port(&self, credential_id: &str) -> Option<u16> {
        let guard = self.bindings.read();
        guard.get(credential_id).map(|b| b.port)
    }

    pub fn release(&self, credential_id: &str) -> bool {
        let mut guard = self.bindings.write();
        if let Some(mut binding) = guard.remove(credential_id) {
            if let Some(cancel) = binding.cancel_tx.take() {
                let _ = cancel.send(());
            }
            info!("[JitGateway] Released binding for {}", credential_id);
            true
        } else {
            false
        }
    }

    pub async fn bind(&self, req: CreateBindingRequest) -> Result<u16, String> {
        // Release previous binding if exists
        self.release(&req.credential_id);

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        if req.expires_at_ms <= now_ms {
            return Err("Expiration time must be in the future".into());
        }

        let policy = CompiledPolicy::from_input(&req.allowed_networks)?;
        if policy.networks.is_empty() {
            return Err("At least one allowed network CIDR is required".into());
        }

        // Bind TCP listener
        let bind_addr = format!("{}:{}", self.bind_host, req.port);
        let listener = TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| format!("Failed to bind to {}: {}", bind_addr, e))?;

        let actual_port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local port: {}", e))?
            .port();

        let (cancel_tx, mut cancel_rx) = oneshot::channel();

        let binding = ActiveBinding {
            port: actual_port,
            expires_at_ms: req.expires_at_ms,
            cancel_tx: Some(cancel_tx),
        };

        self.bindings
            .write()
            .insert(req.credential_id.clone(), binding);

        let upstream_host = self.upstream_host.clone();
        let upstream_port = self.upstream_port;
        let credential_id = req.credential_id.clone();
        let manager_clone = self.clone();

        // Spawn listener accept loop
        tokio::spawn(async move {
            info!(
                "[JitGateway] Listener active on port {} for credential {}",
                actual_port, credential_id
            );

            let remaining_ms = req.expires_at_ms.saturating_sub(now_ms);
            let expiry_sleep = tokio::time::sleep(Duration::from_millis(remaining_ms));
            tokio::pin!(expiry_sleep);

            loop {
                tokio::select! {
                    _ = &mut cancel_rx => {
                        info!("[JitGateway] Listener cancelled for {}", credential_id);
                        break;
                    }
                    _ = &mut expiry_sleep => {
                        info!("[JitGateway] Binding expired for {}", credential_id);
                        manager_clone.release(&credential_id);
                        break;
                    }
                    accept_res = listener.accept() => {
                        match accept_res {
                            Ok((client_stream, client_addr)) => {
                                if !policy.is_allowed(client_addr.ip()) {
                                    warn!(
                                        "[JitGateway] Rejected source address {} for credential {}",
                                        client_addr, credential_id
                                    );
                                    drop(client_stream);
                                    continue;
                                }

                                let up_host = upstream_host.clone();
                                let cred_id = credential_id.clone();
                                tokio::spawn(async move {
                                    handle_proxy_connection(client_stream, client_addr, &up_host, upstream_port, &cred_id).await;
                                });
                            }
                            Err(e) => {
                                error!("[JitGateway] Accept error on port {}: {}", actual_port, e);
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    }
                }
            }
        });

        Ok(actual_port)
    }
}

async fn handle_proxy_connection(
    mut client: TcpStream,
    client_addr: SocketAddr,
    upstream_host: &str,
    upstream_port: u16,
    credential_id: &str,
) {
    let upstream_addr = format!("{}:{}", upstream_host, upstream_port);
    let mut upstream = match TcpStream::connect(&upstream_addr).await {
        Ok(s) => s,
        Err(e) => {
            warn!(
                "[JitGateway] Failed to connect to PostgreSQL upstream {}: {}",
                upstream_addr, e
            );
            return;
        }
    };

    let _ = client.set_nodelay(true);
    let _ = upstream.set_nodelay(true);

    info!(
        "[JitGateway] Proxying session from {} for credential {}",
        client_addr, credential_id
    );

    if let Err(e) = tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
        // Normal EOF or reset is common on client disconnect
        let err_str = e.to_string();
        if !err_str.contains("Broken pipe") && !err_str.contains("Connection reset") {
            warn!(
                "[JitGateway] Proxy transfer closed with note ({}): {}",
                client_addr, e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn test_gateway_proxy_allowed_and_denied() {
        // 1. Start a mock upstream echo server on an ephemeral port
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream_listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            while let Ok((mut stream, _)) = upstream_listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = stream.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        if stream.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        // 2. Setup gateway manager
        let manager = GatewayManager::new("127.0.0.1".into(), "127.0.0.1".into(), upstream_port);

        // Bind allowed credential on ephemeral port 0
        let req_allowed = CreateBindingRequest {
            credential_id: "test-allowed".into(),
            port: 0,
            expires_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60_000,
            allowed_networks: AllowedNetworksInput {
                ipv4: vec!["127.0.0.1/32".into()],
                ipv6: vec![],
            },
        };

        let bound_port = manager.bind(req_allowed).await.unwrap();
        assert_ne!(bound_port, 0);
        assert_eq!(manager.bound_port("test-allowed"), Some(bound_port));

        // Connect client to bound_port and write bytes
        let mut client = TcpStream::connect(format!("127.0.0.1:{}", bound_port))
            .await
            .unwrap();
        client.write_all(b"hello postgres wire").await.unwrap();

        let mut buf = [0u8; 19];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello postgres wire");

        // Release binding
        assert!(manager.release("test-allowed"));
        assert_eq!(manager.bound_port("test-allowed"), None);

        // Bind denied credential (disallow 127.0.0.1)
        let req_denied = CreateBindingRequest {
            credential_id: "test-denied".into(),
            port: 0,
            expires_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60_000,
            allowed_networks: AllowedNetworksInput {
                ipv4: vec!["203.0.113.0/24".into()],
                ipv6: vec![],
            },
        };

        let denied_port = manager.bind(req_denied).await.unwrap();
        let mut denied_client = TcpStream::connect(format!("127.0.0.1:{}", denied_port))
            .await
            .unwrap();

        // Server should drop the connection immediately
        let mut read_buf = [0u8; 10];
        let res = denied_client.read(&mut read_buf).await.unwrap();
        assert_eq!(res, 0); // EOF immediately received
    }
}

