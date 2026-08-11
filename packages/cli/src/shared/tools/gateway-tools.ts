/**
 * Gateway / Caddy — Compound tool.
 *
 * SupaCloud 把网关配置作为 JSON 通过 Caddy Admin API（POST /load）注入，
 * 而不是写 Caddyfile。本工具把这些受控端点暴露给 CLI：
 *   - 自定义网关路由（reverse_proxy / 静态站点 / 重定向）的增删改查
 *   - 网关配置（限流档位、CORS、JWT）
 *   - 证书自动化（lego 申请/续期、手动部署证书）
 *   - 全量重建（把模板/CORS 变更传播到所有租户）
 *   - 自定义域名（绑定到 Caddy TLS 路由）
 *
 * 注意：相关端点均要求 admin 权限，需使用管理员 API Token。
 */
import { Type } from "@sinclair/typebox";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpTransport } from "../transports/http";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: any) => Promise<any>,
    ) => void;
};

type CliScalar = string | number | boolean;

function parseCliStringArray(value: CliScalar | string[]): unknown {
    if (Array.isArray(value)) return value;
    const text = String(value).trim();
    if (!text) return [];
    if (text.startsWith("[")) {
        try {
            return JSON.parse(text);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            return [text];
        }
    }
    return text.split(",").map((item) => item.trim()).filter(Boolean);
}

const cliScalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
const stringArray = Type.Optional(decodedSchema(
    Type.Union([cliScalar, Type.Array(Type.String())]),
    Type.Array(Type.String()),
    parseCliStringArray,
));

