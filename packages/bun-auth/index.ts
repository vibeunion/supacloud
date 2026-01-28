
import { serve, SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { AuthCore, type AuthConfig } from "./core.ts";

const config: AuthConfig = {
    SUPABASE_URL: process.env.SUPABASE_URL || "http://kong:8000",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    SUPABASE_DB_URL: process.env.SUPABASE_DB_URL!,
    JWT_SECRET: process.env.JWT_SECRET!,
    WECHAT_MINIAPP_APPID: process.env.WECHAT_MINIAPP_APPID,
    WECHAT_MINIAPP_SECRET: process.env.WECHAT_MINIAPP_SECRET,
    WECHAT_OFFICIAL_APPID: process.env.WECHAT_OFFICIAL_APPID,
    WECHAT_OFFICIAL_SECRET: process.env.WECHAT_OFFICIAL_SECRET,
    EXTERNAL_URL: process.env.EXTERNAL_URL || "http://localhost:9000"
};

if (!config.SUPABASE_SERVICE_ROLE_KEY || !config.JWT_SECRET || !config.SUPABASE_DB_URL) {
    console.error("Missing required env vars: SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, or SUPABASE_DB_URL");
    process.exit(1);
}

// Export dependencies for mocking
export const deps = {
    serve,
    sql: new SQL(config.SUPABASE_DB_URL),
    supabaseAdmin: createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }),
    fetch: fetch
};

const core = new AuthCore(deps, config);

export const handler = core.handler;
// Export helper for testing, bound to core instance to access config
export const signSupabaseToken = core.signSupabaseToken.bind(core);

if (import.meta.main) {
    const server = deps.serve({
        port: 9000,
        fetch: handler
    });
    console.log(`Auth Service running on port ${server.port}`);
}
