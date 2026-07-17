import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { shellService } from "../services/shell.service";
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
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";

function generateGoTrueOAuthEnv(provider: OAuthProvider, config: OAuthProviderConfig): string {
  const mapping = OAUTH_ENV_MAPPINGS[provider];
  if (!mapping) {
    throw new Error(`Unsupported OAuth provider: ${provider}`);
  }

  let envLines: string[] = [];

  envLines.push(`${mapping.clientId}=${config.client_id}`);
  envLines.push(`${mapping.clientSecret}=${config.client_secret}`);

  if (config.redirect_uri) {
    envLines.push(`${mapping.redirectUri}=${config.redirect_uri}`);
  }

  if (mapping.url && config.url) {
    envLines.push(`${mapping.url}=${config.url}`);
  }

  return envLines.join("\n");
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return value.substring(0, 4) + "****" + value.substring(value.length - 4);
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
      const result: Array<{ id: string; enabled: boolean; client_id?: string; redirect_uri?: string }> = [];

      for (const provider of SUPPORTED_OAUTH_PROVIDERS) {
        const providerConfig = oauthConfig[provider];
        if (providerConfig && providerConfig.client_id) {
          result.push({
            id: provider,
            enabled: true,
            client_id: providerConfig.client_id,
            redirect_uri: providerConfig.redirect_uri,
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

      const updatedExternal = {
        ...currentExternal,
        [provider]: {
          client_id: providerConfig.client_id,
          client_secret: providerConfig.client_secret,
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

      const updatedProviderConfig = {
        ...currentProviderConfig,
        ...body,
      };

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
      if (updatedProviderConfig.client_id && updatedProviderConfig.client_secret) {
        try {
          await tenantRuntimeService.updateOAuthConfig(params.ref, provider, {
            provider,
            client_id: updatedProviderConfig.client_id,
            client_secret: updatedProviderConfig.client_secret,
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
      const safeConfig: Record<string, unknown> = { ...authConfig };

      {
        const ext = safeConfig.external as Record<string, Record<string, string>> | undefined;
        if (ext) {
          for (const provider of Object.keys(ext)) {
            if (ext[provider].client_secret) {
              ext[provider].client_secret = maskSecret(ext[provider].client_secret);
            }
          }
          safeConfig.external = ext;
        }
      }

      return safeConfig;
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
      const updatedAuth = {
        ...currentAuth,
        ...body,
      };

      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: updatedAuth,
      });

      try {
        await tenantRuntimeService.restartRuntime(params.ref);
      } catch (error: unknown) {
        logger.error("Failed to restart GoTrue after config update:", { error: error instanceof Error ? error.message : String(error) });
        if (getAuthRuntimeDescriptor(params.ref).mode === "owner") {
          return status(503, {
            code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
            message: "Auth configuration was saved, but one or more SupAuth dependents failed to refresh",
          });
        }
      }

      return updated?.auth || {};
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
      detail: { tags: ["auth"], summary: "Update auth config" },
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

      for (const provider of SUPPORTED_OAUTH_PROVIDERS) {
        const config = oauthConfig[provider];
        const isWechat = provider.startsWith("wechat");
        const isChina = chinaProviderList.includes(provider as ChinaOAuthProvider);

        providers[provider] = {
          enabled: !!(config && config.client_id),
          client_id: config?.client_id || null,
          redirect_uri: config?.redirect_uri || null,
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

      const updatedProviderConfig = {
        ...currentProviderConfig,
        ...(body.enabled === false ? {} : {
          client_id: body.client_id || currentProviderConfig.client_id,
          client_secret: body.client_secret || currentProviderConfig.client_secret,
          redirect_uri: body.redirect_uri || currentProviderConfig.redirect_uri,
        }),
      };

      if (body.enabled === false) {
        delete updatedProviderConfig.client_id;
        delete updatedProviderConfig.client_secret;
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
      if (body.enabled !== false && updatedProviderConfig.client_id && updatedProviderConfig.client_secret) {
        try {
          await tenantRuntimeService.updateOAuthConfig(params.ref, provider, {
            provider,
            client_id: updatedProviderConfig.client_id,
            client_secret: updatedProviderConfig.client_secret,
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
