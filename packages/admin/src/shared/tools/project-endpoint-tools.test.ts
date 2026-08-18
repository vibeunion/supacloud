import { describe, expect, test } from "bun:test";
import { schemaEnumValues, type ToolSchema } from "../schema";
import { registerAdminProjectCliTools } from "./project-cli-tools";

const PROJECT_REF = "abc123";
const PROJECT_ENDPOINTS = {
    schema: "supacloud.project-endpoints.v1",
    project_ref: PROJECT_REF,
    endpoints: {
        api: {
            origin: "https://api.example.com",
            host: "api.example.com",
            scheme: "https",
            source: "explicit_api_domain",
            aliases: ["abc123.api.platform.example"],
        },
        auth: {
            origin: "https://auth.example.com",
            host: "auth.example.com",
            scheme: "https",
            source: "explicit_auth_domain",
            aliases: [],
        },
        studio: {
            origin: "https://studio.example.com",
            host: "studio.example.com",
            scheme: "https",
            source: "explicit_studio_domain",
            aliases: [],
        },
    },
};

type CapturedProjectTool = {
    schema: ToolSchema;
    callback: (args: Record<string, unknown>) => Promise<any>;
};

function captureAdminProjectTool(http: Record<string, unknown>): CapturedProjectTool {
    let captured: CapturedProjectTool | undefined;
    registerAdminProjectCliTools({
        tool(name: string, _description: string, schema: ToolSchema, callback: CapturedProjectTool["callback"]) {
            if (name === "project") captured = { schema, callback };
        },
    }, http as any);
    if (!captured) throw new Error("admin project tool was not registered");
    return captured;
}

describe("admin project endpoint CLI actions", () => {
    test("exposes single-project and fleet endpoint reads", async () => {
        const requests: Array<{ path: string; maxResponseBytes?: number }> = [];
        const tool = captureAdminProjectTool({
            get: async (path: string, options?: { maxResponseBytes?: number }) => {
                requests.push({ path, maxResponseBytes: options?.maxResponseBytes });
                return {
                    ok: true,
                    status: 200,
                    data: path === "/v1/projects/endpoints" ? [PROJECT_ENDPOINTS] : PROJECT_ENDPOINTS,
                };
            },
        });

        expect(schemaEnumValues(tool.schema.action)).toEqual(
            expect.arrayContaining(["endpoints", "list_endpoints"]),
        );

        const single = await tool.callback({ action: "endpoints", ref: PROJECT_REF });
        const list = await tool.callback({ action: "list_endpoints" });

        expect(requests).toEqual([
            {
                path: `/v1/projects/${PROJECT_REF}/endpoint/projection`,
                maxResponseBytes: 256 * 1024,
            },
            {
                path: "/v1/projects/endpoints",
                maxResponseBytes: 1024 * 1024,
            },
        ]);
        expect(single.isError).not.toBe(true);
        expect(list.isError).not.toBe(true);
        expect(JSON.parse(single.content[0].text)).toEqual(PROJECT_ENDPOINTS);
        expect(JSON.parse(list.content[0].text)).toEqual([PROJECT_ENDPOINTS]);
    });

    test("rejects secret-bearing endpoint responses without reflection", async () => {
        const remoteSecret = "admin-project-endpoint-private-sentinel";
        const tool = captureAdminProjectTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: { ...PROJECT_ENDPOINTS, credentials: { service_role_key: remoteSecret } },
            }),
        });

        const response = await tool.callback({ action: "endpoints", ref: PROJECT_REF });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Invalid project endpoint response");
        expect(response.content[0].text).not.toContain(remoteSecret);
    });
});
