import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
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
        const WECHAT_APP_ID = Deno.env.get("WECHAT_APP_ID")
        const WECHAT_APP_SECRET = Deno.env.get("WECHAT_APP_SECRET")
        const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
        const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
        const JWT_SECRET = Deno.env.get("JWT_SECRET") as string
        const PROJECT_REF = Deno.env.get("PROJECT_REF") || ""

        // 1. Get WeChat Session
        const tokenUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}&js_code=${code}&grant_type=authorization_code`
        const wechatRes = await fetch(tokenUrl)
        const wechatData = await wechatRes.json()

        if (wechatData.errcode) {
            throw new Error(`WeChat API Error: ${wechatData.errmsg}`)
        }

        const { openid, session_key, unionid } = wechatData
        console.log("[wechat-login] Real openid from WeChat:", openid)

        // 补丁：手动签发一个带 aud 的 Service Role Token
        const srvPayload = {
            role: "service_role",
            iss: "supabase",
            aud: "authenticated",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300 // 5 minutes
        }
        const FIXED_SERVICE_KEY = sign(srvPayload, JWT_SECRET, { algorithm: 'HS256' })

        const supabaseAdmin = createClient(SUPABASE_URL as string, FIXED_SERVICE_KEY, {
            auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
            global: { headers: PROJECT_REF ? { "X-Project-Ref": PROJECT_REF } : {} }
        })

        // 3. Find or Create User
        const rawEmail = `${openid}@wechat.com`
        const email = `${openid.toLowerCase()}@wechat.com`
        console.log(`[wechat-login] Attempting createUser with email: ${email}`)

        let userId = ""
        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email, email_confirm: true, user_metadata: { openid, unionid }
        })

        if (createError) {
            console.warn(`[wechat-login] createUser failed: ${createError.message}. Searching listUsers for openid: ${openid} or email: ${email}`)
            const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
            if (listError) throw listError
            console.log(`[wechat-login] listUsers returned ${users.length} users.`)

            const foundUser = users.find(u => u.email === email || u.user_metadata?.openid === openid || u.email === rawEmail || u.email === rawEmail.toLowerCase())
            if (foundUser) {
                userId = foundUser.id
                console.log("[wechat-login] Found existing user:", userId, foundUser.email)
            } else {
                console.error("[wechat-login] Cannot find user in DB! Dump emails:", users.map(u => u.email).join(", "))
                throw new Error(`Cannot create or find user. createUser Error: ${createError.message}`)
            }
        } else {
            userId = newUser.user.id
            console.log("[wechat-login] Created new user:", userId)
        }

        const currentTimestamp = Math.floor(Date.now() / 1000)
        const expiration = currentTimestamp + 60 * 60 * 24 * 7 // 7 days
        const jwtPayload = { aud: "authenticated", exp: expiration, sub: userId, email: email, role: "authenticated", app_metadata: { provider: "wechat", providers: ["wechat"] }, user_metadata: { openid, unionid } }
        const access_token = sign(jwtPayload, JWT_SECRET, { algorithm: 'HS256' })

        const session = { access_token, token_type: "bearer", expires_in: 60 * 60 * 24 * 7, refresh_token: access_token, user: { id: userId, email, app_metadata: jwtPayload.app_metadata, user_metadata: jwtPayload.user_metadata, aud: jwtPayload.aud, created_at: new Date().toISOString(), role: jwtPayload.role } }

        return new Response(JSON.stringify(session), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
    } catch (error: any) {
        console.error("WeChat Login Error:", error)
        const msg = error?.message || String(error)
        return new Response(JSON.stringify({ data: { session: null, user: null }, error: msg, message: msg }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 })
    }
})
