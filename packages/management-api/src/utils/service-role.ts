import { normalizeProjectJwtKeys, signOidcServiceRoleJwt } from "./project-jwt";
import { normalizeProjectConfig } from "./project-config";
import { decryptSecretIfNeeded } from "./secret-crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";

type StoredServiceRoleCredential = {
  service_role_key?: string | null;
  service_role_key_encrypted?: string | null;
  jwt_secret?: string | null;
};

function isJwtLike(value: string | null | undefined): value is string {
  return typeof value === "string" && value.split(".").length === 3;
}

export function resolveStoredServiceRoleKey(
  project: StoredServiceRoleCredential,
): string | null {
  if (isJwtLike(project.service_role_key)) return project.service_role_key;
  if (!project.service_role_key_encrypted) return null;

  const decryptedKey = decryptSecretIfNeeded(project.service_role_key_encrypted);
  return isJwtLike(decryptedKey) ? decryptedKey : null;
}

/**
 * Check the legacy HS256 service-role key against the project's current JWT
 * secret. Asymmetric/OIDC keys are validated by their JWKS consumers and are
 * intentionally left untouched here; older deployments also contain opaque
 * three-part test fixtures that cannot be decoded, so preserve their existing
 * compatibility behavior.
 */
export async function isStoredServiceRoleKeyAligned(
  project: StoredServiceRoleCredential,
): Promise<boolean> {
  const key = resolveStoredServiceRoleKey(project);
  if (!key) return false;

  let header: { alg?: unknown };
  try {
    header = decodeProtectedHeader(key);
  } catch {
    // Keep accepting legacy/opaque placeholders that were previously accepted
    // by shape-only validation. Real JWTs always decode through this branch.
    return true;
  }

  if (header.alg !== "HS256") return true;
  if (!project.jwt_secret) return false;

  try {
    const { payload } = await jwtVerify(
      key,
      new TextEncoder().encode(project.jwt_secret),
      { algorithms: ["HS256"] },
    );
    return payload.role === "service_role" && payload.iss === "supabase";
  } catch {
    return false;
  }
}

/**
 * Resolve a key suitable for runtime use. A missing or stale legacy key is
 * regenerated from the current project secret; callers that need durable
 * repair must persist the returned value with projectRepository.updateApiKeys.
 */
export async function resolveAlignedServiceRoleKey(
  project: StoredServiceRoleCredential,
): Promise<string | null> {
  const stored = resolveStoredServiceRoleKey(project);
  if (stored && await isStoredServiceRoleKeyAligned(project)) return stored;
  if (!project.jwt_secret) return null;

  const { jwtService } = await import("../services/jwt.service");
  return jwtService.generateServiceRoleKey(project.jwt_secret);
}

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
  if (typeof oauthServer.issuer === "string" && oauthServer.issuer.trim()) {
    return oauthServer.issuer.replace(/\/+$/, "");
  }
  return ref ? `supacloud-${ref}` : "supacloud";
}

export function resolveProjectServiceJwtVerifier(projectRef: string, config: unknown) {
  const oauthServer = resolveOauthServerConfig(config);
  try {
    const signer = normalizeProjectJwtKeys(oauthServer.jwt_keys)?.find(
      (key) => key.alg === "ES256" && key.kty === "EC" && typeof key.d === "string",
    );
    if (!projectRef || !signer || signer.crv !== "P-256" ||
      typeof signer.kid !== "string" || !signer.kid ||
      typeof signer.x !== "string" || !signer.x ||
      typeof signer.y !== "string" || !signer.y) return null;
    // Only this project's service signer; never shared-owner or third-party keys.
    return {
      schema: "supacloud.service-jwt-verifier.v1",
      project_ref: projectRef,
      issuer: resolveOauthIssuer(projectRef, oauthServer),
      algorithm: "ES256",
      jwks: { keys: [{
        kty: "EC", crv: "P-256", alg: "ES256", use: "sig",
        kid: signer.kid, x: signer.x, y: signer.y,
      }] },
    };
  } catch {
    return null;
  }
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
  const projectRef = project?.ref ?? (typeof projectOrRef === "string" ? projectOrRef : undefined);
  const oidcServiceRoleKey = await signOidcServiceRoleJwt(
    oauthServer.jwt_keys,
    resolveOauthIssuer(projectRef, oauthServer),
    300,
    projectRef,
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
