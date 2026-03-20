/**
 * Auth Provider Tools - OAuth provider management (list, configure, delete)
 * Maps to Management API: /v1/projects/:ref/auth/*
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerAuthTools(server: McpServer, http: HttpTransport): void {
    // ═══════════════════════════════════════
    // Auth Providers
    // ═══════════════════════════════════════

    server.tool(
        "list_auth_providers",
        "List all OAuth providers and their enabled status for a project (GitHub, Google, WeChat, etc.)",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/auth/providers`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatProviders(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "get_auth_provider",
        "Get configuration details for a specific OAuth provider",
        {
            ref: z.string().describe("Project ref"),
            provider: z.string().describe("Provider name (github, google, apple, wechat, wechat_miniprogram, wechat_mp, qq, weibo, etc.)"),
        },
        async ({ ref, provider }) => {
            const res = await http.get(`/v1/projects/${ref}/auth/providers/${provider}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "configure_auth_provider",
        "Configure an OAuth provider for a project (set client_id, client_secret, redirect_uri)",
        {
            ref: z.string().describe("Project ref"),
            provider: z.string().describe("Provider name (github, google, apple, wechat, wechat_miniprogram, wechat_mp, qq, etc.)"),
            client_id: z.string().describe("OAuth Client ID / App ID"),
            client_secret: z.string().describe("OAuth Client Secret / App Secret"),
            redirect_uri: z.string().optional().describe("OAuth redirect URI (optional)"),
            url: z.string().optional().describe("Custom OAuth URL (for self-hosted providers)"),
        },
        async ({ ref, provider, client_id, client_secret, redirect_uri, url }) => {
            const body: Record<string, string> = { client_id, client_secret };
            if (redirect_uri) body.redirect_uri = redirect_uri;
            if (url) body.url = url;

            const res = await http.post(`/v1/projects/${ref}/auth/providers/${provider}`, body);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ OAuth provider ${provider} configured\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Configuration failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    server.tool(
        "update_auth_provider",
        "Update specific fields of an OAuth provider configuration",
        {
            ref: z.string().describe("Project ref"),
            provider: z.string().describe("Provider name"),
            client_id: z.string().optional().describe("Updated Client ID"),
            client_secret: z.string().optional().describe("Updated Client Secret"),
            redirect_uri: z.string().optional().describe("Updated redirect URI"),
        },
        async ({ ref, provider, ...updates }) => {
            const body: Record<string, string> = {};
            if (updates.client_id) body.client_id = updates.client_id;
            if (updates.client_secret) body.client_secret = updates.client_secret;
            if (updates.redirect_uri) body.redirect_uri = updates.redirect_uri;

            const res = await http.patch(`/v1/projects/${ref}/auth/providers/${provider}`, body);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Provider ${provider} updated\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Update failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "disable_auth_provider",
        "Disable and remove an OAuth provider from a project",
        {
            ref: z.string().describe("Project ref"),
            provider: z.string().describe("Provider name to disable"),
        },
        async ({ ref, provider }) => {
            const res = await http.delete(`/v1/projects/${ref}/auth/providers/${provider}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Provider ${provider} disabled`
                        : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_supported_providers",
        "List all OAuth providers supported by SupaCloud (including WeChat, China OAuth providers)",
        {},
        async () => {
            const res = await http.get("/v1/projects/_/auth/supported-providers");
            return {
                content: [{
                    type: "text",
                    text: res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // WeChat-specific tools
    // ═══════════════════════════════════════

    server.tool(
        "configure_wechat_miniprogram",
        "Configure WeChat Mini Program login for a project (deploys Edge Function automatically)",
        {
            ref: z.string().describe("Project ref"),
            app_id: z.string().describe("WeChat Mini Program App ID"),
            app_secret: z.string().describe("WeChat Mini Program App Secret"),
        },
        async ({ ref, app_id, app_secret }) => {
            const res = await http.post(`/v1/projects/${ref}/auth/wechat/miniprogram`, {
                app_id, app_secret, deploy_function: true,
            });
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ WeChat Mini Program login configured\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    server.tool(
        "configure_wechat_open",
        "Configure WeChat Open Platform (QR code scan) login for a project",
        {
            ref: z.string().describe("Project ref"),
            app_id: z.string().describe("WeChat Open Platform App ID"),
            app_secret: z.string().describe("WeChat Open Platform App Secret"),
            redirect_uri: z.string().optional().describe("OAuth callback URL"),
        },
        async ({ ref, app_id, app_secret, redirect_uri }) => {
            const body: Record<string, string> = { app_id, app_secret };
            if (redirect_uri) body.redirect_uri = redirect_uri;

            const res = await http.post(`/v1/projects/${ref}/auth/wechat/open`, body);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ WeChat Open Platform login configured\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    // Auth General Config
    // ═══════════════════════════════════════

    server.tool(
        "get_auth_settings",
        "Get project auth general settings (SMTP, JWT, session config, etc.)",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/auth/config`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "update_auth_settings",
        "Update project auth general settings (e.g., SMTP, JWT expiry, site URL)",
        {
            ref: z.string().describe("Project ref"),
            config: z.record(z.unknown()).describe("Auth config fields to update (JSON object)"),
        },
        async ({ ref, config }) => {
            const res = await http.patch(`/v1/projects/${ref}/auth/config`, config);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Auth settings updated`
                        : `❌ Update failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );
}

// ── Helpers ──

function formatProviders(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const result = data as { providers?: Record<string, { enabled: boolean; client_id?: string; redirect_uri?: string }> };
    const providers = result.providers || {};
    const entries = Object.entries(providers);
    if (entries.length === 0) return "No providers configured.";

    const enabled = entries.filter(([, v]) => v.enabled);
    const disabled = entries.filter(([, v]) => !v.enabled);

    let output = `🔐 OAuth Providers (${enabled.length} enabled / ${disabled.length} disabled):\n\n`;

    if (enabled.length > 0) {
        output += "✅ Enabled:\n";
        for (const [name, config] of enabled) {
            output += `  - ${name}: client_id=${config.client_id || "N/A"}\n`;
        }
        output += "\n";
    }

    if (disabled.length > 0) {
        output += "⏹️ Disabled:\n";
        for (const [name] of disabled) {
            output += `  - ${name}\n`;
        }
    }

    return output;
}
