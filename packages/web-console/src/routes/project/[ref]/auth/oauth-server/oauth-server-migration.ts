export type OAuthServerStatus = {
  enabled: boolean;
  allow_dynamic_registration: boolean;
  issuer: string;
  discovery_url: string;
  oauth_authorization_server_metadata_url: string;
  jwks_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  signing_alg: string;
  oidc_id_token_ready: boolean;
  migration_status: string;
  warnings?: string[];
};

type OAuthApiResponse = {
  response: Response;
  payload: unknown;
};

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate));
}

function responseMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload) || typeof payload.message !== "string" || !payload.message.trim()) {
    return fallback;
  }
  return payload.message;
}

function isAppliedDependentRefreshFailure({ response, payload }: OAuthApiResponse): boolean {
  return response.status === 503
    && isRecord(payload)
    && payload.code === "SUPAUTH_DEPENDENT_REFRESH_FAILED"
    && payload.persisted === true
    && payload.runtime_applied === true;
}

function enabledOAuthServerStatus(payload: unknown): OAuthServerStatus | null {
  if (!isRecord(payload)
    || payload.enabled !== true
    || typeof payload.allow_dynamic_registration !== "boolean"
    || typeof payload.issuer !== "string"
    || typeof payload.discovery_url !== "string"
    || typeof payload.oauth_authorization_server_metadata_url !== "string"
    || typeof payload.jwks_url !== "string"
    || typeof payload.authorization_endpoint !== "string"
    || typeof payload.token_endpoint !== "string"
    || typeof payload.registration_endpoint !== "string"
    || typeof payload.signing_alg !== "string"
    || typeof payload.oidc_id_token_ready !== "boolean"
    || typeof payload.migration_status !== "string"
    || (payload.warnings !== undefined
      && (!Array.isArray(payload.warnings)
        || !payload.warnings.every((warning: unknown) => typeof warning === "string")))) {
    return null;
  }
  return {
    enabled: payload.enabled,
    allow_dynamic_registration: payload.allow_dynamic_registration,
    issuer: payload.issuer,
    discovery_url: payload.discovery_url,
    oauth_authorization_server_metadata_url: payload.oauth_authorization_server_metadata_url,
    jwks_url: payload.jwks_url,
    authorization_endpoint: payload.authorization_endpoint,
    token_endpoint: payload.token_endpoint,
    registration_endpoint: payload.registration_endpoint,
    signing_alg: payload.signing_alg,
    oidc_id_token_ready: payload.oidc_id_token_ready,
    migration_status: payload.migration_status,
    ...(payload.warnings ? { warnings: payload.warnings.filter((warning): warning is string => typeof warning === "string") } : {}),
  };
}

export async function migrateOAuthServerWithReadback(
  requestMigration: () => Promise<OAuthApiResponse>,
  readOAuthServer: () => Promise<OAuthApiResponse>,
): Promise<OAuthServerStatus> {
  const migration = await requestMigration();
  if (migration.response.ok) {
    const status = enabledOAuthServerStatus(migration.payload);
    if (!status) throw new Error("迁移响应未确认 OAuth Server 已启用");
    return status;
  }
  if (!isAppliedDependentRefreshFailure(migration)) {
    throw new Error(responseMessage(migration.payload, "迁移失败"));
  }

  const readback = await readOAuthServer();
  if (!readback.response.ok) {
    throw new Error(responseMessage(readback.payload, "迁移配置已保存并应用，但无法确认 OAuth Server 启用状态"));
  }
  const status = enabledOAuthServerStatus(readback.payload);
  if (!status) throw new Error("迁移配置已保存并应用，但状态回读显示 OAuth Server 未启用");
  return status;
}
