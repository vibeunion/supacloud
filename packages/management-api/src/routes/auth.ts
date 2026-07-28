import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import {
  canonicalAuthProviderLinkingConfig,
  ProviderLinkingDomainsValidationError,
} from "../utils/provider-linking";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import type {
  OAuthProvider,
  OAuthProviderConfig,
  WeChatProviderType,
  ChinaOAuthProvider
} from "../types/oauth";
import {
  OAUTH_ENV_MAPPINGS,
  SUPPORTED_OAUTH_PROVIDERS,
  WECHAT_PROVIDER_INFO,
  CHINA_OAUTH_PROVIDER_INFO,
} from "../types/oauth";
import { requireAuthRuntimeManagement } from "./auth-runtime";
import {
  applyAuthSessionPolicyPatch,
  AuthSessionPolicyValidationError,
  normalizeAuthSessionPolicyPatch,
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
  validateStockPasskeyConfig,
} from "../services/auth-product-boundary";
import {
  AuthUrlConfigValidationError,
  canonicalizeAuthUrlConfig,
} from "../utils/auth-url-config";

const MASKED_SECRET_VALUES = new Set(["********", "****"]);
const SENSITIVE_AUTH_FIELDS = new Set([
  "pass",
  "password",
  "secret",
  "secrets",
  "smstestotp",
]);
const SENSITIVE_AUTH_SUFFIXES = [
  "secret",
  "secrets",
  "password",
  "apikey",
  "accesskey",
  "authtoken",
  "privatekey",
  "privatekeynext",
  "signingkey",
  "encryptionkey",
  "smtppass",
  "token",
];
const JWK_PRIVATE_FIELDS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);
const PUBLIC_ASYMMETRIC_JWK_TYPES = new Set(["EC", "OKP", "RSA"]);
const PUBLIC_JWK_FIELDS = [
  "kty",
  "crv",
  "x",
  "y",
  "n",
  "e",
  "kid",
  "alg",
  "use",
  "x5u",
  "x5c",
  "x5t",
  "x5t#S256",
] as const;
const FLAT_HOOK_SECRET_NAMES: Record<string, string> = {
  hook_before_user_created_secrets: "before_user_created_hook",
  hook_custom_access_token_secrets: "custom_access_token_hook",
  hook_mfa_verification_attempt_secrets: "mfa_verification_hook",
  hook_password_verification_attempt_secrets: "password_verification_hook",
  hook_send_email_secrets: "send_email_hook",
  hook_send_sms_secrets: "send_sms_hook",
};

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function normalizedAuthField(fieldName: string): string {
  return fieldName.replaceAll(/[_-]/g, "").toLowerCase();
}

function isJwkPath(parentPath: string[]): boolean {
  return parentPath.some((segment) => ["jwtkeys", "jwtjwks"].includes(normalizedAuthField(segment)));
}

