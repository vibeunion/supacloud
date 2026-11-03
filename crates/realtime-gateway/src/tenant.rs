use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantConfig {
    pub id: String,
    #[serde(default)]
    pub external_id: Option<String>,
    pub jwt_secret: String,
    #[serde(default = "default_db_host")]
    pub db_host: String,
    #[serde(default = "default_db_port")]
    pub db_port: u16,
    #[serde(default)]
    pub db_name: String,
    #[serde(default = "default_db_user")]
    pub db_user: String,
    #[serde(default)]
    pub db_password: String,
    #[serde(default)]
    pub slot_name: Option<String>,
}

fn default_db_host() -> String {
    "127.0.0.1".to_string()
}

fn default_db_port() -> u16 {
    5432
}

fn default_db_user() -> String {
    "postgres".to_string()
}

#[derive(Debug, Deserialize)]
struct TenantEnvelope {
    tenant: WrappedTenant,
}

#[derive(Debug, Deserialize)]
struct WrappedTenant {
    #[serde(default)]
    external_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    jwt_secret: String,
    #[serde(default)]
    extensions: Vec<WrappedTenantExtension>,
}

#[derive(Debug, Deserialize)]
struct WrappedTenantExtension {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    settings: Value,
}

impl TenantConfig {
    /// Accept both the flat gateway contract and the Management API
    /// `{ tenant: { ..., extensions: [postgres_cdc_rls] } }` payload.
    pub fn from_registration(value: Value) -> Result<Self, String> {
        if let Ok(tenant) = serde_json::from_value::<TenantConfig>(value.clone()) {
            if !tenant.id.trim().is_empty() && !tenant.jwt_secret.is_empty() {
                return Ok(tenant);
            }
        }

        let envelope: TenantEnvelope = serde_json::from_value(value)
            .map_err(|error| format!("invalid tenant payload: {error}"))?;
        let wrapped = envelope.tenant;
        let id = wrapped
            .external_id
            .clone()
            .or_else(|| wrapped.name.clone())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "tenant payload is missing external_id".to_string())?;
        if wrapped.jwt_secret.is_empty() {
            return Err("tenant payload is missing jwt_secret".to_string());
        }

        let postgres = wrapped
            .extensions
            .iter()
            .find(|extension| extension.kind == "postgres_cdc_rls")
            .map(|extension| &extension.settings);
        let read =
            |key: &str| -> Option<&Value> { postgres.and_then(|settings| settings.get(key)) };
        let text = |key: &str| -> Option<String> {
            read(key).and_then(|value| match value {
                Value::String(value) if !value.is_empty() => Some(value.clone()),
                _ => None,
            })
        };

        let db_port = read("db_port")
            .and_then(|value| match value {
                Value::Number(port) => port.as_u64(),
                Value::String(port) => port.parse::<u64>().ok(),
                _ => None,
            })
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or_else(default_db_port);

