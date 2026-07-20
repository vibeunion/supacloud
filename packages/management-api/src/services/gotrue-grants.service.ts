import { getProjectDb, resolveDbName } from "../db";
import { CapabilityUnavailableError, NotFoundError } from "../utils/errors";

function isMissingOAuthSchema(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? String((error as { code?: unknown }).code || "")
    : "";
  return code === "42P01" || code === "42703";
}

async function tenantAuthDb(ref: string) {
  return getProjectDb(await resolveDbName(ref));
}

async function assertUserExists(ref: string, userId: string): Promise<void> {
  const tenantDb = await tenantAuthDb(ref);
  const [user] = await tenantDb`SELECT id FROM auth.users WHERE id::text = ${userId} LIMIT 1`;
  if (!user) throw new NotFoundError("User", userId);
}

export const gotrueGrantsService = {
  async list(ref: string, userId: string, includeRevoked: boolean) {
    await assertUserExists(ref, userId);
    try {
      const tenantDb = await tenantAuthDb(ref);
      const grants = await tenantDb`
        SELECT c.id, c.user_id, c.client_id, c.scopes, c.granted_at, c.revoked_at,
               client.client_name, client.client_uri, client.logo_uri,
               client.client_type, client.registration_type
        FROM auth.oauth_consents c
        JOIN auth.oauth_clients client ON client.id = c.client_id
        WHERE c.user_id::text = ${userId}
          AND (${includeRevoked} = true OR c.revoked_at IS NULL)
        ORDER BY c.granted_at DESC
      `;
      return {
        items: grants.map((grant: Record<string, unknown>) => ({
          ...grant,
          scopes: typeof grant.scopes === "string" ? grant.scopes.split(/\s+/).filter(Boolean) : [],
        })),
        total: grants.length,
        source: "gotrue" as const,
      };
    } catch (error: unknown) {
      if (isMissingOAuthSchema(error)) {
        throw new CapabilityUnavailableError("gotrue_oauth_grants", "gotrue_oauth_server_not_available");
      }
      throw error;
    }
  },

  async revoke() {
    throw new CapabilityUnavailableError(
      "gotrue_oauth_grant_revoke",
      "gotrue_admin_grant_revoke_unavailable",
    );
  },

  async listByClient(ref: string, clientId: string, includeRevoked: boolean) {
    try {
      const tenantDb = await tenantAuthDb(ref);
      const [client] = await tenantDb`
        SELECT id FROM auth.oauth_clients WHERE id::text = ${clientId} AND deleted_at IS NULL LIMIT 1
      `;
      if (!client) throw new NotFoundError("GoTrue OAuth client", clientId);
      const grants = await tenantDb`
        SELECT c.id, c.user_id, c.client_id, c.scopes, c.granted_at, c.revoked_at,
               u.email, u.phone
        FROM auth.oauth_consents c
        JOIN auth.users u ON u.id = c.user_id
        WHERE c.client_id::text = ${clientId}
          AND (${includeRevoked} = true OR c.revoked_at IS NULL)
        ORDER BY c.granted_at DESC
      `;
      return {
        items: grants.map((grant: Record<string, unknown>) => ({
          ...grant,
          scopes: typeof grant.scopes === "string" ? grant.scopes.split(/\s+/).filter(Boolean) : [],
        })),
        total: grants.length,
        source: "gotrue" as const,
      };
    } catch (error: unknown) {
      if (isMissingOAuthSchema(error)) {
        throw new CapabilityUnavailableError("gotrue_oauth_grants", "gotrue_oauth_server_not_available");
      }
      throw error;
    }
  },
};