function isSensitiveAuthField(fieldName: string, parentPath: string[]): boolean {
  const normalized = normalizedAuthField(fieldName);
  if (SENSITIVE_AUTH_FIELDS.has(normalized)) return true;
  if (SENSITIVE_AUTH_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return isJwkPath(parentPath) && JWK_PRIVATE_FIELDS.has(normalized);
}

function isMaskedSecret(candidate: unknown): candidate is string {
  return typeof candidate === "string" && MASKED_SECRET_VALUES.has(candidate);
}

function isNewSecret(candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && !isMaskedSecret(candidate);
}

function secretIsConfigured(candidate: unknown): boolean {
  if (typeof candidate === "string") return candidate.length > 0 && !isMaskedSecret(candidate);
  return candidate !== null && candidate !== undefined;
}

function secretStatusBase(fieldName: string, parentPath: string[]): string | null {
  if (!fieldName.endsWith("_configured")) return null;
  const baseField = fieldName.slice(0, -"_configured".length);
  return isSensitiveAuthField(baseField, parentPath) ? baseField : null;
}

function connectorNameForSecretField(fieldName: string): string | null {
  const normalized = fieldName.toLowerCase();
  const externalMatch = normalized.match(/^external_(.+)_(?:client_)?secret$/);
  if (externalMatch) return externalMatch[1];
  const oauthMatch = normalized.match(/^(.+)_oauth_client_secret$/);
  return oauthMatch?.[1] ?? null;
}

function hookNameForSecretField(fieldName: string): string | null {
  return FLAT_HOOK_SECRET_NAMES[fieldName.toLowerCase()] ?? null;
}

function redactAuthSecrets(authSetting: unknown, parentPath: string[] = []): unknown {
  if (Array.isArray(authSetting)) {
    return authSetting.map((entry) => redactAuthSecrets(entry, parentPath));
  }
  if (!isRecord(authSetting)) return authSetting;

  const redactedSetting: Record<string, unknown> = {};
  for (const [fieldName, fieldSetting] of Object.entries(authSetting)) {
    if (secretStatusBase(fieldName, parentPath)) continue;
    if (isSensitiveAuthField(fieldName, parentPath)) {
      const configured = secretIsConfigured(fieldSetting);
      redactedSetting[fieldName] = configured ? projectControlSecretsService.mask : null;
      redactedSetting[`${fieldName}_configured`] = configured;
      continue;
    }
    redactedSetting[fieldName] = redactAuthSecrets(fieldSetting, [...parentPath, fieldName]);
  }
  return redactedSetting;
}

function preserveMaskedAuthArray(
  incomingEntries: unknown[],
  currentSetting: unknown,
  parentPath: string[],
): unknown[] {
  const currentEntries = Array.isArray(currentSetting) ? currentSetting : [];
  return incomingEntries.map((entry, index) => preserveMaskedAuthSecrets(entry, currentEntries[index], parentPath));
}

function preserveMaskedAuthRecord(
  incomingSetting: Record<string, unknown>,
  currentSetting: unknown,
  parentPath: string[],
): Record<string, unknown> {
  const currentRecord = isRecord(currentSetting) ? currentSetting : {};
  const preservedSetting: Record<string, unknown> = {};
  for (const [fieldName, fieldSetting] of Object.entries(incomingSetting)) {
    if (secretStatusBase(fieldName, parentPath)) continue;
    if (isSensitiveAuthField(fieldName, parentPath) && isMaskedSecret(fieldSetting)) {
      const currentSecret = currentRecord[fieldName];
      if (currentSecret !== undefined && !isMaskedSecret(currentSecret)) {
        preservedSetting[fieldName] = structuredClone(currentSecret);
      }
      continue;
    }
    preservedSetting[fieldName] = preserveMaskedAuthSecrets(
      fieldSetting,
      currentRecord[fieldName],
      [...parentPath, fieldName],
    );
  }
  return preservedSetting;
}

function preserveMaskedAuthSecrets(
  incomingSetting: unknown,
  currentSetting: unknown,
  parentPath: string[] = [],
): unknown {
  if (Array.isArray(incomingSetting)) return preserveMaskedAuthArray(incomingSetting, currentSetting, parentPath);
  if (!isRecord(incomingSetting)) return incomingSetting;
  return preserveMaskedAuthRecord(incomingSetting, currentSetting, parentPath);
}

function mergeAuthConfig(
  currentSetting: Record<string, unknown>,
  incomingSetting: Record<string, unknown>,
): Record<string, unknown> {
  const mergedSetting = structuredClone(currentSetting);
  for (const [fieldName, fieldSetting] of Object.entries(incomingSetting)) {
    const currentField = mergedSetting[fieldName];
    mergedSetting[fieldName] = isRecord(currentField) && isRecord(fieldSetting)
      ? mergeAuthConfig(currentField, fieldSetting)
      : structuredClone(fieldSetting);
  }
  return mergedSetting;
}

async function connectorSecret(ref: string, provider: string, legacyValue?: unknown): Promise<string | null> {
  const stored = await projectControlSecretsService.readValue(ref, "connector", provider);
  if (stored) return stored;
  if (!isNewSecret(legacyValue)) return null;
  await projectControlSecretsService.upsert(ref, "connector", provider, legacyValue);
  return legacyValue;
}

async function moveFlatConnectorSecrets(ref: string, authConfig: Record<string, unknown>): Promise<void> {
  for (const [fieldName, fieldSetting] of Object.entries(authConfig)) {
    const provider = connectorNameForSecretField(fieldName);
    if (!provider) continue;
    if (isNewSecret(fieldSetting)) {
      await projectControlSecretsService.upsert(ref, "connector", provider, fieldSetting);
    }
    delete authConfig[fieldName];
  }
}

async function moveConnectorSecrets(ref: string, authConfig: Record<string, unknown>): Promise<void> {
  const external = isRecord(authConfig.external) ? authConfig.external : null;
  if (external) {
    for (const [provider, rawProviderConfig] of Object.entries(external)) {
      if (!isRecord(rawProviderConfig) || !("client_secret" in rawProviderConfig)) continue;
      if (isNewSecret(rawProviderConfig.client_secret)) {
        await projectControlSecretsService.upsert(ref, "connector", provider, rawProviderConfig.client_secret);
      }
      delete rawProviderConfig.client_secret;
    }
  }
  await moveFlatConnectorSecrets(ref, authConfig);
}

async function moveCaptchaSecret(ref: string, authConfig: Record<string, unknown>): Promise<void> {
  if (!("security_captcha_secret" in authConfig)) return;
  const provider = String(authConfig.security_captcha_provider ?? "default").toLowerCase();
  if (isNewSecret(authConfig.security_captcha_secret)) {
    await projectControlSecretsService.upsert(ref, "captcha", provider, authConfig.security_captcha_secret);
  }
  delete authConfig.security_captcha_secret;
}

async function moveHookSecrets(ref: string, authConfig: Record<string, unknown>): Promise<void> {
  const hooks = isRecord(authConfig.hooks) ? authConfig.hooks : null;
  if (hooks) {
    for (const [hookName, rawHookConfig] of Object.entries(hooks)) {
      if (!isRecord(rawHookConfig) || !("secrets" in rawHookConfig)) continue;
      if (isNewSecret(rawHookConfig.secrets)) {
        await projectControlSecretsService.upsert(ref, "auth-hook", hookName, rawHookConfig.secrets);
      }
      delete rawHookConfig.secrets;
    }
  }
  await moveFlatHookSecrets(ref, authConfig);
}

async function moveFlatHookSecrets(ref: string, authConfig: Record<string, unknown>): Promise<void> {
  for (const [fieldName, fieldSetting] of Object.entries(authConfig)) {
    const hookName = hookNameForSecretField(fieldName);
    if (!hookName) continue;
    if (isNewSecret(fieldSetting)) {
      await projectControlSecretsService.upsert(ref, "auth-hook", hookName, fieldSetting);
    }
    delete authConfig[fieldName];
  }
}

async function moveRawAuthSecrets(
  ref: string,
  authConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sanitized = structuredClone(authConfig);
  await moveConnectorSecrets(ref, sanitized);
  await moveCaptchaSecret(ref, sanitized);
  await moveHookSecrets(ref, sanitized);
  return sanitized;
}

function applyFlatConnectorSecretStatuses(
  safeConfig: Record<string, unknown>,
  configuredNames: Set<string>,
): void {
  for (const fieldName of Object.keys(safeConfig)) {
    const provider = connectorNameForSecretField(fieldName);
    if (!provider) continue;
    const configured = configuredNames.has(provider);
    safeConfig[fieldName] = configured ? projectControlSecretsService.mask : null;
    safeConfig[`${fieldName}_configured`] = configured;
  }
}

async function applyConnectorSecretStatuses(ref: string, safeConfig: Record<string, unknown>): Promise<void> {
  const external = isRecord(safeConfig.external) ? safeConfig.external : null;
  const secretStatuses = await projectControlSecretsService.listStatuses(ref, "connector");
  const configuredNames = new Set(secretStatuses.filter((entry) => entry.configured).map((entry) => entry.name));
  if (external) {
    for (const [provider, providerConfig] of Object.entries(external)) {
      if (!isRecord(providerConfig)) continue;
      delete providerConfig.client_secret;
      providerConfig.client_secret_configured = configuredNames.has(provider);
      if (providerConfig.client_secret_configured) {
        providerConfig.client_secret = projectControlSecretsService.mask;
      }
    }
  }
  applyFlatConnectorSecretStatuses(safeConfig, configuredNames);
}

function applyFlatHookSecretStatuses(
  safeConfig: Record<string, unknown>,
  configuredNames: Set<string>,
): void {
  for (const fieldName of Object.keys(safeConfig)) {
    const hookName = hookNameForSecretField(fieldName);
    if (!hookName) continue;
    const configured = configuredNames.has(hookName);
    safeConfig[fieldName] = configured ? projectControlSecretsService.mask : null;
    safeConfig[`${fieldName}_configured`] = configured;
  }
}

async function applyCaptchaSecretStatus(ref: string, safeConfig: Record<string, unknown>): Promise<void> {
  const captchaProvider = String(safeConfig.security_captcha_provider ?? "default").toLowerCase();
  const captchaStatus = await projectControlSecretsService.getStatus(ref, "captcha", captchaProvider);
  delete safeConfig.security_captcha_secret;
  safeConfig.security_captcha_secret_configured = captchaStatus.configured;
  if (safeConfig.security_captcha_secret_configured) {
    safeConfig.security_captcha_secret = projectControlSecretsService.mask;
  }
}

async function applyHookSecretStatuses(ref: string, safeConfig: Record<string, unknown>): Promise<void> {
  const hooks = isRecord(safeConfig.hooks) ? safeConfig.hooks : null;
  const secretStatuses = await projectControlSecretsService.listStatuses(ref, "auth-hook");
  const configuredNames = new Set(secretStatuses.filter((entry) => entry.configured).map((entry) => entry.name));
  if (hooks) {
    for (const [hookName, hookConfig] of Object.entries(hooks)) {
      if (!isRecord(hookConfig)) continue;
      delete hookConfig.secrets;
      hookConfig.secrets_configured = configuredNames.has(hookName);
      if (hookConfig.secrets_configured) hookConfig.secrets = projectControlSecretsService.mask;
    }
  }
  applyFlatHookSecretStatuses(safeConfig, configuredNames);
}

async function safeAuthConfig(ref: string, authConfig: Record<string, unknown>) {
  const publicConfig = canonicalAuthProviderLinkingConfig(authConfig);
  const safeConfig = redactAuthSecrets(publicConfig) as Record<string, unknown>;
  if (safeConfig.site_url === undefined && safeConfig.SITE_URL !== undefined) {
    safeConfig.site_url = safeConfig.SITE_URL;
  }
  if (safeConfig.uri_allow_list === undefined && safeConfig.URI_ALLOW_LIST !== undefined) {
    safeConfig.uri_allow_list = safeConfig.URI_ALLOW_LIST;
  }
  await applyConnectorSecretStatuses(ref, safeConfig);
  await applyCaptchaSecretStatus(ref, safeConfig);
  await applyHookSecretStatuses(ref, safeConfig);
  return safeConfig;
}

function publicAsymmetricJwk(candidate: unknown): Record<string, unknown> | null {
  if (!isRecord(candidate) || !PUBLIC_ASYMMETRIC_JWK_TYPES.has(String(candidate.kty))) {
    return null;
  }
  const publicJwk: Record<string, unknown> = {};
  for (const field of PUBLIC_JWK_FIELDS) {
    if (candidate[field] !== undefined) publicJwk[field] = structuredClone(candidate[field]);
  }
  return publicJwk;
}

function publicAsymmetricJwks(candidate: unknown): Record<string, unknown>[] {
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map(publicAsymmetricJwk)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

export async function safeProjectSettingsAuthConfig(
  ref: string,
  authConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const safeConfig = await safeAuthConfig(ref, authConfig);
  if (!isRecord(safeConfig.oauth_server)) return safeConfig;

  const oauthServer = { ...safeConfig.oauth_server };
  if (Object.prototype.hasOwnProperty.call(oauthServer, "jwt_keys")) {
    oauthServer.jwt_keys = publicAsymmetricJwks(oauthServer.jwt_keys);
  }
  if (isRecord(oauthServer.jwt_jwks)) {
    oauthServer.jwt_jwks = {
      ...oauthServer.jwt_jwks,
      keys: publicAsymmetricJwks(oauthServer.jwt_jwks.keys),
    };
  }

  return { ...safeConfig, oauth_server: oauthServer };
}

/**
 * Core auth routes — Standard OAuth CRUD, auth config, supported-providers,
 * studio provider management, and WeChat provider listing.
 *
 * WeChat-specific, China OAuth, and User Management routes are in:
 *   - ./auth-wechat.ts
 *   - ./auth-china.ts
 *   - ./auth-users.ts
 */
export const authRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .onBeforeHandle(requireAuthRuntimeManagement("configuration"))
  .get(
    "/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const oauthConfig = ((settings.auth as Record<string, unknown>)?.external ?? {}) as Record<string, Record<string, string>>;
      const result: Array<{
        id: string;
        enabled: boolean;
        client_id?: string;
        redirect_uri?: string;
        secret_configured?: boolean;
      }> = [];
      const secretStatuses = await projectControlSecretsService.listStatuses(params.ref, "connector");
      const configuredSecrets = new Set(secretStatuses.filter((item) => item.configured).map((item) => item.name));

      for (const provider of SUPPORTED_OAUTH_PROVIDERS) {
        const providerConfig = oauthConfig[provider];
        if (providerConfig && providerConfig.client_id) {
          result.push({
            id: provider,
            enabled: true,
            client_id: providerConfig.client_id,
            redirect_uri: providerConfig.redirect_uri,
            secret_configured: configuredSecrets.has(provider),
          });
        } else {
          result.push({ id: provider, enabled: false });
        }
      }

      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["auth"], summary: "List OAuth providers" },
    }
  )

  .get(
    "/providers/:provider",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { message: "Unsupported OAuth provider", code: "400" };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const oauthConfig = ((settings.auth as Record<string, unknown>)?.external ?? {}) as Record<string, Record<string, string>>;
      const providerConfig = oauthConfig[provider];
      const secretStatus = await projectControlSecretsService.getStatus(params.ref, "connector", provider);

      if (!providerConfig || !providerConfig.client_id) {
        return {
          id: provider,
          enabled: false,
          client_id: null,
          redirect_uri: null,
        };
      }

      return {
        id: provider,
        enabled: true,
        client_id: providerConfig.client_id,
        redirect_uri: providerConfig.redirect_uri || null,
        secret_configured: secretStatus.configured,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        provider: t.String(),
      }),
      detail: { tags: ["auth"], summary: "Get OAuth provider" },
    }
  )

  .post(
    "/providers/:provider",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { message: "Unsupported OAuth provider", code: "400" };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const currentExternal = (currentAuth.external ?? {}) as Record<string, Record<string, string>>;

      const providerConfig: OAuthProviderConfig = {
        provider,
        client_id: body.client_id,
        client_secret: body.client_secret,
        redirect_uri: body.redirect_uri,
        url: body.url,
      };

      await projectControlSecretsService.upsert(params.ref, "connector", provider, providerConfig.client_secret);

      const updatedExternal = {
        ...currentExternal,
        [provider]: {
          client_id: providerConfig.client_id,
          redirect_uri: providerConfig.redirect_uri,
          url: providerConfig.url,
        },
      };

      const updatedSettings = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      let warning: string | undefined;
      try {
        await tenantRuntimeService.updateOAuthConfig(params.ref, provider, providerConfig);
      } catch (error: unknown) {
        warning = `Saved to DB, but failed to update GoTrue config: ${error instanceof Error ? error.message : String(error)}. It may apply on next start.`;
        logger.error(`Failed to update GoTrue OAuth config for ${provider}:`, { error: error instanceof Error ? error.message : String(error) });
      }

      return {
        id: provider,
        enabled: true,
        client_id: providerConfig.client_id,
        redirect_uri: providerConfig.redirect_uri || null,
        secret_configured: true,
        ...(warning ? { warning } : {}),
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        provider: t.String(),
      }),
      body: t.Object({
        client_id: t.String({ minLength: 1 }),
        client_secret: t.String({ minLength: 1 }),
        redirect_uri: t.Optional(t.String()),
        url: t.Optional(t.String()),
      }),
      detail: { tags: ["auth"], summary: "Create OAuth provider" },
    }
  )

  .patch(
    "/providers/:provider",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { message: "Unsupported OAuth provider", code: "400" };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const currentExternal = (currentAuth.external ?? {}) as Record<string, Record<string, string>>;
      const currentProviderConfig = currentExternal[provider] || ({} as Record<string, string>);

      const incomingSecret = isNewSecret(body.client_secret) ? body.client_secret : null;
      if (incomingSecret) {
        await projectControlSecretsService.upsert(params.ref, "connector", provider, incomingSecret);
      }

      const updatedProviderConfig: Record<string, string> = {
        ...currentProviderConfig,
        ...body,
      };
      delete updatedProviderConfig.client_secret;
      const effectiveSecret = incomingSecret || await connectorSecret(
        params.ref,
        provider,
        currentProviderConfig.client_secret,
      );

      const updatedExternal = {
        ...currentExternal,
        [provider]: updatedProviderConfig,
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      let warning: string | undefined;
      if (updatedProviderConfig.client_id && effectiveSecret) {
        try {
          await tenantRuntimeService.updateOAuthConfig(params.ref, provider, {
            provider,
            client_id: updatedProviderConfig.client_id,
            client_secret: effectiveSecret,
            redirect_uri: updatedProviderConfig.redirect_uri,
            url: updatedProviderConfig.url,
          });
        } catch (error: unknown) {
          warning = `Saved to DB, but failed to update GoTrue config: ${error instanceof Error ? error.message : String(error)}. It may apply on next start.`;
          logger.error(`Failed to update GoTrue OAuth config for ${provider}:`, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      return {
        id: provider,
        enabled: true,
        client_id: updatedProviderConfig.client_id,
        redirect_uri: updatedProviderConfig.redirect_uri || null,
        secret_configured: Boolean(effectiveSecret),
        ...(warning ? { warning } : {}),
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        provider: t.String(),
      }),
      body: t.Object({
        client_id: t.Optional(t.String({ minLength: 1 })),
        client_secret: t.Optional(t.String({ minLength: 1 })),
        redirect_uri: t.Optional(t.String()),
        url: t.Optional(t.String()),
      }),
      detail: { tags: ["auth"], summary: "Update OAuth provider" },
    }
  )

  .delete(
    "/providers/:provider",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { message: "Unsupported OAuth provider", code: "400" };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const currentExternal = (currentAuth.external ?? {}) as Record<string, Record<string, string>>;

      if (!currentExternal[provider]) {
        return {
          id: provider,
          enabled: false,
        };
      }

      const updatedExternal = { ...currentExternal };
      delete updatedExternal[provider];

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      try {
        await tenantRuntimeService.removeOAuthConfig(params.ref, provider);
      } catch (error: unknown) {
        logger.error(`Failed to remove GoTrue OAuth config for ${provider}:`, { error: error instanceof Error ? error.message : String(error) });
      }
      await projectControlSecretsService.remove(params.ref, "connector", provider);

      return {
        id: provider,
        enabled: false,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        provider: t.String(),
      }),
      detail: { tags: ["auth"], summary: "Delete OAuth provider" },
    }
  )

  .get(
    "/config",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const authConfig = (settings.auth as Record<string, unknown>) || {};
      return safeAuthConfig(params.ref, authConfig);
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["auth"], summary: "Get auth config" },
    }
  )

  .patch(
    "/config",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const sanitizedBody = preserveMaskedAuthSecrets(
        body as Record<string, unknown>,
        currentAuth,
      ) as Record<string, unknown>;
      let canonicalBody: Record<string, unknown>;
      try {
        canonicalBody = canonicalizeStockPasskeyConfig(canonicalizeAuthUrlConfig(sanitizedBody));
      } catch (error: unknown) {
        if (error instanceof PasskeyConfigValidationError) {
          return status(400, passkeyConfigValidationBody(error));
        }
        if (error instanceof AuthUrlConfigValidationError) {
          return status(400, buildAuthUrlConfigErrorBody(error));
        }
        throw error;
      }
      let sessionPolicyPatch: ReturnType<typeof normalizeAuthSessionPolicyPatch>;
      try {
        sessionPolicyPatch = normalizeAuthSessionPolicyPatch(canonicalBody);
      } catch (error: unknown) {
        if (error instanceof AuthSessionPolicyValidationError) {
          return status(400, buildAuthSessionPolicyErrorBody(error));
        }
        throw error;
      }

      const nonPolicyUpdates = Object.fromEntries(
        Object.entries(canonicalBody).filter(([key]) => !sessionPolicyPatch.consumedKeys.has(key)),
      );
      const mergeBaseAuth = { ...currentAuth };
      if ("site_url" in canonicalBody) delete mergeBaseAuth.SITE_URL;
      if ("uri_allow_list" in canonicalBody) delete mergeBaseAuth.URI_ALLOW_LIST;
      const mergedAuth = mergeAuthConfig(mergeBaseAuth, nonPolicyUpdates);
      let canonicalAuth: Record<string, unknown>;
      try {
        canonicalAuth = canonicalAuthProviderLinkingConfig(
          applyAuthSessionPolicyPatch(mergedAuth, sessionPolicyPatch),
        );
        validateStockPasskeyConfig(canonicalAuth);
      } catch (error: unknown) {
        if (error instanceof PasskeyConfigValidationError) {
          return status(400, passkeyConfigValidationBody(error));
        }
        if (error instanceof ProviderLinkingDomainsValidationError) {
          return status(400, { code: "INVALID_PROVIDER_LINKING_DOMAINS", message: error.message });
        }
        throw error;
      }
      const updatedAuth = await moveRawAuthSecrets(params.ref, canonicalAuth);

      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: updatedAuth,
      });

      try {
        await tenantRuntimeService.applyAuthConfig(params.ref, currentAuth, updatedAuth);
      } catch (error: unknown) {
        logger.error("Failed to apply GoTrue auth config:", { error: error instanceof Error ? error.message : String(error) });
        return status(503, buildAuthRuntimeApplyFailureBody(params.ref, error));
      }

      return safeAuthConfig(params.ref, (updated?.auth || {}) as Record<string, unknown>);
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
      detail: {
        tags: ["auth"],
        summary: "Update auth config",
        description: "Provider linking accepts experimental.provider_linking_domains as a validated provider-to-domain map; the deprecated provider list is normalized forward.",
      },
    }
  )

  .get(
    "/supported-providers",
    async () => {
      return {
        providers: SUPPORTED_OAUTH_PROVIDERS.map((p) => {
          const isWechat = p.startsWith("wechat");
          const isChina = ["qq", "weibo", "alipay", "dingtalk", "douyin", "baidu", "huawei", "xiaomi", "kuaishou", "bilibili"].includes(p);
          return {
            id: p,
            name: isWechat
              ? WECHAT_PROVIDER_INFO[p as WeChatProviderType]?.name || p
              : isChina
                ? CHINA_OAUTH_PROVIDER_INFO[p as ChinaOAuthProvider]?.name || p
                : p.charAt(0).toUpperCase() + p.slice(1),
            env_mapping: OAUTH_ENV_MAPPINGS[p],
            is_wechat: isWechat,
            is_china: isChina,
            wechat_info: isWechat ? WECHAT_PROVIDER_INFO[p as WeChatProviderType] : undefined,
            china_info: isChina ? CHINA_OAUTH_PROVIDER_INFO[p as ChinaOAuthProvider] : undefined,
          };
        }),
      };
    },
    { detail: { tags: ["auth"], summary: "List supported OAuth providers" } }
  )

  .get(
    "/studio/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const oauthConfig = ((settings.auth as Record<string, unknown>)?.external ?? {}) as Record<string, Record<string, string>>;
      const providers: Record<string, unknown> = {};
      const chinaProviderList: ChinaOAuthProvider[] = ["qq", "weibo", "alipay", "dingtalk", "douyin", "baidu", "huawei", "xiaomi", "kuaishou", "bilibili"];
      const secretStatuses = await projectControlSecretsService.listStatuses(params.ref, "connector");
      const configuredSecrets = new Set(secretStatuses.filter((item) => item.configured).map((item) => item.name));

      for (const provider of SUPPORTED_OAUTH_PROVIDERS) {
        const config = oauthConfig[provider];
        const isWechat = provider.startsWith("wechat");
        const isChina = chinaProviderList.includes(provider as ChinaOAuthProvider);

        providers[provider] = {
          enabled: !!(config && config.client_id),
          client_id: config?.client_id || null,
          redirect_uri: config?.redirect_uri || null,
          secret_configured: configuredSecrets.has(provider),
          display_name: isWechat
            ? WECHAT_PROVIDER_INFO[provider as WeChatProviderType]?.name || provider
            : isChina
              ? CHINA_OAUTH_PROVIDER_INFO[provider as ChinaOAuthProvider]?.name || provider
              : provider.charAt(0).toUpperCase() + provider.slice(1),
          is_custom: isWechat || isChina,
          custom_type: isWechat
            ? WECHAT_PROVIDER_INFO[provider as WeChatProviderType]?.loginType
            : isChina
              ? "china_oauth"
              : undefined,
          is_china: isChina,
        };
      }

      return {
        providers,
        enabled_providers: Object.keys(providers).filter(p => (providers[p] as Record<string, unknown>).enabled),
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["auth"], summary: "List providers for Studio" },
    }
  )

  .patch(
    "/studio/providers/:provider",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { message: "Unsupported OAuth provider", code: "400" };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const currentExternal = (currentAuth.external ?? {}) as Record<string, Record<string, string>>;
      const currentProviderConfig = currentExternal[provider] || ({} as Record<string, string>);
      const incomingSecret = isNewSecret(body.client_secret) ? body.client_secret : null;
      if (incomingSecret) {
        await projectControlSecretsService.upsert(params.ref, "connector", provider, incomingSecret);
      }
      const effectiveSecret = incomingSecret || await connectorSecret(
        params.ref,
        provider,
        currentProviderConfig.client_secret,
      );

      const updatedProviderConfig: Record<string, string> = {
        ...currentProviderConfig,
        ...(body.enabled === false ? {} : {
          client_id: body.client_id || currentProviderConfig.client_id,
          redirect_uri: body.redirect_uri || currentProviderConfig.redirect_uri,
        }),
      };
      delete updatedProviderConfig.client_secret;

      if (body.enabled === false) {
        delete updatedProviderConfig.client_id;
      }

      const updatedExternal = {
        ...currentExternal,
        [provider]: updatedProviderConfig,
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      let warning: string | undefined;
      if (body.enabled !== false && updatedProviderConfig.client_id && effectiveSecret) {
        try {
          await tenantRuntimeService.updateOAuthConfig(params.ref, provider, {
            provider,
            client_id: updatedProviderConfig.client_id,
            client_secret: effectiveSecret,
            redirect_uri: updatedProviderConfig.redirect_uri,
          });
        } catch (error: unknown) {
          warning = `Saved to DB, but failed to update GoTrue config: ${error instanceof Error ? error.message : String(error)}. It may apply on next start.`;
          logger.error(`Failed to update GoTrue OAuth config for ${provider}:`, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      return {
        provider,
        enabled: body.enabled !== false && !!updatedProviderConfig.client_id,
        client_id: updatedProviderConfig.client_id || null,
        redirect_uri: updatedProviderConfig.redirect_uri || null,
        secret_configured: body.enabled === false ? false : Boolean(effectiveSecret),
        ...(warning ? { warning } : {}),
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        provider: t.String(),
      }),
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        client_id: t.Optional(t.String()),
        client_secret: t.Optional(t.String()),
        redirect_uri: t.Optional(t.String()),
      }),
      detail: { tags: ["auth"], summary: "Update provider for Studio" },
    }
  )

  .get(
    "/wechat/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const oauthConfig = ((settings.auth as Record<string, unknown>)?.external ?? {}) as Record<string, Record<string, string>>;
      const wechatProviders: WeChatProviderType[] = ["wechat", "wechat_miniprogram", "wechat_mp"];
      const result: Record<string, unknown> = {};

      for (const provider of wechatProviders) {
        const providerConfig = oauthConfig[provider];
        const info = WECHAT_PROVIDER_INFO[provider];
        result[provider] = {
          enabled: !!(providerConfig && providerConfig.client_id),
          name: info.name,
          description: info.description,
          login_type: info.loginType,
          client_id: providerConfig?.client_id || null,
          redirect_uri: providerConfig?.redirect_uri || null,
        };
      }

      return { providers: result };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["auth"], summary: "List WeChat providers" },
    }
  );
