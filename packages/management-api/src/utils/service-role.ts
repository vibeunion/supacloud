import { normalizeJwtIssuer, signOidcServiceRoleJwt } from "./project-jwt";
import { normalizeProjectConfig } from "./project-config";

function resolveOauthServerConfig(config: unknown): Record<string, unknown> {
  const projectConfig = normalizeProjectConfig(config);
  const auth = projectConfig.auth && typeof projectConfig.auth === "object"
    ? projectConfig.auth as Record<string, unknown>
    : {};
  const oauthServer = auth.oauth_server && typeof auth.oauth_server === "object"
    ? auth.oauth_server as Record<string, unknown>
    : {};
  return oauthServer;
}

function resolveOauthIssuer(ref: string | undefined, oauthServer: Record<string, unknown>): string {
  const configuredIssuer = normalizeJwtIssuer(oauthServer.issuer);
  if (configuredIssuer) return configuredIssuer;
  return ref ? `supacloud-${ref}` : "supacloud";
}

export async function resolveProjectServiceRoleKey(projectOrRef: string | {
  ref?: string | null;
  service_role_key?: string | null;
  jwt_secret?: string | null;
  config?: unknown;
}): Promise<string | null> {
  const project = typeof projectOrRef === "string"
    ? await loadProjectSecrets(projectOrRef)
    : projectOrRef;

  const oauthServer = resolveOauthServerConfig(project?.config);
  const oidcServiceRoleKey = await signOidcServiceRoleJwt(
    oauthServer.jwt_keys,
    resolveOauthIssuer(project?.ref ?? (typeof projectOrRef === "string" ? projectOrRef : undefined), oauthServer),
  );
  if (oidcServiceRoleKey) {
    return oidcServiceRoleKey;
  }

  if (project?.service_role_key) {
    return project.service_role_key;
  }

  if (!project?.jwt_secret) {
    return null;
  }

  const { jwtService } = await import("../services/jwt.service");
  return jwtService.generateServiceRoleKey(project.jwt_secret);
}

async function loadProjectSecrets(ref: string): Promise<{
  ref?: string | null;
  service_role_key?: string | null;
  jwt_secret?: string | null;
  config?: unknown;
} | null> {
  const { sql } = await import("../db");
  const rows = await sql`
    SELECT ref, service_role_key, jwt_secret, config
    FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}
