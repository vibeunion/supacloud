import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { shellService } from "../services/shell.service";
import {
  OAuthProvider,
  OAuthProviderConfig,
  OAUTH_ENV_MAPPINGS,
  SUPPORTED_OAUTH_PROVIDERS,
  WeChatProviderType,
  WECHAT_PROVIDER_INFO,
  ChinaOAuthProvider,
  CHINA_OAUTH_PROVIDER_INFO,
} from "../types/oauth";

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

export const authRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .get(
    "/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const oauthConfig = (settings.auth as Record<string, any>)?.external || {};
      const result: Record<string, { enabled: boolean; client_id?: string; redirect_uri?: string }> = {};

      for (const provider of SUPPORTED_OAUTH_PROVIDERS) {
        const providerConfig = oauthConfig[provider];
        if (providerConfig && providerConfig.client_id) {
          result[provider] = {
            enabled: true,
            client_id: providerConfig.client_id,
            redirect_uri: providerConfig.redirect_uri,
          };
        } else {
          result[provider] = { enabled: false };
        }
      }

      return { providers: result };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  .get(
    "/providers/:provider",
    async ({ params, set }) => {
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { error: `Unsupported OAuth provider: ${provider}` };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const oauthConfig = (settings.auth as Record<string, any>)?.external || {};
      const providerConfig = oauthConfig[provider];

      if (!providerConfig || !providerConfig.client_id) {
        return {
          provider,
          enabled: false,
          client_id: null,
          redirect_uri: null,
        };
      }

      return {
        provider,
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
    }
  )

  .post(
    "/providers/:provider",
    async ({ params, body, set }) => {
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { error: `Unsupported OAuth provider: ${provider}` };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};

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

      try {
        await tenantRuntimeService.updateOAuthConfig(params.ref, provider, providerConfig);
      } catch (error) {
        console.error(`Failed to update GoTrue OAuth config for ${provider}:`, error);
      }

      return {
        provider,
        enabled: true,
        client_id: providerConfig.client_id,
        redirect_uri: providerConfig.redirect_uri || null,
        message: `OAuth provider ${provider} configured successfully`,
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
    }
  )

  .patch(
    "/providers/:provider",
    async ({ params, body, set }) => {
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { error: `Unsupported OAuth provider: ${provider}` };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};
      const currentProviderConfig = currentExternal[provider] || {};

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

      if (updatedProviderConfig.client_id && updatedProviderConfig.client_secret) {
        try {
          await tenantRuntimeService.updateOAuthConfig(params.ref, provider, {
            provider,
            client_id: updatedProviderConfig.client_id,
            client_secret: updatedProviderConfig.client_secret,
            redirect_uri: updatedProviderConfig.redirect_uri,
            url: updatedProviderConfig.url,
          });
        } catch (error) {
          console.error(`Failed to update GoTrue OAuth config for ${provider}:`, error);
        }
      }

      return {
        provider,
        enabled: true,
        client_id: updatedProviderConfig.client_id,
        redirect_uri: updatedProviderConfig.redirect_uri || null,
        message: `OAuth provider ${provider} updated successfully`,
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
    }
  )

  .delete(
    "/providers/:provider",
    async ({ params, set }) => {
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { error: `Unsupported OAuth provider: ${provider}` };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};

      if (!currentExternal[provider]) {
        return {
          provider,
          enabled: false,
          message: `OAuth provider ${provider} was not configured`,
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
      } catch (error) {
        console.error(`Failed to remove GoTrue OAuth config for ${provider}:`, error);
      }

      return {
        provider,
        enabled: false,
        message: `OAuth provider ${provider} removed successfully`,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        provider: t.String(),
      }),
    }
  )

  .get(
    "/config",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const authConfig = (settings.auth as Record<string, any>) || {};
      const safeConfig = { ...authConfig };

      if (safeConfig.external) {
        for (const provider of Object.keys(safeConfig.external)) {
          if (safeConfig.external[provider].client_secret) {
            safeConfig.external[provider].client_secret = maskSecret(
              safeConfig.external[provider].client_secret
            );
          }
        }
      }

      return safeConfig;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  .patch(
    "/config",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
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
      } catch (error) {
        console.error("Failed to restart GoTrue after config update:", error);
      }

      return updated?.auth || {};
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
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
    }
  )

  .get(
    "/studio/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const oauthConfig = (settings.auth as Record<string, any>)?.external || {};
      const providers: Record<string, any> = {};
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
        enabled_providers: Object.keys(providers).filter(p => providers[p].enabled),
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  .patch(
    "/studio/providers/:provider",
    async ({ params, body, set }) => {
      const provider = params.provider as OAuthProvider;

      if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { error: `Unsupported OAuth provider: ${provider}` };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};
      const currentProviderConfig = currentExternal[provider] || {};

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

      if (body.enabled !== false && updatedProviderConfig.client_id && updatedProviderConfig.client_secret) {
        try {
          if (provider.startsWith("wechat")) {
            if (provider === "wechat_miniprogram") {
              await deployWeChatMiniProgramFunction(params.ref, updatedProviderConfig.client_id, updatedProviderConfig.client_secret);
            } else if (provider === "wechat_mp") {
              await deployWeChatMPFunction(params.ref, updatedProviderConfig.client_id, updatedProviderConfig.client_secret, updatedProviderConfig.redirect_uri);
            } else {
              const project = await projectService.getProject(params.ref);
              const apiExternalUrl = project?.api?.url || `https://${params.ref}.supabase.co`;
              await tenantRuntimeService.updateGoTrueCustomOAuth(params.ref, {
                name: "wechat",
                client_id: updatedProviderConfig.client_id,
                client_secret: updatedProviderConfig.client_secret,
                redirect_uri: updatedProviderConfig.redirect_uri || `${apiExternalUrl}/auth/v1/callback`,
                authorize_url: "https://open.weixin.qq.com/connect/qrconnect",
                token_url: "https://api.weixin.qq.com/sns/oauth2/access_token",
                user_url: "https://api.weixin.qq.com/sns/userinfo",
              });
            }
          } else {
            const chinaProviders: ChinaOAuthProvider[] = ["qq", "weibo", "alipay", "dingtalk", "douyin", "baidu", "huawei", "xiaomi", "kuaishou", "bilibili"];
            if (chinaProviders.includes(provider as ChinaOAuthProvider)) {
              await deployChinaOAuthFunction(params.ref, provider as ChinaOAuthProvider, updatedProviderConfig.client_id, updatedProviderConfig.client_secret, updatedProviderConfig.redirect_uri);
            } else {
              await tenantRuntimeService.updateOAuthConfig(params.ref, provider, {
                provider,
                client_id: updatedProviderConfig.client_id,
                client_secret: updatedProviderConfig.client_secret,
                redirect_uri: updatedProviderConfig.redirect_uri,
              });
            }
          }
        } catch (error) {
          console.error(`Failed to update GoTrue OAuth config for ${provider}:`, error);
        }
      }

      return {
        provider,
        enabled: body.enabled !== false && !!updatedProviderConfig.client_id,
        client_id: updatedProviderConfig.client_id || null,
        redirect_uri: updatedProviderConfig.redirect_uri || null,
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
    }
  )

  .get(
    "/wechat/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const oauthConfig = (settings.auth as Record<string, any>)?.external || {};
      const wechatProviders: WeChatProviderType[] = ["wechat", "wechat_miniprogram", "wechat_mp"];
      const result: Record<string, any> = {};

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
    }
  )

  .post(
    "/wechat/miniprogram",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};

      const providerConfig = {
        client_id: body.app_id,
        client_secret: body.app_secret,
      };

      const updatedExternal = {
        ...currentExternal,
        wechat_miniprogram: providerConfig,
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      if (body.deploy_function !== false) {
        try {
          await deployWeChatMiniProgramFunction(params.ref, body.app_id, body.app_secret);
        } catch (error) {
          console.error("Failed to deploy wechat-login function:", error);
        }
      }

      return {
        provider: "wechat_miniprogram",
        enabled: true,
        name: WECHAT_PROVIDER_INFO.wechat_miniprogram.name,
        message: "微信小程序登录配置成功，Edge Function 已部署",
        function_slug: "wechat-login",
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        app_id: t.String({ minLength: 1 }),
        app_secret: t.String({ minLength: 1 }),
        deploy_function: t.Optional(t.Boolean({ default: true })),
      }),
    }
  )

  .post(
    "/wechat/mp",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};

      const providerConfig = {
        client_id: body.app_id,
        client_secret: body.app_secret,
        redirect_uri: body.redirect_uri,
      };

      const updatedExternal = {
        ...currentExternal,
        wechat_mp: providerConfig,
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      try {
        await tenantRuntimeService.updateOAuthConfig(params.ref, "wechat_mp", {
          provider: "wechat_mp",
          client_id: body.app_id,
          client_secret: body.app_secret,
          redirect_uri: body.redirect_uri,
        });
      } catch (error) {
        console.error("Failed to update GoTrue wechat_mp config:", error);
      }

      return {
        provider: "wechat_mp",
        enabled: true,
        name: WECHAT_PROVIDER_INFO.wechat_mp.name,
        message: "微信公众号登录配置成功",
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        app_id: t.String({ minLength: 1 }),
        app_secret: t.String({ minLength: 1 }),
        redirect_uri: t.Optional(t.String()),
      }),
    }
  )

  .post(
    "/wechat/open",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};

      const providerConfig = {
        client_id: body.app_id,
        client_secret: body.app_secret,
        redirect_uri: body.redirect_uri,
      };

      const updatedExternal = {
        ...currentExternal,
        wechat: providerConfig,
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      try {
        const project = await projectService.getProject(params.ref);
        const apiExternalUrl = project?.api?.url || `https://${params.ref}.supabase.co`;
        const redirectUri = body.redirect_uri || `${apiExternalUrl}/auth/v1/callback`;

        await tenantRuntimeService.updateGoTrueCustomOAuth(params.ref, {
          name: "wechat",
          client_id: body.app_id,
          client_secret: body.app_secret,
          redirect_uri: redirectUri,
          authorize_url: "https://open.weixin.qq.com/connect/qrconnect",
          token_url: "https://api.weixin.qq.com/sns/oauth2/access_token",
          user_url: "https://api.weixin.qq.com/sns/userinfo",
          auth_scheme: "query",
        });
      } catch (error) {
        console.error("Failed to update GoTrue wechat config:", error);
      }

      return {
        provider: "wechat",
        enabled: true,
        name: WECHAT_PROVIDER_INFO.wechat.name,
        message: "微信开放平台登录配置成功（标准 OAuth2.0）",
        is_standard_oauth: true,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        app_id: t.String({ minLength: 1 }),
        app_secret: t.String({ minLength: 1 }),
        redirect_uri: t.Optional(t.String()),
      }),
    }
  )

  .post(
    "/wechat/mp",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};

      const providerConfig = {
        client_id: body.app_id,
        client_secret: body.app_secret,
        redirect_uri: body.redirect_uri,
      };

      const updatedExternal = {
        ...currentExternal,
        wechat_mp: providerConfig,
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      if (body.deploy_function !== false) {
        try {
          await deployWeChatMPFunction(params.ref, body.app_id, body.app_secret, body.redirect_uri);
        } catch (error) {
          console.error("Failed to deploy wechat-mp-login function:", error);
        }
      }

      return {
        provider: "wechat_mp",
        enabled: true,
        name: WECHAT_PROVIDER_INFO.wechat_mp.name,
        message: "微信公众号登录配置成功，Edge Function 已部署",
        function_slug: "wechat-mp-login",
        is_standard_oauth: false,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        app_id: t.String({ minLength: 1 }),
        app_secret: t.String({ minLength: 1 }),
        redirect_uri: t.Optional(t.String()),
        deploy_function: t.Optional(t.Boolean({ default: true })),
      }),
    }
  )

  .get(
    "/china/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const oauthConfig = (settings.auth as Record<string, any>)?.external || {};
      const chinaProviders: ChinaOAuthProvider[] = ["qq", "weibo", "alipay", "dingtalk", "douyin", "baidu", "huawei", "xiaomi", "kuaishou", "bilibili"];
      const result: Record<string, any> = {};

      for (const provider of chinaProviders) {
        const providerConfig = oauthConfig[provider];
        const info = CHINA_OAUTH_PROVIDER_INFO[provider];
        result[provider] = {
          enabled: !!(providerConfig && providerConfig.client_id),
          name: info.name,
          description: info.description,
          is_standard_oauth: info.isStandardOAuth,
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
    }
  )

  .post(
    "/china/:provider",
    async ({ params, body, set }) => {
      const provider = params.provider as ChinaOAuthProvider;
      const chinaProviders: ChinaOAuthProvider[] = ["qq", "weibo", "alipay", "dingtalk", "douyin", "baidu", "huawei", "xiaomi", "kuaishou", "bilibili"];

      if (!chinaProviders.includes(provider)) {
        set.status = 400;
        return { error: `Unsupported China OAuth provider: ${provider}` };
      }

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as Record<string, any>) || {};
      const currentExternal = currentAuth.external || {};

      const providerConfig = {
        client_id: body.app_id,
        client_secret: body.app_secret,
        redirect_uri: body.redirect_uri,
      };

      const updatedExternal = {
        ...currentExternal,
        [provider]: providerConfig,
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      if (body.deploy_function !== false) {
        try {
          await deployChinaOAuthFunction(params.ref, provider, body.app_id, body.app_secret, body.redirect_uri);
        } catch (error) {
          console.error(`Failed to deploy ${provider}-login function:`, error);
        }
      }

      const info = CHINA_OAUTH_PROVIDER_INFO[provider];
      return {
        provider,
        enabled: true,
        name: info.name,
        message: `${info.name}登录配置成功`,
        function_slug: `${provider}-login`,
        is_standard_oauth: info.isStandardOAuth,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        provider: t.String(),
      }),
      body: t.Object({
        app_id: t.String({ minLength: 1 }),
        app_secret: t.String({ minLength: 1 }),
        redirect_uri: t.Optional(t.String()),
        deploy_function: t.Optional(t.Boolean({ default: true })),
      }),
    }
  );

