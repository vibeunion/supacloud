import { projectRepository } from "../repositories/project.repository";
import { databaseService } from "./database.service";
import { jwtService } from "./jwt.service";
import { config } from "../config";
import { normalizeProjectConfig } from "../utils/project-config";
import {
  normalizeProjectRoutingConfig,
  resolveProjectApiHost,
  resolveProjectApiUrl,
} from "../utils/project-routing";
import { decryptSecretIfNeeded } from "../utils/secret-crypto";
import { logger } from "../utils/logger";

function isJwtLike(value: string | null | undefined): value is string {
  return typeof value === "string" && value.split(".").length === 3;
}

export async function buildProjectRuntimeEnv(projectRef: string): Promise<Record<string, string> | null> {
  const project = await projectRepository.findByRef(projectRef);
  if (!project) return null;

  const routingConfig = normalizeProjectRoutingConfig(
    normalizeProjectConfig(project.config),
  );
  const supabaseUrl = resolveProjectApiUrl(projectRef, routingConfig);
  const projectApiHost = resolveProjectApiHost(projectRef, routingConfig);
  const internalSupabaseUrl = `http://127.0.0.1:${config.port}`;

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
    JWT_SECRET: project.jwt_secret,
    SUPACLOUD_INTERNAL_SUPABASE_URL: internalSupabaseUrl,
    SUPACLOUD_INTERNAL_AUTH_URL: `${internalSupabaseUrl}/auth/v1`,
    SUPACLOUD_INTERNAL_REST_URL: `${internalSupabaseUrl}/rest/v1`,
    SUPACLOUD_PROJECT_REF: projectRef,
    SUPACLOUD_PROJECT_API_HOST: projectApiHost,
    X_PROJECT_REF: projectRef,
  };
}

export const runtimeEnvService = {
  buildProjectRuntimeEnv,
};
