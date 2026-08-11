import { describe, expect, test } from "bun:test";
import { registerAdminProjectCliTools } from "./project-cli-tools";
import { schemaEnumValues } from "../schema";
import type { ToolSchema } from "../schema";

type ProjectCallback = (
    args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

type ProjectToolRegistration = {
    callback: ProjectCallback;
    schema: ToolSchema;
};

function captureAdminProjectRegistration(http: Record<string, unknown>): ProjectToolRegistration {
    let registration: ProjectToolRegistration | undefined;
    registerAdminProjectCliTools({
        tool(name: string, _description: string, schema: ToolSchema, callback: ProjectCallback) {
            if (name === "project") registration = { callback, schema };
        },
    }, http as any);

    if (!registration) throw new Error("admin project tool was not registered");
    return registration;
}

function captureAdminProjectTool(http: Record<string, unknown>): ProjectCallback {
    return captureAdminProjectRegistration(http).callback;
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

describe("admin project services", () => {
    test("declares inventory and constrained service control actions", () => {
        const { schema } = captureAdminProjectRegistration({});

        expect(schemaEnumValues(schema.action)).toContain("services");
        expect(schemaEnumValues(schema.action)).toContain("service_control");
        expect(schemaEnumValues(schema.service)).toEqual([
            "postgrest", "gotrue", "storage", "postgresql", "realtime", "gateway",
        ]);
        expect(schemaEnumValues(schema.service_action)).toEqual([
            "start", "stop", "restart", "pause", "resume", "status",
        ]);
    });

    test("lists a strictly validated project service inventory", async () => {
        let requestedPath = "";
        const projectCallback = captureAdminProjectTool({
            get: async (path: string) => {
                requestedPath = path;
                return {
                    ok: true,
                    status: 200,
                    data: [{
                        id: "auth",
                        name: "auth",
                        status: "INACTIVE",
                        healthy: false,
                        service_host_ids: ["project-ref-auth"],
                    }],
                };
            },
        });

        const response = await projectCallback({ action: "services", ref: "project/ref" });
        const output = JSON.parse(response.content[0].text);

        expect(requestedPath).toBe("/v1/projects/project%2Fref/services");
        expect(response.isError).not.toBe(true);
        expect(output.project_ref).toBe("project/ref");
        expect(output.services[0].id).toBe("auth");
    });

    test("fails closed when the inventory contract is malformed", async () => {
        const projectCallback = captureAdminProjectTool({
            get: async () => ({ ok: true, status: 200, data: [{ id: "auth" }] }),
        });

        const response = await projectCallback({ action: "services", ref: "project-ref" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("inventory response is invalid");
    });
});

describe("admin project service control", () => {
    test("stops local GoTrue through the exact Management API route", async () => {
        let requestedPath = "";
        const projectCallback = captureAdminProjectTool({
            post: async (path: string) => {
                requestedPath = path;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        service: "gotrue",
                        action: "stop",
                        success: true,
                        message: "Service gotrue stop succeeded",
                    },
                };
            },
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });
        const receipt = JSON.parse(response.content[0].text);

        expect(requestedPath).toBe("/v1/projects/project-ref/services/gotrue/stop");
        expect(response.isError).not.toBe(true);
        expect(receipt).toMatchObject({
            project_ref: "project-ref",
            service: "gotrue",
            action: "stop",
            success: true,
        });
        expect(receipt.receipt.message).toContain("succeeded");
    });

    test("routes every Management API-supported canonical service and action pair", async () => {
        const requestedPaths: string[] = [];
        const projectCallback = captureAdminProjectTool({
            post: async (path: string) => {
                requestedPaths.push(path);
                const [, , , , , service, serviceAction] = path.split("/");
                return {
                    ok: true,
                    status: 200,
                    data: {
                        service,
                        action: serviceAction,
                        success: true,
                        message: `Service ${service} ${serviceAction} succeeded`,
                    },
                };
            },
        });
        const supportedActions = {
            postgrest: ["start", "stop", "restart", "pause", "resume", "status"],
            gotrue: ["start", "stop", "restart"],
            storage: ["start", "stop", "restart"],
            postgresql: ["start", "stop", "restart"],
            realtime: ["start", "stop", "restart"],
            gateway: ["start", "stop", "restart"],
        } as const;

        for (const [service, serviceActions] of Object.entries(supportedActions)) {
            for (const serviceAction of serviceActions) {
                const response = await projectCallback({
                    action: "service_control",
                    ref: "project-ref",
                    service,
                    service_action: serviceAction,
                });
                expect(response.isError).not.toBe(true);
            }
        }

        expect(requestedPaths).toHaveLength(21);
        expect(requestedPaths).toContain("/v1/projects/project-ref/services/postgrest/status");
        expect(requestedPaths).toContain("/v1/projects/project-ref/services/gateway/restart");
    });

    test("rejects unsupported service and action pairs before the request", async () => {
        let requestCount = 0;
        const projectCallback = captureAdminProjectTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "storage",
            service_action: "pause",
        })).rejects.toThrow("'pause' is not supported for service 'storage'");
        expect(requestCount).toBe(0);
    });

    test("treats an HTTP 200 failure receipt as an error", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    service: "gotrue",
                    action: "stop",
                    success: false,
                    message: "Service gotrue stop failed",
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("Project service control failed");
    });

    test("rejects a success receipt that does not match the request", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    service: "storage",
                    action: "stop",
                    success: true,
                    message: "Service storage stop succeeded",
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("does not match the request");
    });

    test("preserves the shared Auth owner boundary as a non-zero CLI result", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: false,
                status: 409,
                data: {
                    code: "AUTH_RUNTIME_MANAGED_BY_OWNER",
                    authority_project_ref: "supauth-owner",
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "shared-project",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("AUTH_RUNTIME_MANAGED_BY_OWNER");
        expect(response.content[0].text).toContain("supauth-owner");
    });
});
