/**
 * Advanced — Split into 3 compound tools: edge_functions, secrets, platform
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";

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

const INVALID_BACKGROUND_ROUTES_MESSAGE = "Invalid background_routes JSON array. Use a valid JSON array or comma-separated routes like /queue/*,/render/*.";

function parseBackgroundRoutes(value: string | string[]): unknown {
    if (Array.isArray(value)) return value;
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith("[")) return trimmed.split(",").map((route) => route.trim()).filter(Boolean);
    try {
        const routes = JSON.parse(trimmed);
        if (Array.isArray(routes) && routes.some((route) => typeof route === "string" && route.trim().startsWith("["))) {
            throw new Error(INVALID_BACKGROUND_ROUTES_MESSAGE);
        }
        return routes;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error(INVALID_BACKGROUND_ROUTES_MESSAGE);
    }
}

const backgroundRoutesSchema = Type.Optional(decodedSchema(
    Type.Union([Type.String(), Type.Array(Type.String())]),
    Type.Array(Type.String()),
    parseBackgroundRoutes,
));

const functionFilesRecordSchema = Type.Record(Type.String(), Type.String());

function parseFunctionFiles(input: string | Record<string, string>): unknown {
    if (typeof input !== "string") return input;
    try {
        return JSON.parse(input);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Invalid files JSON object");
    }
}

const functionFilesSchema = decodedSchema(
    Type.Union([Type.String(), functionFilesRecordSchema]),
    functionFilesRecordSchema,
    parseFunctionFiles,
);

function parseFunctionVersion(input: string | number): unknown {
    const version = String(input);
    if (!CANONICAL_FUNCTION_VERSION_PATTERN.test(version)
        || !Number.isSafeInteger(Number(version))) {
        throw new Error("Function version must be a canonical safe integer");
    }
    return version;
}

const CANONICAL_FUNCTION_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SAFE_FUNCTION_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FUNCTION_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FUNCTION_ACTIVATION_ARGUMENTS = new Set(["action", "ref", "slug", "version"]);
const functionVersionSchema = Type.Optional(decodedSchema(
    Type.Union([
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        Type.String({ pattern: CANONICAL_FUNCTION_VERSION_PATTERN.source, maxLength: 16 }),
    ]),
    Type.String({ pattern: CANONICAL_FUNCTION_VERSION_PATTERN.source, maxLength: 16 }),
    parseFunctionVersion,
));

const secretListSchema = Type.Array(Type.Object({ name: Type.String(), value: Type.String() }));
const ENVIRONMENT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const MAX_SECRET_COUNT = 1024;
const MAX_ENVIRONMENT_SECRET_BYTES = 24 * 1024;
const MAX_SECRET_JSON_BYTES = 1024 * 1024;
const INVALID_ENVIRONMENT_SECRET_NAMES_MESSAGE = "Environment secret names are invalid";
const INVALID_ENVIRONMENT_SECRET_VALUES_MESSAGE = "Environment secret values are missing or exceed safe limits";
const INVALID_SECRET_LIST_RESPONSE = "❌ Project secret list response is invalid";

type SecretEntry = { name: string; value: string };

function parseSecrets(value: string | Array<{ name: string; value: string }>): unknown {
    if (Array.isArray(value)) return value;
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw new Error("Invalid secrets JSON array");
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
}

const secretsSchema = Type.Optional(decodedSchema(
    Type.Union([Type.String(), secretListSchema]),
    secretListSchema,
    parseSecrets,
));

function validEnvironmentSecretNames(names: string[]): boolean {
    if (names.length === 0 || names.length > MAX_SECRET_COUNT) return false;
    const uniqueNames = new Set<string>();
    for (const name of names) {
        if (!ENVIRONMENT_SECRET_NAME_PATTERN.test(name) || uniqueNames.has(name)) return false;
        uniqueNames.add(name);
    }
    return true;
}

function parseEnvironmentSecretNames(input: string): unknown {
    const names = input.split(",", MAX_SECRET_COUNT + 1).map((name) => name.trim());
    if (!validEnvironmentSecretNames(names)) {
        throw new Error(INVALID_ENVIRONMENT_SECRET_NAMES_MESSAGE);
    }
    return names;
}

const environmentSecretNamesSchema = Type.Optional(decodedSchema(
    Type.String(),
    Type.Array(Type.String({ pattern: ENVIRONMENT_SECRET_NAME_PATTERN.source }), {
        minItems: 1,
        maxItems: MAX_SECRET_COUNT,
        uniqueItems: true,
    }),
    parseEnvironmentSecretNames,
));

function jsonWithinSecretLimit(payload: unknown): boolean {
    try {
        const serializedPayload = JSON.stringify(payload);
        return serializedPayload !== undefined
            && Buffer.byteLength(serializedPayload) <= MAX_SECRET_JSON_BYTES;
    } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
    }
}

function maskedSecretEntry(candidate: unknown): SecretEntry | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const { name, value } = candidate as Record<string, unknown>;
    if (typeof name !== "string" || !ENVIRONMENT_SECRET_NAME_PATTERN.test(name)) return null;
    if (value !== "********") return null;
    return { name, value: "********" };
}

function projectedMaskedSecrets(payload: unknown): SecretEntry[] | null {
    if (!Array.isArray(payload) || payload.length > MAX_SECRET_COUNT) return null;
    if (!jsonWithinSecretLimit(payload)) return null;
    const secretNames = new Set<string>();
    const projectedSecrets: SecretEntry[] = [];
    for (const candidate of payload) {
        const secret = maskedSecretEntry(candidate);
        if (!secret || secretNames.has(secret.name)) return null;
        secretNames.add(secret.name);
        projectedSecrets.push(secret);
    }
    return projectedSecrets;
}

function secretsFromEnvironment(
    names: string[],
    environment: NodeJS.ProcessEnv,
): SecretEntry[] {
    const secrets = names.map((name) => {
        const secretValue = environment[name];
        if (typeof secretValue !== "string" || secretValue.length === 0
            || Buffer.byteLength(secretValue) > MAX_ENVIRONMENT_SECRET_BYTES) {
            throw new Error(INVALID_ENVIRONMENT_SECRET_VALUES_MESSAGE);
        }
        return { name, value: secretValue };
    });
    if (!jsonWithinSecretLimit(secrets)) {
        throw new Error(INVALID_ENVIRONMENT_SECRET_VALUES_MESSAGE);
    }
    return secrets;
}

function secretsForUpsert(
    inlineSecrets: SecretEntry[] | undefined,
    environmentNames: string[] | undefined,
    environment: NodeJS.ProcessEnv,
): SecretEntry[] {
    if (inlineSecrets !== undefined && environmentNames !== undefined) {
        throw new Error("'--from-env' cannot be combined with '--secrets'");
    }
    if (environmentNames !== undefined) {
        return secretsFromEnvironment(environmentNames, environment);
    }
    if (!inlineSecrets?.length) throw new Error("'secrets' array required");
    return inlineSecrets;
}

type EdgeFunctionConfigInput = {
    verify_jwt?: boolean;
    background_routes?: string[];
};

function confirmedFunctionConfig(payload: unknown, expected: EdgeFunctionConfigInput): boolean {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const response = payload as Record<string, unknown>;
    if (expected.verify_jwt !== undefined && response.verify_jwt !== expected.verify_jwt) return false;
    if (expected.background_routes !== undefined) {
        if (!Array.isArray(response.background_routes)) return false;
        if (JSON.stringify(response.background_routes) !== JSON.stringify(expected.background_routes)) return false;
    }
    return true;
}

function functionSourceCode(payload: unknown): string | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const code = (payload as Record<string, unknown>).code;
    return typeof code === "string" ? code : null;
}

function objectRecord(candidate: unknown): Record<string, unknown> | null {
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function activationResponse(
    slug: string,
    version: string,
    response: HttpResult<unknown>,
): ReleaseControlToolResponse {
    const operation = "edge_functions.activate";
    if (!response.ok) return releaseControlMutationFailure(operation, response);
    const receipt = objectRecord(response.data);
    const config = objectRecord(receipt?.config);
    if (receipt?.success !== true || receipt.version !== version
        || config?.version !== version || typeof config.verify_jwt !== "boolean") {
        return releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.status);
    }
    return releaseControlSuccess(operation, {
        slug,
        version,
        verify_jwt: config.verify_jwt,
    });
}

interface FunctionActivationTarget {
    projectRef: string;
    functionSlug: string;
    version: string;
}

function readOnlyActivationResult(): ReleaseControlToolResponse {
    return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Edge Function activation blocked in read-only mode." }],
    };
}

function functionActivationTarget(args: Record<string, unknown>): FunctionActivationTarget {
    const projectRef = typeof args.ref === "string" ? args.ref.trim() : "";
    const functionSlug = typeof args.slug === "string" ? args.slug.trim() : "";
    const version = args.version;
    if (!SAFE_FUNCTION_REF_PATTERN.test(projectRef)) throw new Error("'ref' is invalid for 'activate'");
    if (!SAFE_FUNCTION_SLUG_PATTERN.test(functionSlug)) throw new Error("'slug' is invalid for 'activate'");
    if (typeof version !== "string" || !CANONICAL_FUNCTION_VERSION_PATTERN.test(version)
        || !Number.isSafeInteger(Number(version))) {
        throw new Error("'version' is invalid for 'activate'");
    }
    return { projectRef, functionSlug, version };
}

async function activateFunctionVersion(
    http: HttpTransport,
    args: Record<string, unknown>,
    readOnly = false,
): Promise<ReleaseControlToolResponse> {
    if (readOnly) return readOnlyActivationResult();
    const unsupported = Object.keys(args).filter((name) => !FUNCTION_ACTIVATION_ARGUMENTS.has(name));
    if (unsupported.length > 0) throw new Error(`'${unsupported[0]}' is not supported for 'activate'`);
    const { projectRef, functionSlug, version } = functionActivationTarget(args);
    const endpoint = `/v1/projects/${encodeURIComponent(projectRef)}/functions/${encodeURIComponent(functionSlug)}`
        + `/versions/${encodeURIComponent(version)}/activate`;
    return activationResponse(functionSlug, version, await http.post(endpoint));
}

export function registerAdvancedTools(
    server: { tool: (...args: any[]) => void },
    http: HttpTransport,
    environment: NodeJS.ProcessEnv = process.env,
    options: { readOnly?: boolean } = {},
): void {

    // ═══ Edge Functions (8→1) ═══
    server.tool(
        "edge_functions",
        `Edge Function management (Deno/Bun serverless). Server auto-bundles dependencies.
Actions: list, deploy, deploy_bundle, config, source, activate, delete, check`,
        {
            action: withDescription(stringEnum(["list", "deploy", "deploy_bundle", "config", "source", "activate", "delete", "check"]), "Action"),
            ref: withDescription(Type.String(), "Project ref"),
            slug: optional(Type.String(), "[deploy/deploy_bundle/config/source/activate/delete/check] Function name"),
            version: withDescription(functionVersionSchema, "[activate] Existing Function version"),
            code: optional(Type.String(), "[deploy/check] Function source code (TypeScript)"),
            path: optional(Type.String(), "[deploy/check] Local file path to read code from (alternative to code)"),
            output: optional(Type.String(), "[source] Write source to this local file instead of stdout; the file must not already exist"),
            files: optional(functionFilesSchema, "[deploy_bundle] File map as a JSON object: { 'index.ts': '...', '_shared/x.ts': '...' }"),
            entrypoint: optional(Type.String(), "[deploy_bundle] Entrypoint file (default: index.ts)"),
            minify: optional(Type.Boolean(), "[deploy/deploy_bundle] Minify bundle"),
            verify_jwt: optional(Type.Boolean(), "[deploy/deploy_bundle/config] Set JWT verification for this function"),
            background_routes: withDescription(backgroundRoutesSchema, "[deploy/deploy_bundle/config] Background route paths; pass comma-separated or JSON array in CLI"),
        },
        async (args: any) => {
            if (args.action === "activate") return activateFunctionVersion(http, args, options.readOnly);
            const { action, ref, slug, path: pathArg, output, files, entrypoint, minify, verify_jwt, background_routes } = args;
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

            const deploymentPolicyReceiptText = (
                successText: string,
                responsePayload: unknown,
            ): string => {
                if (!hasFunctionConfig() || confirmedFunctionConfig(responsePayload, functionConfig())) {
                    return successText;
                }
                return "❌ Unsafe deployment receipt: POST succeeded but did not confirm the requested function policy. No follow-up PATCH was attempted because code and policy must be activated atomically.";
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
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`Failed to bundle/read path ${pathArg}: ${message}`);
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
                    const dr = await http.post(`/v1/projects/${ref}/functions/${slug}`, {
                        code,
                        minify,
                        ...functionConfig(),
                    });
                    if (!dr.ok) {
                        text = `❌ Failed (${dr.status}): ${JSON.stringify(dr.data)}`;
                        break;
                    }
                    text = deploymentPolicyReceiptText(`✅ Function ${slug} deployed`, dr.data);
                    break;
                case "deploy_bundle":
                    need("slug", slug); need("files", files);
                    const br = await http.post(`/v1/projects/${ref}/functions/${slug}/bundle`, {
                        files,
                        entrypoint,
                        minify,
                        ...functionConfig(),
                    });
                    if (!br.ok) {
                        text = `❌ Failed (${br.status}): ${JSON.stringify(br.data)}`;
                        break;
                    }
                    text = deploymentPolicyReceiptText(
                        `✅ Function ${slug} bundle deployed (${Object.keys(files!).length} files)`,
                        br.data,
                    );
                    break;
                case "config":
                    text = await updateFunctionConfig();
                    break;
                case "source":
                    need("slug", slug);
                    const sr = await http.get(`/v1/projects/${ref}/functions/${slug}/source`);
                    if (!sr.ok) {
                        text = `❌ Not found (${sr.status})`;
                        break;
                    }
                    if (!output) {
                        text = JSON.stringify(sr.data, null, 2);
                        break;
                    }
                    const sourceCode = functionSourceCode(sr.data);
                    if (sourceCode === null) {
                        text = "❌ Source response did not contain a string code field";
                        break;
                    }
                    const outputPath = resolve(output);
                    writeFileSync(outputPath, sourceCode, { flag: "wx" });
                    text = `✅ Function ${slug} source written to ${outputPath} (${Buffer.byteLength(sourceCode)} bytes)`;
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
            action: withDescription(stringEnum(["list", "upsert", "delete"]), "Action"),
            ref: withDescription(Type.String(), "Project ref"),
            secrets: withDescription(secretsSchema, "[upsert] Secret list as JSON array or KEY=VALUE,KEY2=VALUE2"),
            "from-env": withDescription(
                environmentSecretNamesSchema,
                "[upsert] Comma-separated environment variable names; values are read from this CLI process",
            ),
            name: optional(Type.String(), "[delete] Secret name to delete"),
        },
        async (args: any) => {
            const { action, ref, secrets, name } = args;
            const environmentNames = args["from-env"] as string[] | undefined;
            let text: string;
            switch (action) {
                case "list": {
                    const response = await http.get(`/v1/projects/${ref}/secrets`);
                    if (!response.ok) {
                        text = `❌ Failed (${response.status})`;
                        break;
                    }
                    const maskedSecrets = projectedMaskedSecrets(response.data);
                    text = maskedSecrets === null
                        ? INVALID_SECRET_LIST_RESPONSE
                        : JSON.stringify(maskedSecrets, null, 2);
                    break;
                }
                case "upsert":
                    const secretsToUpsert = secretsForUpsert(secrets, environmentNames, environment);
                    text = (await http.post(`/v1/projects/${ref}/secrets`, secretsToUpsert)).ok
                        ? `✅ Updated ${secretsToUpsert.length} secrets` : `❌ Failed`;
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
            action: withDescription(stringEnum([
                "metrics", "list_backups", "create_backup",
                "network", "update_network",
                "list_orgs", "get_org",
            ]), "Action"),
            ref: optional(Type.String(), "Project ref (for backup/network actions)"),
            slug: optional(Type.String(), "[get_org] Organization slug"),
            allowed_cidrs: optional(Type.Array(Type.String()), "[update_network] Allowed CIDRs"),
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
            action: withDescription(stringEnum(["register_webhook", "unregister_webhook", "inspect_webhook"]), "Action"),
            ref: withDescription(Type.String(), "Project ref"),
            url: optional(Type.String(), "[register_webhook] HTTPS webhook URL for task lifecycle events"),
            secret: optional(Type.String(), "[register_webhook] Optional HMAC secret for webhook verification"),
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
            action: withDescription(stringEnum(["list_checks", "run_checks", "get_run", "repair"]), "Action"),
            ref: optional(Type.String(), "Project ref (for project-scoped diagnostics)"),
            run_id: optional(Type.String(), "[get_run/repair] Diagnostic run ID"),
            check_id: optional(Type.String(), "[repair] Check result ID to repair"),
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