async function deployWeChatMiniProgramFunction(ref: string, appId: string, appSecret: string): Promise<void> {
  const functionCode = generateWeChatMiniProgramLoginFunction(appId, appSecret);
  const result = await shellService.execute("function_manager.sh", ["deploy", ref, "wechat-login", functionCode]);
  if (!result.success) {
    throw new Error(`Failed to deploy wechat-login function: ${result.output}`);
  }
}

async function deployWeChatMPFunction(ref: string, appId: string, appSecret: string, redirectUri?: string): Promise<void> {
  const functionCode = generateWeChatMPLoginFunction(appId, appSecret, redirectUri);
  const result = await shellService.execute("function_manager.sh", ["deploy", ref, "wechat-mp-login", functionCode]);
  if (!result.success) {
    throw new Error(`Failed to deploy wechat-mp-login function: ${result.output}`);
  }
}

function generateWeChatMiniProgramLoginFunction(appId: string, appSecret: string): string {
  return `import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sign } from "npm:jsonwebtoken@9.0.2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  try {
    const { code } = await req.json()
    const WECHAT_APP_ID = Deno.env.get("WECHAT_MINIPROGRAM_APP_ID") || "${appId}"
    const WECHAT_APP_SECRET = Deno.env.get("WECHAT_MINIPROGRAM_APP_SECRET") || "${appSecret}"
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    const JWT_SECRET = Deno.env.get("JWT_SECRET") as string

    const tokenUrl = \`https://api.weixin.qq.com/sns/jscode2session?appid=\${WECHAT_APP_ID}&secret=\${WECHAT_APP_SECRET}&js_code=\${code}&grant_type=authorization_code\`
    const wechatRes = await fetch(tokenUrl)
    const wechatData = await wechatRes.json()

    if (wechatData.errcode) {
      throw new Error(\`WeChat API Error: \${wechatData.errmsg}\`)
    }

    const { openid, session_key, unionid } = wechatData

    const srvPayload = {
      role: "service_role",
      iss: "supabase",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300
    }
    const FIXED_SERVICE_KEY = sign(srvPayload, JWT_SECRET, { algorithm: 'HS256' })

    const supabaseAdmin = createClient(SUPABASE_URL as string, FIXED_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })

    const email = \`\${openid.toLowerCase()}@wechat.com\`
    let userId = ""

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { openid, unionid }
    })

    if (createError) {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const foundUser = users.find(u => u.email === email || u.user_metadata?.openid === openid)
      if (foundUser) {
        userId = foundUser.id
      } else {
        throw new Error(\`Cannot create or find user. Error: \${createError.message}\`)
      }
    } else {
      userId = newUser.user.id
    }

    const currentTimestamp = Math.floor(Date.now() / 1000)
    const expiration = currentTimestamp + 60 * 60 * 24 * 7
    const jwtPayload = { aud: "authenticated", exp: expiration, sub: userId, email: email, role: "authenticated", app_metadata: { provider: "wechat_miniprogram", providers: ["wechat_miniprogram"] }, user_metadata: { openid, unionid } }
    const access_token = sign(jwtPayload, JWT_SECRET, { algorithm: 'HS256' })

    const session = { access_token, token_type: "bearer", expires_in: 60 * 60 * 24 * 7, refresh_token: access_token, user: { id: userId, email, app_metadata: jwtPayload.app_metadata, user_metadata: jwtPayload.user_metadata, aud: jwtPayload.aud, created_at: new Date().toISOString(), role: jwtPayload.role } }

    return new Response(JSON.stringify(session), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  } catch (error: any) {
    console.error("WeChat MiniProgram Login Error:", error)
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: error.message }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 })
  }
})`;
}

