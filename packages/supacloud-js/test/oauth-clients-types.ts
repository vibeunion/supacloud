import type {
  SupaCloudOAuthClient, SupaCloudOAuthClientCreate, SupaCloudOAuthClientList, SupaCloudOAuthClientsClient,
  SupaCloudOAuthClientsOptions,
} from "../src/oauth-clients.js";

type Assert<T extends true> = T;
type RejectPublicSecret = Assert<{
  client_id: string; client_type: "public"; client_secret: string;
} extends SupaCloudOAuthClient ? false : true>;
type RejectPublicSecretAuth = Assert<{
  redirect_uris: string[]; client_type: "public"; token_endpoint_auth_method: "client_secret_basic";
} extends SupaCloudOAuthClientCreate ? false : true>;
type RejectConfidentialNone = Assert<{
  redirect_uris: string[]; client_type: "confidential"; token_endpoint_auth_method: "none";
} extends SupaCloudOAuthClientCreate ? false : true>;
type RequireClientsArray = Assert<{} extends SupaCloudOAuthClientList ? false : true>;
type RequireCreatedSecret = Assert<
  Extract<Awaited<ReturnType<SupaCloudOAuthClientsClient["create"]>>, { client_type: "confidential" }> extends
    { client_secret: string } ? true : false
>;
type RequireRotatedSecret = Assert<
  Awaited<ReturnType<SupaCloudOAuthClientsClient["regenerateSecret"]>> extends
    { client_type: "confidential"; client_secret: string } ? true : false
>;
type RequireExplicitAuth = Assert<
  { managementApiUrl: string; projectRef: string } extends SupaCloudOAuthClientsOptions ? false : true
>;
export type OAuthTypeAssertions = [
  RejectPublicSecret, RejectPublicSecretAuth, RejectConfidentialNone, RequireClientsArray,
  RequireCreatedSecret, RequireRotatedSecret, RequireExplicitAuth,
];
