/**
 * Auth — Compound tool (10→1)
 */
import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";

function formatProviders(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { providers?: Record<string, { enabled: boolean; client_id?: string }> };
    const providers = result.providers || {};
    const entries = Object.entries(providers);
    if (entries.length === 0) return "No providers configured.";
    const enabled = entries.filter(([, v]) => v.enabled);
    const disabled = entries.filter(([, v]) => !v.enabled);
    let out = `🔐 OAuth Providers (${enabled.length} enabled / ${disabled.length} disabled):\n\n`;
    if (enabled.length) { out += "✅ Enabled:\n"; for (const [n, c] of enabled) out += `  - ${n}: client_id=${c.client_id || "N/A"}\n`; out += "\n"; }
    if (disabled.length) { out += "⏹️ Disabled:\n"; for (const [n] of disabled) out += `  - ${n}\n`; }
    return out;
}

export function registerAuthTools(server: { tool: (...args: any[]) => void }, http: HttpTransport): void {
    server.tool(
        "auth",
        `Auth & OAuth provider management.
Actions: list_providers, get_provider, configure_provider, update_provider, disable_provider, supported_providers, wechat_mini, wechat_open, get_settings, update_settings, get_config, update_config`,
        {
            action: withDescription(stringEnum([
                "list_providers", "get_provider", "configure_provider", "update_provider",
                "disable_provider", "supported_providers",
                "wechat_mini", "wechat_open",
                "get_settings", "update_settings",
                "get_config", "update_config",
            ]), "Action to perform"),
            ref: optional(Type.String(), "Project ref (required for most actions)"),
            provider: optional(Type.String(), "[*_provider] Provider name (github, google, wechat, etc.)"),
            client_id: optional(Type.String(), "[configure/update] OAuth Client ID"),
            client_secret: optional(Type.String(), "[configure/update] OAuth Client Secret"),
            redirect_uri: optional(Type.String(), "[configure/update/wechat_open] Redirect URI"),
            url: optional(Type.String(), "[configure] Custom OAuth URL"),
            app_id: optional(Type.String(), "[wechat_*] WeChat App ID"),
            app_secret: optional(Type.String(), "[wechat_*] WeChat App Secret"),
            config: optional(Type.Record(Type.String(), Type.Unknown()), "[update_settings/update_config] Config fields"),
        },
        async (args: any) => {
            const { action, ref, provider, client_id, client_secret, redirect_uri, url, app_id, app_secret, config } = args;
            const need = (f: string) => { if (!ref) throw new Error(`'ref' required for '${action}'`); };
            const ok = (res: any) => res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`;

            let text: string;
            switch (action) {
                case "list_providers":
                    need("ref");
                    const lp = await http.get(`/v1/projects/${ref}/auth/providers`);
                    text = lp.ok ? formatProviders(lp.data) : `❌ Failed (${lp.status})`;
                    break;
                case "get_provider":
                    need("ref"); if (!provider) throw new Error("'provider' required");
                    text = ok(await http.get(`/v1/projects/${ref}/auth/providers/${provider}`));
                    break;
                case "configure_provider": {
                    need("ref"); if (!provider || !client_id || !client_secret) throw new Error("provider, client_id, client_secret required");
                    const body: Record<string, string> = { client_id, client_secret };
                    if (redirect_uri) body.redirect_uri = redirect_uri;
                    if (url) body.url = url;
                    const r = await http.post(`/v1/projects/${ref}/auth/providers/${provider}`, body);
                    text = r.ok ? `✅ Provider ${provider} configured\n${JSON.stringify(r.data, null, 2)}` : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "update_provider": {
                    need("ref"); if (!provider) throw new Error("'provider' required");
                    const body: Record<string, string> = {};
                    if (client_id) body.client_id = client_id;
                    if (client_secret) body.client_secret = client_secret;
                    if (redirect_uri) body.redirect_uri = redirect_uri;
                    const r = await http.patch(`/v1/projects/${ref}/auth/providers/${provider}`, body);
                    text = r.ok ? `✅ Provider ${provider} updated` : `❌ Failed (${r.status})`;
                    break;
                }
                case "disable_provider":
                    need("ref"); if (!provider) throw new Error("'provider' required");
                    text = (await http.delete(`/v1/projects/${ref}/auth/providers/${provider}`)).ok ? `✅ Provider ${provider} disabled` : `❌ Failed`;
                    break;
                case "supported_providers":
                    text = ok(await http.get("/v1/projects/_/auth/supported-providers"));
                    break;
                case "wechat_mini":
                    need("ref"); if (!app_id || !app_secret) throw new Error("app_id and app_secret required");
                    text = ok(await http.post(`/v1/projects/${ref}/auth/wechat/miniprogram`, { app_id, app_secret, deploy_function: true }));
                    break;
                case "wechat_open": {
                    need("ref"); if (!app_id || !app_secret) throw new Error("app_id and app_secret required");
                    const b: Record<string, string> = { app_id, app_secret };
                    if (redirect_uri) b.redirect_uri = redirect_uri;
                    text = ok(await http.post(`/v1/projects/${ref}/auth/wechat/open`, b));
                    break;
                }
                case "get_settings":
                    need("ref"); text = ok(await http.get(`/v1/projects/${ref}/auth/config`));
                    break;
                case "update_settings":
                    need("ref"); if (!config) throw new Error("'config' required");
                    text = (await http.patch(`/v1/projects/${ref}/auth/config`, config)).ok ? `✅ Auth settings updated` : `❌ Failed`;
                    break;
                case "get_config":
                    need("ref"); text = ok(await http.get(`/v1/projects/${ref}/config/auth`));
                    break;
                case "update_config":
                    need("ref"); if (!config) throw new Error("'config' required");
                    text = (await http.patch(`/v1/projects/${ref}/config/auth`, config)).ok ? `✅ Auth config updated` : `❌ Failed`;
                    break;
                default: text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
