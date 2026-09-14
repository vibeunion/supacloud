import {
  SupaCloudOAuthServerClient, type SupaCloudOAuthServerStatus,
} from "../src/oauth-server.js";

declare const status: SupaCloudOAuthServerStatus;
if (status.signing_alg === "ES256") {
  const ready: true = status.oidc_id_token_ready;
  const migrated: "oidc_es256_migrated" = status.migration_status;
  const kid: string = status.key_id;
  void [ready, migrated, kid];
}
if (status.signing_alg === "not_migrated") {
  const ready: false = status.oidc_id_token_ready;
  const absent: undefined = status.key_id;
  void [ready, absent];
}
const runtimeVerified: false = status.runtime_verified;
void runtimeVerified;
// @ts-expect-error Contradictory algorithm/readiness is not a valid status.
const contradictory: SupaCloudOAuthServerStatus = { ...status, signing_alg: "ES256", oidc_id_token_ready: false };
void contradictory;
declare const client: SupaCloudOAuthServerClient;
const discovery = await client.getDiscovery();
const issuer: string = discovery.issuer;
const keys = await client.getJwks();
const key = keys.keys[0];
if (key?.kty === "EC") {
  const curve: "P-256" = key.crv;
  void curve;
  // @ts-expect-error Private material must not be exposed.
  void key.d;
}
void issuer;
