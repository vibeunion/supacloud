import { describe, expect, test } from "bun:test";
import { registerAdminProjectCliTools } from "./project-cli-tools";

type ProjectCallback = (
    args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }> }>;

function captureAdminProjectTool(http: Record<string, unknown>): ProjectCallback {
    let projectCallback: ProjectCallback | undefined;
    registerAdminProjectCliTools({
        tool(name: string, _description: string, _schema: Record<string, unknown>, callback: ProjectCallback) {
            if (name === "project") projectCallback = callback;
        },
    }, http as any);

    if (!projectCallback) throw new Error("admin project tool was not registered");
    return projectCallback;
}

describe("admin project create", () => {
    test("forwards every non-empty custom domain unchanged", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const projectCallback = captureAdminProjectTool({
            post: async (path: string, body: unknown) => {
                requests.push({ path, body });
                return { ok: true, status: 201, data: { ref: "project-ref" } };
            },
        });

        await projectCallback({
            action: "create",
            name: "domain-project",
            region: "ap-southeast-1",
            organization_id: "organization-id",
            domain: "Example.COM",
            api_domain: "API.Example.COM",
            auth_domain: "Auth.Example.COM",
            studio_domain: "Studio.Example.COM",
        });

        expect(requests).toEqual([{
            path: "/v1/projects",
            body: {
                name: "domain-project",
                region: "ap-southeast-1",
                organization_id: "organization-id",
                domain: "Example.COM",
                api_domain: "API.Example.COM",
                auth_domain: "Auth.Example.COM",
                studio_domain: "Studio.Example.COM",
            },
        }]);
    });

    test("omits empty custom domain flags from the create request", async () => {
        let createRequest: Record<string, unknown> | undefined;
        const projectCallback = captureAdminProjectTool({
            post: async (_path: string, body: Record<string, unknown>) => {
                createRequest = body;
                return { ok: true, status: 201, data: { ref: "project-ref" } };
            },
        });

        await projectCallback({
            action: "create",
            name: "default-domain-project",
            domain: "",
            api_domain: "",
            auth_domain: "",
            studio_domain: "",
        });

        if (!createRequest) throw new Error("project create request was not captured");
        expect(createRequest.name).toBe("default-domain-project");
        expect(createRequest.region).toBe("local");
        expect("domain" in createRequest).toBe(false);
        expect("api_domain" in createRequest).toBe(false);
        expect("auth_domain" in createRequest).toBe(false);
        expect("studio_domain" in createRequest).toBe(false);
    });
});
