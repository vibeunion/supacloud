import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { normalizeEnvironmentName } from "./global-options";

export type ContextSourceKind =
    | "process_env"
    | "named_env_file"
    | "explicit_env_file"
    | "legacy_dotenv"
    | "none";

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
    sshHostFingerprint: string;
    apiUrl: string;
    apiToken: string;
    projectRef: string;
    readOnly: boolean;
    environment: string;
    production: boolean;
    inferredSupabaseUrl: string;
    inferredServiceRoleKey: string;
    source: ContextSourceKind;
    sourcePath: string | null;
}

interface ContextSource {
    environment: Record<string, string>;
    kind: ContextSourceKind;
    path: string | null;
    environmentName: string;
}

const ADMIN_CONTEXT_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_MANAGEMENT_API_URL",
    "MANAGEMENT_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "X_PROJECT_REF",
    "SUPACLOUD_HOST",
    "SUPACLOUD_SSH_USER",
    "SUPACLOUD_SSH_PORT",
    "SUPACLOUD_SSH_KEY",
    "SUPACLOUD_SSH_PASS",
    "SUPACLOUD_SSH_HOST_FINGERPRINT",
    "SUPACLOUD_READ_ONLY",
] as const;
const SOURCE_ENVIRONMENT_KEYS = [...ADMIN_CONTEXT_KEYS, "SUPACLOUD_ENV"] as const;

function unquotedEnvValue(rawValue: string): string {
    const trimmedValue = rawValue.trim();
    const quote = trimmedValue[0];
    return quote && (quote === '"' || quote === "'") && trimmedValue.endsWith(quote)
        ? trimmedValue.slice(1, -1)
        : trimmedValue;
}

function parseEnvFile(contents: string): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (match) environment[match[1]] = unquotedEnvValue(match[2]);
    }
    return environment;
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

function normalizeUrl(urlCandidate: string): string {
    const trimmed = urlCandidate.trim();
    if (!trimmed) return "";
    try {
        const url = new URL(trimmed);
        if (!["http:", "https:"].includes(url.protocol)
            || url.username || url.password || url.search || url.hash) return "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return "";
    }
}

function hostFromUrl(urlCandidate: string): string {
    try {
        return new URL(urlCandidate).hostname;
    } catch {
        return "";
    }
}

function inferProjectRefFromSupabaseUrl(supabaseUrlCandidate: string): string {
    const normalized = normalizeUrl(supabaseUrlCandidate);
    if (!normalized) return "";
    return new URL(normalized).hostname.match(/^([a-z0-9-]+)\.api\./i)?.[1] ?? "";
}

function inferManagementApiUrlFromSupabaseUrl(supabaseUrlCandidate: string, projectRef = ""): string {
    const normalized = normalizeUrl(supabaseUrlCandidate);
    if (!normalized) return "";

    const url = new URL(normalized);
    const host = url.hostname;
    if (host.startsWith("api.")) {
        url.hostname = `studio.${host.slice("api.".length)}`;
        return url.toString().replace(/\/+$/, "");
    }
    const ref = projectRef.trim();
    if (ref && host.startsWith(`${ref}.api.`)) {
        url.hostname = `studio-${ref}.${host.slice(`${ref}.api.`.length)}`;
        return url.toString().replace(/\/+$/, "");
    }
    const managedHost = host.match(/^([a-z0-9-]+)\.api\.(.+)$/i);
    if (managedHost) {
        url.hostname = `studio-${managedHost[1]}.${managedHost[2]}`;
        return url.toString().replace(/\/+$/, "");
    }
    return normalized;
}

function sourceAdminCore(environment: Record<string, string>) {
    const supabaseUrl = normalizeUrl(environment.SUPABASE_URL || "");
    const projectRef = (environment.SUPACLOUD_PROJECT_REF || environment.X_PROJECT_REF || "").trim()
        || inferProjectRefFromSupabaseUrl(supabaseUrl);
    const explicitApiUrl = environment.SUPACLOUD_API_URL
        || environment.SUPACLOUD_MANAGEMENT_API_URL
        || environment.MANAGEMENT_API_URL
        || "";
    const apiUrl = normalizeUrl(explicitApiUrl)
        || inferManagementApiUrlFromSupabaseUrl(supabaseUrl, projectRef)
        || normalizeUrl(environment.SUPACLOUD_HOST ? `http://${environment.SUPACLOUD_HOST}:9090` : "");
    const apiToken = environment.SUPACLOUD_API_TOKEN || environment.SUPABASE_SERVICE_ROLE_KEY || "";
    return { apiUrl, apiToken, projectRef, supabaseUrl };
}

function processEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(SOURCE_ENVIRONMENT_KEYS.flatMap((key) => {
        const environmentValue = env[key];
        return environmentValue === undefined ? [] : [[key, environmentValue]];
    }));
}

function hasProcessContext(env: NodeJS.ProcessEnv): boolean {
    return ADMIN_CONTEXT_KEYS.some((key) => Object.hasOwn(env, key));
}

