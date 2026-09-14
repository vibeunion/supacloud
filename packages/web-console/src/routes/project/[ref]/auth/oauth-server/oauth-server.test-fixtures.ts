export function oauthStatus(ref = "a") {
  const issuer = `https://${ref}.example.test/auth/v1`;
  return {
    project_ref: ref, organization_id: null, account_isolated: true,
    state_source: "configuration", runtime_verified: false,
    enabled: true, allow_dynamic_registration: false,
    issuer, authorization_path: "/authorize.html",
    discovery_url: `${issuer}/.well-known/openid-configuration`,
    oauth_authorization_server_metadata_url: `https://${ref}.example.test/.well-known/oauth-authorization-server/auth/v1`,
    jwks_url: `${issuer}/.well-known/jwks.json`, authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`, userinfo_endpoint: `${issuer}/oauth/userinfo`,
    registration_endpoint: `${issuer}/oauth/clients/register`,
    signing_alg: "ES256", key_id: `key-${ref}`, oidc_id_token_ready: true,
    migration_status: "oidc_es256_migrated", warnings: [],
  };
}
export function oauthClient() {
  return {
    client_id: "12345678-1234-4234-8234-123456789abc", client_type: "confidential",
    client_name: "App", token_endpoint_auth_method: "client_secret_basic",
    redirect_uris: ["https://app.test/callback"], registration_type: "manual",
  };
}
export function partialFailure(ref = "a") {
  return {
    code: "SUPAUTH_DEPENDENT_REFRESH_FAILED", persisted: true, runtime_applied: true,
    dependents_applied: false, runtime_mode: "owner", authority_project_ref: ref,
    dependent_status: "failed", failed_dependents: ["dependent-project"],
  };
}
