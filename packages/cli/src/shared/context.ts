import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { normalizeEnvironmentName } from "./global-options";

export type ContextSourceKind = "process_env" | "named_env_file" | "explicit_env_file" | "legacy_dotenv" | "none";
export type ContextCredentialScope = "management" | "project_application" | "incomplete";

export interface ContextSelection {
    environmentName?: string;
    envFile?: string;
}

export interface ResolvedContext {
    host: string;
    sshUser: string;
    sshPort: number;
    sshKey: string;
    sshPass: string;
    apiUrl: string;
    apiToken: string;
    projectRef: string;
    readOnly: boolean;
    environment: string;
    production: boolean;
    inferredSupabaseUrl: string;
    inferredServiceRoleKey: string;
    credentialScope: ContextCredentialScope;
    source: ContextSourceKind;
    sourcePath: string | null;
}

interface ContextSource {
    values: Record<string, string>;
    kind: ContextSourceKind;
    path: string | null;
    environment: string;
}

const CORE_CONTEXT_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_MANAGEMENT_API_URL",
    "MANAGEMENT_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "X_PROJECT_REF",
    "SUPACLOUD_HOST",
] as const;

function unquotedEnvValue(rawValue: string): string {
    const value = rawValue.trim();
    const quote = value[0];
    return quote && (quote === '"' || quote === "'") && value.endsWith(quote)
        ? value.slice(1, -1)
        : value;
}

function parseEnvFile(contents: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        values[match[1]] = unquotedEnvValue(match[2]);
    }
    return values;
}

