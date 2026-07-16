import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { edgeFunctionService } from "../services/edge-function.service";
import { runtimeCacheService } from "../services/runtime-cache.service";
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

      const secretsSaved = await projectService.upsertSecrets(params.ref, [
        { name: "WECHAT_MINIPROGRAM_APP_ID", value: body.app_id },
        { name: "WECHAT_MINIPROGRAM_APP_SECRET", value: body.app_secret },
      ]);
      if (!secretsSaved) {
        return status(500, { message: "Failed to save WeChat Mini Program credentials", code: "500" });
      }
      await runtimeCacheService.invalidateProjectRuntimeEnv(params.ref);

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      if (body.deploy_function !== false) {
        try {
          await deployWeChatMiniProgramFunction(params.ref);
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

      const runtimeSecrets = [
        { name: "WECHAT_MP_APP_ID", value: body.app_id },
        { name: "WECHAT_MP_APP_SECRET", value: body.app_secret },
        ...(body.redirect_uri ? [{ name: "WECHAT_MP_REDIRECT_URI", value: body.redirect_uri }] : []),
      ];
      if (!body.redirect_uri) {
        await projectService.deleteSecret(params.ref, "WECHAT_MP_REDIRECT_URI");
      }
      const secretsSaved = await projectService.upsertSecrets(params.ref, runtimeSecrets);
      if (!secretsSaved) {
        return status(500, { message: "Failed to save WeChat Official Account credentials", code: "500" });
      }
      await runtimeCacheService.invalidateProjectRuntimeEnv(params.ref);

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          external: updatedExternal,
        },
      });

      if (body.deploy_function !== false) {
        try {
          await deployWeChatMPFunction(params.ref);
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

async function deployWeChatMiniProgramFunction(ref: string): Promise<void> {
  const functionCode = generateWeChatMiniProgramLoginFunction();
  const ok = await edgeFunctionService.deploy(ref, "wechat-login", functionCode);
  if (!ok) {
    throw new Error("Failed to deploy wechat-login function");
  }
}

async function deployWeChatMPFunction(ref: string): Promise<void> {
  const functionCode = generateWeChatMPLoginFunction();
  const ok = await edgeFunctionService.deploy(ref, "wechat-mp-login", functionCode);
  if (!ok) {
    throw new Error("Failed to deploy wechat-mp-login function");
  }
}

/**
 * Keep generated auth functions self-contained.
 *
 * A function is bundled from its tenant directory, so importing
 * `@supabase/supabase-js` here is not reliable: the management API's
 * node_modules directory is not on the tenant resolver path. The small
 * fetch wrapper below mirrors the Admin API calls used by the SDK without
 * introducing a runtime package dependency.
 */
function generateGoTrueAdminHelpers(): string {
  return `
function runtimeEnv(name) {
  const value = Bun.env[name]
  return typeof value === "string" ? value.trim() : ""
}

function resolveAuthUrl() {
  const configured = runtimeEnv("SUPACLOUD_INTERNAL_AUTH_URL") || runtimeEnv("SUPABASE_URL")
  if (!configured) throw new Error("Supabase URL is not configured")
  const base = configured.replace(/\\/+$/, "")
  return base.endsWith("/auth/v1") ? base : base + "/auth/v1"
}

function authHeaders() {
  const serviceRoleKey = runtimeEnv("SUPABASE_SERVICE_ROLE_KEY")
  if (!serviceRoleKey) throw new Error("Supabase service role key is not configured")
  const headers = {
    "apikey": serviceRoleKey,
    "Authorization": "Bearer " + serviceRoleKey,
    "Accept": "application/json",
  }
  const projectRef = runtimeEnv("X_PROJECT_REF") || runtimeEnv("SUPACLOUD_PROJECT_REF")
  if (projectRef) headers["x-project-ref"] = projectRef
  return headers
}

async function authRequest(path, options = {}) {
  const headers = { ...authHeaders(), ...(options.headers || {}) }
  if (options.body !== undefined) headers["Content-Type"] = "application/json"
  const response = await fetch(resolveAuthUrl() + "/" + String(path).replace(/^\\/+/, ""), {
    method: options.method || "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let payload = null
  if (text.trim()) {
    try { payload = JSON.parse(text) } catch { payload = text }
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object"
      ? payload.msg || payload.message || payload.error_description || payload.error || payload.code
      : payload
    throw new Error("GoTrue request failed (" + response.status + "): " + (detail || response.statusText || "unknown error"))
  }
  return payload
}

async function createWechatSession(email, userMetadata, provider) {
  try {
    await authRequest("admin/users", { body: {
      email,
      email_confirm: true,
      user_metadata: { ...userMetadata, provider },
    }})
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (!message.includes("already registered") && !message.includes("already exists")) {
      throw new Error("Cannot create user. Error: " + (error instanceof Error ? error.message : String(error)))
    }
  }

  const rawLinkData = await authRequest("admin/generate_link", {
    body: { type: "magiclink", email },
  })
  const linkData = rawLinkData?.data?.properties ? rawLinkData.data : rawLinkData
  const hashedToken = linkData?.properties?.hashed_token || linkData?.hashed_token
  if (!hashedToken) throw new Error("Failed to generate magic link")

  const rawSessionData = await authRequest("verify", {
    body: { type: "magiclink", token_hash: hashedToken, gotrue_meta_security: {} },
  })
  const sessionData = rawSessionData?.data?.session
    ? { ...rawSessionData.data.session, user: rawSessionData.data.user || rawSessionData.data.session.user }
    : rawSessionData
  const session = sessionData && sessionData.access_token && sessionData.refresh_token && sessionData.expires_in
    ? { ...sessionData, expires_at: sessionData.expires_at || Math.floor(Date.now() / 1000) + Number(sessionData.expires_in) }
    : null
  const user = sessionData?.user || null
  if (!session || !user?.id) throw new Error("Failed to verify GoTrue session")

  await authRequest("admin/users/" + encodeURIComponent(user.id), { method: "PUT", body: {
    user_metadata: { ...(user.user_metadata || {}), ...userMetadata, provider },
    app_metadata: { ...(user.app_metadata || {}), provider, providers: [provider] },
  }})

  return { session, user }
}

async function getAuthUser(userId) {
  const payload = await authRequest("admin/users/" + encodeURIComponent(userId), { method: "GET" })
  return payload?.user || payload
}
`;
}

function generateWeChatMiniProgramLoginFunction(): string {
  return `import { SQL } from "bun"

${generateGoTrueAdminHelpers()}

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

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  try {
    const body = await req.json()
    const code = body && typeof body.code === "string" ? body.code : ""
    if (!code) throw new Error("WeChat login code is required")
    const WECHAT_APP_ID = runtimeEnv("WECHAT_MINIPROGRAM_APP_ID")
    const WECHAT_APP_SECRET = runtimeEnv("WECHAT_MINIPROGRAM_APP_SECRET")
    if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) throw new Error("WeChat Mini Program credentials are not configured")

    const tokenUrl = \`https://api.weixin.qq.com/sns/jscode2session?appid=\${WECHAT_APP_ID}&secret=\${WECHAT_APP_SECRET}&js_code=\${code}&grant_type=authorization_code\`
    const wechatRes = await fetch(tokenUrl)
    const wechatData = await wechatRes.json()

    if (wechatData.errcode) {
      throw new Error(\`WeChat API Error: \${wechatData.errmsg}\`)
    }

    const { openid, session_key, unionid } = wechatData

    const email = \`\${openid.toLowerCase()}@wechat.com\`

    const { session, user: sessionUser } = await createWechatSession(
      email,
      { openid, unionid },
      "wechat_miniprogram",
    )

    // Explicitly link physical identity row mirroring real OAuth behavior
    const SUPABASE_DB_URL = Bun.env["SUPABASE_DB_URL"]
    if (SUPABASE_DB_URL) {
      const sql = new SQL(SUPABASE_DB_URL)
      try {
        await sql\`
          INSERT INTO auth.identities (id, user_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
          VALUES (\${openid}, \${sessionUser.id}, 'wechat_miniprogram', \${JSON.stringify({ sub: openid, unionid })}::jsonb, NOW(), NOW(), NOW())
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
    const finalUser = await getAuthUser(sessionUser.id)
    const finalSession = { ...session, user: finalUser || sessionUser }
    const responseUser = finalSession.user ?? null
    // Embed native OAuth provider tokens to complete the session payload matching Official Supabase
    if (session_key) (finalSession as any).provider_token = session_key;

    // 包裹在 { data: { session, user } } 中，符合 supabase-mp-js 的 signInWithWechat 契约
    // signInWithWechat 从 responseData.data.session 和 responseData.data.user 解构 session/user
    return new Response(JSON.stringify({ data: { session: finalSession, user: responseUser } }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" } })
  } catch (error: unknown) {
    console.error("WeChat MiniProgram Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" }, status: 400 })
  }
}`;
}

function generateWeChatMPLoginFunction(): string {
  return `import { SQL } from "bun"

${generateGoTrueAdminHelpers()}

const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Vary": "Origin",
}

function corsOriginHeader(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (!origin) return {};
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

const WECHAT_MP_APP_ID = runtimeEnv("WECHAT_MP_APP_ID")
const WECHAT_MP_APP_SECRET = runtimeEnv("WECHAT_MP_APP_SECRET")

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const url = new URL(req.url)

  try {
    if (!WECHAT_MP_APP_ID || !WECHAT_MP_APP_SECRET) throw new Error("WeChat Official Account credentials are not configured")
    const code = url.searchParams.get("code") || (await req.json().catch(() => ({})))?.code

    if (!code) {
      const redirectUri = runtimeEnv("WECHAT_MP_REDIRECT_URI")
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

    const email = \`\${openid.toLowerCase()}@wechat-mp.com\`

    const { session, user: sessionUser } = await createWechatSession(
      email,
      { openid, unionid, nickname: userData.nickname, headimgurl: userData.headimgurl },
      "wechat_mp",
    )

    // Explicitly link physical identity row mirroring real OAuth behavior
    const SUPABASE_DB_URL = Bun.env["SUPABASE_DB_URL"]
    if (SUPABASE_DB_URL) {
      const sql = new SQL(SUPABASE_DB_URL)
      try {
        await sql\`
          INSERT INTO auth.identities (id, user_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
          VALUES (\${openid}, \${sessionUser.id}, \${'wechat_mp'}, CAST(\${JSON.stringify({ sub: openid, unionid, nickname: userData.nickname, headimgurl: userData.headimgurl })} AS jsonb), NOW(), NOW(), NOW())
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
    const finalUser = await getAuthUser(sessionUser.id)
    const finalSession = { ...session, user: finalUser || sessionUser }
    const responseUser = finalSession.user ?? null
    // Embed native OAuth provider tokens to complete the session payload matching Official Supabase
    if (tokenData.access_token) (finalSession as any).provider_token = tokenData.access_token;
    if (tokenData.refresh_token) (finalSession as any).provider_refresh_token = tokenData.refresh_token;

    // 包裹在 { data: { session, user } } 中，符合 supabase-mp-js 的 signInWithWechat 契约
    return new Response(JSON.stringify({ data: { session: finalSession, user: responseUser } }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" } })
  } catch (error: unknown) {
    console.error("WeChat MP Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" }, status: 400 })
  }
}`;
}

export const wechatAuthInternals = {
  generateWeChatMiniProgramLoginFunction,
  generateWeChatMPLoginFunction,
};