        Ok(Self {
            id: id.clone(),
            external_id: Some(id),
            jwt_secret: wrapped.jwt_secret,
            db_host: text("db_host").unwrap_or_else(default_db_host),
            db_port,
            db_name: text("db_name").unwrap_or_default(),
            db_user: text("db_user").unwrap_or_else(default_db_user),
            db_password: text("db_password").unwrap_or_default(),
            slot_name: text("slot_name"),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub role: Option<String>,
    pub sub: Option<String>,
    pub exp: Option<u64>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Default)]
pub struct TenantRegistry {
    tenants: RwLock<HashMap<String, TenantConfig>>,
    global_jwt_secret: RwLock<Option<String>>,
}

impl TenantRegistry {
    pub fn new(global_jwt_secret: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            tenants: RwLock::new(HashMap::new()),
            global_jwt_secret: RwLock::new(global_jwt_secret),
        })
    }

    pub fn set_global_jwt_secret(&self, secret: String) {
        *self.global_jwt_secret.write() = Some(secret);
    }

    pub fn register(&self, config: TenantConfig) {
        let mut map = self.tenants.write();
        let key = config.id.clone();
        if let Some(ext) = &config.external_id {
            map.insert(ext.clone(), config.clone());
        }
        map.insert(key, config);
    }

    pub fn get(&self, id: &str) -> Option<TenantConfig> {
        self.tenants.read().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<TenantConfig> {
        let mut map = self.tenants.write();
        let removed = map.remove(id);
        if let Some(ref tenant) = removed {
            if let Some(ref ext) = tenant.external_id {
                map.remove(ext);
            }
        }
        removed
    }

    pub fn list(&self) -> Vec<TenantConfig> {
        self.tenants.read().values().cloned().collect()
    }

    /// Resolve tenant from project_ref, host, or API key
    pub fn resolve_tenant(&self, candidate: &str) -> Option<TenantConfig> {
        if candidate.is_empty() {
            return None;
        }

        let map = self.tenants.read();
        if let Some(tenant) = map.get(candidate) {
            return Some(tenant.clone());
        }

        // Try extracting subdomain from candidate (e.g. "default.api.localhost" -> "default")
        if let Some(subdomain) = candidate.split('.').next() {
            if let Some(tenant) = map.get(subdomain) {
                return Some(tenant.clone());
            }
        }

        // Try matching by decoding token claims if candidate is a JWT
        if let Some(claims) = self.decode_jwt_unverified(candidate) {
            if let Some(ref_val) = claims.extra.get("ref").and_then(|v| v.as_str()) {
                if let Some(tenant) = map.get(ref_val) {
                    return Some(tenant.clone());
                }
            }
        }

        None
    }

    /// Decode JWT header & payload without verifying signature
    pub fn decode_jwt_unverified(&self, token: &str) -> Option<JwtClaims> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return None;
        }

        let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
        serde_json::from_slice::<JwtClaims>(&payload_bytes).ok()
    }

    /// Verify HS256 JWT using tenant secret or global secret
    pub fn verify_jwt(&self, token: &str, tenant_secret: Option<&str>) -> Option<JwtClaims> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return None;
        }

        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let signature_bytes = URL_SAFE_NO_PAD.decode(parts[2]).ok()?;

        // Candidates: tenant secret, or global secret
        let mut candidate_secrets = Vec::new();
        if let Some(s) = tenant_secret {
            if !s.is_empty() {
                candidate_secrets.push(s);
            }
        }
        let global = self.global_jwt_secret.read();
        if let Some(ref g) = *global {
            if !g.is_empty() {
                candidate_secrets.push(g.as_str());
            }
        }

        let mut verified = false;
        for secret in candidate_secrets {
            if let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) {
                mac.update(signing_input.as_bytes());
                if mac.verify_slice(&signature_bytes).is_ok() {
                    verified = true;
                    break;
                }
            }
        }

        if !verified {
            return None;
        }

        let claims = self.decode_jwt_unverified(token)?;

        // Verify expiry if present
        if let Some(exp) = claims.exp {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            if exp < now {
                return None;
            }
        }

        Some(claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generate_test_jwt(secret: &str, role: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(
            r#"{{"role":"{}","iss":"supabase","exp":{}}}"#,
            role,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 3600
        ));
        let signing_input = format!("{}.{}", header, payload);
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(signing_input.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{}.{}", signing_input, signature)
    }

    #[test]
    fn test_management_api_envelope_registration() {
        let payload = serde_json::json!({
            "tenant": {
                "external_id": "proj_demo",
                "name": "Project proj_demo",
                "jwt_secret": "tenant_secret",
                "extensions": [{
                    "type": "postgres_cdc_rls",
                    "settings": {
                        "db_host": "10.0.0.5",
                        "db_port": "5433",
                        "db_name": "db_proj_demo",
                        "db_user": "supabase_admin",
                        "db_password": "secret",
                        "slot_name": "supabase_realtime_proj_demo"
                    }
                }]
            }
        });

        let tenant = TenantConfig::from_registration(payload).unwrap();
        assert_eq!(tenant.id, "proj_demo");
        assert_eq!(tenant.external_id.as_deref(), Some("proj_demo"));
        assert_eq!(tenant.db_host, "10.0.0.5");
        assert_eq!(tenant.db_port, 5433);
        assert_eq!(tenant.db_name, "db_proj_demo");
        assert_eq!(tenant.db_user, "supabase_admin");
        assert_eq!(
            tenant.slot_name.as_deref(),
            Some("supabase_realtime_proj_demo")
        );
    }

    #[test]
    fn test_tenant_registration_and_jwt() {
        let registry = TenantRegistry::new(Some("global_super_secret".to_string()));
        registry.register(TenantConfig {
            id: "proj_123".to_string(),
            external_id: Some("custom-domain".to_string()),
            jwt_secret: "tenant_secret_key_12345".to_string(),
            db_host: "127.0.0.1".to_string(),
            db_port: 5432,
            db_name: "db_proj_123".to_string(),
            db_user: "postgres".to_string(),
            db_password: "pw".to_string(),
            slot_name: None,
        });

        assert!(registry.get("proj_123").is_some());
        assert!(registry.get("custom-domain").is_some());

        let valid_token = generate_test_jwt("tenant_secret_key_12345", "authenticated");
        let verified = registry.verify_jwt(&valid_token, Some("tenant_secret_key_12345"));
        assert!(verified.is_some());
        assert_eq!(verified.unwrap().role, Some("authenticated".to_string()));

        let invalid_token = generate_test_jwt("wrong_secret", "authenticated");
        let rejected = registry.verify_jwt(&invalid_token, Some("tenant_secret_key_12345"));
        assert!(rejected.is_none());
    }
}
