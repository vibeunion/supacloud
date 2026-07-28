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
  if (!isRecord(payload) || payload.enabled !== true) return null;
  return payload as OAuthServerStatus;
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
