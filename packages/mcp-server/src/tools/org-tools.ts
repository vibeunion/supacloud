/**
 * Organization Tools - Org management
 * Maps to Management API: /v1/organizations/*
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerOrganizationTools(server: McpServer, http: HttpTransport): void {
    server.tool(
        "list_organizations",
        "List all organizations",
        {},
        async () => {
            const res = await http.get("/v1/organizations");
            return {
                content: [{
                    type: "text",
                    text: res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "get_organization",
        "Get organization details by slug",
        { slug: z.string().describe("Organization slug") },
        async ({ slug }) => {
            const res = await http.get(`/v1/organizations/${slug}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? JSON.stringify(res.data, null, 2) : `❌ Organization not found (${res.status})`,
                }],
            };
        }
    );
}
