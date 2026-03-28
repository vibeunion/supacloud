import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { edgeFunctionService } from "../services/edge-function.service";
import { CHINA_OAUTH_PROVIDER_INFO } from "../types/oauth";
import type { ChinaOAuthProvider } from "../types/oauth";

const CHINA_PROVIDERS: ChinaOAuthProvider[] = ["qq", "weibo", "alipay", "dingtalk", "douyin", "baidu", "huawei", "xiaomi", "kuaishou", "bilibili"];

/**
 * China OAuth provider routes — QQ, Weibo, Alipay, DingTalk, Douyin, etc.
 */
export const chinaAuthRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .get(
    "/china/providers",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        return status(404, { error: "Project not found" });
      }

      const oauthConfig = ((settings.auth as Record<string, unknown>)?.external ?? {}) as Record<string, Record<string, string>>;
      const result: Record<string, unknown> = {};

      for (const provider of CHINA_PROVIDERS) {
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

      if (!CHINA_PROVIDERS.includes(provider)) {
        set.status = 400;
        return { error: `Unsupported China OAuth provider: ${provider}` };
      }

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
        } catch (error: unknown) {
          logger.error(`Failed to deploy ${provider}-login function:`, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      const info = CHINA_OAUTH_PROVIDER_INFO[provider];
      return {
        provider,
        enabled: true,
        name: info.name,
        message: `${info.name} login configured successfully`,
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

// --- Deploy helper functions ---

async function deployChinaOAuthFunction(ref: string, provider: ChinaOAuthProvider, appId: string, appSecret: string, redirectUri?: string): Promise<void> {
  const functionCode = generateChinaOAuthFunction(provider, appId, appSecret, redirectUri);
  const ok = await edgeFunctionService.deploy(ref, `${provider}-login`, functionCode);
  if (!ok) {
    throw new Error(`Failed to deploy ${provider}-login function`);
  }
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
  } catch (error: unknown) {
    console.error("${providerInfo.name} Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 })
  }
})`;
}
