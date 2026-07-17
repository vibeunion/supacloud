import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { edgeFunctionService } from "../services/edge-function.service";
import { CHINA_OAUTH_PROVIDER_INFO } from "../types/oauth";
import type { ChinaOAuthProvider } from "../types/oauth";
import { requireAuthRuntimeManagement } from "./auth-runtime";

const CHINA_PROVIDERS: ChinaOAuthProvider[] = ["qq", "weibo", "alipay", "dingtalk", "douyin", "baidu", "huawei", "xiaomi", "kuaishou", "bilibili"];

/**
 * China OAuth provider routes — QQ, Weibo, Alipay, DingTalk, Douyin, etc.
 */
export const chinaAuthRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .onBeforeHandle(requireAuthRuntimeManagement("providers"))
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
      detail: { tags: ["auth"], summary: "List China OAuth providers" },
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
      detail: { tags: ["auth"], summary: "Configure China OAuth provider" },
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

const ${providerUpper}_APP_ID = "${appId}"
const ${providerUpper}_APP_SECRET = "${appSecret}"
const REDIRECT_URI = "${redirectUri || ''}"

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const url = new URL(req.url)

  try {
    const code = url.searchParams.get("code") || (await req.json().catch(() => ({})))?.code

    if (!code) {
      const state = url.searchParams.get("state") || Math.random().toString(36).substring(7)
      const authUrl = \`${providerInfo.oauthUrl}/authorize?client_id=\${${providerUpper}_APP_ID}&redirect_uri=\${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=\${state}\`
      return new Response(JSON.stringify({ auth_url: authUrl }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" } })
    }

    const tokenUrl = \`${providerInfo.oauthUrl}/token?grant_type=authorization_code&client_id=\${${providerUpper}_APP_ID}&client_secret=\${${providerUpper}_APP_SECRET}&code=\${code}&redirect_uri=\${encodeURIComponent(REDIRECT_URI)}\`
    const tokenRes = await fetch(tokenUrl, { method: 'POST' })
    const tokenData = await tokenRes.json()

    if (tokenData.error) {
      throw new Error(\`${providerInfo.name} API Error: \${tokenData.error_description || tokenData.error}\`)
    }

    const { access_token: providerAccessToken, openid, unionid } = tokenData

    const SUPABASE_URL = Bun.env["SUPABASE_URL"]
    const SUPABASE_SERVICE_ROLE_KEY = Bun.env["SUPABASE_SERVICE_ROLE_KEY"]

    const supabaseAdmin = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })

    const email = \`\${(openid || unionid).toLowerCase()}@${provider}.com\`

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { openid, unionid, provider: "${provider}" }
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

    // Force update user metadata to ensure latest OAuth provider data is present
    await supabaseAdmin.auth.admin.updateUserById(sessionData.user.id, {
      user_metadata: { ...sessionData.user.user_metadata, openid, unionid, provider: "${provider}" },
      app_metadata: { ...sessionData.user.app_metadata, provider: "${provider}", providers: ["${provider}"] }
    })

    // Explicitly link physical identity row mirroring real OAuth behavior
    const SUPABASE_DB_URL = Bun.env["SUPABASE_DB_URL"]
    if (SUPABASE_DB_URL) {
      const sql = new SQL(SUPABASE_DB_URL)
      try {
        await sql\`
          INSERT INTO auth.identities (id, user_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
          VALUES (\${openid || unionid}, \${sessionData.user.id}, \${\`\${provider}\`}, CAST(\${JSON.stringify({ sub: openid || unionid, ...tokenData })} AS jsonb), NOW(), NOW(), NOW())
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
    console.error("${providerInfo.name} Login Error:", error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ data: { session: null, user: null }, error: (error instanceof Error ? error.message : String(error)) }), { headers: { ...corsHeaders, ...corsOriginHeader(req), "Content-Type": "application/json" }, status: 400 })
  }
}`;
}

export const chinaAuthInternals = {
  generateChinaOAuthFunction,
};
