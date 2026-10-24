import { Type } from "typebox";
import type { ResolvedContext } from "../context";
import { projectRefPathSegment } from "../project-ref";
import { registerTool, type ToolServer } from "../tool-server";

function projectMcpEndpoint(context: ResolvedContext): string {
    if (context.credentialScope !== "management" || !context.apiUrl || !context.apiToken) {
        throw new Error("MCP configuration requires Management API context");
    }
    if (!context.projectRef) {
        throw new Error("MCP configuration requires SUPACLOUD_PROJECT_REF");
    }
    return `${context.apiUrl}/mcp/projects/${projectRefPathSegment(context.projectRef, "MCP")}`;
}

export function mcpConfiguration(context: ResolvedContext): Record<string, unknown> {
    const endpoint = projectMcpEndpoint(context);
    const projectRef = context.projectRef;
    return {
        project_ref: projectRef,
        scope: "project",
        transport: "streamable-http",
        endpoint,
        authorization: {
            type: "bearer",
            environment_variable: "SUPACLOUD_API_TOKEN",
            header_template: "Bearer ${SUPACLOUD_API_TOKEN}",
            requires_client_configuration: true,
        },
        client_config: {
            mcpServers: {
                [`supacloud-${projectRef}`]: {
                    url: endpoint,
                    headers: {
                        Authorization: "Bearer ${SUPACLOUD_API_TOKEN}",
                    },
                },
            },
        },
        safety: {
            project_binding: projectRef,
            cross_project_requests: "rejected",
            secrets_in_output: false,
        },
    };
}

export function registerMcpTools(server: ToolServer, context: ResolvedContext): void {
    registerTool(
        server,
        "mcp",
        "Print a project-scoped MCP configuration without exposing credentials.",
        { action: Type.Literal("config") },
        async () => ({
            content: [{ type: "text", text: JSON.stringify(mcpConfiguration(context), null, 2) }],
        }),
    );
}
