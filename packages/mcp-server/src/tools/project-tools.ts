/**
 * 项目管理工具集 – 通过 Management API (HTTP) 操作
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerProjectTools(server: McpServer, http: HttpTransport): void {
    // ── 列出所有项目 ──
    server.tool(
        "list_projects",
        "列出 SupaCloud 上所有 Supabase 项目",
        {},
        async () => {
            const res = await http.get("/v1/projects");
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ 请求失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── 创建项目 ──
    server.tool(
        "create_project",
        "创建一个新的 Supabase 项目",
        {
            name: z.string().describe("项目名称"),
            region: z.string().default("local").describe("区域"),
            organization_id: z.string().optional().describe("组织 ID"),
        },
        async ({ name, region, organization_id }) => {
            const res = await http.post("/v1/projects", { name, region, organization_id });
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ 项目创建成功\n${JSON.stringify(res.data, null, 2)}`
                            : `❌ 创建失败 (${res.status}): ${JSON.stringify(res.data)}`,
                    },
                ],
            };
        }
    );

    // ── 获取项目详情 ──
    server.tool(
        "get_project",
        "获取 Supabase 项目的详细信息",
        {
            ref: z.string().describe("项目 ref (短 ID)"),
        },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ 项目不存在 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── 删除项目 ──
    server.tool(
        "delete_project",
        "删除一个 Supabase 项目 (软删除)",
        {
            ref: z.string().describe("项目 ref"),
        },
        async ({ ref }) => {
            const res = await http.delete(`/v1/projects/${ref}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ 项目 ${ref} 已删除` : `❌ 删除失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── 暂停 / 恢复项目 ──
    server.tool(
        "pause_project",
        "暂停一个 Supabase 项目以释放资源",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/pause`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ 项目 ${ref} 已暂停` : `❌ 暂停失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    server.tool(
        "restore_project",
        "恢复一个已暂停的 Supabase 项目",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/restore`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ 项目 ${ref} 已恢复` : `❌ 恢复失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── 项目健康检查 ──
    server.tool(
        "get_project_health",
        "获取项目的健康状态和各服务运行情况",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/health`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ 请求失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── 获取 API Keys ──
    server.tool(
        "get_api_keys",
        "获取项目的 anon_key 和 service_role_key",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/api-keys`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ 请求失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── 重启项目 ──
    server.tool(
        "restart_project",
        "重启项目的所有容器服务",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/restart`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ 重启完成` : `❌ 重启失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── 项目配置管理 ──
    server.tool(
        "get_project_settings",
        "获取项目配置 (域名、运行时、存储等)",
        { ref: z.string().describe("项目 ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/settings`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ 请求失败 (${res.status})`,
                    },
                ],
            };
        }
    );

    server.tool(
        "update_project_settings",
        "更新项目配置",
        {
            ref: z.string().describe("项目 ref"),
            settings: z.record(z.unknown()).describe("要更新的配置字段 (JSON 对象)"),
        },
        async ({ ref, settings }) => {
            const res = await http.put(`/v1/projects/${ref}/settings`, settings);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ 配置已更新\n${JSON.stringify(res.data, null, 2)}`
                            : `❌ 更新失败 (${res.status})`,
                    },
                ],
            };
        }
    );
}
