/**
 * Project Configuration Routes
 * Handles: settings, API keys, auth config, config CRUD factory, pgbouncer, types
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import {
  type CustomGatewayRouteConfig,
  MAX_CUSTOM_GATEWAY_HOSTS,
  MAX_CUSTOM_GATEWAY_PATHS,
  gatewayService,
  normalizeCustomGatewayRoute,
  normalizeCustomGatewayRoutes,
} from "../services/gateway.service";
import { certificateService } from "../services/certificate.service";
import { logger } from "../utils/logger";
import {
  OPENAPI_AUTH_CONFIG_RESPONSE_TEMPLATE,
  OPENAPI_CUSTOM_HOSTNAME_RESPONSE_TEMPLATE,
  OPENAPI_REALTIME_CONFIG_RESPONSE_TEMPLATE,
  OPENAPI_STORAGE_CONFIG_RESPONSE_TEMPLATE,
} from "../utils/openapi-defaults.gen";
import { resolveRoleName, resolveDbName as resolveDbNameTopLevel } from "../db";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import { projectNetworkRestrictionRoutes } from "./project-network-restrictions";
import {
  getAuthRuntimeManagedError,
} from "../services/auth-runtime.service";
import {
  applyAuthSessionPolicyPatch,
  AuthSessionPolicyValidationError,
  normalizeAuthSessionPolicyPatch,
  readAuthSessionPolicy,
} from "../services/auth-session-policy";
import {
  buildAuthRuntimeApplyFailureBody,
  buildAuthSessionPolicyErrorBody,
  buildAuthUrlConfigErrorBody,
} from "./auth-config-responses";
import { projectControlSecretsService } from "../services/project-control-secrets.service";
import {
  canonicalizeStockPasskeyConfig,
  PasskeyConfigValidationError,
  passkeyConfigValidationBody,
  readStockPasskeyConfig,
  requestsUnavailableWebAuthnMfaConfig,
  unavailableWebAuthnMfaConfigBody,
  validateStockPasskeyConfig,
} from "../services/auth-product-boundary";
import {
  canonicalAuthProviderLinkingConfig,
  ProviderLinkingDomainsValidationError,
} from "../utils/provider-linking";
import {
  AuthUrlConfigValidationError,
  canonicalizeAuthUrlConfig,
} from "../utils/auth-url-config";
import { safeProjectSettingsAuthConfig } from "./auth";
import {
  DatabaseConfigValidationError,
  type DatabaseSettingsUpdateResult,
  type LiveDatabaseSetting,
  liveSettingNumber,
  parseDatabaseConfigPatch,
  quoteDatabaseIdentifier,
  readLiveDatabaseSettings,
  updateDatabaseSettings,
} from "../services/project-database-config.service";

/** Map PostgreSQL column types to TypeScript types */
function pgTypeToTs(udtName: string, dataType: string): string {
  const map: Record<string, string> = {
    bool: "boolean",
    int2: "number",
    int4: "number",
    int8: "number",
    float4: "number",
    float8: "number",
    numeric: "number",
    text: "string",
    varchar: "string",
    char: "string",
    bpchar: "string",
    name: "string",
    citext: "string",
    uuid: "string",
    date: "string",
    time: "string",
    timetz: "string",
    timestamp: "string",
    timestamptz: "string",
    interval: "string",
    json: "Json",
    jsonb: "Json",
    bytea: "string",
    inet: "string",
    cidr: "string",
    macaddr: "string",
    oid: "number",
    void: "undefined",
    record: "Record<string, unknown>",
    vector: "number[]",
  };
  if (udtName.startsWith("_"))
    return `${pgTypeToTs(udtName.slice(1), dataType)}[]`;
  return (
    map[udtName] ||
    (dataType === "ARRAY"
      ? "unknown[]"
      : dataType === "USER-DEFINED"
        ? "string"
        : "unknown")
  );
}

/**
 * Factory: generates GET + PATCH routes for a project settings config section.
 * Eliminates repeated boilerplate for database/postgrest/storage/realtime configs.
 */
function addConfigRoutes(section: string) {
  // Mounted under projectConfigRoutes, which already has the /v1/projects prefix.
  return new Elysia()
    .get(
      `/:ref/config/${section}`,
      async ({ params }: { params: { ref: string } }) => {
        const settings = await projectService.getProjectSettings(params.ref);
        if (!settings)
          return status(404, { message: "Project not found", code: "404" });
        return (settings as Record<string, unknown>)[section] || {};
      },
      { params: t.Object({ ref: t.String() }) },
    )
    .patch(
      `/:ref/config/${section}`,
      async ({
        params,
        body,
      }: {
        params: { ref: string };
        body: Record<string, unknown>;
      }) => {
        const settings = await projectService.getProjectSettings(params.ref);
        if (!settings)
          return status(404, { message: "Project not found", code: "404" });
        const current =
          ((settings as Record<string, unknown>)[section] as Record<
            string,
            unknown
          >) || {};
        const updated = await projectService.updateProjectSettings(params.ref, {
          ...settings,
          [section]: { ...current, ...(typeof body === "object" ? body : {}) },
        });
        return (updated as Record<string, unknown>)?.[section] || {};
      },
      {
        params: t.Object({ ref: t.String() }),
        body: t.Record(t.String(), t.Unknown()),
      },
    );
}

function cloneTemplate<T>(template: T): T {
  return structuredClone(template);
}

function buildDatabaseConfigResponse(
  projectRef: string,
  databaseName: string,
  metadata: Record<string, unknown>,
  settings: LiveDatabaseSetting[],
) {
  return {
    pgbouncer_enabled: metadata.pgbouncer_enabled ?? false,
    pgbouncer_settings: metadata.pgbouncer_settings || {},
    connection_string: `postgresql://${resolveRoleName(projectRef)}:[YOUR-PASSWORD]@localhost:5432/${databaseName}`,
    max_connections: liveSettingNumber(settings, "max_connections"),
    statement_timeout: liveSettingNumber(settings, "statement_timeout"),
    idle_in_transaction_session_timeout: liveSettingNumber(
      settings,
      "idle_in_transaction_session_timeout",
    ),
    settings,
  };
}

function databaseUpdateFailureBody(
  update: Extract<DatabaseSettingsUpdateResult<unknown>, { ok: false }>,
) {
  const applyFailed = update.stage === "apply";
  return {
    code: applyFailed
      ? "DATABASE_SETTINGS_APPLY_FAILED"
      : "DATABASE_SETTINGS_PERSIST_FAILED",
    message: applyFailed
      ? "Failed to apply database settings; persisted configuration was not changed"
      : update.restoreAttempted
        ? "Database settings were applied but configuration persistence failed; restoration was attempted"
        : "Failed to persist database configuration",
    rollback: {
      attempted: update.restoreAttempted,
      succeeded: update.restoreAttempted
        ? update.restoreFailures.length === 0
        : null,
      failed_settings: update.restoreFailures.map((failure) => failure.name),
    },
  };
}

async function projectDatabaseConnection(projectRef: string) {
  const { getProjectDb, resolveDbName } = await import("../db");
  const databaseName = await resolveDbName(projectRef);
  quoteDatabaseIdentifier(databaseName);
  return { databaseName, database: getProjectDb(databaseName) };
}

const CustomGatewayHostsSchema = t.Array(t.String(), {
  minItems: 1,
  maxItems: MAX_CUSTOM_GATEWAY_HOSTS,
});
const CustomGatewayPathSchema = t.Union([
  t.String(),
  t.Array(t.String(), { minItems: 1, maxItems: MAX_CUSTOM_GATEWAY_PATHS }),
]);

function readCustomGatewayRoutes(settings: Record<string, unknown>): CustomGatewayRouteConfig[] {
  return normalizeCustomGatewayRoutes(settings.gateway_routes);
}

function customGatewayRouteBody(body: Record<string, unknown>, routeId?: string): CustomGatewayRouteConfig {
  return normalizeCustomGatewayRoute({
    ...(body as unknown as CustomGatewayRouteConfig),
    id: routeId || String(body.id || ""),
  });
}

async function applyCustomGatewayRoutes(projectRef: string, settings: Record<string, unknown>, routes: CustomGatewayRouteConfig[]): Promise<
  | { ok: true; settings: Record<string, unknown> | null }
  | { ok: false; status: 400 | 500; body: { message: string; code: string } }
> {
  if (routes.length > 50) {
    return { ok: false, status: 400, body: { message: "Maximum of 50 custom gateway routes allowed per project", code: "400" } };
  }

  const previousRoutes = readCustomGatewayRoutes(settings);
  const result = await gatewayService.configureCustomGatewayRoutes(projectRef, routes);
  if (!result.success) {
    return { ok: false, status: 500, body: { message: result.error || "Failed to update custom gateway routes", code: "500" } };
  }

  try {
    const updated = await projectService.updateProjectSettings(projectRef, {
      ...settings,
      gateway_routes: routes,
    });
    if (!updated) throw new Error("Project settings update returned no result");
    return { ok: true, settings: updated };
  } catch (error: unknown) {
    const persistenceError = error instanceof Error ? error.message : String(error);
    let rollbackError = "";
    try {
      const rollback = await gatewayService.configureCustomGatewayRoutes(projectRef, previousRoutes);
      if (!rollback.success) rollbackError = rollback.error || "unknown rollback failure";
    } catch (rollback: unknown) {
      rollbackError = rollback instanceof Error ? rollback.message : String(rollback);
    }
    const message = rollbackError
      ? `Failed to persist custom gateway routes: ${persistenceError}; Caddy rollback failed: ${rollbackError}`
      : `Failed to persist custom gateway routes: ${persistenceError}; Caddy routes restored`;
    return { ok: false, status: 500, body: { message, code: "500" } };
  }
}

