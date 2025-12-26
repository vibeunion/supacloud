
import { SupabaseClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";

export interface AuthConfig {
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    SUPABASE_DB_URL: string;
    JWT_SECRET: string;
    WECHAT_MINIAPP_APPID?: string;
    WECHAT_MINIAPP_SECRET?: string;
    WECHAT_OFFICIAL_APPID?: string;
    WECHAT_OFFICIAL_SECRET?: string;
    EXTERNAL_URL: string;
}

export interface AuthDeps {
    sql: any;
    supabaseAdmin: SupabaseClient;
    fetch: typeof fetch;
}

export class AuthCore {
    constructor(private deps: AuthDeps, private config: AuthConfig) { }

    // Helper: Sign Supabase Compatible JWT
    signSupabaseToken(user: any) {
        const payload = {
            aud: "authenticated",
            exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7), // 7 Days
            sub: user.id,
            email: user.email,
            role: "authenticated",
            app_metadata: { provider: "wechat", ...user.app_metadata },
            user_metadata: { ...user.user_metadata }
        };
        return jwt.sign(payload, this.config.JWT_SECRET);
    }

    // Helper: WeChat MiniApp Code to Session
    async code2Session(code: string) {
        const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${this.config.WECHAT_MINIAPP_APPID}&secret=${this.config.WECHAT_MINIAPP_SECRET}&js_code=${code}&grant_type=authorization_code`;
        const res = await this.deps.fetch(url);
        const data: any = await res.json();
        if (data.errcode) {
            throw new Error(`WeChat MiniApp Error: ${data.errmsg}`);
        }
        return data; // { openid, session_key, unionid }
    }

    // Helper: WeChat Web Code to Access Token (Official Account)
    async webCode2Session(code: string) {
        const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${this.config.WECHAT_OFFICIAL_APPID}&secret=${this.config.WECHAT_OFFICIAL_SECRET}&code=${code}&grant_type=authorization_code`;
        const res = await this.deps.fetch(url);
        const data: any = await res.json();
        if (data.errcode) throw new Error(`WeChat Web Error: ${data.errmsg}`);
        return data;
    }

    // Helper: Get Web User Info
    async getWebUserInfo(accessToken: string, openid: string) {
        const url = `https://api.weixin.qq.com/sns/userinfo?access_token=${accessToken}&openid=${openid}&lang=zh_CN`;
        const res = await this.deps.fetch(url);
        const data: any = await res.json();
        if (data.errcode) throw new Error(`WeChat UserInfo Error: ${data.errmsg}`);
        return data;
    }

    // Shared User Creation Logic
    async findOrCreateUser(openid: string, provider: string, userInfo: any) {
        const email = `${openid}@${provider}.com`;

        const { data: newUser, error: createError } = await this.deps.supabaseAdmin.auth.admin.createUser({
            email: email,
            email_confirm: true,
            user_metadata: {
                openid: openid,
                ...userInfo
            }
        });

        if (createError) {
            // Fallback or Check Exist
            // Use deps.sql tagged template style
            const users = await this.deps.sql`SELECT id FROM auth.users WHERE email = ${email} LIMIT 1`;
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
    handler = async (req: Request) => {
        const url = new URL(req.url);

        // Health Check
        if (url.pathname === "/health") return new Response("OK");

        // 1. WeChat MiniApp Login
        if (url.pathname === "/auth/wechat/miniapp" && req.method === "POST") {
            try {
                const body = await req.json() as { code: string; userInfo: any };
                const { code, userInfo } = body;
                if (!code) return new Response("Missing code", { status: 400 });

                const wxSession: any = await this.code2Session(code);
                const userId = await this.findOrCreateUser(wxSession.openid, 'wechat', { ...userInfo, unionid: wxSession.unionid });
                const token = this.signSupabaseToken({
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

            const callbackUrl = encodeURIComponent(`${this.config.EXTERNAL_URL}/auth/wechat/web/callback?target=${encodeURIComponent(redirectUrl)}`);
            const scope = "snsapi_userinfo";
            const wxAuthUrl = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${this.config.WECHAT_OFFICIAL_APPID}&redirect_uri=${callbackUrl}&response_type=code&scope=${scope}&state=STATE#wechat_redirect`;

            return Response.redirect(wxAuthUrl, 302);
        }

        // 3. WeChat Official Account (Web) Callback
        if (url.pathname === "/auth/wechat/web/callback" && req.method === "GET") {
            try {
                const code = url.searchParams.get("code");
                const target = url.searchParams.get("target") || "/";

                if (!code) return new Response("Missing code", { status: 400 });

                // Exchange Code
                const tokens: any = await this.webCode2Session(code);
                // Get User Info
                const userInfo: any = await this.getWebUserInfo(tokens.access_token, tokens.openid);

                // Create/Find User
                const userId = await this.findOrCreateUser(tokens.openid, 'wechat_web', userInfo);

                // Sign Token
                const token = this.signSupabaseToken({
                    id: userId,
                    email: `${tokens.openid}@wechat_web.com`,
                    app_metadata: { provider: 'wechat_web', openid: tokens.openid },
                    user_metadata: userInfo
                });

                // Redirect back to frontend with Token
                const finalRedirect = `${target}#access_token=${token}&refresh_token=${token}&expires_in=604800`;

                return Response.redirect(finalRedirect, 302);

            } catch (e: any) {
                return new Response(`Login Failed: ${e.message}`, { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    };
}
