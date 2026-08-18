/**
 * Auth — Compound tool (10→1)
 */
import { Type } from "@sinclair/typebox";
import { projectRefPathSegment } from "../project-ref";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";

const authConfigRecord = Type.Record(Type.String(), Type.Unknown());
const safeAuthMutationCodes = new Set([
    "AUTH_RUNTIME_APPLY_FAILED",
    "SUPAUTH_DEPENDENT_REFRESH_FAILED",
]);
const MAX_AUTH_READ_BYTES = 64 * 1024;
const AUTH_READ_TIMEOUT_MS = 5_000;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_LINK_TYPES = [
    "signup", "magiclink", "recovery", "invite", "email_change", "email_change_current", "email_change_new",
] as const;

const SAFE_USER_FIELDS = [
    "id", "email", "phone", "created_at", "last_sign_in_at",
] as const;

function parseAuthConfig(input: string | Record<string, unknown>): unknown {
    if (typeof input !== "string") return input;
    try {
        return JSON.parse(input);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Invalid auth config JSON object");
    }
}

const authConfigSchema = decodedSchema(
    Type.Union([Type.String(), authConfigRecord]),
    authConfigRecord,
    parseAuthConfig,
);

function safeAuthFailureFields(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    const body = payload as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    if (typeof body.code === "string" && safeAuthMutationCodes.has(body.code)) {
        fields.code = body.code;
    }
    for (const field of ["persisted", "runtime_applied", "dependents_applied"] as const) {
        if (typeof body[field] === "boolean") fields[field] = body[field];
    }
    if (body.dependent_status === "failed" || body.dependent_status === "unknown") {
        fields.dependent_status = body.dependent_status;
    }
    if (body.runtime_mode === "local" || body.runtime_mode === "owner" || body.runtime_mode === "shared") {
        fields.runtime_mode = body.runtime_mode;
    }
    return fields;
}

function safeAuthMutationFailure(response: HttpResult<unknown>): Record<string, unknown> {
    return {
        ok: false,
        http_status: response.status,
        ...safeAuthFailureFields(response.data),
    };
}

function authMutationResult(response: HttpResult<unknown>, successMessage: string) {
    if (response.ok) {
        return { content: [{ type: "text" as const, text: successMessage }] };
    }
    return {
        isError: true,
        content: [{
            type: "text" as const,
            text: JSON.stringify(safeAuthMutationFailure(response), null, 2),
        }],
    };
}

function requiredRef(candidate: unknown): string {
    if (typeof candidate !== "string" || !candidate.trim()) throw new Error("'ref' is required");
    return projectRefPathSegment(candidate.trim(), "Auth");
}

function requiredUserId(candidate: unknown): string {
    if (typeof candidate !== "string" || !USER_ID_PATTERN.test(candidate.trim())) {
        throw new Error("'user_id' must be a UUID");
    }
    return candidate.trim().toLowerCase();
}

function boundedPage(candidate: unknown): number {
    if (candidate === undefined) return 1;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) {
        throw new Error("'page' must be a positive integer");
    }
    return candidate;
}

function boundedPerPage(candidate: unknown): number {
    if (candidate === undefined) return 50;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1 || candidate > 100) {
        throw new Error("'per_page' must be an integer between 1 and 100");
    }
    return candidate;
}

function safeRedirectTo(candidate: unknown): string | undefined {
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "string" || !candidate.trim()) throw new Error("'redirect_to' must be an absolute HTTPS or loopback HTTP URL");
    let uri: URL;
    try {
        uri = new URL(candidate.trim());
    } catch {
        throw new Error("'redirect_to' must be an absolute HTTPS or loopback HTTP URL");
    }
    const loopback = uri.hostname === "127.0.0.1" || uri.hostname === "[::1]";
    const validProtocol = uri.protocol === "https:" || (uri.protocol === "http:" && loopback && Boolean(uri.port));
    if (!validProtocol || uri.username || uri.password || uri.hash) {
        throw new Error("'redirect_to' must be an absolute HTTPS or loopback HTTP URL without credentials or fragment");
    }
    return uri.toString();
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function projectUser(candidate: unknown): Record<string, unknown> | null {
    if (!isRecord(candidate) || typeof candidate.id !== "string") return null;
    const projectedUser: Record<string, unknown> = {};
    for (const field of SAFE_USER_FIELDS) {
        if (field in candidate) projectedUser[field] = candidate[field];
    }
    return projectedUser;
}