function buildCustomHostnameResponse(domainInfo: unknown) {
  const response = cloneTemplate(
    OPENAPI_CUSTOM_HOSTNAME_RESPONSE_TEMPLATE,
  ) as Record<string, any>;
  const raw = (domainInfo as Record<string, unknown>) || {};
  const hostname =
    typeof raw.custom_hostname === "string" ? raw.custom_hostname : "";
  const configured = hostname.length > 0;
  const data = (response.data as Record<string, any>) || {};
  const result = (data.result as Record<string, any>) || {};
  const ssl = (result.ssl as Record<string, any>) || {};

  response.custom_hostname = hostname;
  response.status = configured
    ? "5_services_reconfigured"
    : "1_not_started";
  response.data = {
    ...data,
    success: configured,
    result: {
      ...result,
      id: hostname,
      hostname,
      custom_origin_server: hostname,
      status: configured ? "active" : "pending",
      ssl: {
        ...ssl,
        status: configured ? "active" : ssl.status,
      },
    },
  };
  return response;
}

function buildStorageConfigResponse(raw: Record<string, unknown>) {
  const response = cloneTemplate(
    OPENAPI_STORAGE_CONFIG_RESPONSE_TEMPLATE,
  ) as Record<string, any>;
  const features = (raw.features as Record<string, any>) || {};

  response.fileSizeLimit = Number(
    raw.fileSizeLimit ?? raw.file_size_limit ?? response.fileSizeLimit,
  );
  response.features = {
    ...(response.features as Record<string, unknown>),
    ...features,
    imageTransformation: {
      ...((response.features as Record<string, any>).imageTransformation || {}),
      ...((features.imageTransformation as Record<string, unknown>) || {}),
    },
    s3Protocol: {
      ...((response.features as Record<string, any>).s3Protocol || {}),
      ...((features.s3Protocol as Record<string, unknown>) || {}),
    },
    purgeCache: {
      ...((response.features as Record<string, any>).purgeCache || {}),
      ...((features.purgeCache as Record<string, unknown>) || {}),
    },
    icebergCatalog: {
      ...((response.features as Record<string, any>).icebergCatalog || {}),
      ...((features.icebergCatalog as Record<string, unknown>) || {}),
      enabled: false,
    },
    vectorBuckets: {
      ...((response.features as Record<string, any>).vectorBuckets || {}),
      ...((features.vectorBuckets as Record<string, unknown>) || {}),
      enabled: true,
      experimental: true,
      dataPlane: "bounded_exact_scan",
      maxBuckets: 100,
      maxIndexes: 10,
      maxValuesPerIndex: 1_000_000,
    },
  };
  response.capabilities = {
    ...(response.capabilities as Record<string, unknown>),
    ...(((raw.capabilities as Record<string, unknown>) || {}) as Record<
      string,
      unknown
    >),
    iceberg_catalog: false,
    storage_iceberg: false,
    storage_vectors: true,
    storage_vectors_experimental: true,
  };
  response.external = {
    ...(response.external as Record<string, unknown>),
    ...(((raw.external as Record<string, unknown>) || {}) as Record<
      string,
      unknown
    >),
  };
  response.migrationVersion =
    (raw.migrationVersion as string) ??
    (raw.migration_version as string) ??
    response.migrationVersion;
  response.databasePoolMode =
    (raw.databasePoolMode as string) ??
    (raw.database_pool_mode as string) ??
    response.databasePoolMode;

  return {
    ...raw,
    ...response,
    fileSizeLimit: response.fileSizeLimit,
    features: response.features,
    capabilities: response.capabilities,
    external: response.external,
    migrationVersion: response.migrationVersion,
    databasePoolMode: response.databasePoolMode,
  };
}

function buildRealtimeConfigResponse(raw: Record<string, unknown>) {
  const response = cloneTemplate(
    OPENAPI_REALTIME_CONFIG_RESPONSE_TEMPLATE,
  ) as Record<string, unknown>;

  response.private_only = raw.private_only ?? raw.privateOnly ?? response.private_only;
  response.connection_pool =
    raw.connection_pool ?? raw.connectionPool ?? response.connection_pool;
  response.max_concurrent_users =
    raw.max_concurrent_users ??
    raw.maxConcurrentUsers ??
    response.max_concurrent_users;
  response.max_events_per_second =
    raw.max_events_per_second ??
    raw.maxEventsPerSecond ??
    response.max_events_per_second;
  response.max_bytes_per_second =
    raw.max_bytes_per_second ??
    raw.maxBytesPerSecond ??
    response.max_bytes_per_second;
  response.max_channels_per_client =
    raw.max_channels_per_client ??
    raw.maxChannelsPerClient ??
    response.max_channels_per_client;
  response.max_joins_per_second =
    raw.max_joins_per_second ??
    raw.maxJoinsPerSecond ??
    response.max_joins_per_second;
  response.max_presence_events_per_second =
    raw.max_presence_events_per_second ??
    raw.maxPresenceEventsPerSecond ??
    response.max_presence_events_per_second;
  response.max_payload_size_in_kb =
    raw.max_payload_size_in_kb ??
    raw.maxPayloadSizeInKb ??
    response.max_payload_size_in_kb;
  response.suspend = raw.suspend ?? response.suspend;
  response.presence_enabled =
    raw.presence_enabled ?? raw.presenceEnabled ?? response.presence_enabled;

  return {
    ...raw,
    ...response,
  };
}

function isNewControlSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "********" && value !== "****";
}

