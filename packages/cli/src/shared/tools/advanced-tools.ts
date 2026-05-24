/**
 * Advanced — Split into 3 compound tools: edge_functions, secrets, platform
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { z } from "zod";
import type { HttpTransport } from "../transports/http";

const execFileAsync = promisify(execFile);

async function runBunBuild(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
        return await execFileAsync("bun", ["build", ...args], { maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
        const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (e.code === "ENOENT") {
            throw new Error("Bun is required for local edge function bundling. Install Bun or use deploy_bundle with explicit files.");
        }
        throw error;
    }
}

async function bundleEdgeFunctionPath(pathArg: string): Promise<string> {
    const entrypoint = resolveEntrypoint(pathArg);
    const tmpDir = mkdtempSync(join(tmpdir(), "supacloud-edge-"));
    const outfile = join(tmpDir, `${basename(entrypoint).replace(/\.[^.]+$/, "") || "index"}.js`);
    try {
        const { stderr } = await runBunBuild([entrypoint, "--target", "bun", "--outfile", outfile]);
        if (!existsSync(outfile)) throw new Error(`Bundle failed: ${stderr}`);
        return readFileSync(outfile, "utf-8");
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

function resolveEntrypoint(pathArg: string): string {
    const resolved = resolve(pathArg);
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return resolved;
    const entrypoint = join(resolved, "index.ts");
    if (!existsSync(entrypoint)) {
        throw new Error(`Directory provided but no index.ts found at ${entrypoint}`);
    }
    return entrypoint;
}

const backgroundRoutesSchema = z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith("[")) return trimmed.split(",").map((route) => route.trim()).filter(Boolean);
    try {
        return JSON.parse(trimmed);
    } catch {
        return [trimmed];
    }
}, z.array(z.string()).optional().superRefine((routes, ctx) => {
    if (!routes) return;
    for (const route of routes) {
        if (route.trim().startsWith("[")) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid background_routes JSON array. Use a valid JSON array or comma-separated routes like /queue/*,/render/*.",
            });
            return;
        }
    }
}));

const secretsSchema = z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return trimmed;
        }
    }
    return trimmed.split(",").map((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0) return { name: entry.trim(), value: "" };
        return {
            name: entry.slice(0, separator).trim(),
            value: entry.slice(separator + 1),
        };
    }).filter((entry) => entry.name);
}, z.array(z.object({ name: z.string(), value: z.string() })).optional());

type EdgeFunctionConfigInput = {
    verify_jwt?: boolean;
    background_routes?: string[];
};

export function registerAdvancedTools(server: { tool: (...args: any[]) => void }, http: HttpTransport): void {

    // ═══ Edge Functions (5→1) ═══
    server.tool(
        "edge_functions",
        `Edge Function management (Deno/Bun serverless). Server auto-bundles dependencies.
Actions: list, deploy, deploy_bundle, config, source, delete, check`,
        {
            action: z.enum(["list", "deploy", "deploy_bundle", "config", "source", "delete", "check"]).describe("Action"),
            ref: z.string().describe("Project ref"),
            slug: z.string().optional().describe("[deploy/deploy_bundle/config/source/delete/check] Function name"),
            code: z.string().optional().describe("[deploy/check] Function source code (TypeScript)"),
            path: z.string().optional().describe("[deploy/check] Local file path to read code from (alternative to code)"),
            files: z.record(z.string()).optional().describe("[deploy_bundle] File map: { 'index.ts': '...', '_shared/x.ts': '...' }"),
            entrypoint: z.string().optional().describe("[deploy_bundle] Entrypoint file (default: index.ts)"),
            minify: z.boolean().optional().describe("[deploy/deploy_bundle] Minify bundle"),
            verify_jwt: z.boolean().optional().describe("[deploy/deploy_bundle/config] Set JWT verification for this function"),
            background_routes: backgroundRoutesSchema.describe("[deploy/deploy_bundle/config] Background route paths; pass comma-separated or JSON array in CLI"),
        },
        async (args: any) => {
            const { action, ref, slug, path: pathArg, files, entrypoint, minify, verify_jwt, background_routes } = args;
            let code = args.code as string | undefined;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };

            let text: string;

            const functionConfig = (): EdgeFunctionConfigInput => ({
                ...(typeof verify_jwt === "boolean" ? { verify_jwt } : {}),
                ...(Array.isArray(background_routes) ? { background_routes } : {}),
            });

            const hasFunctionConfig = () => Object.keys(functionConfig()).length > 0;

            const updateFunctionConfig = async (): Promise<string> => {
                need("slug", slug);
                if (!hasFunctionConfig()) {
                    throw new Error("'verify_jwt' or 'background_routes' required for 'config'");
                }
                const cr = await http.patch(`/v1/projects/${ref}/functions/${slug}/config`, functionConfig());
                return cr.ok
                    ? `✅ Function ${slug} config updated\n${JSON.stringify(cr.data, null, 2)}`
                    : `❌ Config update failed (${cr.status}): ${JSON.stringify(cr.data)}`;
            };

            const checkSyntax = async (sourceCode: string): Promise<{ ok: boolean; err?: string }> => {
                const tmpDir = mkdtempSync(join(tmpdir(), "supacloud-edge-check-"));
                const tmpFile = join(tmpDir, "index.ts");
                writeFileSync(tmpFile, sourceCode);
                try {
                    await runBunBuild([tmpFile, "--external", "*"]);
                    return { ok: true };
                } catch (e: any) {
                    return { ok: false, err: `${e.stdout || ""}\n${e.stderr || e.message}` };
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            };

            if (pathArg && !code) {
                try {
                    code = await bundleEdgeFunctionPath(pathArg);
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
                    if (!dr.ok) {
                        text = `❌ Failed (${dr.status}): ${JSON.stringify(dr.data)}`;
                        break;
                    }
                    text = hasFunctionConfig()
                        ? `✅ Function ${slug} deployed\n${await updateFunctionConfig()}`
                        : `✅ Function ${slug} deployed`;
                    break;
                case "deploy_bundle":
                    need("slug", slug); need("files", files);
                    const br = await http.post(`/v1/projects/${ref}/functions/${slug}/bundle`, { files, entrypoint, minify });
                    if (!br.ok) {
                        text = `❌ Failed (${br.status}): ${JSON.stringify(br.data)}`;
                        break;
                    }
                    text = hasFunctionConfig()
                        ? `✅ Function ${slug} bundle deployed (${Object.keys(files!).length} files)\n${await updateFunctionConfig()}`
                        : `✅ Function ${slug} bundle deployed (${Object.keys(files!).length} files)`;
                    break;
                case "config":
                    text = await updateFunctionConfig();
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
            secrets: secretsSchema
                .describe("[upsert] Secret list as JSON array or KEY=VALUE,KEY2=VALUE2"),
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

    // ═══ Task Events (3→1) ═══
    server.tool(
        "task_events",
        `Task lifecycle webhook configuration.
Actions: register_webhook, unregister_webhook, inspect_webhook`,
        {
            action: z.enum(["register_webhook", "unregister_webhook", "inspect_webhook"]).describe("Action"),
            ref: z.string().describe("Project ref"),
            url: z.string().optional().describe("[register_webhook] HTTPS webhook URL for task lifecycle events"),
            secret: z.string().optional().describe("[register_webhook] Optional HMAC secret for webhook verification"),
        },
        async (args: any) => {
            const { action, ref, url, secret } = args;
            let text: string;
            switch (action) {
                case "register_webhook": {
                    if (!url) throw new Error("'url' is required for register_webhook");
                    const body: Record<string, unknown> = { url };
                    if (secret) body.secret = secret;
                    const r = await http.post(`/v1/projects/${ref}/task-events/webhook`, body);
                    text = r.ok
                        ? `✅ Webhook registered for project ${ref}\n${JSON.stringify(r.data, null, 2)}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "unregister_webhook": {
                    const r = await http.delete(`/v1/projects/${ref}/task-events/webhook`);
                    text = r.ok
                        ? `✅ Webhook unregistered for project ${ref}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "inspect_webhook": {
                    const r = await http.get(`/v1/projects/${ref}/task-events/webhook`);
                    text = r.ok
                        ? JSON.stringify(r.data, null, 2)
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                default:
                    text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );

    // ═══ Diagnostics (4→1) ═══
    server.tool(
        "diagnostics",
        `Platform and project diagnostics: health checks, diagnostic runs, and repair.
Actions: list_checks, run_checks, get_run, repair`,
        {
            action: z.enum(["list_checks", "run_checks", "get_run", "repair"]).describe("Action"),
            ref: z.string().optional().describe("Project ref (for project-scoped diagnostics)"),
            run_id: z.string().optional().describe("[get_run/repair] Diagnostic run ID"),
            check_id: z.string().optional().describe("[repair] Check result ID to repair"),
        },
        async (args: any) => {
            const { action, ref, run_id, check_id } = args;
            let text: string;
            switch (action) {
                case "list_checks": {
                    const path = ref
                        ? `/v1/projects/${ref}/diagnostics/checks`
                        : "/v1/diagnostics/checks";
                    text = JSON.stringify((await http.get(path)).data, null, 2);
                    break;
                }
                case "run_checks": {
                    const path = ref
                        ? `/v1/projects/${ref}/diagnostics/runs`
                        : "/v1/diagnostics/runs";
                    const r = await http.post(path);
                    text = r.ok
                        ? `✅ Diagnostic run started\n${JSON.stringify(r.data, null, 2)}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "get_run": {
                    if (!run_id) throw new Error("'run_id' is required for get_run");
                    const path = ref
                        ? `/v1/projects/${ref}/diagnostics/runs/${run_id}`
                        : `/v1/diagnostics/runs/${run_id}`;
                    text = JSON.stringify((await http.get(path)).data, null, 2);
                    break;
                }
                case "repair": {
                    if (!check_id) throw new Error("'check_id' is required for repair");
                    const path = `/v1/diagnostics/results/${check_id}/repair`;
                    const r = await http.post(path);
                    text = r.ok
                        ? `✅ Repair executed for ${check_id}\n${JSON.stringify(r.data, null, 2)}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                default:
                    text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