function parseCliHeaders(value: CliScalar | Record<string, unknown>): unknown {
    if (typeof value === "object" && !Array.isArray(value)) return value;
    const text = String(value).trim();
    if (!text) return undefined;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
    }
    const out: Record<string, string> = {};
    for (const part of text.split(",")) {
        const idx = part.indexOf(":");
        if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

const stringRecord = Type.Record(Type.String(), Type.String());
const headersRecord = Type.Optional(decodedSchema(
    Type.Union([cliScalar, Type.Record(Type.String(), Type.Unknown())]),
    Type.Union([stringRecord, Type.Undefined()]),
    parseCliHeaders,
));

const redirectStatus = Type.Optional(Type.Union([
    Type.Literal(301), Type.Literal(302), Type.Literal(307), Type.Literal(308),
]));

const ok = (res: any) => (res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`);
const simple = (res: any, msg: string) => (res.ok ? `✅ ${msg}` : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`);

export function registerGatewayTools(server: ToolServer, http: HttpTransport, options: { projectRef?: string } = {}): void {
    const { projectRef } = options;

    server.tool(
        "gateway",
        `Gateway / Caddy 配置（通过 JSON Admin API 注入）。要求 admin 权限。
Actions: routes, upsert_route, update_route, delete_route, config, get_certificate, update_certificate, issue_certificate, deploy_certificate, rebuild, custom_hostname, set_custom_hostname, delete_custom_hostname, verify_custom_hostname`,
        {
            action: withDescription(stringEnum([
                "routes", "upsert_route", "update_route", "delete_route",
                "config", "get_certificate", "update_certificate",
                "issue_certificate", "deploy_certificate", "rebuild",
                "custom_hostname", "set_custom_hostname",
                "delete_custom_hostname", "verify_custom_hostname",
            ]), "Action"),
            ref: optional(Type.String(), projectRef ? "可选：覆盖自动关联的项目 ref" : "项目 ref"),
            // 路由参数
            route_id: optional(Type.String(), "[upsert_route/update_route/delete_route] 路由 ID（字母/数字/_/-，1-64）"),
            hosts: withDescription(stringArray, "[upsert_route/update_route] 主机名列表，逗号分隔或 JSON 数组（1-20）"),
            paths: withDescription(stringArray, "[upsert_route/update_route] 路径列表，逗号分隔或 JSON 数组（1-32）"),
            upstream: optional(Type.String(), "[upsert_route/update_route] 反代上游 host:port 或 http(s)://host[:port]"),
            managed_upstream: optional(stringEnum(["edge-functions"]), "[upsert_route/update_route] 托管上游（同步 Edge Function）"),
            upstream_tls_insecure_skip_verify: optional(Type.Boolean(), "[upsert_route/update_route] 上游 TLS 跳过校验"),
            static_root: optional(Type.String(), "[upsert_route/update_route] 静态站点根目录"),
            protocol: optional(stringEnum(["http", "https"]), "[upsert_route/update_route] 可选请求协议匹配"),
            redirect_to: optional(Type.String(), "[upsert_route/update_route] 带固定 host 的绝对 http(s) 目标，可在末尾使用 {http.request.uri}"),
            redirect_status: withDescription(redirectStatus, "[upsert_route/update_route] 重定向状态码，默认 308"),
            rewrite_uri: optional(Type.String(), "[upsert_route/update_route] 重写 URI（以 / 开头）"),
            strip_prefix: optional(Type.String(), "[upsert_route/update_route] 去除前缀"),
            headers: withDescription(headersRecord, "[upsert_route/update_route] 自定义请求头，JSON 或 K:V,K2:V2"),
            cors: withDescription(stringArray, "[upsert_route/update_route] 额外 CORS 源，逗号分隔"),
            priority: optional(Type.Number(), "[upsert_route/update_route] 路由优先级"),
            enabled: optional(Type.Boolean(), "[upsert_route/update_route] 是否启用"),
            // 网关配置
            rate_limit_tier: optional(stringEnum(["free", "pro", "enterprise"]), "[config] 限流档位"),
            cors_origins: optional(Type.String(), "[config] CORS 源（逗号分隔）"),
            jwt_enabled: optional(Type.Boolean(), "[config] 是否启用 JWT"),
            jwt_secret: optional(Type.String(), "[config] JWT 密钥"),
            // 证书
            cert_mode: optional(stringEnum(["lego", "manual"]), "[update_certificate] 证书模式"),
            challenge: optional(stringEnum(["dns-01", "http-01"]), "[update_certificate/issue_certificate] ACME challenge"),
            email: optional(Type.String(), "[update_certificate/issue_certificate] ACME 邮箱"),
            dns_provider: optional(Type.String(), "[update_certificate/issue_certificate] DNS 提供商"),
            dns_env: withDescription(stringArray, "[update_certificate/issue_certificate] DNS 环境变量 KEY=VALUE 列表"),
            domains: withDescription(stringArray, "[update_certificate/issue_certificate/deploy_certificate] 域名列表"),
            auto_renew: optional(Type.Boolean(), "[update_certificate/issue_certificate] 自动续期"),
            renew: optional(Type.Boolean(), "[issue_certificate] 仅续期已有证书"),
            cert: optional(Type.String(), "[deploy_certificate] PEM 证书内容"),
            key: optional(Type.String(), "[deploy_certificate] PEM 私钥内容"),
            // 重建
            clean: optional(Type.Boolean(), "[rebuild] 清理后全量重建"),
            // 自定义域名
            custom_hostname: optional(Type.String(), "[set_custom_hostname] 自定义域名"),
        },
        async (args: any) => {
            const resolveRef = (override?: string) => {
                const ref = override || projectRef;
                if (!ref) throw new Error("'ref' is required for this action");
                return ref;
            };
            const need = (field: string, value: any) => {
                if (value === undefined || value === null || value === "") throw new Error(`'${field}' is required for '${args.action}'`);
            };

            const {
                action, ref, route_id, hosts, paths, upstream, managed_upstream, upstream_tls_insecure_skip_verify,
                static_root, protocol, redirect_to, redirect_status, rewrite_uri, strip_prefix, headers, cors, priority, enabled,
                rate_limit_tier, cors_origins, jwt_enabled, jwt_secret,
                cert_mode, challenge, email, dns_provider, dns_env, domains, auto_renew, renew,
                cert, key, clean, custom_hostname,
            } = args;

            const projectRefValue = resolveRef(ref);
            let text: string;

            switch (action) {
                case "routes":
                    text = ok(await http.get(`/v1/projects/${projectRefValue}/gateway/routes`));
                    break;

                case "upsert_route": {
                    need("route_id", route_id);
                    need("hosts", hosts);
                    need("paths", paths);
                    const body: Record<string, unknown> = {
                        id: route_id,
                        hosts,
                        path: (paths as string[]).length === 1 ? (paths as string[])[0] : paths,
                    };
                    if (upstream !== undefined) body.upstream = upstream;
                    if (managed_upstream !== undefined) body.managed_upstream = managed_upstream;
                    if (upstream_tls_insecure_skip_verify !== undefined) body.upstream_tls_insecure_skip_verify = upstream_tls_insecure_skip_verify;
                    if (static_root !== undefined) body.static_root = static_root;
                    if (protocol !== undefined) body.protocol = protocol;
                    if (redirect_to !== undefined) body.redirect_to = redirect_to;
                    if (redirect_status !== undefined) body.redirect_status = redirect_status;
                    if (rewrite_uri !== undefined) body.rewrite_uri = rewrite_uri;
                    if (strip_prefix !== undefined) body.strip_prefix = strip_prefix;
                    if (headers !== undefined) body.headers = headers;
                    if (cors !== undefined) body.cors = cors;
                    if (priority !== undefined) body.priority = priority;
                    if (enabled !== undefined) body.enabled = enabled;
                    text = ok(await http.post(`/v1/projects/${projectRefValue}/gateway/routes`, body));
                    break;
                }

                case "update_route": {
                    need("route_id", route_id);
                    need("hosts", hosts);
                    need("paths", paths);
                    const body: Record<string, unknown> = {
                        hosts,
                        path: (paths as string[]).length === 1 ? (paths as string[])[0] : paths,
                    };
                    if (upstream !== undefined) body.upstream = upstream;
                    if (managed_upstream !== undefined) body.managed_upstream = managed_upstream;
                    if (upstream_tls_insecure_skip_verify !== undefined) body.upstream_tls_insecure_skip_verify = upstream_tls_insecure_skip_verify;
                    if (static_root !== undefined) body.static_root = static_root;
                    if (protocol !== undefined) body.protocol = protocol;
                    if (redirect_to !== undefined) body.redirect_to = redirect_to;
                    if (redirect_status !== undefined) body.redirect_status = redirect_status;
                    if (rewrite_uri !== undefined) body.rewrite_uri = rewrite_uri;
                    if (strip_prefix !== undefined) body.strip_prefix = strip_prefix;
                    if (headers !== undefined) body.headers = headers;
                    if (cors !== undefined) body.cors = cors;
                    if (priority !== undefined) body.priority = priority;
                    if (enabled !== undefined) body.enabled = enabled;
                    text = ok(await http.put(`/v1/projects/${projectRefValue}/gateway/routes/${route_id}`, body));
                    break;
                }

                case "delete_route": {
                    need("route_id", route_id);
                    text = ok(await http.delete(`/v1/projects/${projectRefValue}/gateway/routes/${route_id}`));
                    break;
                }

                case "config": {
                    const body: Record<string, unknown> = {};
                    if (rate_limit_tier !== undefined) body.rate_limit_tier = rate_limit_tier;
                    if (cors_origins !== undefined) body.cors_origins = cors_origins;
                    if (jwt_enabled !== undefined) body.jwt_enabled = jwt_enabled;
                    if (jwt_secret !== undefined) body.jwt_secret = jwt_secret;
                    if (Object.keys(body).length === 0) throw new Error("At least one of rate_limit_tier, cors_origins, jwt_enabled, jwt_secret is required");
                    text = ok(await http.post(`/v1/projects/${projectRefValue}/gateway/config`, body));
                    break;
                }

                case "get_certificate":
                    text = ok(await http.get(`/v1/projects/${projectRefValue}/gateway/certificate`));
                    break;

                case "update_certificate": {
                    const body: Record<string, unknown> = {};
                    if (cert_mode !== undefined) body.mode = cert_mode;
                    if (challenge !== undefined) body.challenge = challenge;
                    if (email !== undefined) body.email = email;
                    if (dns_provider !== undefined) body.dns_provider = dns_provider;
                    if (dns_env !== undefined) body.dns_env = dns_env;
                    if (domains !== undefined) body.domains = domains;
                    if (auto_renew !== undefined) body.auto_renew = auto_renew;
                    text = ok(await http.put(`/v1/projects/${projectRefValue}/gateway/certificate`, body));
                    break;
                }

                case "issue_certificate": {
                    const body: Record<string, unknown> = {};
                    if (challenge !== undefined) body.challenge = challenge;
                    if (email !== undefined) body.email = email;
                    if (dns_provider !== undefined) body.dns_provider = dns_provider;
                    if (dns_env !== undefined) body.dns_env = dns_env;
                    if (domains !== undefined) body.domains = domains;
                    if (auto_renew !== undefined) body.auto_renew = auto_renew;
                    if (renew !== undefined) body.renew = renew;
                    text = ok(await http.post(`/v1/projects/${projectRefValue}/gateway/certificate/issue`, body));
                    break;
                }

                case "deploy_certificate": {
                    need("cert", cert);
                    need("key", key);
                    const body: Record<string, unknown> = { cert, key };
                    if (domains !== undefined) body.domains = domains;
                    text = ok(await http.post(`/v1/projects/${projectRefValue}/gateway/certificate/deploy`, body));
                    break;
                }

                case "rebuild": {
                    const query = clean ? "?clean=true" : "";
                    text = ok(await http.post(`/v1/projects/${projectRefValue}/gateway/rebuild-all${query}`));
                    break;
                }

                case "custom_hostname":
                    text = ok(await http.get(`/v1/projects/${projectRefValue}/custom-hostname`));
                    break;

                case "set_custom_hostname": {
                    need("custom_hostname", custom_hostname);
                    text = simple(
                        await http.post(`/v1/projects/${projectRefValue}/custom-hostname`, { custom_hostname }),
                        `Custom hostname ${custom_hostname} requested`,
                    );
                    break;
                }

                case "delete_custom_hostname":
                    text = simple(await http.delete(`/v1/projects/${projectRefValue}/custom-hostname`), "Custom hostname removed");
                    break;

                case "verify_custom_hostname":
                    text = ok(await http.post(`/v1/projects/${projectRefValue}/custom-hostname/verify`));
                    break;

                default:
                    text = `❌ Unknown action: ${action}`;
            }

            return { content: [{ type: "text" as const, text }] };
        },
    );
}