function completeAdminContext(environment: Record<string, string>): boolean {
    const adminCore = sourceAdminCore(environment);
    const hasApiContext = Boolean(adminCore.apiUrl && adminCore.apiToken);
    const hasSshContext = Boolean(environment.SUPACLOUD_HOST && environment.SUPACLOUD_SSH_HOST_FINGERPRINT);
    return hasApiContext || hasSshContext;
}

function namedEnvironmentSource(cwd: string, selector: string): ContextSource {
    const environment = normalizeEnvironmentName(selector);
    const path = resolve(cwd, `.env.supacloud.${selector}`);
    const selectedEnvironment = readEnvFile(path, true);
    if (!selectedEnvironment.SUPACLOUD_ENV) {
        throw new Error(`SUPACLOUD_ENV is required in ${path}`);
    }
    if (normalizeEnvironmentName(selectedEnvironment.SUPACLOUD_ENV) !== environment) {
        throw new Error(`SUPACLOUD_ENV in ${path} does not match selector ${selector}`);
    }
    return {
        environment: selectedEnvironment,
        kind: "named_env_file",
        path,
        environmentName: environment,
    };
}

function explicitEnvironmentSource(cwd: string, envFile: string): ContextSource {
    const path = resolve(cwd, envFile);
    const selectedEnvironment = readEnvFile(path, true);
    if (!selectedEnvironment.SUPACLOUD_ENV) throw new Error(`SUPACLOUD_ENV is required in ${path}`);
    return {
        environment: selectedEnvironment,
        kind: "explicit_env_file",
        path,
        environmentName: normalizeEnvironmentName(selectedEnvironment.SUPACLOUD_ENV),
    };
}

function legacyEnvironmentSource(cwd: string): ContextSource {
    const path = resolve(cwd, ".env");
    const environment = readEnvFile(path, false);
    const environmentName = environment.SUPACLOUD_ENV
        ? normalizeEnvironmentName(environment.SUPACLOUD_ENV)
        : "";
    return {
        environment,
        kind: Object.keys(environment).length ? "legacy_dotenv" : "none",
        path: existsSync(path) ? path : null,
        environmentName,
    };
}

function ambientContextSource(env: NodeJS.ProcessEnv, cwd: string): ContextSource {
    const environment = processEnvironment(env);
    if (env.SUPACLOUD_ENV) {
        const environmentName = normalizeEnvironmentName(env.SUPACLOUD_ENV);
        if (completeAdminContext(environment)) {
            return { environment, kind: "process_env", path: null, environmentName };
        }
        return namedEnvironmentSource(cwd, env.SUPACLOUD_ENV);
    }
    if (hasProcessContext(env)) {
        return { environment, kind: "process_env", path: null, environmentName: "" };
    }
    return legacyEnvironmentSource(cwd);
}

function contextSource(
    env: NodeJS.ProcessEnv,
    cwd: string,
    selection: ContextSelection,
): ContextSource {
    if (selection.environmentName && selection.envFile) {
        throw new Error("Environment selectors are mutually exclusive");
    }
    if (selection.environmentName) return namedEnvironmentSource(cwd, selection.environmentName);
    if (selection.envFile) return explicitEnvironmentSource(cwd, selection.envFile);
    return ambientContextSource(env, cwd);
}

function resolvedSshContext(environment: Record<string, string>) {
    const rawPort = environment.SUPACLOUD_SSH_PORT || "22";
    if (!/^\d+$/.test(rawPort)) {
        throw new Error("SUPACLOUD_SSH_PORT must be an integer between 1 and 65535");
    }
    const sshPort = Number(rawPort);
    if (!Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65_535) {
        throw new Error("SUPACLOUD_SSH_PORT must be an integer between 1 and 65535");
    }
    return {
        sshUser: environment.SUPACLOUD_SSH_USER || "root",
        sshPort,
        sshKey: environment.SUPACLOUD_SSH_KEY || resolve(homedir(), ".ssh", "id_rsa"),
        sshPass: environment.SUPACLOUD_SSH_PASS || "",
        sshHostFingerprint: environment.SUPACLOUD_SSH_HOST_FINGERPRINT || "",
    };
}

export function resolveSupaCloudContext(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
    selection: ContextSelection = {},
): ResolvedContext {
    const source = contextSource(env, cwd, selection);
    const adminCore = sourceAdminCore(source.environment);
    const host = source.environment.SUPACLOUD_HOST || hostFromUrl(adminCore.apiUrl || adminCore.supabaseUrl);

    return {
        host,
        ...resolvedSshContext(source.environment),
        apiUrl: adminCore.apiUrl,
        apiToken: adminCore.apiToken,
        projectRef: adminCore.projectRef,
        readOnly: env.SUPACLOUD_READ_ONLY === "true"
            || source.environment.SUPACLOUD_READ_ONLY === "true",
        environment: source.environmentName,
        production: source.environmentName === "production",
        inferredSupabaseUrl: adminCore.supabaseUrl,
        inferredServiceRoleKey: source.environment.SUPABASE_SERVICE_ROLE_KEY || "",
        source: source.kind,
        sourcePath: source.path,
    };
}
