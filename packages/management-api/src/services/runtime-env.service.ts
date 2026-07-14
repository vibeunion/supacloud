import { projectRepository } from "../repositories/project.repository";
import { databaseService } from "./database.service";
import { jwtService } from "./jwt.service";
import { normalizeProjectConfig } from "../utils/project-config";
import {
  normalizeProjectRoutingConfig,
  resolveProjectApiHost,
  resolveProjectApiUrl,
  resolveTenantPorts,
} from "../utils/project-routing";
import { decryptSecretIfNeeded } from "../utils/secret-crypto";
import { logger } from "../utils/logger";
import {
  normalizeProjectJwtJwks,
  normalizeProjectJwtKeys,
} from "../utils/project-jwt";

function isJwtLike(value: string | null | undefined): value is string {
  return typeof value === "string" && value.split(".").length === 3;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function internalSupabaseBaseUrl(): string {
  return stripTrailingSlash(
    process.env.SUPACLOUD_INTERNAL_SUPABASE_URL ||
    process.env.INTERNAL_SUPABASE_URL ||
    "http://127.0.0.1",
  );
}

function localServiceBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function buildProjectRuntimeEnv(projectRef: string): Promise<Record<string, string> | null> {
  const project = await projectRepository.findByRef(projectRef);
  if (!project) return null;

  const projectConfig = normalizeProjectConfig(project.config);
  const routingConfig = normalizeProjectRoutingConfig(
    projectConfig,
  );
  const authConfig = (projectConfig.auth || {}) as Record<string, unknown>;
  const oauthServerConfig = (authConfig.oauth_server || {}) as Record<string, unknown>;
  const jwtKeys = normalizeProjectJwtKeys(oauthServerConfig.jwt_keys);
  const jwtJwks = normalizeProjectJwtJwks(oauthServerConfig.jwt_jwks);
  const supabaseUrl = resolveProjectApiUrl(projectRef, routingConfig);
  const projectApiHost = resolveProjectApiHost(projectRef, routingConfig);
  const tenantPorts = resolveTenantPorts(routingConfig);
  const internalSupabaseUrl = internalSupabaseBaseUrl();
  const internalRestUrl = stripTrailingSlash(
    process.env.SUPACLOUD_INTERNAL_REST_URL ||
    process.env.INTERNAL_REST_URL ||
    (tenantPorts ? localServiceBaseUrl(tenantPorts.pgrstPort) : `${internalSupabaseUrl}/rest/v1`),
  );
  const internalAuthUrl = stripTrailingSlash(
    process.env.SUPACLOUD_INTERNAL_AUTH_URL ||
    process.env.INTERNAL_AUTH_URL ||
    `${internalSupabaseUrl}/auth/v1`,
  );

  let serviceRoleKey = project.service_role_key;
  const encryptedServiceRoleKey = (project as unknown as { service_role_key_encrypted?: string | null }).service_role_key_encrypted;

  if (!isJwtLike(serviceRoleKey) && encryptedServiceRoleKey) {
    try {
      const decrypted = decryptSecretIfNeeded(encryptedServiceRoleKey);
      if (isJwtLike(decrypted)) serviceRoleKey = decrypted;
    } catch {
      // Fall through to deterministic repair from jwt_secret below.
    }
  }

  if (!isJwtLike(serviceRoleKey)) {
    serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
    await projectRepository.updateApiKeys(projectRef, {
      jwt_secret: project.jwt_secret,
      anon_key: project.anon_key,
      service_role_key: serviceRoleKey,
    });
    logger.warn(`[RuntimeEnv] Repaired invalid service_role_key for ${projectRef}`);
  }

  const customSecrets = await databaseService.getSecrets(projectRef);
  const env: Record<string, string> = {};
  for (const secret of customSecrets) {
    env[secret.name] = secret.value;
  }

  return {
    ...env,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: project.anon_key,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    ...(project.publishable_key ? { SUPABASE_PUBLISHABLE_KEY: project.publishable_key } : {}),
    ...(project.secret_key_encrypted ? {
      SUPABASE_SECRET_KEY: decryptSecretIfNeeded(project.secret_key_encrypted),
    } : {}),
    JWT_SECRET: project.jwt_secret,
    ...(jwtKeys ? { JWT_KEYS: JSON.stringify(jwtKeys) } : {}),
    ...(jwtJwks ? { JWT_JWKS: JSON.stringify(jwtJwks) } : {}),
    SUPACLOUD_INTERNAL_SUPABASE_URL: internalSupabaseUrl,
    SUPACLOUD_INTERNAL_AUTH_URL: internalAuthUrl,
    SUPACLOUD_INTERNAL_REST_URL: internalRestUrl,
    ...(tenantPorts ? {
      SUPACLOUD_INTERNAL_POSTGREST_PORT: String(tenantPorts.pgrstPort),
      SUPACLOUD_INTERNAL_GOTRUE_PORT: String(tenantPorts.gotruePort),
    } : {}),
    SUPACLOUD_PROJECT_REF: projectRef,
    SUPACLOUD_PROJECT_API_HOST: projectApiHost,
    X_PROJECT_REF: projectRef,
  };
}

export const runtimeEnvService = {
  buildProjectRuntimeEnv,
};