function projectUserList(candidate: unknown): Record<string, unknown> | null {
    if (!isRecord(candidate) || !Array.isArray(candidate.users)) return null;
    const users = candidate.users.map(projectUser);
    if (users.some((user) => user === null)) return null;
    const projectedFields: Record<string, unknown> = { users };
    for (const field of ["total", "page", "per_page", "next_page", "last_page"] as const) {
        if (field in candidate && (typeof candidate[field] === "number" || candidate[field] === null)) {
            projectedFields[field] = candidate[field];
        }
    }
    return projectedFields;
}

function actionLink(candidate: unknown): string | null {
    const candidates: unknown[] = [candidate];
    if (isRecord(candidate)) {
        candidates.push(candidate.data, candidate.properties);
        if (isRecord(candidate.data)) candidates.push(candidate.data.properties);
    }
    for (const candidate of candidates) {
        if (isRecord(candidate) && typeof candidate.action_link === "string" && candidate.action_link.length > 0) {
            return candidate.action_link;
        }
    }
    return null;
}

function safeAuthReadFailure(operation: string, response: HttpResult<unknown>) {
    return {
        isError: true,
        content: [{
            type: "text" as const,
            text: JSON.stringify({
                ok: false,
                operation,
                http_status: response.transportError || response.responseReadError ? null : response.status,
                error: response.responseReadError ? "INVALID_RESPONSE" : response.transportError ? "NETWORK_ERROR" : "HTTP_ERROR",
            }, null, 2),
        }],
    };
}

async function listUsers(http: HttpTransport, args: Record<string, unknown>) {
    const ref = requiredRef(args.ref);
    const page = boundedPage(args.page);
    const perPage = boundedPerPage(args.per_page);
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    for (const key of ["search", "email_like"] as const) {
        if (args[key] !== undefined) {
            if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`'${key}' must be a non-empty string`);
            params.set(key, args[key].trim());
        }
    }
    const response = await http.get(`/v1/projects/${ref}/auth/users?${params.toString()}`, {
        maxJsonBytes: MAX_AUTH_READ_BYTES,
        responseTimeoutMs: AUTH_READ_TIMEOUT_MS,
    });
    if (!response.ok) return safeAuthReadFailure("auth.list_users", response);
    const users = projectUserList(response.data);
    if (!users) return safeAuthReadFailure("auth.list_users", { ...response, responseReadError: true });
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: "auth.list_users", project_ref: ref, ...users }, null, 2) }] };
}

async function getUser(http: HttpTransport, args: Record<string, unknown>) {
    const ref = requiredRef(args.ref);
    const userId = requiredUserId(args.user_id);
    const response = await http.get(`/v1/projects/${ref}/auth/users/${encodeURIComponent(userId)}`, {
        maxJsonBytes: MAX_AUTH_READ_BYTES,
        responseTimeoutMs: AUTH_READ_TIMEOUT_MS,
    });
    if (!response.ok) return safeAuthReadFailure("auth.get_user", response);
    const user = projectUser(response.data);
    if (!user) return safeAuthReadFailure("auth.get_user", { ...response, responseReadError: true });
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: "auth.get_user", project_ref: ref, user }, null, 2) }] };
}

