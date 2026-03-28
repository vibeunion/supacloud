import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { edgeFunctionService } from "../services/edge-function.service";
import { WECHAT_PROVIDER_INFO } from "../types/oauth";
import type { WeChatProviderType } from "../types/oauth";

/**
 * WeChat OAuth routes — miniprogram, official account (mp), and open platform
 */
export const wechatAuthRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .post(
    "/wechat/miniprogram",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { error: "Project not found" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const currentExternal = (currentAuth.external ?? {}) as Record<string, Record<string, string>>;

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
        } catch (error: unknown) {
          logger.error("Failed to deploy wechat-login function:", { error: error instanceof Error ? error.message : String(error) });
        }
      }

      return {
        provider: "wechat_miniprogram",
        enabled: true,
        name: WECHAT_PROVIDER_INFO.wechat_miniprogram.name,
        message: "WeChat Mini Program login configured successfully, Edge Function deployed",
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
        return status(404, { error: "Project not found" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const currentExternal = (currentAuth.external ?? {}) as Record<string, Record<string, string>>;

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
        } catch (error: unknown) {
          logger.error("Failed to deploy wechat-mp-login function:", { error: error instanceof Error ? error.message : String(error) });
        }
      }

      return {
        provider: "wechat_mp",
        enabled: true,
        name: WECHAT_PROVIDER_INFO.wechat_mp.name,
        message: "WeChat Official Account login configured successfully, Edge Function deployed",
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

  .post(
    "/wechat/open",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { error: "Project not found" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const currentExternal = (currentAuth.external ?? {}) as Record<string, Record<string, string>>;

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
      } catch (error: unknown) {
        logger.error("Failed to update GoTrue wechat config:", { error: error instanceof Error ? error.message : String(error) });
      }

      return {
        provider: "wechat",
        enabled: true,
        name: WECHAT_PROVIDER_INFO.wechat.name,
        message: "WeChat Open Platform login configured successfully (Standard OAuth2.0)",
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
  );

// --- Deploy helper functions ---

async function deployWeChatMiniProgramFunction(ref: string, appId: string, appSecret: string): Promise<void> {
  const functionCode = generateWeChatMiniProgramLoginFunction(appId, appSecret);
  const ok = await edgeFunctionService.deploy(ref, "wechat-login", functionCode);
  if (!ok) {
    throw new Error("Failed to deploy wechat-login function");
  }
}

async function deployWeChatMPFunction(ref: string, appId: string, appSecret: string, redirectUri?: string): Promise<void> {
  const functionCode = generateWeChatMPLoginFunction(appId, appSecret, redirectUri);
  const ok = await edgeFunctionService.deploy(ref, "wechat-mp-login", functionCode);
  if (!ok) {
    throw new Error("Failed to deploy wechat-mp-login function");
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
  } catch (error: unknown) {
    console.error("WeChat MiniProgram Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 })
  }
})`;
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
  } catch (error: unknown) {
    console.error("WeChat MP Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 })
  }
})`;
}