function recordSetting(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function containsEmbeddedAuthSecret(value: unknown): boolean {
  const auth = recordSetting(value);
  if ("security_captcha_secret" in auth && isNewControlSecret(auth.security_captcha_secret)) return true;
  for (const provider of Object.values(recordSetting(auth.external))) {
    if (isNewControlSecret(recordSetting(provider).client_secret)) return true;
  }
  for (const hook of Object.values(recordSetting(auth.hooks))) {
    if (isNewControlSecret(recordSetting(hook).secrets)) return true;
  }
  return false;
}

async function moveEmbeddedAuthSecrets(
  ref: string,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const auth = structuredClone(value);
  const external = recordSetting(auth.external);
  for (const [provider, rawConfig] of Object.entries(external)) {
    const providerConfig = recordSetting(rawConfig);
    if (isNewControlSecret(providerConfig.client_secret)) {
      await projectControlSecretsService.upsert(ref, "connector", provider, providerConfig.client_secret);
    }
    delete providerConfig.client_secret;
  }

  if (isNewControlSecret(auth.security_captcha_secret)) {
    const provider = String(auth.security_captcha_provider ?? "default").toLowerCase();
    await projectControlSecretsService.upsert(ref, "captcha", provider, auth.security_captcha_secret);
  }
  delete auth.security_captcha_secret;

  const hooks = recordSetting(auth.hooks);
  for (const [hookName, rawHook] of Object.entries(hooks)) {
    const hook = recordSetting(rawHook);
    if (isNewControlSecret(hook.secrets)) {
      await projectControlSecretsService.upsert(ref, "auth-hook", hookName, hook.secrets);
    }
    delete hook.secrets;
  }
  return auth;
}

async function buildAuthConfigResponse(ref: string, settings: Record<string, unknown>) {
  const authConfig = canonicalAuthProviderLinkingConfig(
    (settings.auth as Record<string, unknown>) || {},
  );
  const sessionPolicy = readAuthSessionPolicy(authConfig);
  const externalConfig =
    (authConfig.external as Record<string, unknown>) || {};
  const hooksConfig = (authConfig.hooks as Record<string, unknown>) || {};
  const smtpConfig = (authConfig.smtp as Record<string, unknown>) || {};
  const connectorStatuses = await projectControlSecretsService.listStatuses(ref, "connector");
  const configuredConnectors = new Set(connectorStatuses.filter((item) => item.configured).map((item) => item.name));
  const hookStatuses = await projectControlSecretsService.listStatuses(ref, "auth-hook");
  const configuredHooks = new Set(hookStatuses.filter((item) => item.configured).map((item) => item.name));
  const captchaProvider = String(authConfig.security_captcha_provider ?? "default").toLowerCase();
  const captchaStatus = await projectControlSecretsService.getStatus(ref, "captcha", captchaProvider);

  const response: Record<string, unknown> = {
    ...cloneTemplate(OPENAPI_AUTH_CONFIG_RESPONSE_TEMPLATE),
    enable_signup: authConfig.enable_signup ?? true,
    enable_signups: authConfig.enable_signup ?? true,
    enable_confirmations: authConfig.enable_confirmations ?? false,
    double_confirm_changes: authConfig.double_confirm_changes ?? true,
    manual_linking_enabled:
      authConfig.manual_linking_enabled ??
      authConfig.enable_manual_linking ??
      false,
    jwt_exp: sessionPolicy.jwt_expiry,
    jwt_expiry: sessionPolicy.jwt_expiry,
    disable_signup: authConfig.disable_signup ?? false,
    mailer_autoconfirm: authConfig.mailer_autoconfirm ?? false,
    mail_autoconfirm: authConfig.mailer_autoconfirm ?? false,
    sms_autoconfirm: authConfig.sms_autoconfirm ?? false,
    phone_autoconfirm: authConfig.sms_autoconfirm ?? false,
    uri_allow_list: authConfig.uri_allow_list ?? authConfig.URI_ALLOW_LIST ?? null,
    site_url: authConfig.site_url ?? authConfig.SITE_URL ?? null,
    password_min_length: sessionPolicy.password_min_length,
    password_required_characters: sessionPolicy.password_required_characters,
    refresh_token_rotation_enabled:
      sessionPolicy.refresh_token_rotation_enabled,
    security_refresh_token_reuse_interval:
      sessionPolicy.security_refresh_token_reuse_interval,
    mfa_max_enrolled_factors:
      authConfig.mfa_max_enrolled_factors ??
      authConfig.max_enrolled_factors ??
      null,
    security_update_password_require_reauthentication:
      sessionPolicy.security_update_password_require_reauthentication,
    sessions_inactivity_timeout: sessionPolicy.sessions_inactivity_timeout,
    sessions_single_per_user: sessionPolicy.sessions_single_per_user,
    sessions_timebox: sessionPolicy.sessions_timebox,
    external_anonymous_users_enabled:
      authConfig.external_anonymous_users_enabled ?? null,
    external_email_enabled: authConfig.external_email_enabled ?? null,
    external_phone_enabled: authConfig.external_phone_enabled ?? null,
    saml_enabled: authConfig.saml_enabled ?? null,
    saml_external_url: authConfig.saml_external_url ?? null,
    saml_private_key_next_configured:
      Boolean((authConfig.saml as Record<string, unknown> | undefined)?.private_key_next) ||
      Boolean(authConfig.saml_private_key_next),
    security_captcha_enabled: authConfig.security_captcha_enabled ?? null,
    security_captcha_provider: authConfig.security_captcha_provider ?? "hcaptcha",
    security_captcha_secret: captchaStatus.configured ? "********" : null,
    security_captcha_secret_configured: captchaStatus.configured,
    rate_limit_anonymous_users: authConfig.rate_limit_anonymous_users ?? null,
    rate_limit_email_sent: authConfig.rate_limit_email_sent ?? null,
    rate_limit_sms_sent: authConfig.rate_limit_sms_sent ?? null,
    rate_limit_verify: authConfig.rate_limit_verify ?? null,
    rate_limit_token_refresh: authConfig.rate_limit_token_refresh ?? null,
    rate_limit_otp: authConfig.rate_limit_otp ?? null,
    sms_provider: authConfig.sms_provider ?? "twilio",
    experimental: authConfig.experimental ?? {},
    ...readStockPasskeyConfig(authConfig),
  };

  delete response.external;
  delete response.hooks;
  delete response.smtp;

  for (const [key, value] of Object.entries(externalConfig)) {
    if (!value || typeof value !== "object") continue;
    const provider = value as Record<string, unknown>;
    response[`external_${key}_enabled`] =
      provider.enabled ?? !!provider.client_id;
    if ("client_id" in provider) {
      response[`external_${key}_client_id`] = provider.client_id ?? null;
    }
    if ("client_secret" in provider || configuredConnectors.has(key)) {
      response[`external_${key}_secret`] = configuredConnectors.has(key) ? "********" : null;
      response[`external_${key}_secret_configured`] = configuredConnectors.has(key);
    }
    if ("email_optional" in provider) {
      response[`external_${key}_email_optional`] =
        provider.email_optional ?? null;
    }
    if ("additional_client_ids" in provider) {
      response[`external_${key}_additional_client_ids`] =
        provider.additional_client_ids ?? null;
    }
    if ("url" in provider) {
      response[`external_${key}_url`] = provider.url ?? null;
    }
    if ("skip_nonce_check" in provider) {
      response[`external_${key}_skip_nonce_check`] =
        provider.skip_nonce_check ?? null;
    }
  }

  const hookMap: Record<string, string> = {
    custom_access_token_hook: "custom_access_token",
    mfa_verification_hook: "mfa_verification_attempt",
    password_verification_hook: "password_verification_attempt",
    send_sms_hook: "send_sms",
    send_email_hook: "send_email",
    before_user_created_hook: "before_user_created",
    after_user_created_hook: "after_user_created",
  };

  for (const [hookName, suffix] of Object.entries(hookMap)) {
    const hook = (hooksConfig[hookName] as Record<string, unknown>) || {};
    response[`hook_${suffix}_enabled`] = hook.enabled ?? null;
    response[`hook_${suffix}_uri`] = hook.uri ?? null;
    if ("secrets" in hook || configuredHooks.has(hookName)) {
      const configured = configuredHooks.has(hookName);
      response[`hook_${suffix}_secrets`] = configured ? "********" : null;
      response[`hook_${suffix}_secrets_configured`] = configured;
    }
  }

  response.smtp_admin_email = smtpConfig.admin_email ?? null;
  response.smtp_host = smtpConfig.host ?? null;
  response.smtp_port = smtpConfig.port ?? null;
  response.smtp_user = smtpConfig.user ?? null;
  response.smtp_pass = smtpConfig.pass ? "********" : null;
  response.smtp_max_frequency = smtpConfig.max_frequency ?? null;
  response.smtp_sender_name = smtpConfig.sender_name ?? null;

  return response;
}

function buildSharedSettingsResponse(
  settings: Record<string, unknown>,
  authorityProjectRef: unknown,
) {
  const { auth: _auth, ...safeSettings } = settings;
  return {
    ...safeSettings,
    auth_runtime: {
      mode: "shared",
      authority_project_ref: authorityProjectRef,
      configuration_management: "owner_only",
    },
  };
}

async function buildProjectSettingsResponse(
  ref: string,
  settings: Record<string, unknown>,
) {
  const auth = settings.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return settings;
  return {
    ...settings,
    auth: await safeProjectSettingsAuthConfig(ref, auth as Record<string, unknown>),
  };
}

export const projectConfigRoutes = new Elysia({ prefix: "/v1/projects" })
  // 组级守卫：统一保护所有 project-scoped 路由（含 addConfigRoutes 工厂与各 .use 子路由），
  // 避免逐接口手工遗漏导致委托 member/viewer 绕过 tenant.config.read / operations.read
  .onBeforeHandle(async ({ params, request }) => {
    const ref = (params as { ref?: string }).ref;
    if (!ref) return;
    const authError = await requireProjectOrAdminAuth(request, ref);
    if (authError) return status(authError.status, authError.body);
  })
  // Get project settings
  .get(
    "/:ref/settings",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (settings === null) {
        return status(404, { message: "Project not found", code: "404" });
      }
      const managedError = getAuthRuntimeManagedError(params.ref, "configuration");
      if (managedError) {
        return buildSharedSettingsResponse(
          settings,
          managedError.authority_project_ref,
        );
      }
      return buildProjectSettingsResponse(params.ref, settings);
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    
      detail: { tags: ["projects"], summary: "Get project settings" },
},
  )

  // Update project settings
  .put(
    "/:ref/settings",
    async ({ params, body }) => {
      const managedError = getAuthRuntimeManagedError(params.ref, "configuration");
      if (managedError && Object.prototype.hasOwnProperty.call(body, "auth")) {
        return status(409, managedError);
      }
      if (containsEmbeddedAuthSecret((body as Record<string, unknown>).auth)) {
        return status(400, {
          code: "SECRET_MANAGER_REQUIRED",
          message: "Auth credentials must be written through the project control secret API",
        });
      }
      const settings = await projectService.updateProjectSettings(
        params.ref,
        body,
      );
      if (settings === null) {
        return status(404, { message: "Project not found", code: "404" });
      }
      if (managedError) {
        return buildSharedSettingsResponse(
          settings,
          managedError.authority_project_ref,
        );
      }
      return buildProjectSettingsResponse(params.ref, settings);
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
      detail: { tags: ["projects"], summary: "Update project settings" },
    },
  )

  // Get project API keys
  .get(
    "/:ref/api-keys",
    async ({ params }) => {
      const keys = await projectService.getApiKeys(params.ref);
      if (!keys) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return [
        { name: "publishable", api_key: keys.publishable_key || "" },
        { name: "secret", api_key: keys.secret_key ? "********" : "" },
        { name: "anon", api_key: keys.anon_key },
        { name: "service_role", api_key: keys.service_role_key ? "********" : "" },
      ];
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    
      detail: { tags: ["projects"], summary: "Get project API keys" },
},
  )

  // Rotate API keys
  .post(
    "/:ref/api-keys/rotate",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const keys = await projectService.rotateApiKeys(params.ref);
      if (!keys) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return {
        anon_key: keys.anon_key,
        service_role_key: keys.service_role_key ? "********" : "",
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    
      detail: { tags: ["projects"], summary: "Rotate legacy JWT API keys" },
},
  )

  // Rotate opaque Publishable/Secret keys without invalidating user JWT sessions.
  .post(
    "/:ref/api-keys/rotate-opaque",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const keys = await projectService.rotateOpaqueApiKeys(params.ref);
      if (!keys) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return keys;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),

      detail: { tags: ["projects"], summary: "Rotate opaque Publishable and Secret keys" },
},
  )

  // Get logs
  .get(
    "/:ref/logs",
    async ({ params, query, set }) => {
      const logs = await projectService.queryLogs(params.ref, query.type);
      return logs;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      query: t.Object({
        type: t.Optional(t.String()),
      }),
    
      detail: { tags: ["projects"], summary: "Get project logs" },
},
  )

  .use(projectNetworkRestrictionRoutes)

  // Get custom domain
  .get(
    "/:ref/custom-hostname",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const domainInfo = await projectService.getCustomDomain(params.ref);
      if (!domainInfo) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return buildCustomHostnameResponse(domainInfo);
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    
      detail: { tags: ["projects"], summary: "Get custom hostname" },
},
  )

  // Add custom domain
  .post(
    "/:ref/custom-hostname",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const success = await projectService.addCustomDomain(
        params.ref,
        (body as Record<string, unknown>).custom_hostname as string,
      );
      if (!success) {
        return status(500, {
          message: "Failed to add custom hostname",
          code: "500",
        });
      }
      return {
        custom_hostname: (body as Record<string, unknown>).custom_hostname,
        status: "1_requested",
        data: {},
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ custom_hostname: t.String() }),
    
      detail: { tags: ["projects"], summary: "Add custom hostname" },
},
  )

  .delete(
    "/:ref/custom-hostname",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const success = await projectService.deleteCustomDomain(params.ref);
      if (!success) {
        return status(500, {
          message: "Failed to delete custom hostname",
          code: "500",
        });
      }
      return { custom_hostname: null, status: "0_not_started", data: {} };
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Delete custom hostname" },

    },
  )

  .post(
    "/:ref/custom-hostname/verify",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const domainInfo = await projectService.getCustomDomain(params.ref);
      if (!domainInfo) {
        return status(404, {
          message: "No custom hostname configured",
          code: "404",
        });
      }
      const verified = await projectService
        .getCustomDomain(params.ref)
        .then((d) => !!d)
        .catch(() => false);
      return {
        status: verified ? "verified" : "pending_verification",
        custom_hostname: domainInfo,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
    
      detail: { tags: ["projects"], summary: "Verify custom hostname" },
},
  )

  // Get Auth config (Studio compatible format)
  .get(
    "/:ref/config/auth",
    async ({ params }) => {
      const managedError = getAuthRuntimeManagedError(params.ref, "configuration");
      if (managedError) return status(409, managedError);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      return await buildAuthConfigResponse(params.ref, settings);
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    
      detail: { tags: ["projects"], summary: "Get auth config" },
},
  )

  // Modify Auth config (supports deep copy override for third-party Providers)
  .patch(
    "/:ref/config/auth",
    async ({ params, body }) => {
      const managedError = getAuthRuntimeManagedError(params.ref, "configuration");
      if (managedError) return status(409, managedError);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const rawAuthPatch = typeof body === "object" && body !== null
        ? body as Record<string, unknown>
        : {};
      if (requestsUnavailableWebAuthnMfaConfig(rawAuthPatch)) {
        return status(501, unavailableWebAuthnMfaConfigBody());
      }

      let newAuth: Record<string, unknown>;
      try {
        newAuth = canonicalizeStockPasskeyConfig(canonicalizeAuthUrlConfig(
          typeof body === "object" && body !== null ? body : {},
        ));
      } catch (error: unknown) {
        if (error instanceof PasskeyConfigValidationError) {
          return status(400, passkeyConfigValidationBody(error));
        }
        if (error instanceof AuthUrlConfigValidationError) {
          return status(400, buildAuthUrlConfigErrorBody(error));
        }
        throw error;
      }
      const currentAuth = await moveEmbeddedAuthSecrets(
        params.ref,
        (settings.auth as Record<string, unknown>) || {},
      );
      let sessionPolicyPatch: ReturnType<typeof normalizeAuthSessionPolicyPatch>;
      try {
        sessionPolicyPatch = normalizeAuthSessionPolicyPatch(newAuth);
      } catch (error: unknown) {
        if (error instanceof AuthSessionPolicyValidationError) {
          return status(400, buildAuthSessionPolicyErrorBody(error));
        }
        throw error;
      }

      // Parse external_* keys back into nested external config
      const externalUpdates: Record<string, unknown> = {};
      const otherUpdates: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(newAuth)) {
        if (sessionPolicyPatch.consumedKeys.has(key)) continue;
        if (key.startsWith("EXTERNAL_") && key.endsWith("_ENABLED")) {
          const provider = key
            .replace(/^EXTERNAL_/, "")
            .replace(/_ENABLED$/, "")
            .toLowerCase();
          if (["anonymous_users", "email", "phone"].includes(provider)) {
            otherUpdates[`external_${provider}_enabled`] = val;
            continue;
          }
          const existing =
            ((currentAuth.external as Record<string, unknown>)?.[
              provider
            ] as Record<string, unknown>) || {};
          if (val === false || val === 0) {
            externalUpdates[provider] = {
              ...existing,
              client_id: "",
            };
          } else {
            externalUpdates[provider] = { ...existing };
          }
        } else if (key.startsWith("EXTERNAL_") && key.endsWith("_CLIENT_ID")) {
          const provider = key
            .replace(/^EXTERNAL_/, "")
            .replace(/_CLIENT_ID$/, "")
            .toLowerCase();
          const existing =
            ((currentAuth.external as Record<string, unknown>)?.[
              provider
            ] as Record<string, unknown>) || {};
          externalUpdates[provider] = { ...existing, client_id: val };
        } else if (key.startsWith("EXTERNAL_") && key.endsWith("_SECRET")) {
          const provider = key
            .replace(/^EXTERNAL_/, "")
            .replace(/_SECRET$/, "")
            .toLowerCase();
          if (isNewControlSecret(val)) {
            await projectControlSecretsService.upsert(params.ref, "connector", provider, val);
          }
        } else if (
          key.startsWith("external_") &&
          ![
            "external_anonymous_users_enabled",
            "external_email_enabled",
            "external_phone_enabled",
            "external_providers",
          ].includes(key)
        ) {
          const provider = key.replace("external_", "");
          const providerVal = val as Record<string, unknown>;
          externalUpdates[provider] = {
            ...(((currentAuth.external as Record<string, unknown>)?.[
              provider
            ] as Record<string, unknown>) || {}),
            ...(providerVal.client_id !== undefined
              ? { client_id: providerVal.client_id }
              : {}),
          };
          if (isNewControlSecret(providerVal.secret)) {
            await projectControlSecretsService.upsert(params.ref, "connector", provider, providerVal.secret);
          }
        } else if (key.startsWith("hook_")) {
          const hookMap: Record<string, string> = {
            hook_custom_access_token_enabled: "custom_access_token_hook",
            hook_custom_access_token_uri: "custom_access_token_hook",
            hook_mfa_verification_enabled: "mfa_verification_hook",
            hook_mfa_verification_uri: "mfa_verification_hook",
            hook_password_verification_enabled: "password_verification_hook",
            hook_password_verification_uri: "password_verification_hook",
            hook_send_email_enabled: "send_email_hook",
            hook_send_email_uri: "send_email_hook",
            hook_send_sms_enabled: "send_sms_hook",
            hook_send_sms_uri: "send_sms_hook",
            hook_custom_access_token_secrets: "custom_access_token_hook",
            hook_mfa_verification_attempt_secrets: "mfa_verification_hook",
            hook_password_verification_attempt_secrets: "password_verification_hook",
            hook_send_email_secrets: "send_email_hook",
            hook_send_sms_secrets: "send_sms_hook",
            hook_before_user_created_secrets: "before_user_created_hook",
          };
          const hookName = hookMap[key];
          if (hookName) {
            const currentHooks =
              (currentAuth.hooks as Record<string, any>) || {};
            const currentHook = currentHooks[hookName] || {};
            if (key.endsWith("_enabled")) {
              otherUpdates.hooks = {
                ...((otherUpdates.hooks as Record<string, any>) || {}),
                [hookName]: { ...currentHook, enabled: !!val },
              };
            } else if (key.endsWith("_uri")) {
              otherUpdates.hooks = {
                ...((otherUpdates.hooks as Record<string, any>) || {}),
                [hookName]: { ...currentHook, uri: val },
              };
            } else if (key.endsWith("_secrets") && isNewControlSecret(val)) {
              await projectControlSecretsService.upsert(params.ref, "auth-hook", hookName, val);
            }
          }
        } else if (key.startsWith("smtp_")) {
          const smtpKeyMap: Record<string, string> = {
            smtp_admin_email: "admin_email",
            smtp_host: "host",
            smtp_port: "port",
            smtp_user: "user",
            smtp_pass: "pass",
            smtp_max_frequency: "max_frequency",
            smtp_sender_name: "sender_name",
          };
          const smtpField = smtpKeyMap[key];
          if (smtpField) {
            const currentSmtp =
              (currentAuth.smtp as Record<string, unknown>) || {};
            otherUpdates.smtp = {
              ...((otherUpdates.smtp as Record<string, unknown>) || {}),
              [smtpField]:
                key === "smtp_pass" && val === "********"
                  ? currentSmtp.pass
                  : val,
            };
          }
        } else if (key.startsWith("saml_")) {
          const samlKeyMap: Record<string, string> = {
            saml_enabled: "enabled",
            saml_external_url: "external_url",
            saml_api_base: "api_base",
            saml_metadata_url: "metadata_url",
            saml_metadata_xml: "metadata_xml",
            saml_private_key: "private_key",
            saml_private_key_next: "private_key_next",
            saml_allow_encrypted_assertions: "allow_encrypted_assertions",
            saml_relay_state_validity_period: "relay_state_validity_period",
            saml_rate_limit_assertion: "rate_limit_assertion",
          };
          const samlField = samlKeyMap[key];
          if (samlField) {
            const currentSaml =
              (currentAuth.saml as Record<string, unknown>) || {};
            otherUpdates.saml = {
              ...((otherUpdates.saml as Record<string, unknown>) || {}),
              [samlField]: val,
            };
          }
        } else if (key === "security_captcha_secret") {
          if (isNewControlSecret(val)) {
            const provider = String(
              newAuth.security_captcha_provider ?? currentAuth.security_captcha_provider ?? "default",
            ).toLowerCase();
            await projectControlSecretsService.upsert(params.ref, "captcha", provider, val);
          }
        } else if (key !== "external_providers") {
          otherUpdates[key] = val;
        }
      }

      const mergeBaseAuth = { ...currentAuth };
      if ("site_url" in newAuth) delete mergeBaseAuth.SITE_URL;
      if ("uri_allow_list" in newAuth) delete mergeBaseAuth.URI_ALLOW_LIST;

      const mergedExternal = {
        ...((mergeBaseAuth.external as Record<string, unknown>) || {}),
        ...externalUpdates,
      };

      let mergedAuth = {
        ...mergeBaseAuth,
        ...otherUpdates,
        ...(Object.keys(externalUpdates).length > 0
          ? { external: mergedExternal }
          : {}),
        ...(otherUpdates.hooks
          ? {
              hooks: {
                ...((mergeBaseAuth.hooks as Record<string, any>) || {}),
                ...(otherUpdates.hooks as Record<string, any>),
              },
            }
          : {}),
        ...(otherUpdates.smtp
          ? {
              smtp: {
                ...((mergeBaseAuth.smtp as Record<string, unknown>) || {}),
                ...(otherUpdates.smtp as Record<string, unknown>),
              },
            }
          : {}),
        ...(otherUpdates.saml
          ? {
              saml: {
                ...((mergeBaseAuth.saml as Record<string, unknown>) || {}),
                ...(otherUpdates.saml as Record<string, unknown>),
              },
            }
          : {}),
      };

      delete mergedAuth.hooks;
      delete mergedAuth.smtp;
      if (otherUpdates.hooks)
        mergedAuth.hooks = {
          ...((mergeBaseAuth.hooks as Record<string, any>) || {}),
          ...(otherUpdates.hooks as Record<string, any>),
        };
      if (otherUpdates.smtp)
        mergedAuth.smtp = {
          ...((mergeBaseAuth.smtp as Record<string, unknown>) || {}),
          ...(otherUpdates.smtp as Record<string, unknown>),
        };
      if (otherUpdates.saml)
        mergedAuth.saml = {
          ...((mergeBaseAuth.saml as Record<string, unknown>) || {}),
          ...(otherUpdates.saml as Record<string, unknown>),
        };

      try {
        mergedAuth = canonicalAuthProviderLinkingConfig(
          applyAuthSessionPolicyPatch(mergedAuth, sessionPolicyPatch),
        );
        validateStockPasskeyConfig(mergedAuth);
      } catch (error: unknown) {
        if (error instanceof PasskeyConfigValidationError) {
          return status(400, passkeyConfigValidationBody(error));
        }
        if (error instanceof ProviderLinkingDomainsValidationError) {
          return status(400, { code: "INVALID_PROVIDER_LINKING_DOMAINS", message: error.message });
        }
        throw error;
      }

      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: mergedAuth,
      });

      // Apply only the owner/local GoTrue runtime. Shared dependents are
      // refreshed by the owner-aware service path after GoTrue is healthy.
      try {
        const { tenantRuntimeService } =
          await import("../services/tenant-runtime.service");
        await tenantRuntimeService.applyAuthConfig(params.ref, currentAuth, mergedAuth);
      } catch (error: unknown) {
        logger.warn(
          "[project-config] Failed to propagate auth config to runtime",
          { error },
        );
        return status(503, buildAuthRuntimeApplyFailureBody(params.ref, error));
      }

      const freshSettings = await projectService.getProjectSettings(params.ref);
      return await buildAuthConfigResponse(
        params.ref,
        (freshSettings || updated || { ...settings, auth: mergedAuth }) as Record<string, unknown>,
      );
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
    
      detail: {
        tags: ["projects"],
        summary: "Update auth config",
        description: "Provider linking accepts experimental.provider_linking_domains as a validated provider-to-domain map; the deprecated provider list is normalized forward.",
      },
},
  )

  // --- Config CRUD (database, postgrest, storage, realtime) via factory ---
  .get(
    "/:ref/config/database",
    async ({ params }) => {
      const projectSettings = await projectService.getProjectSettings(params.ref);
      if (!projectSettings)
        return status(404, { message: "Project not found", code: "404" });
      const databaseMetadata =
        ((projectSettings as Record<string, unknown>).database as Record<
          string,
          unknown
        >) || {};
      try {
        const { database, databaseName } = await projectDatabaseConnection(
          params.ref,
        );
        const liveSettings = await readLiveDatabaseSettings(database);
        return buildDatabaseConfigResponse(
          params.ref,
          databaseName,
          databaseMetadata,
          liveSettings,
        );
      } catch (error: unknown) {
        logger.warn("[project-config] Failed to read live database settings", {
          errorType: error instanceof Error ? error.name : typeof error,
          projectRef: params.ref,
        });
        return status(503, {
          message: "Failed to read live database settings",
          code: "DATABASE_SETTINGS_READ_FAILED",
        });
      }
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get database config" },

    },
  )

  .patch(
    "/:ref/config/pooler",
    async ({ params, body }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const current =
        ((settings as Record<string, unknown>).pooler as Record<
          string,
          unknown
        >) || {};
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        pooler: { ...current, ...(typeof body === "object" ? body : {}) },
      });
      return (updated as Record<string, unknown>)?.pooler || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    
      detail: { tags: ["projects"], summary: "Update pooler config" },
},
  )

  .get(
    "/:ref/database/replication",
    async ({ params }) => {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(params.ref);
      const db = getProjectDb(dbName);
      const slots = await db`
        SELECT slot_name, slot_type, active, restart_lsn
        FROM pg_replication_slots
      `;
      const publications = await db`
        SELECT pubname, pubinsert, pubupdate, pubdelete, pubtruncate
        FROM pg_publication
      `;
      return { replication_slots: slots, publications };
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get database replication info" },

    },
  )

  .get(
    "/:ref/types/python",
    async ({ params, query }) => {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(params.ref);
      const db = getProjectDb(dbName);
      const schemas = (query?.schemas || "public").split(",");
      let py = "";
      for (const schema of schemas) {
        const tables = await db`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `;
        for (const t of tables) {
          const cols = await db`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = ${schema} AND table_name = ${t.table_name}
            ORDER BY ordinal_position
          `;
          py += `class ${t.table_name}(BaseModel):\n`;
          for (const c of cols) {
            const pyType =
              c.data_type === "integer" || c.data_type === "bigint"
                ? "int"
                : c.data_type === "numeric" ||
                    c.data_type === "real" ||
                    c.data_type === "double precision"
                  ? "float"
                  : c.data_type === "boolean"
                    ? "bool"
                    : "str";
            const nullable = c.is_nullable === "YES" ? " | None = None" : "";
            py += `    ${c.column_name}: ${pyType}${nullable}\n`;
          }
          py += "\n";
        }
      }
      return { types: py };
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object(
        { schemas: t.Optional(t.String()) },
        { additionalProperties: true },
      ),
    
      detail: { tags: ["projects"], summary: "Generate Python types" },
},
  )
  .patch(
    "/:ref/config/database",
    async ({ params, body }) => {
      let patch;
      try {
        patch = parseDatabaseConfigPatch(body);
      } catch (error: unknown) {
        if (error instanceof DatabaseConfigValidationError) {
          return status(400, { code: error.code, message: error.message });
        }
        throw error;
      }

      const projectSettings = await projectService.getProjectSettings(params.ref);
      if (!projectSettings)
        return status(404, { message: "Project not found", code: "404" });
      const current =
        ((projectSettings as Record<string, unknown>).database as Record<
          string,
          unknown
        >) || {};
      let databaseConnection;
      try {
        databaseConnection = await projectDatabaseConnection(params.ref);
      } catch (error: unknown) {
        logger.warn("[project-config] Failed to resolve project database", {
          errorType: error instanceof Error ? error.name : typeof error,
          projectRef: params.ref,
        });
        return status(503, {
          code: "DATABASE_SETTINGS_APPLY_FAILED",
          message: "Failed to resolve the project database; persisted configuration was not changed",
          rollback: { attempted: false, succeeded: null, failed_settings: [] },
        });
      }
      const { database, databaseName } = databaseConnection;
      const update = await updateDatabaseSettings({
        database,
        databaseName,
        patch,
        persist: async () => {
          const persisted = await projectService.updateProjectSettings(params.ref, {
            ...projectSettings,
            database: { ...current, ...patch },
          });
          if (!persisted) throw new Error("Project settings update returned no result");
          return persisted;
        },
      });

      if (!update.ok) {
        logger.warn(`[project-config] Database settings ${update.stage} failed`, {
          errorType: update.error instanceof Error
            ? update.error.name
            : typeof update.error,
          projectRef: params.ref,
          restoreFailedSettings: update.restoreFailures.map(
            (failure) => failure.name,
          ),
        });
        return status(
          update.stage === "apply" ? 503 : 500,
          databaseUpdateFailureBody(update),
        );
      }

      try {
        const liveSettings = await readLiveDatabaseSettings(database);
        const persistedDatabase =
          ((update.persisted as Record<string, unknown>).database as Record<
            string,
            unknown
          >) || { ...current, ...patch };
        return buildDatabaseConfigResponse(
          params.ref,
          databaseName,
          persistedDatabase,
          liveSettings,
        );
      } catch (error: unknown) {
        logger.warn("[project-config] Failed to read applied database settings", {
          errorType: error instanceof Error ? error.name : typeof error,
          projectRef: params.ref,
        });
        return status(503, {
          message: "Database settings were updated but the live read-back failed",
          code: "DATABASE_SETTINGS_READ_FAILED",
        });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    
      detail: { tags: ["projects"], summary: "Update database config" },
},
  )
  .use(addConfigRoutes("postgrest"))

  // Config Storage — with official default fields
  .get(
    "/:ref/config/storage",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const raw =
        ((settings as Record<string, unknown>).storage as Record<
          string,
          unknown
        >) || {};
      return buildStorageConfigResponse(raw);
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get storage config" },

    },
  )
  .patch(
    "/:ref/config/storage",
    async ({ params, body }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const current =
        ((settings as Record<string, unknown>).storage as Record<
          string,
          unknown
        >) || {};
      const merged = { ...current, ...(typeof body === "object" ? body : {}) };
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        storage: merged,
      });
      const raw =
        ((updated as Record<string, unknown>).storage as Record<
          string,
          unknown
        >) || {};
      return buildStorageConfigResponse(raw);
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    
      detail: { tags: ["projects"], summary: "Update storage config" },
},
  )

  // Config Realtime — with official default fields
  .get(
    "/:ref/config/realtime",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const raw =
        ((settings as Record<string, unknown>).realtime as Record<
          string,
          unknown
        >) || {};
      return buildRealtimeConfigResponse(raw);
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get realtime config" },

    },
  )
  .patch(
    "/:ref/config/realtime",
    async ({ params, body }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const current =
        ((settings as Record<string, unknown>).realtime as Record<
          string,
          unknown
        >) || {};
      const merged = { ...current, ...(typeof body === "object" ? body : {}) };
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        realtime: merged,
      });
      const raw =
        ((updated as Record<string, unknown>).realtime as Record<
          string,
          unknown
        >) || {};
      return {
        maxConnections: raw.maxConnections || raw.max_connections || 100,
        maxJoinsPerSecond:
          raw.maxJoinsPerSecond || raw.max_joins_per_second || 100,
        maxChannelsPerClient:
          raw.maxChannelsPerClient || raw.max_channels_per_client || 100,
        ...raw,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    
      detail: { tags: ["projects"], summary: "Update realtime config" },
},
  )

  // Get PgBouncer config (for Studio display)
  .get(
    "/:ref/pgbouncer",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      return (
        settings.pgbouncer || {
          pool_mode: "transaction",
          default_pool_size: 15,
          ignore_startup_parameters: "extra_float_digits",
        }
      );
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get PgBouncer config" },

    },
  )

  // Get Postgres DB config — required by CLI `supabase link` (V1GetPostgresConfig)
  .get(
    "/:ref/config/postgres",
    async ({ params }) => {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(params.ref);

      try {
        const db = getProjectDb(dbName);
        const settings = await db`
          SELECT name, setting, unit, short_desc
          FROM pg_settings
          WHERE name IN (
            'max_connections', 'shared_buffers', 'effective_cache_size',
            'maintenance_work_mem', 'work_mem', 'statement_timeout',
            'idle_in_transaction_session_timeout', 'wal_level',
            'max_wal_senders', 'max_replication_slots'
          )
        `;

        const settingsMap: Record<string, string> = {};
        for (const s of settings) {
          settingsMap[s.name as string] = s.setting as string;
        }

        return {
          max_connections: settingsMap.max_connections || "100",
          shared_buffers: settingsMap.shared_buffers || "128MB",
          effective_cache_size: settingsMap.effective_cache_size || "4GB",
          maintenance_work_mem: settingsMap.maintenance_work_mem || "64MB",
          work_mem: settingsMap.work_mem || "4MB",
          statement_timeout: settingsMap.statement_timeout || "0",
          idle_in_transaction_session_timeout:
            settingsMap.idle_in_transaction_session_timeout || "0",
          wal_level: settingsMap.wal_level || "replica",
        };
      } catch {
        return {
          max_connections: "100",
          shared_buffers: "128MB",
          effective_cache_size: "4GB",
        };
      }
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get Postgres config" },

    },
  )

  // Get Pooler config — required by CLI `supabase link` (GetPoolerConfig)
  .get(
    "/:ref/config/pooler",
    async ({ params }) => {
      const { config: appConfig } = await import("../config");

      const pgHost = appConfig.baseDomain || "localhost";
      const pgPort = appConfig.pgPort || 5432;
      const poolerHost = appConfig.poolerHost || pgHost;
      const poolerPort = appConfig.poolerPort || 6543;

      const dbUser = resolveRoleName(params.ref);
      const dbName = await resolveDbNameTopLevel(params.ref);
      return {
        pool_mode: "transaction",
        default_pool_size: 15,
        max_client_conn: 200,
        connection_string: `postgresql://${dbUser}:[YOUR-PASSWORD]@${poolerHost}:${poolerPort}/${dbName}?pgbouncer=true`,
        direct_connection_string: `postgresql://${dbUser}:[YOUR-PASSWORD]@${pgHost}:${pgPort}/${dbName}`,
      };
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get pooler config" },

    },
  )

  // Get Storage policies — required by Studio Storage > Policies page (P0-15)
  .get(
    "/:ref/storage/policies",
    async ({ params }) => {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(params.ref);

      try {
        const db = getProjectDb(dbName);
        const policies = await db`
          SELECT pol.polname as name, pol.polpermissive as permissive,
            CASE pol.polcmd
              WHEN 'r' THEN 'SELECT'
              WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE'
              WHEN 'd' THEN 'DELETE'
              ELSE 'ALL'
            END as command,
            pg_get_expr(pol.polqual, pol.polrelid) as definition,
            pg_get_expr(pol.polwithcheck, pol.polrelid) as check,
            cls.relname as table_name,
            nsp.nspname as schema_name,
            ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)) as roles
          FROM pg_policy pol
          JOIN pg_class cls ON pol.polrelid = cls.oid
          JOIN pg_namespace nsp ON cls.relnamespace = nsp.oid
          WHERE nsp.nspname = 'storage'
          ORDER BY cls.relname, pol.polname
        `;
        return policies;
      } catch (err) {
        logger.warn("[project-config] Failed to list storage policies", {
          error: err,
        });
        return [];
      }
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get storage policies" },

    },
  )

  // Get Types (Studio calls this path — delegates to /types/typescript)
  .get(
    "/:ref/types",
    async ({ params, query, set }) => {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(params.ref);
      const db = getProjectDb(dbName);
      const includedSchemas = query?.included_schemas || "public";

      try {
        const schemas = includedSchemas
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const tables = await db`
          SELECT table_schema, table_name
          FROM information_schema.tables
          WHERE table_schema = ANY(${schemas})
            AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name
        `;
        const columns = await db`
          SELECT table_schema, table_name, column_name, data_type, is_nullable, udt_name
          FROM information_schema.columns
          WHERE table_schema = ANY(${schemas})
          ORDER BY table_schema, table_name, ordinal_position
        `;

        let ts = `export type Json =\n  | string\n  | number\n  | boolean\n  | null\n  | { [key: string]: Json | undefined }\n  | Json[]\n\nexport type Database = {\n`;

        const schemaGroups = new Map<string, typeof tables>();
        for (const t of tables) {
          const schema = t.table_schema as string;
          if (!schemaGroups.has(schema)) schemaGroups.set(schema, []);
          schemaGroups.get(schema)!.push(t);
        }

        for (const [schema, schemaTables] of schemaGroups) {
          ts += `  ${schema}: {\n    Tables: {\n`;
          for (const table of schemaTables) {
            const tableName = table.table_name as string;
            const tableCols = columns.filter(
              (c: Record<string, unknown>) =>
                c.table_name === tableName && c.table_schema === schema,
            );
            ts += `      ${tableName}: {\n        Row: {\n`;
            for (const col of tableCols) {
              const nullable =
                (col as Record<string, unknown>).is_nullable === "YES";
              ts += `          ${(col as Record<string, unknown>).column_name}: ${pgTypeToTs((col as Record<string, unknown>).udt_name as string, (col as Record<string, unknown>).data_type as string)}${nullable ? " | null" : ""}\n`;
            }
            ts += `        }\n        Insert: {\n`;
            for (const col of tableCols) {
              const nullable =
                (col as Record<string, unknown>).is_nullable === "YES";
              ts += `          ${(col as Record<string, unknown>).column_name}?: ${pgTypeToTs((col as Record<string, unknown>).udt_name as string, (col as Record<string, unknown>).data_type as string)}${nullable ? " | null" : ""}\n`;
            }
            ts += `        }\n        Update: {\n`;
            for (const col of tableCols) {
              ts += `          ${(col as Record<string, unknown>).column_name}?: ${pgTypeToTs((col as Record<string, unknown>).udt_name as string, (col as Record<string, unknown>).data_type as string)} | null\n`;
            }
            ts += `        }\n      }\n`;
          }
          ts += `    }\n    Views: {\n      [_ in never]: never\n    }\n    Functions: {\n      [_ in never]: never\n    }\n    Enums: {\n      [_ in never]: never\n    }\n    CompositeTypes: {\n      [_ in never]: never\n    }\n  }\n`;
        }
        ts += `}\n`;
        return { types: ts };
      } catch (err: unknown) {
        return {
          types:
            "export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];",
        };
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Optional(t.Object({ included_schemas: t.Optional(t.String()) })),
    
      detail: { tags: ["projects"], summary: "Get generated types" },
},
  )

  // Get Typescript Types — Real schema reflection (P0-5)
  .get(
    "/:ref/types/typescript",
    async ({ params, query }) => {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(params.ref);

      try {
        const db = getProjectDb(dbName);
        const includedSchemas = (query?.included_schemas || "public")
          .split(",")
          .map((s: string) => s.trim());

        // 1. Fetch all enums
        const enums = await db`
          SELECT n.nspname as schema, t.typname as name,
            array_agg(e.enumlabel ORDER BY e.enumsortorder) as values
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          JOIN pg_namespace n ON t.typnamespace = n.oid
          WHERE n.nspname = ANY(${includedSchemas})
          GROUP BY n.nspname, t.typname
          ORDER BY n.nspname, t.typname
        `;

        // 2. Fetch all tables + columns
        const columns = await db`
          SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
            c.is_nullable, c.column_default, c.is_identity, c.identity_generation,
            c.is_generated, c.generation_expression,
            (SELECT tc.constraint_type FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
             WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name
               AND kcu.column_name = c.column_name AND tc.constraint_type = 'PRIMARY KEY'
             LIMIT 1) as is_primary_key
          FROM information_schema.columns c
          WHERE c.table_schema = ANY(${includedSchemas})
          ORDER BY c.table_schema, c.table_name, c.ordinal_position
        `;

        // 3. Fetch views
        const views = await db`
          SELECT table_schema, table_name
          FROM information_schema.views
          WHERE table_schema = ANY(${includedSchemas})
        `;
        const viewSet = new Set(
          views.map(
            (v: Record<string, unknown>) => `${v.table_schema}.${v.table_name}`,
          ),
        );

        // 4. Fetch functions
        const functions = await db`
          SELECT n.nspname as schema, p.proname as name,
            pg_get_function_arguments(p.oid) as args,
            pg_get_function_result(p.oid) as return_type
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE n.nspname = ANY(${includedSchemas})
            AND p.prokind IN ('f', 'p')
            AND NOT p.proisagg
          ORDER BY n.nspname, p.proname
        `;

        // 5. Fetch foreign key relationships
        const fkeys = await db`
          SELECT
            ns.nspname AS source_schema,
            cls.relname AS source_table,
            attr.attname AS source_column,
            ns2.nspname AS target_schema,
            cls2.relname AS target_table,
            attr2.attname AS target_column
          FROM pg_constraint con
          JOIN pg_class cls ON con.conrelid = cls.oid
          JOIN pg_namespace ns ON cls.relnamespace = ns.oid
          JOIN pg_class cls2 ON con.confrelid = cls2.oid
          JOIN pg_namespace ns2 ON cls2.relnamespace = ns2.oid
          JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = ANY(con.conkey)
          JOIN pg_attribute attr2 ON attr2.attrelid = con.confrelid AND attr2.attnum = ANY(con.confkey)
          WHERE con.contype = 'f'
            AND ns.nspname = ANY(${includedSchemas})
          ORDER BY ns.nspname, cls.relname, attr.attname
        `;

        const relMap = new Map<
          string,
          Array<{
            source_column: string;
            target_schema: string;
            target_table: string;
            target_column: string;
          }>
        >();
        for (const fk of fkeys) {
          const key = `${fk.source_schema}.${fk.source_table}`;
          if (!relMap.has(key)) relMap.set(key, []);
          relMap.get(key)!.push({
            source_column: fk.source_column,
            target_schema: fk.target_schema,
            target_table: fk.target_table,
            target_column: fk.target_column,
          });
        }

        // Generate TypeScript
        let ts = `export type Json =\n  | string\n  | number\n  | boolean\n  | null\n  | { [key: string]: Json | undefined }\n  | Json[]\n\nexport type Database = {\n`;

        for (const schema of includedSchemas) {
          ts += `  ${schema}: {\n    Tables: {\n`;

          // Group columns by table
          const tableMap = new Map<string, Array<Record<string, unknown>>>();
          for (const col of columns) {
            if (col.table_schema !== schema) continue;
            const key = col.table_name as string;
            if (viewSet.has(`${schema}.${key}`)) continue; // skip views
            if (!tableMap.has(key)) tableMap.set(key, []);
            tableMap.get(key)!.push(col);
          }

          for (const [tableName, cols] of tableMap) {
            ts += `      ${tableName}: {\n        Row: {\n`;
            for (const col of cols) {
              const tsType = pgTypeToTs(
                col.udt_name as string,
                col.data_type as string,
              );
              const nullable = col.is_nullable === "YES" ? " | null" : "";
              ts += `          ${col.column_name}: ${tsType}${nullable}\n`;
            }
            ts += `        }\n        Insert: {\n`;
            for (const col of cols) {
              const tsType = pgTypeToTs(
                col.udt_name as string,
                col.data_type as string,
              );
              const nullable = col.is_nullable === "YES" ? " | null" : "";
              const optional =
                col.column_default ||
                col.is_identity === "YES" ||
                col.is_nullable === "YES"
                  ? "?"
                  : "";
              ts += `          ${col.column_name}${optional}: ${tsType}${nullable}\n`;
            }
            ts += `        }\n        Update: {\n`;
            for (const col of cols) {
              const tsType = pgTypeToTs(
                col.udt_name as string,
                col.data_type as string,
              );
              const nullable = col.is_nullable === "YES" ? " | null" : "";
              ts += `          ${col.column_name}?: ${tsType}${nullable}\n`;
            }
            ts += `        }\n        Relationships: [\n`;
            const rels = relMap.get(`${schema}.${tableName}`) || [];
            for (const rel of rels) {
              ts += `          { source_column: "${rel.source_column}"; target_schema: "${rel.target_schema}"; target_table: "${rel.target_table}"; target_column: "${rel.target_column}" },\n`;
            }
            ts += `        ]\n      }\n`;
          }

          ts += `    }\n    Views: {\n`;

          // Views
          for (const view of views.filter(
            (v: Record<string, unknown>) => v.table_schema === schema,
          )) {
            const viewCols = columns.filter(
              (c: Record<string, unknown>) =>
                c.table_schema === schema && c.table_name === view.table_name,
            );
            ts += `      ${view.table_name}: {\n        Row: {\n`;
            for (const col of viewCols) {
              const tsType = pgTypeToTs(
                col.udt_name as string,
                col.data_type as string,
              );
              ts += `          ${col.column_name}: ${tsType} | null\n`;
            }
            ts += `        }\n        Insert: {\n`;
            for (const col of viewCols) {
              const tsType = pgTypeToTs(
                col.udt_name as string,
                col.data_type as string,
              );
              ts += `          ${col.column_name}?: ${tsType} | null\n`;
            }
            ts += `        }\n        Update: {\n`;
            for (const col of viewCols) {
              const tsType = pgTypeToTs(
                col.udt_name as string,
                col.data_type as string,
              );
              ts += `          ${col.column_name}?: ${tsType} | null\n`;
            }
            ts += `        }\n        Relationships: []\n      }\n`;
          }

          ts += `    }\n    Functions: {\n`;

          // Functions
          for (const fn of functions.filter(
            (f: Record<string, unknown>) => f.schema === schema,
          )) {
            ts += `      ${fn.name}: {\n        Args: Record<string, unknown>\n        Returns: unknown\n      }\n`;
          }

          ts += `    }\n    Enums: {\n`;

          for (const en of enums.filter(
            (e: Record<string, unknown>) => e.schema === schema,
          )) {
            const vals = (en.values as string[])
              .map((v) => `"${v}"`)
              .join(" | ");
            ts += `      ${en.name}: ${vals}\n`;
          }

          ts += `    }\n    CompositeTypes: {\n      [_ in never]: never\n    }\n  }\n`;
        }

        ts += `}\n`;

        return { types: ts };
      } catch (err: unknown) {
        logger.error("[project-config] TypeScript type generation failed", {
          error: err,
        });
        // Fallback to minimal stub
        return {
          types:
            "export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];",
        };
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Optional(t.Object({ included_schemas: t.Optional(t.String()) })),
    
      detail: { tags: ["projects"], summary: "Generate TypeScript types" },
},
  )

  .get(
    "/:ref/gateway/routes",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      try {
        return { routes: readCustomGatewayRoutes(settings) };
      } catch (error: unknown) {
        return status(500, { message: error instanceof Error ? error.message : String(error), code: "500" });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "List controlled custom gateway routes" },
    },
  )

  .post(
    "/:ref/gateway/routes",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      try {
        const route = customGatewayRouteBody(body);
        const current = readCustomGatewayRoutes(settings).filter((item) => item.id !== route.id);
        const result = await applyCustomGatewayRoutes(params.ref, settings, [...current, route]);
        if (!result.ok) return status(result.status, result.body);
        return { success: true, route };
      } catch (error: unknown) {
        return status(400, { message: error instanceof Error ? error.message : String(error), code: "400" });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        id: t.String(),
        hosts: CustomGatewayHostsSchema,
        path: CustomGatewayPathSchema,
        upstream: t.Optional(t.String()),
        managed_upstream: t.Optional(t.Literal("edge-functions")),
        upstream_tls_insecure_skip_verify: t.Optional(t.Boolean()),
        static_root: t.Optional(t.String()),
        protocol: t.Optional(t.Union([t.Literal("http"), t.Literal("https")])),
        redirect_to: t.Optional(t.String()),
        redirect_status: t.Optional(t.Union([t.Literal(301), t.Literal(302), t.Literal(307), t.Literal(308)])),
        rewrite_uri: t.Optional(t.String()),
        strip_prefix: t.Optional(t.String()),
        headers: t.Optional(t.Record(t.String(), t.String())),
        cors: t.Optional(t.Array(t.String())),
        priority: t.Optional(t.Number()),
        enabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["projects"], summary: "Create or replace a controlled custom gateway route" },
    },
  )

  .put(
    "/:ref/gateway/routes/:routeId",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      try {
        const route = customGatewayRouteBody(body, params.routeId);
        const current = readCustomGatewayRoutes(settings).filter((item) => item.id !== route.id);
        const result = await applyCustomGatewayRoutes(params.ref, settings, [...current, route]);
        if (!result.ok) return status(result.status, result.body);
        return { success: true, route };
      } catch (error: unknown) {
        return status(400, { message: error instanceof Error ? error.message : String(error), code: "400" });
      }
    },
    {
      params: t.Object({ ref: t.String(), routeId: t.String() }),
      body: t.Object({
        hosts: CustomGatewayHostsSchema,
        path: CustomGatewayPathSchema,
        upstream: t.Optional(t.String()),
        managed_upstream: t.Optional(t.Literal("edge-functions")),
        upstream_tls_insecure_skip_verify: t.Optional(t.Boolean()),
        static_root: t.Optional(t.String()),
        protocol: t.Optional(t.Union([t.Literal("http"), t.Literal("https")])),
        redirect_to: t.Optional(t.String()),
        redirect_status: t.Optional(t.Union([t.Literal(301), t.Literal(302), t.Literal(307), t.Literal(308)])),
        rewrite_uri: t.Optional(t.String()),
        strip_prefix: t.Optional(t.String()),
        headers: t.Optional(t.Record(t.String(), t.String())),
        cors: t.Optional(t.Array(t.String())),
        priority: t.Optional(t.Number()),
        enabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["projects"], summary: "Replace a controlled custom gateway route" },
    },
  )

  .delete(
    "/:ref/gateway/routes/:routeId",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      try {
        const current = readCustomGatewayRoutes(settings);
        const next = current.filter((route) => route.id !== params.routeId);
        const result = await applyCustomGatewayRoutes(params.ref, settings, next);
        if (!result.ok) return status(result.status, result.body);
        return { success: true, deleted: current.length !== next.length };
      } catch (error: unknown) {
        return status(400, { message: error instanceof Error ? error.message : String(error), code: "400" });
      }
    },
    {
      params: t.Object({ ref: t.String(), routeId: t.String() }),
      detail: { tags: ["projects"], summary: "Delete a controlled custom gateway route" },
    },
  )

  // Update gateway config (rate limiting, CORS, JWT)
  .post(
    "/:ref/gateway/config",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const result = await gatewayService.applyConfig(params.ref, {
        rateLimitTier: body.rate_limit_tier as
          | "free"
          | "pro"
          | "enterprise"
          | undefined,
        corsOrigins: body.cors_origins,
        jwtEnabled: body.jwt_enabled,
        jwtSecret: body.jwt_secret,
      });
      if (!result.success) {
        return status(500, { message: result.message, code: "500" });
      }
      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        rate_limit_tier: t.Optional(
          t.Union([
            t.Literal("free"),
            t.Literal("pro"),
            t.Literal("enterprise"),
          ]),
        ),
        cors_origins: t.Optional(t.String()),
        jwt_enabled: t.Optional(t.Boolean()),
        jwt_secret: t.Optional(t.String()),
      }),
    
      detail: { tags: ["projects"], summary: "Update gateway config" },
},
  )

  // Get gateway certificate automation settings
  .get(
    "/:ref/gateway/certificate",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const settings = await certificateService.getSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return settings;
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get project gateway certificate settings" },
    },
  )

  // Save certificate automation settings
  .put(
    "/:ref/gateway/certificate",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const settings = await certificateService.updateSettings(params.ref, body);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return settings;
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        mode: t.Optional(t.Union([t.Literal("lego"), t.Literal("manual")])),
        challenge: t.Optional(t.Union([t.Literal("dns-01"), t.Literal("http-01")])),
        email: t.Optional(t.String()),
        dns_provider: t.Optional(t.String()),
        dns_env: t.Optional(t.Array(t.String())),
        domains: t.Optional(t.Array(t.String())),
        auto_renew: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["projects"], summary: "Save project gateway certificate settings" },
    },
  )

  // Issue or renew a certificate with lego, then deploy it into gateway certificates.
  .post(
    "/:ref/gateway/certificate/issue",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const result = await certificateService.issueWithLego(params.ref, body);
      if (!result.success) {
        return status(500, { message: result.error || "Certificate issuance failed", output: result.output, code: "500" });
      }
      return result;
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        challenge: t.Optional(t.Union([t.Literal("dns-01"), t.Literal("http-01")])),
        email: t.Optional(t.String()),
        dns_provider: t.Optional(t.String()),
        dns_env: t.Optional(t.Array(t.String())),
        domains: t.Optional(t.Array(t.String())),
        auto_renew: t.Optional(t.Boolean()),
        renew: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["projects"], summary: "Issue or renew a gateway certificate with lego" },
    },
  )

  // Upload an existing certificate/key pair and bind it to gateway hostnames.
  .post(
    "/:ref/gateway/certificate/deploy",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const result = await certificateService.deployCertificate(params.ref, {
        cert: body.cert,
        key: body.key,
        domains: body.domains,
      });
      if (!result.success) {
        return status(500, { message: result.error || "Certificate deployment failed", code: "500" });
      }
      return result;
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        cert: t.String(),
        key: t.String(),
        domains: t.Optional(t.Array(t.String())),
      }),
      detail: { tags: ["projects"], summary: "Deploy an existing certificate into gateway" },
    },
  )

  // Rebuild ALL tenant gateway configs (propagate CORS / template changes)
  .post(
    "/:ref/gateway/rebuild-all",
    async ({ request, query }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const { frontendService } = await import("../services/frontend.service");
      const clean = query.clean === "true" || query.clean === "1";
      const { result, frontend } = clean
        ? await gatewayService.withDeferredPersist(async () => {
            await gatewayService.prepareCleanRebuild();
            await gatewayService.setupMasterRoutes();
            const result = await gatewayService.rebuildAllTenantConfigs();
            const frontend = await frontendService.reconcileGatewayRoutes();
            const hostedAuth = await gatewayService.setupHostedAuthRoutes();
            return { result, frontend, hostedAuth };
          }, ({ result, frontend, hostedAuth }) => result.success && frontend.errors.length === 0 && hostedAuth.success)
        : {
            result: await gatewayService.rebuildAllTenantConfigs(),
            frontend: await frontendService.reconcileGatewayRoutes(),
          };
      if (!result.success) {
        return { ...result, frontend, clean, message: "Rebuild failed" };
      }
      return { ...result, frontend, clean };
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object({ clean: t.Optional(t.String()) }),
      detail: {
        tags: ["projects"],
        summary: "Rebuild all tenant gateway configs",
      },
    },
  )

  // --- Programmable Rate Limiting (gateway provider) ---

  // Get current rate limit config for a project
  .get(
    "/:ref/gateway/rate-limit",
    async ({ params }) => {
      const rateLimit = await gatewayService.getRateLimit(params.ref);
      if (rateLimit === null) {
        return status(500, {
          message: "Failed to query rate limit from gateway",
          code: "500",
        });
      }
      return rateLimit;
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get project rate limit config" },
    },
  )

  // Set rate limit — supports tier presets OR custom values
  .put(
    "/:ref/gateway/rate-limit",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      let success: boolean;
      if (body.tier) {
        success = await gatewayService.setRateLimit(params.ref, body.tier);
      } else {
        success = await gatewayService.setRateLimit(params.ref, {
          second: body.second,
          minute: body.minute,
          hour: body.hour,
        });
      }
      if (!success) {
        return status(500, {
          message: "Failed to update rate limit",
          code: "500",
        });
      }
      return { success: true, message: "Rate limit updated" };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        tier: t.Optional(
          t.Union([
            t.Literal("free"),
            t.Literal("pro"),
            t.Literal("enterprise"),
          ]),
        ),
        second: t.Optional(t.Number()),
        minute: t.Optional(t.Number()),
        hour: t.Optional(t.Number()),
      }),
      detail: { tags: ["projects"], summary: "Set project rate limit" },
    },
  )

  // --- Tenant Custom Path Rate Limiting ---

  // Set custom rate limit for a specific path
  .put(
    "/:ref/gateway/custom-rate-limits",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      // 1. Fetch current settings to persist and check limits
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });

      const currentLimits =
        (settings.rate_limits as Record<string, unknown>) || {};
      const customPaths = Object.keys(currentLimits);

      // Enforce max 20 custom rate-limit routes per project
      if (customPaths.length >= 20 && !customPaths.includes(body.path)) {
        return status(400, {
          message: "Maximum of 20 custom rate limit routes allowed per project",
          code: "400",
        });
      }

      // 2. Apply to gateway
      const success = await gatewayService.setCustomRouteRateLimit(
        params.ref,
        body.path,
        {
          second: body.second,
          minute: body.minute,
          hour: body.hour,
        },
      );

      if (!success) {
        return status(500, {
          message: "Failed to update custom route rate limit in gateway",
          code: "500",
        });
      }

      // 3. Persist in database
      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        rate_limits: {
          ...currentLimits,
          [body.path]: {
            second: body.second,
            minute: body.minute,
            hour: body.hour,
          },
        },
      });

      return {
        success: true,
        message: `Custom rate limit set for ${body.path}`,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        path: t.String({
          description: "Base path to rate limit. e.g. /rest/v1/payments",
        }),
        second: t.Optional(t.Number()),
        minute: t.Optional(t.Number()),
        hour: t.Optional(t.Number()),
      }),
      detail: {
        tags: ["projects"],
        summary: "Set a custom rate limit for a specific path",
      },
    },
  )

  // Remove custom rate limit for a specific path
  .delete(
    "/:ref/gateway/custom-rate-limits",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      // 1. Fetch current settings
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });

      // 2. Remove from gateway
      const success = await gatewayService.removeCustomRouteRateLimit(
        params.ref,
        body.path,
      );
      if (!success) {
        return status(500, {
          message: "Failed to remove custom route rate limit from gateway",
          code: "500",
        });
      }

      // 3. Persist removal in DB
      const currentLimits =
        (settings.rate_limits as Record<string, unknown>) || {};
      if (currentLimits[body.path]) {
        delete currentLimits[body.path];
        await projectService.updateProjectSettings(params.ref, {
          ...settings,
          rate_limits: currentLimits,
        });
      }

      return {
        success: true,
        message: `Custom rate limit removed for ${body.path}`,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        path: t.String({
          description: "Base path to rate limit. e.g. /rest/v1/payments",
        }),
      }),
      detail: {
        tags: ["projects"],
        summary: "Remove a custom rate limit for a specific path",
      },
    },
  );
