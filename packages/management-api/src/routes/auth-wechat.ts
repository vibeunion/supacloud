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
        return status(404, { message: "Project not found", code: "404" });
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
      detail: { tags: ["auth"], summary: "Configure WeChat Mini Program login" },
    }
  )

  .post(
    "/wechat/mp",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
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
      detail: { tags: ["auth"], summary: "Configure WeChat Official Account login" },
    }
  )

  .post(
    "/wechat/open",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { message: "Project not found", code: "404" });
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
        const { config } = await import("../config");
        const apiExternalUrl = project?.api?.url || `https://${params.ref}.api.${config.baseDomain || 'localhost'}`;
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
      detail: { tags: ["auth"], summary: "Configure WeChat Open Platform login" },
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
  return `import { createClient } from "@supabase/supabase-js"
import { SQL } from "bun"

const corsHeaders = {
  "Access-Control-Allow-Origin": "",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Vary": "Origin",
}

function corsOriginHeader(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (!origin) return {};
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  try {
    const { code } = await req.json()
    const WECHAT_APP_ID = Bun.env["WECHAT_MINIPROGRAM_APP_ID"] || "${appId}"
    const WECHAT_APP_SECRET = Bun.env["WECHAT_MINIPROGRAM_APP_SECRET"] || "${appSecret}"
    const SUPABASE_URL = Bun.env["SUPABASE_URL"]
    const SUPABASE_SERVICE_ROLE_KEY = Bun.env["SUPABASE_SERVICE_ROLE_KEY"]

    const tokenUrl = \`https://api.weixin.qq.com/sns/jscode2session?appid=\${WECHAT_APP_ID}&secret=\${WECHAT_APP_SECRET}&js_code=\${code}&grant_type=authorization_code\`
    const wechatRes = await fetch(tokenUrl)
    const wechatData = await wechatRes.json()

    if (wechatData.errcode) {
      throw new Error(\`WeChat API Error: \${wechatData.errmsg}\`)
    }

    const { openid, session_key, unionid } = wechatData

    const supabaseAdmin = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })

    const email = \`\${openid.toLowerCase()}@wechat.com\`

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { openid, unionid, provider: "wechat_miniprogram" }
    })

    if (createError && !(createError.message.toLowerCase().includes("already registered") || createError.message.toLowerCase().includes("already exists"))) {
      throw new Error(\`Cannot create user. Error: \${createError.message}\`)
    }

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: email,
    })

    if (linkError || !linkData?.properties?.hashed_token) {
      throw new Error(\`Failed to generate magic link: \${linkError?.message}\`)
    }

    const { data: sessionData, error: verifyError } = await supabaseAdmin.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    })

    if (verifyError || !sessionData?.session) {
      throw new Error(\`Failed to verify GoTrue session: \${verifyError?.message}\`)
    }

    await supabaseAdmin.auth.admin.updateUserById(sessionData.user.id, {
        user_metadata: { ...sessionData.user.user_metadata, openid, unionid, provider: "wechat_miniprogram" },
        app_metadata: { ...sessionData.user.app_metadata, provider: "wechat_miniprogram", providers: ["wechat_miniprogram"] }
    })

    // Explicitly link physical identity row mirroring real OAuth behavior
    const SUPABASE_DB_URL = Bun.env["SUPABASE_DB_URL"]
    if (SUPABASE_DB_URL) {
      const sql = new SQL(SUPABASE_DB_URL)
      try {
        await sql\`
          INSERT INTO auth.identities (id, user_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
          VALUES (\${openid}, \${sessionData.user.id}, 'wechat_miniprogram', \${JSON.stringify({ sub: openid, unionid })}::jsonb, NOW(), NOW(), NOW())
          ON CONFLICT (provider, id) DO UPDATE 
          SET identity_data = EXCLUDED.identity_data, last_sign_in_at = EXCLUDED.last_sign_in_at, updated_at = EXCLUDED.updated_at
        \`
      } catch (e) {
        console.error("Identity linkage failed:", e)
      } finally {
        await sql.close()
      }
    }

    // Refetch the user to bundle the completed identity payload within the first session
    const { data: finalUser } = await supabaseAdmin.auth.admin.getUserById(sessionData.user.id)
    const finalSession = finalUser?.user ? { ...sessionData.session, user: finalUser.user } : sessionData.session
    // Embed native OAuth provider tokens to complete the session payload matching Official Supabase
    if (session_key) (finalSession as any).provider_token = session_key;

    return new Response(JSON.stringify(finalSession), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" } })
  } catch (error: unknown) {
    console.error("WeChat MiniProgram Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" }, status: 400 })
  }
})`;
}

