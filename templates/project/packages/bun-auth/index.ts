
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

// Helper: WeChat Code to Session
async function code2Session(code: string) {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_MINIAPP_APPID}&secret=${WECHAT_MINIAPP_SECRET}&js_code=${code}&grant_type=authorization_code`;
    const res = await deps.fetch(url);
    const data: any = await res.json();
    if (data.errcode) {
        throw new Error(`WeChat Error: ${data.errmsg}`);
    }
    return data; // { openid, session_key, unionid }
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

            // A. Get OpenID
            const wxSession: any = await code2Session(code);
            const openid = wxSession.openid;
            const unionid = wxSession.unionid; // Optional

            // B. Find or Create User in Supabase
            // We use email hack: openid@wechat.com to reuse standard table
            const email = `${openid}@wechat.com`;
            // B. Find or Create User
            // Strategy: Try to insert via Admin API (safest). If fails, query DB directly for ID.

            let userId;

            const { data: newUser, error: createError } = await deps.supabaseAdmin.auth.admin.createUser({
                email: `${openid}@wechat.com`,
                email_confirm: true,
                user_metadata: {
                    openid: openid,
                    unionid: unionid,
                    ...userInfo
                }
            });

            if (createError) {
                console.log("User likely exists, fetching ID from DB...");
                // Native Bun SQL Query
                // Note: Native bun:sql uses sql("query", [params])
                const users = await deps.sql`SELECT id FROM auth.users WHERE email = ${`${openid}@wechat.com`} LIMIT 1`;

                if (users.length > 0) {
                    userId = users[0].id;
                } else {
                    throw new Error("User creation failed and user not found: " + createError.message);
                }
            } else {
                userId = newUser.user.id;
            }

            // C. Sign Token
            const token = signSupabaseToken({
                id: userId,
                email: `${openid}@wechat.com`,
                app_metadata: { provider: 'wechat', openid },
                user_metadata: userInfo
            });

            // Use a dummy refresh token or implement real refresh logic storing in DB
            // For simple usage, long-lived access token is okay, but refresh is better.
            // We can just return the same token as refresh for now (not spec compliant but works).

            return Response.json({
                access_token: token,
                token_type: "bearer",
                expires_in: 60 * 60 * 24 * 7,
                refresh_token: token,
                user: {
                    id: userId,
                    email: `${openid}@wechat.com`,
                    app_metadata: { provider: 'wechat' },
                    user_metadata: userInfo
                }
            });

        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
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