function readEnvFile(path: string, required: boolean): Record<string, string> {
    if (!existsSync(path)) {
        if (required) throw new Error(`SupaCloud environment file not found: ${path}`);
        return {};
    }
    try {
        return parseEnvFile(readFileSync(path, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read SupaCloud environment file ${path}: ${message}`);
    }
}

function canonicalApiOrigin(value: string): string {
    const candidate = value.trim();
    if (!candidate) return "";
    try {
        const url = new URL(candidate);
        const loopback = url.hostname === "localhost"
            || url.hostname === "127.0.0.1"
            || url.hostname === "[::1]";
        const allowedProtocol = url.protocol === "https:"
            || (url.protocol === "http:" && loopback);
        const exactOrigin = candidate === url.origin || candidate === `${url.origin}/`;
        return allowedProtocol && !url.username && !url.password
            && exactOrigin && url.pathname === "/" && !url.search && !url.hash
            ? url.origin
            : "";
    } catch (error: unknown) {
        if (error instanceof TypeError) return "";
        throw error;
    }
}

function hostFromUrl(value: string): string {
    return value ? new URL(value).hostname : "";
}

function inferProjectRefFromSupabaseUrl(value: string): string {
    if (!value) return "";
    return new URL(value).hostname.match(/^([a-z0-9-]+)\.api\./i)?.[1] ?? "";
}

function sourceCredentialScope(
    values: Record<string, string>,
    explicitApiUrl: string,
    supabaseUrl: string,
): ContextCredentialScope {
    const hasManagementContext = Boolean(
        explicitApiUrl.trim() || values.SUPACLOUD_API_TOKEN?.trim() || values.SUPACLOUD_HOST?.trim(),
    );
    if (hasManagementContext) return "management";
    return supabaseUrl || values.SUPABASE_SERVICE_ROLE_KEY?.trim()
        ? "project_application"
        : "incomplete";
}

function sourceProjectCore(values: Record<string, string>) {
    const supabaseUrl = canonicalApiOrigin(values.SUPABASE_URL || "");
    const projectRef = (values.SUPACLOUD_PROJECT_REF || values.X_PROJECT_REF || "").trim()
        || inferProjectRefFromSupabaseUrl(supabaseUrl);
    const explicitApiUrl = values.SUPACLOUD_API_URL
        || values.SUPACLOUD_MANAGEMENT_API_URL
        || values.MANAGEMENT_API_URL
        || "";
    const credentialScope = sourceCredentialScope(values, explicitApiUrl, supabaseUrl);
    const managementUrl = explicitApiUrl
        || (values.SUPACLOUD_HOST ? `http://${values.SUPACLOUD_HOST}:9090` : "");
    const apiUrl = credentialScope === "management" ? canonicalApiOrigin(managementUrl) : "";
    const apiToken = credentialScope === "management" ? values.SUPACLOUD_API_TOKEN || "" : "";
    return { apiUrl, apiToken, projectRef, supabaseUrl, credentialScope };
}

function processValues(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function hasProcessContext(env: NodeJS.ProcessEnv): boolean {
    return CORE_CONTEXT_KEYS.some((key) => Object.hasOwn(env, key));
}

function completeProjectContext(values: Record<string, string>): boolean {
    const core = sourceProjectCore(values);
    if (core.credentialScope === "project_application") {
        return Boolean(
            core.supabaseUrl
            && values.SUPABASE_SERVICE_ROLE_KEY?.trim()
            && core.projectRef,
        );
    }
    return Boolean(core.apiUrl && core.apiToken && core.projectRef);
}

function namedEnvironmentSource(cwd: string, selector: string): ContextSource {
    const environment = normalizeEnvironmentName(selector);
    const path = resolve(cwd, `.env.supacloud.${selector}`);
    const values = readEnvFile(path, true);
    if (values.SUPACLOUD_ENV && normalizeEnvironmentName(values.SUPACLOUD_ENV) !== environment) {
        throw new Error(`SUPACLOUD_ENV in ${path} does not match selector ${selector}`);
    }
    return { values, kind: "named_env_file", path, environment };
}

function explicitEnvironmentSource(cwd: string, envFile: string): ContextSource {
    const path = resolve(cwd, envFile);
    const values = readEnvFile(path, true);
    if (!values.SUPACLOUD_ENV) throw new Error(`SUPACLOUD_ENV is required in ${path}`);
    return {
        values,
        kind: "explicit_env_file",
        path,
        environment: normalizeEnvironmentName(values.SUPACLOUD_ENV),
    };
}

function contextSource(env: NodeJS.ProcessEnv, cwd: string, selection: ContextSelection): ContextSource {
    if (selection.environmentName && selection.envFile) throw new Error("Environment selectors are mutually exclusive");
    if (selection.environmentName) return namedEnvironmentSource(cwd, selection.environmentName);
    if (selection.envFile) return explicitEnvironmentSource(cwd, selection.envFile);

    if (env.SUPACLOUD_ENV) {
        const environment = normalizeEnvironmentName(env.SUPACLOUD_ENV);
        const values = processValues(env);
        if (completeProjectContext(values)) {
            return { values, kind: "process_env", path: null, environment };
        }
        return namedEnvironmentSource(cwd, env.SUPACLOUD_ENV);
    }
    if (hasProcessContext(env)) {
        return { values: processValues(env), kind: "process_env", path: null, environment: "" };
    }

    const path = resolve(cwd, ".env");
    const values = readEnvFile(path, false);
    const environment = values.SUPACLOUD_ENV ? normalizeEnvironmentName(values.SUPACLOUD_ENV) : "";
    return { values, kind: Object.keys(values).length ? "legacy_dotenv" : "none", path: existsSync(path) ? path : null, environment };
}

export function resolveSupaCloudContext(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
    selection: ContextSelection = {},
): ResolvedContext {
    const source = contextSource(env, cwd, selection);
    const core = sourceProjectCore(source.values);
    const host = source.values.SUPACLOUD_HOST || hostFromUrl(core.apiUrl || core.supabaseUrl);
    const readOnly = env.SUPACLOUD_READ_ONLY === "true" || source.values.SUPACLOUD_READ_ONLY === "true";

    return {
        host,
        sshUser: env.SUPACLOUD_SSH_USER ?? "root",
        sshPort: parseInt(env.SUPACLOUD_SSH_PORT ?? "22", 10),
        sshKey: env.SUPACLOUD_SSH_KEY ?? resolve(homedir(), ".ssh", "id_rsa"),
        sshPass: env.SUPACLOUD_SSH_PASS ?? "",
        apiUrl: core.apiUrl,
        apiToken: core.apiToken,
        projectRef: core.projectRef,
        readOnly,
        environment: source.environment,
        production: source.environment === "prod" || source.environment === "production",
        inferredSupabaseUrl: core.supabaseUrl,
        inferredServiceRoleKey: source.values.SUPABASE_SERVICE_ROLE_KEY || "",
        credentialScope: core.credentialScope,
        source: source.kind,
        sourcePath: source.path,
    };
}
