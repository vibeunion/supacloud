/**
 * Frontend Hosting — Compound tool (13→1)
 */
import { basename } from "node:path";
import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";

export function registerFrontendTools(server: { tool: (...args: any[]) => void }, http: HttpTransport): void {
    server.tool(
        "frontend",
        `Frontend hosting (static sites & SSR). Supports: static, react, vue, svelte, sveltekit, nextjs, nuxt, astro.
Actions: list, get, create, update, delete, deploy_git, deploy_upload, redeploy, build_logs, add_domain, remove_domain, set_env, list_frameworks, list_records`,
        {
            action: withDescription(stringEnum([
                "list", "get", "create", "update", "delete",
                "deploy_git", "deploy_upload", "redeploy", "build_logs",
                "add_domain", "remove_domain", "set_env",
                "list_frameworks", "list_records",
            ]), "Action"),
            ref: optional(Type.String(), "Project ref"),
            id: optional(Type.String(), "Deployment ID"),
            // create/update params
            name: optional(Type.String(), "[create] Deployment name"),
            framework: optional(Type.String(), "[create] Framework (static|react|vue|svelte|sveltekit|nextjs|nuxt|astro)"),
            domain: optional(Type.String(), "[create/update/add_domain/remove_domain] Custom domain"),
            build_command: optional(Type.String(), "[create/update] Build command override"),
            output_dir: optional(Type.String(), "[create/update] Output directory override"),
            install_command: optional(Type.String(), "[create/update] Install command override"),
            node_version: optional(Type.String(), "[create/update] Node.js version"),
            env_vars: optional(Type.Record(Type.String(), Type.String()), "[create/update/set_env] Environment variables"),
            // deploy_git params
            git_url: optional(Type.String(), "[deploy_git] Git repository URL"),
            branch: optional(Type.String(), "[deploy_git] Branch (default: main)"),
            zip_path: optional(Type.String(), "[deploy_upload] Local zip file path"),
        },
        async (args: any) => {
            const { action, ref, id, name, framework, domain, build_command, output_dir, install_command, node_version, env_vars, git_url, branch, zip_path } = args;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };
            const ok = (res: any) => res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`;

            let text: string;
            switch (action) {
                case "list":
                    need("ref", ref);
                    text = ok(await http.get(`/v1/projects/${ref}/frontend/deployments`));
                    break;
                case "get":
                    need("ref", ref); need("id", id);
                    text = ok(await http.get(`/v1/projects/${ref}/frontend/deployments/${id}`));
                    break;
                case "create":
                    need("ref", ref); need("name", name); need("framework", framework);
                    text = ok(await http.post(`/v1/projects/${ref}/frontend/deployments`, {
                        name, framework, domain, build_command, output_dir, install_command, node_version, env_vars,
                    }));
                    break;
                case "update":
                    need("ref", ref); need("id", id);
                    text = ok(await http.patch(`/v1/projects/${ref}/frontend/deployments/${id}`, {
                        name, domain, build_command, output_dir, install_command, node_version, env_vars,
                    }));
                    break;
                case "delete":
                    need("ref", ref); need("id", id);
                    text = (await http.delete(`/v1/projects/${ref}/frontend/deployments/${id}`)).ok ? `✅ Deleted` : `❌ Failed`;
                    break;
                case "deploy_git":
                    need("ref", ref); need("id", id); need("git_url", git_url);
                    text = ok(await http.post(`/v1/projects/${ref}/frontend/deployments/${id}/deploy/git`, { git_url, branch }));
                    break;
                case "deploy_upload":
                    need("ref", ref); need("id", id); need("zip_path", zip_path);
                    const file = Bun.file(zip_path!);
                    if (!(await file.exists())) {
                        throw new Error(`Zip file not found: ${zip_path}`);
                    }
                    const form = new FormData();
                    form.append(
                        "file",
                        new File([await file.arrayBuffer()], basename(zip_path!), {
                            type: "application/zip",
                        }),
                    );
                    text = ok(
                        await http.postMultipart(
                            `/v1/projects/${ref}/frontend/deployments/${id}/deploy/upload`,
                            form,
                        ),
                    );
                    break;
                case "redeploy":
                    need("ref", ref); need("id", id);
                    text = ok(await http.post(`/v1/projects/${ref}/frontend/deployments/${id}/redeploy`));
                    break;
                case "build_logs":
                    need("ref", ref); need("id", id);
                    const lr = await http.get(`/v1/projects/${ref}/frontend/deployments/${id}/logs`);
                    text = lr.ok ? ((lr.data as any)?.logs || "(no logs)") : `❌ Failed (${lr.status})`;
                    break;
                case "add_domain":
                    need("ref", ref); need("id", id); need("domain", domain);
                    text = (await http.post(`/v1/projects/${ref}/frontend/deployments/${id}/domains`, { domain })).ok
                        ? `✅ Domain ${domain} added` : `❌ Failed`;
                    break;
                case "remove_domain":
                    need("ref", ref); need("id", id); need("domain", domain);
                    text = (await http.delete(`/v1/projects/${ref}/frontend/deployments/${id}/domains/${domain}`)).ok
                        ? `✅ Domain ${domain} removed` : `❌ Failed`;
                    break;
                case "set_env":
                    need("ref", ref); need("id", id); need("env_vars", env_vars);
                    text = (await http.put(`/v1/projects/${ref}/frontend/deployments/${id}/env`, { env_vars })).ok
                        ? `✅ Set ${Object.keys(env_vars!).length} env vars` : `❌ Failed`;
                    break;
                case "list_frameworks":
                    text = ok(await http.get("/v1/projects/_/frontend/frameworks"));
                    break;
                case "list_records":
                    need("ref", ref); need("id", id);
                    text = ok(await http.get(`/v1/projects/${ref}/frontend/deployments/${id}/records`));
                    break;
                default: text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
