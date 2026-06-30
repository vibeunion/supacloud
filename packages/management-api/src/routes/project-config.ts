/**
 * Project Configuration Routes
 * Handles: settings, API keys, auth config, config CRUD factory, pgbouncer, types
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import {
  type CustomGatewayRouteConfig,
  gatewayService,
  normalizeCustomGatewayRoute,
  normalizeCustomGatewayRoutes,
} from "../services/gateway.service";
import { certificateService } from "../services/certificate.service";
import { logger } from "../utils/logger";
import {
  OPENAPI_AUTH_CONFIG_RESPONSE_TEMPLATE,
  OPENAPI_CUSTOM_HOSTNAME_RESPONSE_TEMPLATE,
  OPENAPI_NETWORK_RESTRICTIONS_RESPONSE_TEMPLATE,
  OPENAPI_REALTIME_CONFIG_RESPONSE_TEMPLATE,
  OPENAPI_STORAGE_CONFIG_RESPONSE_TEMPLATE,
} from "../utils/openapi-defaults.gen";
import { resolveRoleName, resolveDbName as resolveDbNameTopLevel } from "../db";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";

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
        request,
      }: {
        params: { ref: string };
        body: Record<string, unknown>;
        request: Request;
      }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
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

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function pickFirstArray(...candidates: unknown[]): string[] {
  for (const candidate of candidates) {
    const values = toStringArray(candidate);
    if (values.length > 0) return values;
  }
  return [];
}

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

  const result = await gatewayService.configureCustomGatewayRoutes(projectRef, routes);
  if (!result.success) {
    return { ok: false, status: 500, body: { message: result.error || "Failed to update custom gateway routes", code: "500" } };
  }

  const updated = await projectService.updateProjectSettings(projectRef, {
    ...settings,
    gateway_routes: routes,
  });
  return { ok: true, settings: updated };
}

function buildNetworkRestrictionsResponse(value: unknown) {
  const response = cloneTemplate(
    OPENAPI_NETWORK_RESTRICTIONS_RESPONSE_TEMPLATE,
  ) as Record<string, any>;
  const raw = (value as Record<string, unknown>) || {};
  const config = (raw.config as Record<string, unknown>) || raw;
  const dbAllowedCidrs = pickFirstArray(
    raw.allowed_address_ranges,
    config.dbAllowedCidrs,
    raw.dbAllowedCidrs,
  );
  const dbAllowedCidrsV6 = pickFirstArray(
    config.dbAllowedCidrsV6,
    raw.dbAllowedCidrsV6,
  );

  response.config = {
    ...(response.config as Record<string, unknown>),
    dbAllowedCidrs,
    dbAllowedCidrsV6,
  };
  response.status = "applied";
  response.entitlement = dbAllowedCidrs.length > 0 ? "allowed" : "disallowed";
  return response;
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
      enabled: false,
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
    storage_vectors: false,
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

function buildAuthConfigResponse(settings: Record<string, unknown>) {
  const authConfig = (settings.auth as Record<string, unknown>) || {};
  const externalConfig =
    (authConfig.external as Record<string, unknown>) || {};
  const hooksConfig = (authConfig.hooks as Record<string, unknown>) || {};
  const smtpConfig = (authConfig.smtp as Record<string, unknown>) || {};

  const response: Record<string, unknown> = {
    ...cloneTemplate(OPENAPI_AUTH_CONFIG_RESPONSE_TEMPLATE),
    ...authConfig,
    enable_signup: authConfig.enable_signup ?? true,
    enable_signups: authConfig.enable_signup ?? true,
    enable_confirmations: authConfig.enable_confirmations ?? false,
    double_confirm_changes: authConfig.double_confirm_changes ?? true,
    manual_linking_enabled:
      authConfig.manual_linking_enabled ??
      authConfig.enable_manual_linking ??
      false,
    jwt_expiry: authConfig.jwt_expiry ?? authConfig.jwt_exp ?? 3600,
    disable_signup: authConfig.disable_signup ?? false,
    mailer_autoconfirm: authConfig.mailer_autoconfirm ?? false,
    mail_autoconfirm: authConfig.mailer_autoconfirm ?? false,
    sms_autoconfirm: authConfig.sms_autoconfirm ?? false,
    phone_autoconfirm: authConfig.sms_autoconfirm ?? false,
    uri_allow_list: authConfig.uri_allow_list ?? null,
    site_url: authConfig.site_url ?? null,
    password_min_length: authConfig.password_min_length ?? null,
    refresh_token_rotation_enabled:
      authConfig.refresh_token_rotation_enabled ??
      authConfig.security_refresh_token_rotation_enabled ??
      null,
    security_refresh_token_reuse_interval:
      authConfig.security_refresh_token_reuse_interval ??
      authConfig.security_refresh_token_rotation_reuse_interval ??
      null,
    mfa_max_enrolled_factors:
      authConfig.mfa_max_enrolled_factors ??
      authConfig.max_enrolled_factors ??
      null,
    security_update_password_require_reauthentication:
      authConfig.security_update_password_require_reauthentication ?? null,
    external_anonymous_users_enabled:
      authConfig.external_anonymous_users_enabled ?? null,
    external_email_enabled: authConfig.external_email_enabled ?? null,
    external_phone_enabled: authConfig.external_phone_enabled ?? null,
    saml_enabled: authConfig.saml_enabled ?? null,
    saml_external_url: authConfig.saml_external_url ?? null,
    saml_private_key_next_configured:
      Boolean((authConfig.saml as Record<string, unknown> | undefined)?.private_key_next) ||
      Boolean(authConfig.saml_private_key_next),
    passkey_enabled:
      (authConfig.passkey as Record<string, unknown> | undefined)?.enabled ??
      authConfig.passkey_enabled ??
      false,
    security_captcha_enabled: authConfig.security_captcha_enabled ?? null,
    security_captcha_provider: authConfig.security_captcha_provider ?? "hcaptcha",
    security_captcha_secret: authConfig.security_captcha_secret
      ? "********"
      : null,
    rate_limit_anonymous_users: authConfig.rate_limit_anonymous_users ?? null,
    rate_limit_email_sent: authConfig.rate_limit_email_sent ?? null,
    rate_limit_sms_sent: authConfig.rate_limit_sms_sent ?? null,
    rate_limit_verify: authConfig.rate_limit_verify ?? null,
    rate_limit_token_refresh: authConfig.rate_limit_token_refresh ?? null,
    rate_limit_otp: authConfig.rate_limit_otp ?? null,
    sms_provider: authConfig.sms_provider ?? "twilio",
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
    if ("client_secret" in provider) {
      response[`external_${key}_secret`] = provider.client_secret
        ? "********"
        : null;
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
    if ("secrets" in hook) {
      response[`hook_${suffix}_secrets`] = hook.secrets ?? null;
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

export const projectConfigRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get project settings
  .get(
    "/:ref/settings",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (settings === null) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return settings;
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
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.updateProjectSettings(
        params.ref,
        body,
      );
      if (settings === null) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return settings;
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
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const keys = await projectService.getApiKeys(params.ref);
      if (!keys) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return [
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
    
      detail: { tags: ["projects"], summary: "Rotate API keys" },
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

  // Get backup list
  .get(
    "/:ref/database/backups",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const backups = await projectService.listBackups(params.ref);
      return backups;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    
      detail: { tags: ["projects"], summary: "List database backups" },
},
  )

  // Restore backup
  .post(
    "/:ref/database/backups/restore",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const success = await projectService.restoreBackup(
        params.ref,
        body.backup_id,
      );
      if (!success) {
        return status(500, {
          message: "Failed to restore backup",
          code: "500",
        });
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        backup_id: t.String(),
      }),
    
      detail: { tags: ["projects"], summary: "Restore a database backup" },
},
  )

  // Get network restrictions
  .get(
    "/:ref/network-restrictions",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found" });
      }
      const nr =
        ((settings as Record<string, unknown>).network_restrictions as Record<
          string,
          unknown
        >) || {};
      return buildNetworkRestrictionsResponse(nr);
    },
    {
      params: t.Object({ ref: t.String() }),
    
      detail: { tags: ["projects"], summary: "Get network restrictions" },
},
  )

  // Update network restrictions
  .post(
    "/:ref/network-restrictions",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const success = await projectService.updateNetworkRestrictions(
        params.ref,
        body.allowed_address_ranges,
      );
      if (!success) {
        return status(500, {
          message: "Failed to update network restrictions",
          code: "500",
        });
      }
      return {
        config: { dbAllowedCidrs: body.allowed_address_ranges },
        status: "applied",
        entitlement: "allowed",
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        allowed_address_ranges: t.Array(t.String()),
      }),
    
      detail: { tags: ["projects"], summary: "Update network restrictions" },
},
  )
  .patch(
    "/:ref/network-restrictions",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const success = await projectService.updateNetworkRestrictions(
        params.ref,
        body.allowed_address_ranges,
      );
      if (!success) {
        return status(500, {
          message: "Failed to update network restrictions",
          code: "500",
        });
      }
      return {
        config: { dbAllowedCidrs: body.allowed_address_ranges },
        status: "applied",
        entitlement: "allowed",
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ allowed_address_ranges: t.Array(t.String()) }),
    
      detail: { tags: ["projects"], summary: "Patch network restrictions" },
},
  )
  .delete(
    "/:ref/network-restrictions",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      const success = await projectService.updateNetworkRestrictions(
        params.ref,
        [],
      );
      if (!success) {
        return status(500, {
          message: "Failed to remove network restrictions",
          code: "500",
        });
      }
      return {
        config: { dbAllowedCidrs: [] },
        status: "applied",
        entitlement: "allowed",
      };
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Remove network restrictions" },

    },
  )

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
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      return buildAuthConfigResponse(settings);
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
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const newAuth = typeof body === "object" ? body : {};

      // Parse external_* keys back into nested external config
      const externalUpdates: Record<string, unknown> = {};
      const otherUpdates: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(newAuth)) {
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
              client_secret: "",
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
          if (val && val !== "********") {
            const existing =
              ((currentAuth.external as Record<string, unknown>)?.[
                provider
              ] as Record<string, unknown>) || {};
            externalUpdates[provider] = { ...existing, client_secret: val };
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
            ...(providerVal.secret && providerVal.secret !== "********"
              ? { client_secret: providerVal.secret }
              : {}),
          };
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
        } else if (key.startsWith("passkey_")) {
          const passkeyKeyMap: Record<string, string> = {
            passkey_enabled: "enabled",
            passkey_max_passkeys_per_user: "max_passkeys_per_user",
          };
          const passkeyField = passkeyKeyMap[key];
          if (passkeyField) {
            const currentPasskey =
              (currentAuth.passkey as Record<string, unknown>) || {};
            otherUpdates.passkey = {
              ...((otherUpdates.passkey as Record<string, unknown>) || currentPasskey),
              [passkeyField]: val,
            };
          }
        } else if (key.startsWith("webauthn_")) {
          const webAuthnKeyMap: Record<string, string> = {
            webauthn_rp_id: "rp_id",
            webauthn_rp_display_name: "rp_display_name",
            webauthn_rp_origins: "rp_origins",
            webauthn_challenge_expiry_duration: "challenge_expiry_duration",
          };
          const webAuthnField = webAuthnKeyMap[key];
          if (webAuthnField) {
            const currentWebAuthn =
              (currentAuth.webauthn as Record<string, unknown>) || {};
            otherUpdates.webauthn = {
              ...((otherUpdates.webauthn as Record<string, unknown>) || currentWebAuthn),
              [webAuthnField]: val,
            };
          }
        } else if (key.startsWith("mfa_webauthn_")) {
          const mfaWebAuthnKeyMap: Record<string, string> = {
            mfa_webauthn_enroll_enabled: "enroll_enabled",
            mfa_webauthn_verify_enabled: "verify_enabled",
          };
          const mfaWebAuthnField = mfaWebAuthnKeyMap[key];
          if (mfaWebAuthnField) {
            const currentMfa = (currentAuth.mfa as Record<string, unknown>) || {};
            const currentWebAuthn = (currentMfa.webauthn as Record<string, unknown>) || {};
            const nextMfa = ((otherUpdates.mfa as Record<string, unknown>) || currentMfa);
            otherUpdates.mfa = {
              ...nextMfa,
              webauthn: {
                ...currentWebAuthn,
                ...((nextMfa.webauthn as Record<string, unknown>) || {}),
                [mfaWebAuthnField]: val,
              },
            };
          }
        } else if (key !== "external_providers") {
          otherUpdates[key] = val;
        }
      }

      const mergedExternal = {
        ...((currentAuth.external as Record<string, unknown>) || {}),
        ...externalUpdates,
      };

      const mergedAuth = {
        ...currentAuth,
        ...otherUpdates,
        ...(Object.keys(externalUpdates).length > 0
          ? { external: mergedExternal }
          : {}),
        ...(otherUpdates.hooks
          ? {
              hooks: {
                ...((currentAuth.hooks as Record<string, any>) || {}),
                ...(otherUpdates.hooks as Record<string, any>),
              },
            }
          : {}),
        ...(otherUpdates.smtp
          ? {
              smtp: {
                ...((currentAuth.smtp as Record<string, unknown>) || {}),
                ...(otherUpdates.smtp as Record<string, unknown>),
              },
            }
          : {}),
        ...(otherUpdates.saml
          ? {
              saml: {
                ...((currentAuth.saml as Record<string, unknown>) || {}),
                ...(otherUpdates.saml as Record<string, unknown>),
              },
            }
          : {}),
      };

      delete mergedAuth.hooks;
      delete mergedAuth.smtp;
      if (otherUpdates.hooks)
        mergedAuth.hooks = {
          ...((currentAuth.hooks as Record<string, any>) || {}),
          ...(otherUpdates.hooks as Record<string, any>),
        };
      if (otherUpdates.smtp)
        mergedAuth.smtp = {
          ...((currentAuth.smtp as Record<string, unknown>) || {}),
          ...(otherUpdates.smtp as Record<string, unknown>),
        };
      if (otherUpdates.saml)
        mergedAuth.saml = {
          ...((currentAuth.saml as Record<string, unknown>) || {}),
          ...(otherUpdates.saml as Record<string, unknown>),
        };

      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: mergedAuth,
      });

      // Propagate config to running services
      try {
        const { tenantRuntimeService } =
          await import("../services/tenant-runtime.service");
        await tenantRuntimeService.restartRuntime(params.ref);
      } catch (err) {
        logger.warn(
          "[project-config] Failed to propagate auth config to runtime",
          { error: err },
        );
      }

      const freshSettings = await projectService.getProjectSettings(params.ref);
      const freshAuth = (freshSettings?.auth as Record<string, unknown>) || {};
      const freshExternal =
        (freshAuth.external as Record<string, unknown>) || {};
      const freshHooks = (freshAuth.hooks as Record<string, any>) || {};
      const freshSmtp = (freshAuth.smtp as Record<string, unknown>) || {};

      const response: Record<string, unknown> = {
        ...freshAuth,
        enable_signup: freshAuth.enable_signup ?? true,
        enable_signups: freshAuth.enable_signup ?? true,
        enable_confirmations: freshAuth.enable_confirmations ?? false,
        double_confirm_changes: freshAuth.double_confirm_changes ?? true,
        manual_linking_enabled:
          freshAuth.manual_linking_enabled ??
          freshAuth.enable_manual_linking ??
          false,
        mfa_max_enrolled_factors:
          freshAuth.mfa_max_enrolled_factors ??
          freshAuth.max_enrolled_factors ??
          10,
      };
      delete response.external;
      delete response.hooks;

      for (const [key, val] of Object.entries(freshExternal)) {
        const providerConfig = val as Record<string, unknown>;
        const upperKey = key.toUpperCase();
        response[`EXTERNAL_${upperKey}_ENABLED`] = !!providerConfig?.client_id;
        response[`EXTERNAL_${upperKey}_CLIENT_ID`] =
          providerConfig?.client_id || "";
        response[`EXTERNAL_${upperKey}_SECRET`] = providerConfig?.client_secret
          ? "********"
          : "";
      }

      response.hook_custom_access_token_enabled =
        !!freshHooks.custom_access_token_hook?.enabled;
      response.hook_custom_access_token_uri =
        freshHooks.custom_access_token_hook?.uri || null;
      response.hook_mfa_verification_enabled =
        !!freshHooks.mfa_verification_hook?.enabled;
      response.hook_mfa_verification_uri =
        freshHooks.mfa_verification_hook?.uri || null;
      response.hook_password_verification_enabled =
        !!freshHooks.password_verification_hook?.enabled;
      response.hook_password_verification_uri =
        freshHooks.password_verification_hook?.uri || null;
      response.hook_send_email_enabled = !!freshHooks.send_email_hook?.enabled;
      response.hook_send_email_uri = freshHooks.send_email_hook?.uri || null;
      response.hook_send_sms_enabled = !!freshHooks.send_sms_hook?.enabled;
      response.hook_send_sms_uri = freshHooks.send_sms_hook?.uri || null;

      response.smtp_admin_email = freshSmtp.admin_email || "";
      response.smtp_host = freshSmtp.host || "";
      response.smtp_port = freshSmtp.port || 587;
      response.smtp_user = freshSmtp.user || "";
      response.smtp_pass = freshSmtp.pass ? "********" : "";
      response.smtp_max_frequency = freshSmtp.max_frequency || "1m0s";
      response.smtp_sender_name = freshSmtp.sender_name || "";

      return response;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
    
      detail: { tags: ["projects"], summary: "Update auth config" },
},
  )

  // --- Config CRUD (database, postgrest, storage, realtime) via factory ---
  .get(
    "/:ref/config/database",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const dbSettings = (settings as Record<string, unknown>).database || {};
      try {
        const { getProjectDb, resolveDbName } = await import("../db");
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);
        const rows = await db`
            SELECT name, setting FROM pg_settings
            WHERE name IN ('max_connections', 'statement_timeout', 'idle_in_transaction_session_timeout')
        `;
        const pgMap: Record<string, string> = {};
        for (const row of rows) {
          pgMap[row.name] = row.setting;
        }
        return {
          pgbouncer_enabled:
            (dbSettings as Record<string, unknown>).pgbouncer_enabled ?? false,
          pgbouncer_settings:
            (dbSettings as Record<string, unknown>).pgbouncer_settings || {},
          connection_string: `postgresql://${resolveRoleName(params.ref)}:[YOUR-PASSWORD]@localhost:5432/${dbName}`,
          max_connections: parseInt(pgMap.max_connections || "100"),
          statement_timeout: parseInt(pgMap.statement_timeout || "0"),
          idle_in_transaction_session_timeout: parseInt(
            pgMap.idle_in_transaction_session_timeout || "0",
          ),
        };
      } catch {
        return {
          pgbouncer_enabled: false,
          pgbouncer_settings: {},
          connection_string: `postgresql://${resolveRoleName(params.ref)}:[YOUR-PASSWORD]@localhost:5432/postgres`,
          max_connections: 100,
          statement_timeout: 0,
          idle_in_transaction_session_timeout: 0,
        };
      }
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get database config" },

    },
  )

  .patch(
    "/:ref/config/pooler",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
    async ({ params, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const current =
        ((settings as Record<string, unknown>).database as Record<
          string,
          unknown
        >) || {};
      const merged = { ...current, ...(typeof body === "object" ? body : {}) };
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        database: merged,
      });

      try {
        const { getProjectDb, resolveDbName } = await import("../db");
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);
        if (merged.statement_timeout !== undefined) {
          await db.unsafe(
            `ALTER DATABASE "${dbName}" SET statement_timeout = '${merged.statement_timeout}'`,
          );
        }
        if (merged.max_connections !== undefined) {
          await db.unsafe(
            `ALTER DATABASE "${dbName}" SET max_connections = '${merged.max_connections}'`,
          );
        }
      } catch (err) {
        logger.warn(
          "[project-config] Failed to apply database config to PostgreSQL",
          { error: err },
        );
      }

      try {
        const { tenantRuntimeService } =
          await import("../services/tenant-runtime.service");
        await tenantRuntimeService.restartRuntime(params.ref);
      } catch (err) {
        logger.warn(
          "[project-config] Failed to propagate database config to runtime",
          { error: err },
        );
      }

      const raw =
        ((updated as Record<string, unknown>).database as Record<
          string,
          unknown
        >) || {};
      return {
        pgbouncer_enabled: raw.pgbouncer_enabled ?? false,
        pgbouncer_settings: raw.pgbouncer_settings || {},
        connection_string:
          raw.connection_string ||
          `postgresql://${resolveRoleName(params.ref)}:[YOUR-PASSWORD]@localhost:5432/${await resolveDbNameTopLevel(params.ref)}`,
        max_connections: raw.max_connections ?? 100,
        statement_timeout: raw.statement_timeout ?? 0,
        idle_in_transaction_session_timeout:
          raw.idle_in_transaction_session_timeout ?? 0,
      };
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
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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

  // Get Network Restrictions — required by CLI `supabase link` (V1GetNetworkRestrictions)
  .get(
    "/:ref/network-restrictions",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });

      return buildNetworkRestrictionsResponse(
        (settings as Record<string, unknown>).network_restrictions,
      );
    },
    {

      params: t.Object({ ref: t.String() }),

      detail: { tags: ["projects"], summary: "Get network restrictions" },

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
    async ({ params, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
        hosts: t.Array(t.String()),
        path: t.Union([t.String(), t.Array(t.String())]),
        upstream: t.Optional(t.String()),
        upstream_tls_insecure_skip_verify: t.Optional(t.Boolean()),
        static_root: t.Optional(t.String()),
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
        hosts: t.Array(t.String()),
        path: t.Union([t.String(), t.Array(t.String())]),
        upstream: t.Optional(t.String()),
        upstream_tls_insecure_skip_verify: t.Optional(t.Boolean()),
        static_root: t.Optional(t.String()),
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
