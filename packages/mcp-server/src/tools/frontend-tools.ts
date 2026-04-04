/**
 * Frontend Hosting Tools — Static site & SSR deployment via MCP
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerFrontendTools(server: McpServer, http: HttpTransport): void {
    // ═══════════════════════════════════════
    //  Deployment CRUD
    // ═══════════════════════════════════════

    server.tool(
        "list_frontend_deployments",
        "List all frontend (static site / SSR) deployments for a project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/frontend/deployments`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "get_frontend_deployment",
        "Get details of a specific frontend deployment",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
        },
        async ({ ref, id }) => {
            const res = await http.get(`/v1/projects/${ref}/frontend/deployments/${id}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? JSON.stringify(res.data, null, 2)
                        : `❌ Deployment not found (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "create_frontend_deployment",
        "Create a new frontend deployment configuration (static site or SSR). Supported frameworks: static, react, vue, svelte, sveltekit, nextjs, nuxt, astro. After creation, use deploy_frontend_git or deploy_frontend_files to push code.",
        {
            ref: z.string().describe("Project ref"),
            name: z.string().describe("Deployment name (e.g. 'my-landing-page')"),
            framework: z.string().describe("Framework: static | react | vue | svelte | sveltekit | nextjs | nuxt | astro"),
            domain: z.string().optional().describe("Custom domain (e.g. 'app.example.com')"),
            build_command: z.string().optional().describe("Build command override (e.g. 'npm run build')"),
            output_dir: z.string().optional().describe("Output directory override (e.g. 'dist')"),
            install_command: z.string().optional().describe("Install command override (e.g. 'bun install')"),
            node_version: z.string().optional().describe("Node.js version (e.g. '20')"),
            env_vars: z.record(z.string()).optional().describe("Environment variables for build"),
        },
        async ({ ref, name, framework, domain, build_command, output_dir, install_command, node_version, env_vars }) => {
            const res = await http.post(`/v1/projects/${ref}/frontend/deployments`, {
                name, framework, domain, build_command, output_dir, install_command, node_version, env_vars,
            });
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Deployment "${name}" created (${framework})\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Creation failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    server.tool(
        "update_frontend_deployment",
        "Update an existing frontend deployment configuration",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
            name: z.string().optional().describe("New name"),
            domain: z.string().optional().describe("New domain"),
            build_command: z.string().optional().describe("New build command"),
            output_dir: z.string().optional().describe("New output directory"),
            install_command: z.string().optional().describe("New install command"),
            node_version: z.string().optional().describe("New Node.js version"),
            env_vars: z.record(z.string()).optional().describe("New environment variables"),
        },
        async ({ ref, id, ...updates }) => {
            const res = await http.patch(`/v1/projects/${ref}/frontend/deployments/${id}`, updates);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Deployment updated\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Update failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    server.tool(
        "delete_frontend_deployment",
        "Delete a frontend deployment (removes config, build artifacts, and Angie route)",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
        },
        async ({ ref, id }) => {
            const res = await http.delete(`/v1/projects/${ref}/frontend/deployments/${id}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? `✅ Deployment deleted` : `❌ Deletion failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Deploy Actions
    // ═══════════════════════════════════════

    server.tool(
        "deploy_frontend_git",
        "Deploy a frontend site from a Git repository. Clones, installs deps, builds, and configures Angie routing.",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
            git_url: z.string().describe("Git repository URL (HTTPS)"),
            branch: z.string().optional().describe("Branch to deploy (default: main)"),
        },
        async ({ ref, id, git_url, branch }) => {
            const res = await http.post(`/v1/projects/${ref}/frontend/deployments/${id}/deploy/git`, {
                git_url, branch,
            });
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Git deployment complete\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Git deployment failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    server.tool(
        "redeploy_frontend",
        "Re-build and re-deploy an existing frontend from its cached source",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
        },
        async ({ ref, id }) => {
            const res = await http.post(`/v1/projects/${ref}/frontend/deployments/${id}/redeploy`);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Redeployment complete\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Redeployment failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Logs & Diagnostics
    // ═══════════════════════════════════════

    server.tool(
        "get_frontend_build_logs",
        "Get build logs for a frontend deployment (useful for debugging build failures)",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
        },
        async ({ ref, id }) => {
            const res = await http.get(`/v1/projects/${ref}/frontend/deployments/${id}/logs`);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? (res.data as { logs: string }).logs || "(no logs)"
                        : `❌ Failed to retrieve logs (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Custom Domains
    // ═══════════════════════════════════════

    server.tool(
        "add_frontend_domain",
        "Add a custom domain to a frontend deployment (auto-configures HTTPS via ACME/Let's Encrypt)",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
            domain: z.string().describe("Custom domain (e.g. 'www.example.com')"),
        },
        async ({ ref, id, domain }) => {
            const res = await http.post(`/v1/projects/${ref}/frontend/deployments/${id}/domains`, { domain });
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Domain ${domain} added`
                        : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`,
                }],
            };
        }
    );

    server.tool(
        "remove_frontend_domain",
        "Remove a custom domain from a frontend deployment",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
            domain: z.string().describe("Domain to remove"),
        },
        async ({ ref, id, domain }) => {
            const res = await http.delete(`/v1/projects/${ref}/frontend/deployments/${id}/domains/${domain}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Domain ${domain} removed`
                        : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Environment Variables
    // ═══════════════════════════════════════

    server.tool(
        "set_frontend_env",
        "Set build-time environment variables for a frontend deployment",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
            env_vars: z.record(z.string()).describe("Environment variables, e.g. { VITE_API_URL: 'https://...' }"),
        },
        async ({ ref, id, env_vars }) => {
            const res = await http.put(`/v1/projects/${ref}/frontend/deployments/${id}/env`, { env_vars });
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ Set ${Object.keys(env_vars).length} env vars`
                        : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Frameworks
    // ═══════════════════════════════════════

    server.tool(
        "list_frontend_frameworks",
        "List supported frontend frameworks and their default build settings",
        {},
        async () => {
            const res = await http.get(`/v1/projects/_/frontend/frameworks`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Deployment Records (History)
    // ═══════════════════════════════════════

    server.tool(
        "list_frontend_records",
        "List deployment history/records for a frontend deployment",
        {
            ref: z.string().describe("Project ref"),
            id: z.string().describe("Deployment ID"),
        },
        async ({ ref, id }) => {
            const res = await http.get(`/v1/projects/${ref}/frontend/deployments/${id}/records`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );
}
