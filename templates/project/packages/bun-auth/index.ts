
import { serve, SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";

// Environment Variables
const SUPABASE_URL = process.env.SUPABASE_URL || "http://kong:8000";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const JWT_SECRET = process.env.JWT_SECRET;

const WECHAT_MINIAPP_APPID = process.env.WECHAT_MINIAPP_APPID;
const WECHAT_MINIAPP_SECRET = process.env.WECHAT_MINIAPP_SECRET;

const WECHAT_OFFICIAL_APPID = process.env.WECHAT_OFFICIAL_APPID;
const WECHAT_OFFICIAL_SECRET = process.env.WECHAT_OFFICIAL_SECRET;
const EXTERNAL_URL = process.env.EXTERNAL_URL || "http://localhost:9000"; // Self URL

if (!SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET || !SUPABASE_DB_URL) {
    console.error("Missing required env vars: SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, or SUPABASE_DB_URL");
    process.exit(1);
}

// Exportable Dependencies for Mocking
export const deps = {
    serve,
    sql: new SQL(SUPABASE_DB_URL!),
    supabaseAdmin: createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }),
    fetch: fetch
};


// Helper: Sign Supabase Compatible JWT
function signSupabaseToken(user: any) {
    const payload = {
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7), // 7 Days
        sub: user.id,
        email: user.email,
        role: "authenticated",
        app_metadata: { provider: "wechat", ...user.app_metadata },
        user_metadata: { ...user.user_metadata }
    };
    return jwt.sign(payload, JWT_SECRET!);
}

// Helper: WeChat MiniApp Code to Session
async function code2Session(code: string) {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_MINIAPP_APPID}&secret=${WECHAT_MINIAPP_SECRET}&js_code=${code}&grant_type=authorization_code`;
    const res = await deps.fetch(url);
    const data: any = await res.json();
    if (data.errcode) {
        throw new Error(`WeChat MiniApp Error: ${data.errmsg}`);
    }
    return data; // { openid, session_key, unionid }
}

// Helper: WeChat Web Code to Access Token (Official Account)
async function webCode2Session(code: string) {
    const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT_OFFICIAL_APPID}&secret=${WECHAT_OFFICIAL_SECRET}&code=${code}&grant_type=authorization_code`;
    const res = await deps.fetch(url);
    const data: any = await res.json();
    if (data.errcode) throw new Error(`WeChat Web Error: ${data.errmsg}`);
    return data;
}

// Helper: Get Web User Info
async function getWebUserInfo(accessToken: string, openid: string) {
    const url = `https://api.weixin.qq.com/sns/userinfo?access_token=${accessToken}&openid=${openid}&lang=zh_CN`;
    const res = await deps.fetch(url);
    const data: any = await res.json();
    if (data.errcode) throw new Error(`WeChat UserInfo Error: ${data.errmsg}`);
    return data;
}

// Shared User Creation Logic
async function findOrCreateUser(openid: string, provider: string, userInfo: any) {
    const email = `${openid}@${provider}.com`;

    const { data: newUser, error: createError } = await deps.supabaseAdmin.auth.admin.createUser({
        email: email,
        email_confirm: true,
        user_metadata: {
            openid: openid,
            ...userInfo
        }
    });

    if (createError) {
        // Fallback or Check Exist
        const users = await deps.sql`SELECT id FROM auth.users WHERE email = ${email} LIMIT 1`;
        if (users.length > 0) {
            return users[0].id; // Existing ID
        } else {
            throw new Error("User creation failed: " + createError.message);
        }
    } else {
        return newUser.user.id;
    }
}


// Web Server Handler
export const handler = async (req: Request) => {
    const url = new URL(req.url);

    // Health Check
    if (url.pathname === "/health") return new Response("OK");

    // 1. WeChat MiniApp Login
    if (url.pathname === "/auth/wechat/miniapp" && req.method === "POST") {
        try {
            const body = await req.json() as { code: string; userInfo: any };
            const { code, userInfo } = body;
            if (!code) return new Response("Missing code", { status: 400 });

            const wxSession: any = await code2Session(code);
            const userId = await findOrCreateUser(wxSession.openid, 'wechat', { ...userInfo, unionid: wxSession.unionid });
            const token = signSupabaseToken({
                id: userId,
                email: `${wxSession.openid}@wechat.com`,
                app_metadata: { provider: 'wechat', openid: wxSession.openid },
                user_metadata: userInfo
            });

            return Response.json({
                access_token: token,
                token_type: "bearer",
                expires_in: 60 * 60 * 24 * 7,
                refresh_token: token,
                user: { id: userId, email: `${wxSession.openid}@wechat.com` }
            });

        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }

    // 2. WeChat Official Account (Web) Login - Redirect to WeChat
    if (url.pathname === "/auth/wechat/web/login" && req.method === "GET") {
        const redirectUrl = url.searchParams.get("redirect_url") || "/";
        // Encode the target redirect_url into state or callback param logic if needed.
        // Here we just use a fixed callback and maybe pass redirect_url as state?
        // State has length limit. Let's assume we redirect to a fixed frontend route after callback.

        const callbackUrl = encodeURIComponent(`${EXTERNAL_URL}/auth/wechat/web/callback?target=${encodeURIComponent(redirectUrl)}`);
        const scope = "snsapi_userinfo";
        const wxAuthUrl = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${WECHAT_OFFICIAL_APPID}&redirect_uri=${callbackUrl}&response_type=code&scope=${scope}&state=STATE#wechat_redirect`;

        return Response.redirect(wxAuthUrl, 302);
    }

    // 3. WeChat Official Account (Web) Callback
    if (url.pathname === "/auth/wechat/web/callback" && req.method === "GET") {
        try {
            const code = url.searchParams.get("code");
            const target = url.searchParams.get("target") || "/";

            if (!code) return new Response("Missing code", { status: 400 });

            // Exchange Code
            const tokens: any = await webCode2Session(code);
            // Get User Info
            const userInfo: any = await getWebUserInfo(tokens.access_token, tokens.openid);

            // Create/Find User
            const userId = await findOrCreateUser(tokens.openid, 'wechat_web', userInfo);

            // Sign Token
            const token = signSupabaseToken({
                id: userId,
                email: `${tokens.openid}@wechat_web.com`,
                app_metadata: { provider: 'wechat_web', openid: tokens.openid },
                user_metadata: userInfo
            });

            // Redirect back to frontend with Token
            // Append token to hash
            const finalRedirect = `${target}#access_token=${token}&refresh_token=${token}&expires_in=604800`;

            return Response.redirect(finalRedirect, 302);

        } catch (e: any) {
            return new Response(`Login Failed: ${e.message}`, { status: 500 });
        }
    }

    return new Response("Not Found", { status: 404 });
};

export { signSupabaseToken };

if (import.meta.main) {
    const server = deps.serve({
        port: 9000,
        fetch: handler
    });
    console.log(`Auth Service running on port ${server.port}`);
}