function generateWeChatMPLoginFunction(appId: string, appSecret: string, redirectUri?: string): string {
  return `import { createClient } from "@supabase/supabase-js"
import { SQL } from "bun"

const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Vary": "Origin",
}

function corsOriginHeader(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (!origin) return {};
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

const WECHAT_MP_APP_ID = "${appId}"
const WECHAT_MP_APP_SECRET = "${appSecret}"

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const url = new URL(req.url)

  try {
    const code = url.searchParams.get("code") || (await req.json().catch(() => ({})))?.code

    if (!code) {
      const redirectUri = "${redirectUri || ''}"
      const state = url.searchParams.get("state") || Math.random().toString(36).substring(7)
      const authUrl = \`https://open.weixin.qq.com/connect/oauth2/authorize?appid=\${WECHAT_MP_APP_ID}&redirect_uri=\${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_userinfo&state=\${state}#wechat_redirect\`
      return new Response(JSON.stringify({ auth_url: authUrl }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" } })
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

    const SUPABASE_URL = Bun.env["SUPABASE_URL"]
    const SUPABASE_SERVICE_ROLE_KEY = Bun.env["SUPABASE_SERVICE_ROLE_KEY"]

    const supabaseAdmin = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })

    const email = \`\${openid.toLowerCase()}@wechat-mp.com\`

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { openid, unionid, nickname: userData.nickname, headimgurl: userData.headimgurl, provider: "wechat_mp" }
    })

    if (createError && !(createError.message.toLowerCase().includes("already registered") || createError.message.toLowerCase().includes("already exists"))) {
      throw new Error(\`Cannot create user. Error: \${createError.message}\`)
    }
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: email,
    })

    if (linkError || !linkData?.properties?.hashed_token) {
      throw new Error(\`Failed to generate magic link: \${linkError?.message}\`)
    }

    const { data: sessionData, error: verifyError } = await supabaseAdmin.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    })

    if (verifyError || !sessionData?.session) {
      throw new Error(\`Failed to verify GoTrue session: \${verifyError?.message}\`)
    }

    await supabaseAdmin.auth.admin.updateUserById(sessionData.user.id, {
        user_metadata: { ...sessionData.user.user_metadata, openid, unionid, nickname: userData.nickname, headimgurl: userData.headimgurl, provider: "wechat_mp" },
        app_metadata: { ...sessionData.user.app_metadata, provider: "wechat_mp", providers: ["wechat_mp"] }
    })

    // Explicitly link physical identity row mirroring real OAuth behavior
    const SUPABASE_DB_URL = Bun.env["SUPABASE_DB_URL"]
    if (SUPABASE_DB_URL) {
      const sql = new SQL(SUPABASE_DB_URL)
      try {
        await sql\`
          INSERT INTO auth.identities (id, user_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
          VALUES (\${openid}, \${sessionData.user.id}, \${'wechat_mp'}, CAST(\${JSON.stringify({ sub: openid, unionid, nickname: userData.nickname, headimgurl: userData.headimgurl })} AS jsonb), NOW(), NOW(), NOW())
          ON CONFLICT (provider, id) DO UPDATE 
          SET identity_data = EXCLUDED.identity_data, last_sign_in_at = EXCLUDED.last_sign_in_at, updated_at = EXCLUDED.updated_at
        \`
      } catch (e) {
        console.error("Identity linkage failed:", e)
      } finally {
        await sql.close()
      }
    }

    // Refetch the user to bundle the completed identity payload within the first session
    const { data: finalUser } = await supabaseAdmin.auth.admin.getUserById(sessionData.user.id)
    const finalSession = finalUser?.user ? { ...sessionData.session, user: finalUser.user } : sessionData.session
    // Embed native OAuth provider tokens to complete the session payload matching Official Supabase
    if (tokenData.access_token) (finalSession as any).provider_token = tokenData.access_token;
    if (tokenData.refresh_token) (finalSession as any).provider_refresh_token = tokenData.refresh_token;

    return new Response(JSON.stringify(finalSession), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" } })
  } catch (error: unknown) {
    console.error("WeChat MP Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" }, status: 400 })
  }
})`;
}
