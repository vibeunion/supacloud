/**
 * Advanced — Split into 3 compound tools: edge_functions, secrets, platform
 */
import { z } from "zod";
import type { HttpTransport } from "../transports/http";

export function registerAdvancedTools(server: { tool: (...args: any[]) => void }, http: HttpTransport): void {

    // ═══ Edge Functions (5→1) ═══
    server.tool(
        "edge_functions",
        `Edge Function management (Deno/Bun serverless). Server auto-bundles dependencies.
Actions: list, deploy, deploy_bundle, source, delete, check`,
        {
            action: z.enum(["list", "deploy", "deploy_bundle", "source", "delete", "check"]).describe("Action"),
            ref: z.string().describe("Project ref"),
            slug: z.string().optional().describe("[deploy/deploy_bundle/source/delete/check] Function name"),
            code: z.string().optional().describe("[deploy/check] Function source code (TypeScript)"),
            path: z.string().optional().describe("[deploy/check] Local file path to read code from (alternative to code)"),
            files: z.record(z.string(), z.string()).optional().describe("[deploy_bundle] File map: { 'index.ts': '...', '_shared/x.ts': '...' }"),
            entrypoint: z.string().optional().describe("[deploy_bundle] Entrypoint file (default: index.ts)"),
            minify: z.boolean().optional().describe("[deploy/deploy_bundle] Minify bundle"),
        },
        async (args: any) => {
            const { action, ref, slug, path: pathArg, files, entrypoint, minify } = args;
            let code = args.code as string | undefined;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };

            let text: string;

            // Helper for local TS syntax check
            const checkSyntax = async (sourceCode: string): Promise<{ ok: boolean; err?: string }> => {
                const fs = require("fs");
                const os = require("os");
                const { promisify } = require("util");
                const execAsync = promisify(require("child_process").exec);
                const tmpFile = `${os.tmpdir()}/supacloud_edge_${Date.now()}.ts`;
                fs.writeFileSync(tmpFile, sourceCode);
                try {
                    await execAsync(`bun build ${tmpFile} --external='*'`);
                    return { ok: true };
                } catch (e: any) {
                    return { ok: false, err: e.stdout + "\n" + (e.stderr || e.message) };
                } finally {
                    try { fs.unlinkSync(tmpFile); } catch (e) {}
                }
            };

            // Resolve code from path if provided
            if (pathArg && !code) {
                try {
                    const fs = require("fs");
                    const os = require("os");
                    const { promisify } = require("util");
                    const execAsync = promisify(require("child_process").exec);

                    const stat = fs.statSync(pathArg);
                    let entrypoint = pathArg;
                    if (stat.isDirectory()) {
                        entrypoint = `${pathArg}/index.ts`;
                        if (!fs.existsSync(entrypoint)) {
                            throw new Error(`Directory provided but no index.ts found at ${entrypoint}`);
                        }
                    }

                    // For edge functions, local auto-bundling is highly recommended to resolve multi-file imports
                    // We bundle the function to a temp file, then read it as the deployment code.
                    const tmpOut = `${os.tmpdir()}/supacloud_bundled_${Date.now()}.js`;
                    try {
                        const { stderr } = await execAsync(`bun build ${entrypoint} --target bun --outfile ${tmpOut}`);
                        if (!fs.existsSync(tmpOut)) throw new Error(`Bundle failed: ${stderr}`);
                        code = fs.readFileSync(tmpOut, "utf-8");
                    } finally {
                        try { fs.unlinkSync(tmpOut); } catch (e) {}
                    }
                } catch (e: any) {
                    throw new Error(`Failed to bundle/read path ${pathArg}: ${e.message}`);
                }
            }

            switch (action) {
                case "list":
                    text = JSON.stringify((await http.get(`/v1/projects/${ref}/functions`)).data, null, 2);
                    break;
                case "check":
                    need("code (or path)", code);
                    const checkRes = await checkSyntax(code!);
                    if (checkRes.ok) {
                        text = `✅ Syntax check passed for function`;
                    } else {
                        text = `❌ Syntax check failed:\n${checkRes.err}`;
                    }
                    break;
                case "deploy":
                    need("slug", slug); need("code", code);
                    const deployCheck = await checkSyntax(code!);
                    if (!deployCheck.ok) {
                        text = `❌ Deployment aborted. Syntax check failed:\n${deployCheck.err}`;
                        break;
                    }
                    const dr = await http.post(`/v1/projects/${ref}/functions/${slug}`, { code, minify });
                    text = dr.ok ? `✅ Function ${slug} deployed` : `❌ Failed (${dr.status}): ${JSON.stringify(dr.data)}`;
                    break;
                case "deploy_bundle":
                    need("slug", slug); need("files", files);
                    const br = await http.post(`/v1/projects/${ref}/functions/${slug}/bundle`, { files, entrypoint, minify });
                    text = br.ok ? `✅ Function ${slug} bundle deployed (${Object.keys(files!).length} files)` : `❌ Failed (${br.status}): ${JSON.stringify(br.data)}`;
                    break;
                case "source":
                    need("slug", slug);
                    const sr = await http.get(`/v1/projects/${ref}/functions/${slug}/source`);
                    text = sr.ok ? JSON.stringify(sr.data, null, 2) : `❌ Not found (${sr.status})`;
                    break;
                case "delete":
                    need("slug", slug);
                    text = (await http.delete(`/v1/projects/${ref}/functions/${slug}`)).ok ? `✅ Function ${slug} deleted` : `❌ Failed`;
                    break;
                default: text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );

    // ═══ Secrets (3→1) ═══
    server.tool(
        "secrets",
        `Project secrets (environment variables for Edge Functions).
Actions: list, upsert, delete`,
        {
            action: z.enum(["list", "upsert", "delete"]).describe("Action"),
            ref: z.string().describe("Project ref"),
            secrets: z.array(z.object({ name: z.string(), value: z.string() })).optional()
                .describe("[upsert] Secret list: [{name:'KEY', value:'...'}]"),
            name: z.string().optional().describe("[delete] Secret name to delete"),
        },
        async (args: any) => {
            const { action, ref, secrets, name } = args;
            let text: string;
            switch (action) {
                case "list":
                    text = JSON.stringify((await http.get(`/v1/projects/${ref}/secrets`)).data, null, 2);
                    break;
                case "upsert":
                    if (!secrets?.length) throw new Error("'secrets' array required");
                    text = (await http.post(`/v1/projects/${ref}/secrets`, secrets)).ok
                        ? `✅ Updated ${secrets.length} secrets` : `❌ Failed`;
                    break;
                case "delete":
                    if (!name) throw new Error("'name' required");
                    text = (await http.delete(`/v1/projects/${ref}/secrets/${name}`)).ok
                        ? `✅ Secret ${name} deleted` : `❌ Failed`;
                    break;
                default: text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );

    // ═══ Platform (metrics + backup + network + org → 1) ═══
    server.tool(
        "platform",
        `Platform monitoring, backups, network, and organizations.
Actions: metrics, list_backups, create_backup, network, update_network, list_orgs, get_org`,
        {
            action: z.enum([
                "metrics", "list_backups", "create_backup",
                "network", "update_network",
                "list_orgs", "get_org",
            ]).describe("Action"),
            ref: z.string().optional().describe("Project ref (for backup/network actions)"),
            slug: z.string().optional().describe("[get_org] Organization slug"),
            allowed_cidrs: z.array(z.string()).optional().describe("[update_network] Allowed CIDRs"),
        },
        async (args: any) => {
            const { action, ref, slug, allowed_cidrs } = args;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };
            let text: string;
            switch (action) {
                case "metrics":
                    text = JSON.stringify((await http.get("/v1/monitor/system")).data, null, 2);
                    break;
                case "list_backups":
                    need("ref", ref);
                    text = JSON.stringify((await http.get(`/v1/projects/${ref}/database/backups`)).data, null, 2);
                    break;
                case "create_backup": {
                    need("ref", ref);
                    const r = await http.post(`/v1/projects/${ref}/database/backups`);
                    text = r.ok ? `✅ Backup created\n${JSON.stringify(r.data, null, 2)}` : `❌ Failed (${r.status})`;
                    break;
                }
                case "network":
                    need("ref", ref);
                    text = JSON.stringify((await http.get(`/v1/projects/${ref}/network-restrictions`)).data, null, 2);
                    break;
                case "update_network":
                    need("ref", ref); if (!allowed_cidrs) throw new Error("'allowed_cidrs' required");
                    text = (await http.put(`/v1/projects/${ref}/network-restrictions`, { allowedCidrs: allowed_cidrs })).ok
                        ? `✅ Network restrictions updated` : `❌ Failed`;
                    break;
                case "list_orgs":
                    text = JSON.stringify((await http.get("/v1/organizations")).data, null, 2);
                    break;
                case "get_org":
                    need("slug", slug);
                    text = JSON.stringify((await http.get(`/v1/organizations/${slug}`)).data, null, 2);
                    break;
                default: text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
