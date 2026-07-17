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
import { z } from "zod";
import type { HttpTransport } from "../transports/http";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: Record<string, z.ZodTypeAny>,
        callback: (args: any) => Promise<any>,
    ) => void;
};

// 逗号分隔或 JSON 数组 → string[]，便于命令行传参
const stringArray = z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value;
    const text = String(value).trim();
    if (!text) return [];
    if (text.startsWith("[")) {
        try {
            return JSON.parse(text);
        } catch {
            return [text];
        }
    }
    return text.split(",").map((item) => item.trim()).filter(Boolean);
}, z.array(z.string()).optional());

// JSON 对象或 KEY:VALUE,KEY2:VALUE2 → Record<string,string>
const headersRecord = z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "object" && !Array.isArray(value)) return value;
    const text = String(value).trim();
    if (!text) return undefined;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
        // fall through to KEY:VALUE 解析
    }
    const out: Record<string, string> = {};
    for (const part of text.split(",")) {
        const idx = part.indexOf(":");
        if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
}, z.record(z.string(), z.string()).optional());

const redirectStatus = z.union([
    z.literal(301), z.literal(302), z.literal(307), z.literal(308),
]).optional();

const ok = (res: any) => (res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`);
const simple = (res: any, msg: string) => (res.ok ? `✅ ${msg}` : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`);

export function registerGatewayTools(server: ToolServer, http: HttpTransport, options: { projectRef?: string } = {}): void {
    const { projectRef } = options;

    server.tool(
        "gateway",
        `Gateway / Caddy 配置（通过 JSON Admin API 注入）。要求 admin 权限。
Actions: routes, upsert_route, update_route, delete_route, config, get_certificate, update_certificate, issue_certificate, deploy_certificate, rebuild, custom_hostname, set_custom_hostname, delete_custom_hostname, verify_custom_hostname`,
        {
            action: z.enum([
                "routes", "upsert_route", "update_route", "delete_route",
                "config", "get_certificate", "update_certificate",
                "issue_certificate", "deploy_certificate", "rebuild",
                "custom_hostname", "set_custom_hostname",
                "delete_custom_hostname", "verify_custom_hostname",
            ]).describe("Action"),
            ref: z.string().optional().describe(projectRef ? "可选：覆盖自动关联的项目 ref" : "项目 ref"),
            // 路由参数
            route_id: z.string().optional().describe("[upsert_route/update_route/delete_route] 路由 ID（字母/数字/_/-，1-64）"),
            hosts: stringArray.describe("[upsert_route/update_route] 主机名列表，逗号分隔或 JSON 数组（1-20）"),
            paths: stringArray.describe("[upsert_route/update_route] 路径列表，逗号分隔或 JSON 数组（1-20）"),
            upstream: z.string().optional().describe("[upsert_route/update_route] 反代上游 host:port 或 http(s)://host[:port]"),
            upstream_tls_insecure_skip_verify: z.boolean().optional().describe("[upsert_route/update_route] 上游 TLS 跳过校验"),
            static_root: z.string().optional().describe("[upsert_route/update_route] 静态站点根目录"),
            protocol: z.enum(["http", "https"]).optional().describe("[upsert_route/update_route] 可选请求协议匹配"),
            redirect_to: z.string().optional().describe("[upsert_route/update_route] 绝对 http(s) 重定向目标，可使用 {http.request.uri}"),
            redirect_status: redirectStatus.describe("[upsert_route/update_route] 重定向状态码，默认 308"),
            rewrite_uri: z.string().optional().describe("[upsert_route/update_route] 重写 URI（以 / 开头）"),
            strip_prefix: z.string().optional().describe("[upsert_route/update_route] 去除前缀"),
            headers: headersRecord.describe("[upsert_route/update_route] 自定义请求头，JSON 或 K:V,K2:V2"),
            cors: stringArray.describe("[upsert_route/update_route] 额外 CORS 源，逗号分隔"),
            priority: z.number().optional().describe("[upsert_route/update_route] 路由优先级"),
            enabled: z.boolean().optional().describe("[upsert_route/update_route] 是否启用"),
            // 网关配置
            rate_limit_tier: z.enum(["free", "pro", "enterprise"]).optional().describe("[config] 限流档位"),
            cors_origins: z.string().optional().describe("[config] CORS 源（逗号分隔）"),
            jwt_enabled: z.boolean().optional().describe("[config] 是否启用 JWT"),
            jwt_secret: z.string().optional().describe("[config] JWT 密钥"),
            // 证书
            cert_mode: z.enum(["lego", "manual"]).optional().describe("[update_certificate] 证书模式"),
            challenge: z.enum(["dns-01", "http-01"]).optional().describe("[update_certificate/issue_certificate] ACME challenge"),
            email: z.string().optional().describe("[update_certificate/issue_certificate] ACME 邮箱"),
            dns_provider: z.string().optional().describe("[update_certificate/issue_certificate] DNS 提供商"),
            dns_env: stringArray.describe("[update_certificate/issue_certificate] DNS 环境变量 KEY=VALUE 列表"),
            domains: stringArray.describe("[update_certificate/issue_certificate/deploy_certificate] 域名列表"),
            auto_renew: z.boolean().optional().describe("[update_certificate/issue_certificate] 自动续期"),
            renew: z.boolean().optional().describe("[issue_certificate] 仅续期已有证书"),
            cert: z.string().optional().describe("[deploy_certificate] PEM 证书内容"),
            key: z.string().optional().describe("[deploy_certificate] PEM 私钥内容"),
            // 重建
            clean: z.boolean().optional().describe("[rebuild] 清理后全量重建"),
            // 自定义域名
            custom_hostname: z.string().optional().describe("[set_custom_hostname] 自定义域名"),
        },
        async (args: any) => {
            const resolveRef = (override?: string) => {
                const ref = projectRef || override;
                if (!ref) throw new Error("'ref' is required for this action");
                return ref;
            };
            const need = (field: string, value: any) => {
                if (value === undefined || value === null || value === "") throw new Error(`'${field}' is required for '${args.action}'`);
            };

            const {
                action, ref, route_id, hosts, paths, upstream, upstream_tls_insecure_skip_verify,
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