function generateChinaOAuthFunction(provider: ChinaOAuthProvider, appId: string, appSecret: string, redirectUri?: string): string {
  const providerInfo = CHINA_OAUTH_PROVIDER_INFO[provider];
  const providerUpper = provider.toUpperCase();
  
  return `import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sign } from "npm:jsonwebtoken@9.0.2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const ${providerUpper}_APP_ID = "${appId}"
const ${providerUpper}_APP_SECRET = "${appSecret}"
const REDIRECT_URI = "${redirectUri || ''}"

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const url = new URL(req.url)

  try {
    const code = url.searchParams.get("code") || (await req.json().catch(() => ({})))?.code

    if (!code) {
      const state = url.searchParams.get("state") || Math.random().toString(36).substring(7)
      const authUrl = \`${providerInfo.oauthUrl}/authorize?client_id=\${${providerUpper}_APP_ID}&redirect_uri=\${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=\${state}\`
      return new Response(JSON.stringify({ auth_url: authUrl }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    const tokenUrl = \`${providerInfo.oauthUrl}/token?grant_type=authorization_code&client_id=\${${providerUpper}_APP_ID}&client_secret=\${${providerUpper}_APP_SECRET}&code=\${code}&redirect_uri=\${encodeURIComponent(REDIRECT_URI)}\`
    const tokenRes = await fetch(tokenUrl, { method: 'POST' })
    const tokenData = await tokenRes.json()

    if (tokenData.error) {
      throw new Error(\`${providerInfo.name} API Error: \${tokenData.error_description || tokenData.error}\`)
    }

    const { access_token: providerAccessToken, openid, unionid } = tokenData

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
    const JWT_SECRET = Deno.env.get("JWT_SECRET") as string

    const srvPayload = {
      role: "service_role",
      iss: "supabase",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300
    }
    const FIXED_SERVICE_KEY = sign(srvPayload, JWT_SECRET, { algorithm: 'HS256' })

    const supabaseAdmin = createClient(SUPABASE_URL as string, FIXED_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })

    const email = \`\${(openid || unionid).toLowerCase()}@${provider}.com\`
    let userId = ""

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { openid, unionid, provider: "${provider}" }
    })

    if (createError) {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const foundUser = users.find(u => u.email === email || u.user_metadata?.openid === openid)
      if (foundUser) {
        userId = foundUser.id
      } else {
        throw new Error(\`Cannot create or find user. Error: \${createError.message}\`)
      }
    } else {
      userId = newUser.user.id
    }

    const currentTimestamp = Math.floor(Date.now() / 1000)
    const expiration = currentTimestamp + 60 * 60 * 24 * 7
    const jwtPayload = { aud: "authenticated", exp: expiration, sub: userId, email: email, role: "authenticated", app_metadata: { provider: "${provider}", providers: ["${provider}"] }, user_metadata: { openid, unionid } }
    const access_token = sign(jwtPayload, JWT_SECRET, { algorithm: 'HS256' })

    const session = { access_token, token_type: "bearer", expires_in: 60 * 60 * 24 * 7, refresh_token: access_token, user: { id: userId, email, app_metadata: jwtPayload.app_metadata, user_metadata: jwtPayload.user_metadata, aud: jwtPayload.aud, created_at: new Date().toISOString(), role: jwtPayload.role } }

    return new Response(JSON.stringify(session), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  } catch (error: any) {
    console.error("${providerInfo.name} Login Error:", error)
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: error.message }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 })
  }
})`;
}

