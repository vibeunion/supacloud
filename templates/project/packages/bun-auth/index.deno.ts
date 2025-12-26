
import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2.39.8";
import { AuthCore, type AuthConfig } from "./core.ts";

const config: AuthConfig = {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") || "http://kong:8000",
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    SUPABASE_DB_URL: Deno.env.get("SUPABASE_DB_URL")!,
    JWT_SECRET: Deno.env.get("JWT_SECRET")!,
    WECHAT_MINIAPP_APPID: Deno.env.get("WECHAT_MINIAPP_APPID"),
    WECHAT_MINIAPP_SECRET: Deno.env.get("WECHAT_MINIAPP_SECRET"),
    WECHAT_OFFICIAL_APPID: Deno.env.get("WECHAT_OFFICIAL_APPID"),
    WECHAT_OFFICIAL_SECRET: Deno.env.get("WECHAT_OFFICIAL_SECRET"),
    EXTERNAL_URL: Deno.env.get("EXTERNAL_URL") || "http://localhost:9000"
};

if (!config.SUPABASE_SERVICE_ROLE_KEY || !config.JWT_SECRET || !config.SUPABASE_DB_URL) {
    console.error("Missing required env vars");
    Deno.exit(1);
}

const sql = postgres(config.SUPABASE_DB_URL);

const deps = {
    // postgres.js works as tagged template, compatible with interface
    sql,
    supabaseAdmin: createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }),
    fetch: fetch
};

const core = new AuthCore(deps, config);

if (import.meta.main) {
    console.log(`Auth Service running on port 9000 (Deno)`);
    Deno.serve({ port: 9000 }, core.handler);
}
