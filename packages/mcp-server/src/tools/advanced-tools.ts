/**
 * 高级工具集 – Edge Functions、Secrets、Auth 配置、备份
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerAdvancedTools(server: McpServer, http: HttpTransport): void {
    // ═══════════════════════════════════════
    //  Edge Functions
    // ═══════════════════════════════════════

    server.tool(
        "list_edge_functions",
        "列出项目的所有 Edge Functions",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/functions`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "deploy_edge_function",
        "部署一个 Edge Function 到项目",
        {
            ref: z.string().describe("项目 ref"),
            slug: z.string().describe("函数名 (slug)"),
            code: z.string().describe("函数源代码 (TypeScript)"),
        },
        async ({ ref, slug, code }) => {
            const res = await http.post(`/v1/projects/${ref}/functions/${slug}`, { code });
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ 函数 ${slug} 部署成功`
                            : `❌ 部署失败 (${res.status}): ${JSON.stringify(res.data)}`,
                    },
                ],
            };
        }
    );

    server.tool(
        "delete_edge_function",
        "删除项目中的一个 Edge Function",
        {
            ref: z.string().describe("项目 ref"),
            slug: z.string().describe("函数名"),
        },
        async ({ ref, slug }) => {
            const res = await http.delete(`/v1/projects/${ref}/functions/${slug}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ 函数 ${slug} 已删除` : `❌ 删除失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Secrets
    // ═══════════════════════════════════════

    server.tool(
        "list_secrets",
        "列出项目的所有 Secrets (环境变量)",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/secrets`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "upsert_secrets",
        "创建或更新项目的 Secrets",
        {
            ref: z.string().describe("项目 ref"),
            secrets: z
                .array(z.object({ name: z.string(), value: z.string() }))
                .describe("Secret 列表，例如 [{name: 'API_KEY', value: '...'}]"),
        },
        async ({ ref, secrets }) => {
            const res = await http.post(`/v1/projects/${ref}/secrets`, secrets);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ 已更新 ${secrets.length} 个 Secrets`
                            : `❌ 更新失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    server.tool(
        "delete_secret",
        "删除项目的一个 Secret",
        {
            ref: z.string().describe("项目 ref"),
            name: z.string().describe("Secret 名称"),
        },
        async ({ ref, name }) => {
            const res = await http.delete(`/v1/projects/${ref}/secrets/${name}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ Secret ${name} 已删除` : `❌ 删除失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Auth 配置
    // ═══════════════════════════════════════

    server.tool(
        "get_auth_config",
        "获取项目的 Auth 鉴权配置 (SMTP, OAuth 提供商等)",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/config/auth`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "update_auth_config",
        "更新项目的 Auth 鉴权配置，可一次性开启多个 OAuth 提供商或配置 SMTP",
        {
            ref: z.string().describe("项目 ref"),
            config: z
                .record(z.unknown())
                .describe(
                    "Auth 配置对象，例如: {external_google_enabled: true, external_google_client_id: '...'}"
                ),
        },
        async ({ ref, config }) => {
            const res = await http.patch(`/v1/projects/${ref}/config/auth`, config);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Auth 配置已更新`
                            : `❌ 更新失败 (${res.status}): ${JSON.stringify(res.data)}`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  备份
    // ═══════════════════════════════════════

    server.tool(
        "list_backups",
        "列出项目的所有数据库备份",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/database/backups`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "create_backup",
        "为项目创建一个数据库备份",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/database/backups`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ 备份任务已创建\n${JSON.stringify(res.data, null, 2)}`
                            : `❌ 备份失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  监控
    // ═══════════════════════════════════════

    server.tool(
        "get_system_metrics",
        "获取 SupaCloud 平台的系统级监控指标",
        {},
        async () => {
            const res = await http.get("/v1/monitor/system");
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  安全
    // ═══════════════════════════════════════

    server.tool(
        "get_network_restrictions",
        "获取项目的网络访问限制规则",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/network-restrictions`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "update_network_restrictions",
        "更新项目的网络访问限制 (IP 白名单)",
        {
            ref: z.string().describe("项目 ref"),
            restrictions: z
                .object({
                    allowedCidrs: z.array(z.string()).describe("允许访问的 CIDR 列表"),
                })
                .describe("网络限制配置"),
        },
        async ({ ref, restrictions }) => {
            const res = await http.put(`/v1/projects/${ref}/network-restrictions`, restrictions);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ 网络限制已更新`
                            : `❌ 更新失败 (${res.status})`,
                    },
                ],
            };
        }
    );
}
