import { expect, test } from "bun:test";
import { resolveSupaCloudContext } from "../context";
import { mcpConfiguration } from "./mcp-tools";

const context = resolveSupaCloudContext({
    SUPACLOUD_API_URL: "https://control.example.com",
    SUPACLOUD_API_TOKEN: "project-a-token",
    SUPACLOUD_PROJECT_REF: "project-a",
}, "/tmp");

test("prints project connection metadata without credentials", () => {
    const configuration = mcpConfiguration(context);
    expect(configuration).toMatchObject({
        project_ref: "project-a",
        endpoint: "https://control.example.com/mcp/projects/project-a",
        client_config: {
            mcpServers: {
                "supacloud-project-a": {
                    url: "https://control.example.com/mcp/projects/project-a",
                },
            },
        },
        safety: {
            project_binding: "project-a",
            cross_project_requests: "rejected",
        },
    });
    expect(JSON.stringify(configuration)).not.toContain("project-a-token");
});

test("rejects application-only credentials and unsafe project references", () => {
    expect(() => mcpConfiguration({ ...context, credentialScope: "project_application" })).toThrow();
    expect(() => mcpConfiguration({ ...context, apiToken: "" })).toThrow();
    for (const projectRef of ["", "..", "a/b", "a?b", "%2e%2e"]) {
        expect(() => mcpConfiguration({ ...context, projectRef })).toThrow();
    }
});