async function generateLink(http: HttpTransport, args: Record<string, unknown>) {
    const ref = requiredRef(args.ref);
    if (typeof args.type !== "string" || !(AUTH_LINK_TYPES as readonly string[]).includes(args.type)) {
        throw new Error("'type' is invalid for 'generate_link'");
    }
    if (typeof args.email !== "string" || !args.email.trim()) throw new Error("'email' is required for 'generate_link'");
    const body: Record<string, unknown> = { type: args.type, email: args.email.trim() };
    const redirectTo = safeRedirectTo(args.redirect_to);
    if (redirectTo) body.redirect_to = redirectTo;
    const response = await http.postReleaseMutation(`/v1/projects/${ref}/auth/generate_link`, body);
    if (!response.ok) return safeAuthReadFailure("auth.generate_link", response);
    const link = actionLink(response.data);
    if (!link) return safeAuthReadFailure("auth.generate_link", { ...response, responseReadError: true });
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: "auth.generate_link", action_link: link }, null, 2) }] };
}

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
        `Auth & OAuth provider management, controlled user lookup, and login-link generation.
Actions: list_users, get_user, generate_link, list_providers, get_provider, configure_provider, update_provider, disable_provider, supported_providers, wechat_mini, wechat_open, get_settings, update_settings, get_config, update_config`,
        {
            action: withDescription(stringEnum([
                "list_users", "get_user", "generate_link",
                "list_providers", "get_provider", "configure_provider", "update_provider",
                "disable_provider", "supported_providers",
                "wechat_mini", "wechat_open",
                "get_settings", "update_settings",
                "get_config", "update_config",
            ]), "Action to perform"),
            ref: optional(Type.String(), "Project ref (required for most actions)"),
            user_id: optional(Type.String(), "[get_user] Exact auth user UUID"),
            page: optional(Type.Integer({ minimum: 1 }), "[list_users] 1-based page"),
            per_page: optional(Type.Integer({ minimum: 1, maximum: 100 }), "[list_users] Users per page (1-100)"),
            search: optional(Type.String(), "[list_users] Search user email, phone, or UUID"),
            email_like: optional(Type.String(), "[list_users] Search user email or phone"),
            type: optional(stringEnum(AUTH_LINK_TYPES), "[generate_link] GoTrue link type"),
            email: optional(Type.String(), "[generate_link] User email"),
            redirect_to: optional(Type.String(), "[generate_link] Absolute HTTPS or loopback callback"),
            provider: optional(Type.String(), "[*_provider] Provider name (github, google, wechat, etc.)"),
            client_id: optional(Type.String(), "[configure/update] OAuth Client ID"),
            client_secret: optional(Type.String(), "[configure/update] OAuth Client Secret"),
            redirect_uri: optional(Type.String(), "[configure/update/wechat_open] Redirect URI"),
            url: optional(Type.String(), "[configure] Custom OAuth URL"),
            app_id: optional(Type.String(), "[wechat_*] WeChat App ID"),
            app_secret: optional(Type.String(), "[wechat_*] WeChat App Secret"),
            config: optional(authConfigSchema, "[update_settings/update_config] Config fields as a JSON object"),
        },
        async (args: any) => {
            const { action, ref, provider, client_id, client_secret, redirect_uri, url, app_id, app_secret, config } = args;
            const need = (f: string) => { if (!ref) throw new Error(`'ref' required for '${action}'`); };
            const ok = (res: any) => res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`;

            let text: string;
            switch (action) {
                case "list_users":
                    return listUsers(http, args);
                case "get_user":
                    return getUser(http, args);
                case "generate_link":
                    return generateLink(http, args);
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
                    return authMutationResult(
                        await http.patch(`/v1/projects/${ref}/auth/config`, config),
                        "✅ Auth settings updated",
                    );
                case "get_config":
                    need("ref"); text = ok(await http.get(`/v1/projects/${ref}/config/auth`));
                    break;
                case "update_config":
                    need("ref"); if (!config) throw new Error("'config' required");
                    return authMutationResult(
                        await http.patch(`/v1/projects/${ref}/config/auth`, config),
                        "✅ Auth config updated",
                    );
                default: text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