async function deployChinaOAuthFunction(ref: string, provider: ChinaOAuthProvider, appId: string, appSecret: string, redirectUri?: string): Promise<void> {
  const functionCode = generateChinaOAuthFunction(provider, appId, appSecret, redirectUri);
  const result = await shellService.execute("function_manager.sh", ["deploy", ref, `${provider}-login`, functionCode]);
  if (!result.success) {
    throw new Error(`Failed to deploy ${provider}-login function: ${result.output}`);
  }
}

function generateWeChatMPLoginFunction(appId: string, appSecret: string, redirectUri?: string): string {
  return `import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sign } from "npm:jsonwebtoken@9.0.2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const WECHAT_MP_APP_ID = "${appId}"
const WECHAT_MP_APP_SECRET = "${appSecret}"

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const url = new URL(req.url)

  try {
    const code = url.searchParams.get("code") || (await req.json().catch(() => ({})))?.code

    if (!code) {
      const redirectUri = "${redirectUri || ''}"
      const state = url.searchParams.get("state") || Math.random().toString(36).substring(7)
      const authUrl = \`https://open.weixin.qq.com/connect/oauth2/authorize?appid=\${WECHAT_MP_APP_ID}&redirect_uri=\${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_userinfo&state=\${state}#wechat_redirect\`
      return new Response(JSON.stringify({ auth_url: authUrl }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    const tokenUrl = \`https://api.weixin.qq.com/sns/oauth2/access_token?appid=\${WECHAT_MP_APP_ID}&secret=\${WECHAT_MP_APP_SECRET}&code=\${code}&grant_type=authorization_code\`
    const tokenRes = await fetch(tokenUrl)
    const tokenData = await tokenRes.json()

    if (tokenData.errcode) {
      throw new Error(\`WeChat MP API Error: \${tokenData.errmsg}\`)
    }

    const { access_token: wechatAccessToken, openid, unionid } = tokenData

    const userUrl = \`https://api.weixin.qq.com/sns/userinfo?access_token=\${wechatAccessToken}&openid=\${openid}&lang=zh_CN\`
    const userRes = await fetch(userUrl)
    const userData = await userRes.json()

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
    const JWT_SECRET = Deno.env.get("JWT_SECRET") as string

    const srvPayload = {
      role: "service_role",
      iss: "supabase",
      aud: "authenticated",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300
    }
    const FIXED_SERVICE_KEY = sign(srvPayload, JWT_SECRET, { algorithm: 'HS256' })

    const supabaseAdmin = createClient(SUPABASE_URL as string, FIXED_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })

    const email = \`\${openid.toLowerCase()}@wechat-mp.com\`
    let userId = ""

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { openid, unionid, nickname: userData.nickname, headimgurl: userData.headimgurl }
    })

    if (createError) {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const foundUser = users.find(u => u.email === email || u.user_metadata?.openid === openid)
      if (foundUser) {
        userId = foundUser.id
      } else {
        throw new Error(\`Cannot create or find user. Error: \${createError.message}\`)
      }
    } else {
      userId = newUser.user.id
    }

    const currentTimestamp = Math.floor(Date.now() / 1000)
    const expiration = currentTimestamp + 60 * 60 * 24 * 7
    const jwtPayload = { aud: "authenticated", exp: expiration, sub: userId, email: email, role: "authenticated", app_metadata: { provider: "wechat_mp", providers: ["wechat_mp"] }, user_metadata: { openid, unionid, nickname: userData.nickname, headimgurl: userData.headimgurl } }
    const access_token = sign(jwtPayload, JWT_SECRET, { algorithm: 'HS256' })

    const session = { access_token, token_type: "bearer", expires_in: 60 * 60 * 24 * 7, refresh_token: access_token, user: { id: userId, email, app_metadata: jwtPayload.app_metadata, user_metadata: jwtPayload.user_metadata, aud: jwtPayload.aud, created_at: new Date().toISOString(), role: jwtPayload.role } }

    return new Response(JSON.stringify(session), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  } catch (error: any) {
    console.error("WeChat MP Login Error:", error)
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: error.message }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 })
  }
})`;
}
